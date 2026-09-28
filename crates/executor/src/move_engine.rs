//! MoveEngine —— 同卷 rename / 跨盘并行复制引擎（v26.1.4.0 菜2/菜6，
//! 规格 docs/release-plan-26.1.4.0.md §2.1/§6）。
//!
//! # 语义（规格红线）
//! - **同卷**：`std::fs::rename` 瞬时完成；
//! - **跨盘**：文件级任务队列 + N worker（默认 4）并行复制 + SHA-256 校验
//!   （复制时边读源边哈希，写后 `sync_all` 落盘，再逐文件读回目标重哈希
//!   比对）+ **全部校验通过才进入删源阶段**；
//! - **任意失败/取消**：回滚已复制的目标文件（花名册到删源为止不清空，
//!   覆盖校验中途失败的情形），**绝不删源**——失败项之前已完成迁移的条目
//!   保持迁移态且有 undo 台账（action=migrate 双向 src/dst），可经
//!   `migrate_paths` 反向回迁；
//! - **删源阶段**失败（源文件被锁等）：目标已全部校验通过、数据无损，
//!   报错保留现场（部分源残留），不做破坏性反向操作；
//! - 接取消令牌 `Arc<AtomicBool>`：复制/校验每个 64KB 分块都检查；
//! - 进度按 CONTRACT `migrate://progress` 载荷回调：
//!   `{src, dst, bytes_done, bytes_total, files_done, files_total, phase}`，
//!   phase ∈ copying | verifying | deleting | done | rolled_back（serde
//!   snake_case 逐字冻结）；copying/verifying 阶段按 PROGRESS_TICK 轮询
//!   计数器流式回调。
//!
//! 顶层 symlink/联接拒绝复制（与 quarantine 既有纪律一致：rename 移动的是
//! 联接本体，跨盘复制绝不能把联接目标整树搬走）。

use anyhow::anyhow;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::{path_bytes, reject_never_touch, UndoEntry, DRY_RUN_REASON_PREFIX};

/// 并行复制 worker 数（规格默认 4）。
pub const DEFAULT_WORKERS: usize = 4;
/// 复制/哈希分块。
const CHUNK: usize = 64 * 1024;
/// 进度回调节流。
const PROGRESS_TICK: Duration = Duration::from_millis(20);

/// CONTRACT phase 取值域（serde snake_case 逐字冻结）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MovePhase {
    Copying,
    Verifying,
    Deleting,
    Done,
    RolledBack,
}

/// CONTRACT `migrate://progress` 载荷（字段名冻结）。
#[derive(Debug, Clone, serde::Serialize)]
pub struct MoveProgress {
    pub src: String,
    pub dst: String,
    pub bytes_done: u64,
    pub bytes_total: u64,
    pub files_done: u64,
    pub files_total: u64,
    pub phase: MovePhase,
}

/// 一次 move_paths 的结果。
#[derive(Debug, Default)]
pub struct MoveOutcome {
    /// 已完成迁移条目的台账（action=Migrate，source=原路径，
    /// destination=新路径——双向记录，回迁即反向再迁一次）。
    pub entries: Vec<UndoEntry>,
    /// 因取消令牌中止（当前项已回滚，源完好）。
    pub cancelled: bool,
    /// 当前项发生过回滚（已复制目标文件被清除）。
    pub rolled_back: bool,
    /// 失败原因（首个，含防覆盖与删源中断）。
    pub error: Option<String>,
}

/// 单项失败形态（pub：move_one_cross_volume 的公开返回类型）。
#[derive(Debug)]
pub enum ItemFailure {
    Cancelled,
    Io(anyhow::Error),
}

impl std::fmt::Display for ItemFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ItemFailure::Cancelled => write!(f, "已取消"),
            ItemFailure::Io(e) => write!(f, "{e}"),
        }
    }
}

/// 同卷判定：两侧都是盘符路径且盘字母相同（ASCII 不区分大小写）。
/// 非盘符形态（UNC 等）一律按跨卷处理（走复制管线，保守正确）。
pub fn same_volume(a: &Path, b: &Path) -> bool {
    fn drive(p: &Path) -> Option<char> {
        let s = p.to_string_lossy();
        let b = s.as_bytes();
        if b.len() >= 2 && b[1] == b':' && (b[0] as char).is_ascii_alphabetic() {
            Some((b[0] as char).to_ascii_uppercase())
        } else {
            None
        }
    }
    match (drive(a), drive(b)) {
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

/// 批量迁移入口（src-tauri `migrate_paths` 的引擎面）。
///
/// - 逐项迁移：同卷 rename，跨盘并行复制管线；
/// - 批内失败/取消：中止后续项；当前项由管线自行回滚（绝不删源）；
///   之前已完成项保持迁移态（undo 台账已写，可回迁）；
/// - 与既有动作同一安全纪律：先 NEVER_TOUCH 整单拦截，再按用户排除规则
///   收紧（被排除的路径不迁移）。
#[allow(clippy::too_many_arguments)]
pub fn move_paths(
    paths: &[PathBuf],
    dest_root: &Path,
    reason: &str,
    dry_run: bool,
    undo_log: &Path,
    cancel: Option<&Arc<AtomicBool>>,
    on_progress: &mut dyn FnMut(MoveProgress),
) -> anyhow::Result<MoveOutcome> {
    // 与 execute() 同款 NEVER_TOUCH 整单拦截（迁移是重定位，同样不许碰
    // 系统保护区）。
    reject_never_touch(paths)?;
    // 用户排除规则只能收紧：被排除的路径不参与迁移（用户看不见的不动）。
    let excludes = pinkbin_excludes::Excludes::load_default();
    let paths: Vec<PathBuf> = if excludes.is_empty() {
        paths.to_vec()
    } else {
        let kept: Vec<PathBuf> = paths
            .iter()
            .filter(|p| !excludes.matches(p))
            .cloned()
            .collect();
        let dropped = paths.len() - kept.len();
        if dropped > 0 {
            tracing::info!("move_engine: {dropped} 条路径命中用户排除规则，已从迁移计划剔除");
        }
        kept
    };

    let mut outcome = MoveOutcome::default();
    if dry_run {
        let now = || chrono::Utc::now().to_rfc3339();
        for src in &paths {
            let dst = dest_root.join(src.file_name().unwrap_or_default());
            outcome.entries.push(UndoEntry {
                timestamp: now(),
                action: crate::Action::Migrate,
                source: src.clone(),
                destination: Some(dst),
                reason: format!("{DRY_RUN_REASON_PREFIX}{reason}"),
                bytes: Some(path_bytes(src)),
            });
        }
        return Ok(outcome);
    }

    for src in &paths {
        if cancelled(cancel) {
            outcome.cancelled = true;
            break;
        }
        let leaf = src
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .ok_or_else(|| anyhow!("无法取得路径末段：{}", src.display()))?;
        let dst = dest_root.join(&leaf);
        if dst.symlink_metadata().is_ok() {
            // 防覆盖：目标已存在一律失败（宁可不迁，不可盖数据）。
            outcome.error = Some(format!("目标已存在，拒绝覆盖：{}", dst.display()));
            break;
        }
        let total = path_bytes(src);
        let src_s = src.to_string_lossy().to_string();
        let dst_s = dst.to_string_lossy().to_string();

        let result = if same_volume(src, &dst) {
            // 同卷：rename 瞬时完成。
            std::fs::rename(src, &dst)
                .map_err(|e| anyhow!("rename({src_s} → {dst_s}) 失败: {e}"))?;
            on_progress(MoveProgress {
                src: src_s,
                dst: dst_s,
                bytes_done: total,
                bytes_total: total,
                files_done: 1,
                files_total: 1,
                phase: MovePhase::Done,
            });
            Ok(())
        } else {
            move_one_cross_volume(src, &dst, &excludes, cancel, on_progress)
        };

        match result {
            Ok(()) => {
                outcome.entries.push(UndoEntry {
                    timestamp: chrono::Utc::now().to_rfc3339(),
                    action: crate::Action::Migrate,
                    source: src.clone(),
                    destination: Some(dst),
                    reason: reason.to_string(),
                    bytes: Some(total),
                });
            }
            Err(ItemFailure::Cancelled) => {
                outcome.cancelled = true;
                outcome.rolled_back = true;
                break;
            }
            Err(ItemFailure::Io(e)) => {
                outcome.error = Some(e.to_string());
                break;
            }
        }
    }

    crate::write_log(undo_log, &outcome.entries)?;
    Ok(outcome)
}

/// 跨盘管线：把 `src`（文件或目录）复制到 `dst` 并校验，全部通过后删源。
/// 任何失败/取消 → 回滚已复制目标文件（rolled_back），源零触碰。
/// 返回迁移字节数。quarantine 的跨盘兜底同样走这里（菜单 6）。
/// `excludes`（探 bug 修复）：flatten 阶段命中的子树整枝不迁——既不复制、
/// 也不进删源清单（删源清单与复制清单同源于同一趟遍历，被排除内容必然
/// 留在源侧父目录里）。
pub fn move_one_cross_volume(
    src: &Path,
    dst: &Path,
    excludes: &pinkbin_excludes::Excludes,
    cancel: Option<&Arc<AtomicBool>>,
    on_progress: &mut dyn FnMut(MoveProgress),
) -> Result<(), ItemFailure> {
    let src_s = src.to_string_lossy().to_string();
    let dst_s = dst.to_string_lossy().to_string();
    let prog = move |bytes_done: u64,
                     bytes_total: u64,
                     files_done: u64,
                     files_total: u64,
                     phase: MovePhase| {
        MoveProgress {
            src: src_s.clone(),
            dst: dst_s.clone(),
            bytes_done,
            bytes_total,
            files_done,
            files_total,
            phase,
        }
    };

    // 顶层 reparse 点拒绝（复制绝不能搬联接目标整树）。
    if std::fs::symlink_metadata(src)
        .map_err(|e| ItemFailure::Io(anyhow!("读取 {} 失败: {e}", src.display())))?
        .file_type()
        .is_symlink()
    {
        return Err(ItemFailure::Io(anyhow!(
            "拒绝复制 reparse 点整树：{}",
            src.display()
        )));
    }

    // 1) 文件级任务清单（一次遍历定死；复制与删源都以此为准——复制期间
    //    新出现在源目录里的文件既不会被复制，也绝不会在删源阶段被误删）。
    //    跳过 symlink 项（既不复制也不进入）。
    let mut tasks: VecDeque<Task> = VecDeque::new();
    let mut src_files: Vec<PathBuf> = Vec::new();
    let mut src_dirs: Vec<PathBuf> = Vec::new();
    let mut created_dirs: Vec<PathBuf> = Vec::new();
    if src.is_dir() {
        create_dir_recorded(dst, &mut created_dirs)
            .map_err(|e| ItemFailure::Io(anyhow!("创建 {}: {e}", dst.display())))?;
        for entry in walkdir::WalkDir::new(src)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                // symlink 项既不复制也不进入（既有纪律）；排除命中的子树
                // 整枝剪断——不复制、不建骨架、不进删源清单（同源遍历）。
                !e.file_type().is_symlink() && !excludes.matches(e.path())
            })
        {
            let entry =
                entry.map_err(|e| ItemFailure::Io(anyhow!("遍历 {}: {e}", src.display())))?;
            let ft = entry.file_type();
            if ft.is_dir() {
                src_dirs.push(entry.path().to_path_buf());
                let rel = entry.path().strip_prefix(src).expect("walkdir 子项必含前缀");
                let d = dst.join(rel);
                create_dir_recorded(&d, &mut created_dirs)
                    .map_err(|e| ItemFailure::Io(anyhow!("创建 {}: {e}", d.display())))?;
            } else if ft.is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let rel = entry.path().strip_prefix(src).expect("walkdir 子项必含前缀");
                tasks.push_back(Task {
                    src: entry.path().to_path_buf(),
                    dst: dst.join(rel),
                    size,
                });
                src_files.push(entry.path().to_path_buf());
            }
        }
    } else {
        let size = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
        tasks.push_back(Task {
            src: src.to_path_buf(),
            dst: dst.to_path_buf(),
            size,
        });
        src_files.push(src.to_path_buf());
    }
    let files_total = tasks.len() as u64;
    let bytes_total: u64 = tasks.iter().map(|t| t.size).sum();

    let shared = Arc::new(Shared {
        tasks: Mutex::new(tasks),
        // 花名册保序：Verify 按游标读、不清空——校验中途失败回滚仍能拿到
        // 全部已复制目标。到删源阶段才消费。
        copied: Mutex::new(Vec::new()),
        // 在途目标：worker 开写前登记——中途取消/失败的半截文件不在
        // copied 花名册里，回滚必须连它们一起清掉。
        inflight: Mutex::new(Vec::new()),
        verify_cursor: AtomicUsize::new(0),
        bytes_done: AtomicU64::new(0),
        files_done: AtomicU64::new(0),
        created_dirs: Mutex::new(created_dirs),
        failure: Mutex::new(None),
        stop: AtomicBool::new(false),
    });

    // 2) 阶段 A：并行复制（源侧边读边哈希，分块检查取消），
    //    编排线程按 PROGRESS_TICK 轮询计数器流式回调 copying 进度。
    run_stage_polled(
        shared.clone(),
        WorkerStage::Copy,
        |s| {
            on_progress(prog(
                s.bytes_done.load(Ordering::Relaxed),
                bytes_total,
                s.files_done.load(Ordering::Relaxed),
                files_total,
                MovePhase::Copying,
            ))
        },
    );
    if let Some(fail) = take_failure(&shared, cancel) {
        rollback(&shared, on_progress, &prog);
        return Err(fail);
    }
    let copied_len = shared.copied.lock().unwrap().len() as u64;
    on_progress(prog(bytes_total, bytes_total, copied_len, files_total, MovePhase::Verifying));

    // 3) 阶段 B：逐文件读回目标 SHA-256 比对（校验通过才允许删源）。
    run_stage_polled(
        shared.clone(),
        WorkerStage::Verify,
        |s| {
            on_progress(prog(
                bytes_total,
                bytes_total,
                s.files_done.load(Ordering::Relaxed),
                files_total,
                MovePhase::Verifying,
            ))
        },
    );
    if let Some(fail) = take_failure(&shared, cancel) {
        rollback(&shared, on_progress, &prog);
        return Err(fail);
    }

    // 4) 删源（全部校验通过之后）。
    on_progress(prog(bytes_total, bytes_total, files_total, files_total, MovePhase::Deleting));
    if let Err(e) = delete_sources(src, &src_files, &src_dirs) {
        // 目标已全部校验通过（数据无损）；删源中断是半完成态：目标有效、
        // 部分源残留。报错保留现场，不做破坏性反向操作。
        return Err(ItemFailure::Io(e));
    }
    on_progress(prog(bytes_total, bytes_total, files_total, files_total, MovePhase::Done));
    Ok(())
}

struct Shared {
    tasks: Mutex<VecDeque<Task>>,
    /// (目标路径, 源侧哈希)——校验与回滚的花名册。
    copied: Mutex<Vec<(PathBuf, [u8; 32])>>,
    /// 已开写但尚未入花名册的目标（半截文件回滚清单）。
    inflight: Mutex<Vec<PathBuf>>,
    verify_cursor: AtomicUsize,
    bytes_done: AtomicU64,
    files_done: AtomicU64,
    created_dirs: Mutex<Vec<PathBuf>>,
    failure: Mutex<Option<ItemFailure>>,
    /// 取消/失败后置位，让在跑 worker 尽快退出。
    stop: AtomicBool,
}

struct Task {
    src: PathBuf,
    dst: PathBuf,
    size: u64,
}

#[derive(Clone, Copy, PartialEq)]
enum WorkerStage {
    Copy,
    Verify,
}

/// 起 N 个 worker 并在编排线程轮询进度回调，直至全部退出（join 收尾）。
fn run_stage_polled(shared: Arc<Shared>, stage: WorkerStage, mut emit: impl FnMut(&Shared)) {
    let mut handles = Vec::with_capacity(DEFAULT_WORKERS);
    for _ in 0..DEFAULT_WORKERS {
        let sh = shared.clone();
        handles.push(std::thread::spawn(move || worker_loop(&sh, stage)));
    }
    while handles.iter().any(|h| !h.is_finished()) {
        std::thread::sleep(PROGRESS_TICK);
        emit(&shared);
    }
    for h in handles {
        let _ = h.join();
    }
    emit(&shared);
}

fn worker_loop(shared: &Shared, stage: WorkerStage) {
    loop {
        if shared.stop.load(Ordering::Relaxed) {
            return;
        }
        let result = match stage {
            WorkerStage::Copy => {
                let task = shared.tasks.lock().unwrap().pop_front();
                let Some(Task { src, dst, size }) = task else { return };
                // 开写前登记在途目标：半截文件也要能被回滚清掉。
                shared.inflight.lock().unwrap().push(dst.clone());
                match copy_file_hashed(&src, &dst, &shared.stop) {
                    Ok(hash) => {
                        shared.copied.lock().unwrap().push((dst, hash));
                        shared.bytes_done.fetch_add(size, Ordering::Relaxed);
                        shared.files_done.fetch_add(1, Ordering::Relaxed);
                        Ok(())
                    }
                    // 错误带源文件路径：失败原因要能点名是哪个文件。
                    // 在途登记保留——半截目标文件由 rollback 清除。
                    Err(e) => Err(std::io::Error::new(
                        e.kind(),
                        format!("复制 {} 失败: {e}", src.display()),
                    )),
                }
            }
            WorkerStage::Verify => {
                // 按游标读，不清花名册（回滚要用）。
                let i = shared.verify_cursor.fetch_add(1, Ordering::Relaxed);
                let item = shared.copied.lock().unwrap().get(i).cloned();
                let Some((dst, want)) = item else { return };
                match hash_file(&dst, &shared.stop) {
                    Ok(got) if got == want => {
                        shared.files_done.fetch_add(1, Ordering::Relaxed);
                        Ok(())
                    }
                    Ok(_) => Err(std::io::Error::new(
                        std::io::ErrorKind::InvalidData,
                        format!("SHA-256 校验不一致：{}", dst.display()),
                    )),
                    Err(e) => Err(std::io::Error::new(
                        e.kind(),
                        format!("校验 {} 失败: {e}", dst.display()),
                    )),
                }
            }
        };
        if let Err(e) = result {
            let mut f = shared.failure.lock().unwrap();
            if f.is_none() {
                *f = Some(ItemFailure::Io(anyhow!("{e}")));
            }
            shared.stop.store(true, Ordering::Relaxed);
        }
    }
}

/// 收取失败/取消。None = 本阶段干净完成。
fn take_failure(shared: &Shared, cancel: Option<&Arc<AtomicBool>>) -> Option<ItemFailure> {
    let fail = shared.failure.lock().unwrap().take();
    if fail.is_some() {
        return fail;
    }
    if cancelled(cancel) {
        shared.stop.store(true, Ordering::Relaxed);
        return Some(ItemFailure::Cancelled);
    }
    None
}

/// 回滚：删除花名册上的已复制目标文件 + 建过的目录（自深而浅、只删空壳），
/// 源零触碰。
fn rollback(
    shared: &Shared,
    on_progress: &mut dyn FnMut(MoveProgress),
    prog: &dyn Fn(u64, u64, u64, u64, MovePhase) -> MoveProgress,
) {
    let copied: Vec<(PathBuf, [u8; 32])> = std::mem::take(&mut *shared.copied.lock().unwrap());
    let inflight: Vec<PathBuf> = std::mem::take(&mut *shared.inflight.lock().unwrap());
    let mut dirs: Vec<PathBuf> = std::mem::take(&mut *shared.created_dirs.lock().unwrap());
    dirs.sort_by_key(|d| std::cmp::Reverse(d.as_os_str().len()));
    on_progress(prog(0, 0, 0, 0, MovePhase::RolledBack));
    for (target, _) in &copied {
        let _ = std::fs::remove_file(target);
    }
    // 在途（半截）目标同样清除——它们不在 copied 花名册里。
    for target in &inflight {
        let _ = std::fs::remove_file(target);
    }
    for d in &dirs {
        let _ = std::fs::remove_dir(d); // 非空壳（意外有用户数据）保留
    }
}

/// 删源（复制与校验全部通过后）：按任务清单删文件，再自深而浅删空目录，
/// 顶层最后。文件删除失败立即报错（目标侧数据完好，现场保留）。
fn delete_sources(src: &Path, files: &[PathBuf], dirs: &[PathBuf]) -> anyhow::Result<()> {
    for f in files {
        std::fs::remove_file(f).map_err(|e| anyhow!("删除源文件 {}: {e}", f.display()))?;
    }
    let mut dirs: Vec<PathBuf> = dirs.to_vec();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.as_os_str().len()));
    for d in &dirs {
        let _ = std::fs::remove_dir(d); // 非空（残留锁定文件）保留
    }
    let _ = std::fs::remove_dir(src);
    Ok(())
}

fn cancelled(cancel: Option<&Arc<AtomicBool>>) -> bool {
    cancel.map(|c| c.load(Ordering::Relaxed)).unwrap_or(false)
}

/// 建目录并记录新建项（回滚时只删自己建的空壳，绝不碰已存在的目录）。
fn create_dir_recorded(dir: &Path, created: &mut Vec<PathBuf>) -> std::io::Result<()> {
    if dir.symlink_metadata().is_ok() {
        return Ok(());
    }
    if let Some(parent) = dir.parent() {
        create_dir_recorded(parent, created)?;
    }
    std::fs::create_dir(dir)?;
    created.push(dir.to_path_buf());
    Ok(())
}

/// 复制文件并计算源侧 SHA-256（单趟读、64KB 分块、分块检查取消）。
fn copy_file_hashed(src: &Path, dst: &Path, stop: &AtomicBool) -> std::io::Result<[u8; 32]> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut reader = std::fs::File::open(src)?;
    let mut writer = BufWriter::new(std::fs::File::create(dst)?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                format!("复制已中止：{}", src.display()),
            ));
        }
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        writer.write_all(&buf[..n])?;
    }
    writer.flush()?;
    // 落盘再校验：不 sync 的话校验可能读到缓存里的好数据而磁盘上是坏的。
    writer.get_ref().sync_all()?;
    Ok(hasher.finalize().into())
}

/// 读回文件计算 SHA-256（分块检查取消）。
fn hash_file(path: &Path, stop: &AtomicBool) -> std::io::Result<[u8; 32]> {
    let mut f = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                format!("校验已中止：{}", path.display()),
            ));
        }
        let n = f.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_root(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "disksift-move-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn no_progress(_: MoveProgress) {}

    /// CONTRACT：phase 枚举的 serde 字符串逐字冻结。
    #[test]
    fn phase_serde_names_are_frozen_contract() {
        assert_eq!(
            serde_json::to_value(MovePhase::Copying).unwrap(),
            "copying"
        );
        assert_eq!(serde_json::to_value(MovePhase::Verifying).unwrap(), "verifying");
        assert_eq!(serde_json::to_value(MovePhase::Deleting).unwrap(), "deleting");
        assert_eq!(serde_json::to_value(MovePhase::Done).unwrap(), "done");
        assert_eq!(
            serde_json::to_value(MovePhase::RolledBack).unwrap(),
            "rolled_back"
        );
        // 载荷字段名冻结。
        let p = serde_json::to_value(MoveProgress {
            src: "a".into(),
            dst: "b".into(),
            bytes_done: 1,
            bytes_total: 2,
            files_done: 3,
            files_total: 4,
            phase: MovePhase::Copying,
        })
        .unwrap();
        for k in ["src", "dst", "bytes_done", "bytes_total", "files_done", "files_total", "phase"]
        {
            assert!(p.as_object().unwrap().contains_key(k), "缺契约字段 {k}");
        }
    }

    #[test]
    fn same_volume_matrix() {
        assert!(same_volume(Path::new(r"C:\a"), Path::new(r"C:\b")));
        assert!(same_volume(Path::new(r"c:\a"), Path::new(r"C:\b")));
        assert!(!same_volume(Path::new(r"C:\a"), Path::new(r"D:\b")));
        // 非盘符形态按跨卷（保守走复制管线）。
        assert!(!same_volume(Path::new(r"\\srv\share\x"), Path::new(r"\\srv\share\y")));
        assert!(!same_volume(Path::new(r"relative"), Path::new(r"relative2")));
    }

    #[test]
    fn move_paths_same_volume_rename_instant() {
        let root = temp_root("same-vol");
        let src_dir = root.join("src");
        let dest = root.join("dest");
        fs::create_dir_all(src_dir.join("nested")).unwrap();
        fs::write(src_dir.join("nested\\a.bin"), vec![7u8; 1000]).unwrap();
        fs::write(src_dir.join("top.txt"), b"hello").unwrap();
        fs::create_dir_all(&dest).unwrap();

        let undo = root.join("undo.jsonl");
        let mut events: Vec<MoveProgress> = Vec::new();
        let srcs = vec![src_dir.clone()];
        let outcome = move_paths(
            &srcs,
            &dest,
            "test-migrate",
            false,
            &undo,
            None,
            &mut |p| events.push(p),
        )
        .unwrap();

        assert!(outcome.entries.len() == 1);
        assert!(!outcome.cancelled && !outcome.rolled_back && outcome.error.is_none());
        let e = &outcome.entries[0];
        assert!(matches!(e.action, crate::Action::Migrate));
        assert_eq!(e.source, src_dir);
        assert_eq!(e.destination.as_deref(), Some(dest.join("src").as_path()));
        // rename 语义：源没了，目标在，内容不变。
        assert!(!src_dir.exists());
        assert_eq!(fs::read(dest.join("src\\nested\\a.bin")).unwrap(), vec![7u8; 1000]);
        assert_eq!(fs::read(dest.join("src\\top.txt")).unwrap(), b"hello");
        // 进度：同卷一次 Done 事件，载荷数字齐全。
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].phase, MovePhase::Done);
        assert_eq!(events[0].files_done, 1);
        assert_eq!(events[0].bytes_done, 1005);
        // undo.jsonl 落了 migrate 行（双向 src/dst 可回迁）。
        let line = fs::read_to_string(&undo).unwrap();
        assert!(line.contains("\"migrate\""), "undo 行应是 migrate：{line}");
        assert!(line.contains("src"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cross_volume_pipeline_copies_verifies_and_deletes_source() {
        let root = temp_root("cross");
        let src_dir = root.join("srcdir");
        let dest_root = root.join("dest");
        fs::create_dir_all(src_dir.join("sub")).unwrap();
        let payload_a: Vec<u8> = (0..=255u8).cycle().take(200_000).collect();
        fs::write(src_dir.join("sub\\a.bin"), &payload_a).unwrap();
        fs::write(src_dir.join("b.txt"), b"world").unwrap();
        fs::create_dir_all(&dest_root).unwrap();

        // 强制走跨盘管线：src 与 dst 同在 C: 盘，直接调 move_one_cross_volume。
        let dst = dest_root.join("srcdir");
        let mut phases: Vec<MovePhase> = Vec::new();
        let mut last: Option<MoveProgress> = None;
        move_one_cross_volume(&src_dir, &dst, &pinkbin_excludes::Excludes::empty(), None, &mut |p| {
            if last.as_ref().map(|l| l.phase) != Some(p.phase) {
                phases.push(p.phase);
            }
            last = Some(p);
        })
        .expect("跨盘管线应成功");

        assert!(!src_dir.exists(), "校验通过后源目录应删除");
        assert_eq!(fs::read(dst.join("sub\\a.bin")).unwrap(), payload_a);
        assert_eq!(fs::read(dst.join("b.txt")).unwrap(), b"world");
        // 阶段序列覆盖 CONTRACT 全部正向 phase。
        assert_eq!(
            phases,
            vec![MovePhase::Copying, MovePhase::Verifying, MovePhase::Deleting, MovePhase::Done]
        );
        let last_p = last.unwrap();
        assert_eq!(last_p.bytes_done, last_p.bytes_total);
        assert_eq!(last_p.files_done, last_p.files_total);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cross_volume_failure_rolls_back_and_never_deletes_source() {
        let root = temp_root("rollback");
        let src_dir = root.join("srcdir");
        let dest_root = root.join("dest");
        fs::create_dir_all(&src_dir).unwrap();
        fs::write(src_dir.join("f1.bin"), vec![1u8; 50_000]).unwrap();
        fs::write(src_dir.join("f2.bin"), vec![2u8; 50_000]).unwrap();
        fs::write(src_dir.join("f3.bin"), vec![3u8; 50_000]).unwrap();
        fs::create_dir_all(&dest_root).unwrap();

        // 锁住 f2（独占、零共享）：worker 打开它必然 sharing violation。
        // 锁在块内持有，断言读内容前释放（本测试自己也会被零共享挡住）。
        let dst = dest_root.join("srcdir");
        {
            use std::os::windows::fs::OpenOptionsExt;
            let _lock = std::fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(src_dir.join("f2.bin"))
                .expect("锁文件句柄");

            let err = move_one_cross_volume(
                &src_dir,
                &dst,
                &pinkbin_excludes::Excludes::empty(),
                None,
                &mut no_progress,
            )
            .expect_err("锁定的文件必须让管线失败");
            let msg = format!("{err}");
            assert!(msg.contains("f2"), "失败原因应点名锁定文件：{msg}");

            // 绝不删源：三个源文件全部原地存在（内容断言在锁释放后做）。
            assert!(src_dir.exists());
            assert!(src_dir.join("f1.bin").exists());
            assert!(src_dir.join("f2.bin").exists());
            assert!(src_dir.join("f3.bin").exists());
            // 回滚：已复制的目标全部清除，目录骨架不残留。
            assert!(!dst.exists(), "回滚后目标目录不应残留（f1 已复制必须被清除）");
        }
        assert_eq!(fs::read(src_dir.join("f1.bin")).unwrap(), vec![1u8; 50_000]);
        assert_eq!(fs::read(src_dir.join("f2.bin")).unwrap(), vec![2u8; 50_000]);
        assert_eq!(fs::read(src_dir.join("f3.bin")).unwrap(), vec![3u8; 50_000]);
        let _ = fs::remove_dir_all(&root);
    }

    fn excl_path_rule(value: &str) -> pinkbin_excludes::Excludes {
        pinkbin_excludes::Excludes::from_config(&pinkbin_excludes::ExcludesConfig {
            rules: vec![pinkbin_excludes::ExcludeRule {
                id: "t".into(),
                kind: pinkbin_excludes::RuleKind::Path,
                value: value.into(),
                enabled: true,
            }],
        })
    }

    /// 探 bug 防回归（排除四处生效一致性·迁移面）：flatten 阶段命中排除
    /// 规则的子树整枝不迁——不复制、不建骨架、不进删源清单，被排除内容
    /// 必须原样留在源侧父目录里（与扫描面整树剪枝同语义）。
    #[test]
    fn cross_volume_pipeline_skips_excluded_subtree() {
        let root = temp_root("nested-excl");
        let src_dir = root.join("srcdir");
        let dest_root = root.join("dest");
        fs::create_dir_all(src_dir.join("keep")).unwrap();
        fs::create_dir_all(src_dir.join("cache")).unwrap();
        fs::write(src_dir.join("keep\\a.txt"), b"a").unwrap();
        fs::write(src_dir.join("cache\\b.tmp"), vec![9u8; 100]).unwrap();
        fs::create_dir_all(&dest_root).unwrap();

        let cache_abs = src_dir.join("cache");
        let dst = dest_root.join("srcdir");
        move_one_cross_volume(&src_dir, &dst, &excl_path_rule(&cache_abs.to_string_lossy()), None, &mut no_progress)
            .expect("含排除子树的迁移应成功");

        // 迁移面：keep 走了，cache 不在目标侧。
        assert_eq!(fs::read(dst.join("keep\\a.txt")).unwrap(), b"a");
        assert!(!dst.join("cache").exists(), "被排除子树不得出现在目标侧");
        // 源侧：被排除内容原样保留（绝不删源覆盖到排除子树）。
        assert!(src_dir.exists(), "源父目录含保留内容，壳不得删除");
        assert_eq!(fs::read(src_dir.join("cache\\b.tmp")).unwrap(), vec![9u8; 100]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn cancel_mid_copy_rolls_back_and_keeps_source() {
        let root = temp_root("cancel");
        let src_dir = root.join("srcdir");
        let dest_root = root.join("dest");
        fs::create_dir_all(&src_dir).unwrap();
        // 多个大文件保证 Copy 阶段持续足够久，取消能在中途命中。
        for i in 0..8 {
            fs::write(src_dir.join(format!("f{i}.bin")), vec![i as u8; 2_000_000]).unwrap();
        }
        fs::create_dir_all(&dest_root).unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let cancel2 = cancel.clone();
        // 第一份复制完成（files_done>=1）即取消。
        let seen = Arc::new(AtomicU64::new(0));
        let seen2 = seen.clone();
        let dst = dest_root.join("srcdir");
        let dst_for_cb = dst.clone();
        let result = move_one_cross_volume(
            &src_dir,
            &dst,
            &pinkbin_excludes::Excludes::empty(),
            Some(&cancel),
            &mut move |p| {
            if p.phase == MovePhase::Copying
                && p.files_done >= 1
                && seen2.fetch_add(1, Ordering::Relaxed) == 0
            {
                let _ = &dst_for_cb;
                cancel2.store(true, Ordering::Relaxed);
            }
        });
        match result {
            Err(ItemFailure::Cancelled) => {}
            other => panic!("取消必须以 Cancelled 收场：{other:?}"),
        }
        // 绝不删源：全部源文件原地完好。
        assert!(src_dir.exists());
        for i in 0..8 {
            assert!(
                src_dir.join(format!("f{i}.bin")).exists(),
                "f{i}.bin 必须未被删除"
            );
        }
        // 回滚：目标不残留。
        assert!(!dst.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn move_paths_dry_run_previews_without_touching_fs() {
        let root = temp_root("dry");
        let src = root.join("data");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.txt"), b"x").unwrap();
        let dest = root.join("dest");
        let undo = root.join("undo.jsonl");

        let srcs = vec![src.clone()];
        let outcome = move_paths(
            &srcs,
            &dest,
            "preview",
            true,
            &undo,
            None,
            &mut no_progress,
        )
        .unwrap();
        assert_eq!(outcome.entries.len(), 1);
        assert!(outcome.entries[0].reason.starts_with(crate::DRY_RUN_REASON_PREFIX));
        assert_eq!(
            outcome.entries[0].destination.as_deref(),
            Some(dest.join("data").as_path())
        );
        // 预览不动盘：源仍在、undo 未写。
        assert!(src.exists());
        assert!(!undo.exists());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn move_paths_dest_exists_fails_without_overwrite() {
        let root = temp_root("overwrite");
        let src = root.join("data");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.txt"), b"new").unwrap();
        let dest = root.join("dest");
        fs::create_dir_all(dest.join("data")).unwrap();
        fs::write(dest.join("data\\a.txt"), b"precious").unwrap();

        let srcs = vec![src.clone()];
        let outcome = move_paths(
            &srcs,
            &dest,
            "test",
            false,
            &root.join("undo.jsonl"),
            None,
            &mut no_progress,
        )
        .unwrap();
        assert!(outcome.error.as_deref().unwrap().contains("拒绝覆盖"));
        assert!(outcome.entries.is_empty(), "失败项不得进台账");
        // 双方原样。
        assert_eq!(fs::read(src.join("a.txt")).unwrap(), b"new");
        assert_eq!(fs::read(dest.join("data\\a.txt")).unwrap(), b"precious");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn move_paths_never_touch_rejected() {
        let root = temp_root("nt");
        let outcome = move_paths(
            &[PathBuf::from(r"C:\Windows\Temp")],
            &root.join("d"),
            "test",
            false,
            &root.join("undo.jsonl"),
            None,
            &mut no_progress,
        );
        let err = format!("{}", outcome.expect_err("NEVER_TOUCH 必须整单拦截"));
        assert!(err.contains("NEVER_TOUCH"));
    }
}
