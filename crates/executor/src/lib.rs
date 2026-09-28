//! Performs cleanup actions safely. Recycle (default), quarantine, or permanent delete.
//! Every performed action is appended to `undo.jsonl`. Dry-run previews are
//! computed and returned to the caller but never logged — a preview is not an
//! operation, and logging it would pollute the ledger the records view reads.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub mod move_engine;
pub use move_engine::{
    move_one_cross_volume, move_paths, same_volume, ItemFailure, MoveOutcome, MovePhase,
    MoveProgress, DEFAULT_WORKERS,
};

use std::sync::atomic::AtomicBool;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Recycle,
    Quarantine,
    Delete,
    /// v26.1.4.0 菜2：迁移（MoveEngine）。undo.jsonl 双向记录
    /// source=原路径 / destination=新路径，回迁 = 反向再迁一次。
    /// 不走 execute()——迁移走 move_engine::move_paths（migrate_paths
    /// 命令面）；execute() 收到该 action 显式拒绝。
    Migrate,
}

/// Reason prefix attached to dry-run preview entries. Exported so ledger
/// readers (e.g. src-tauri `list_undo`) can filter out preview entries that
/// older versions appended to `undo.jsonl` before dry-run stopped logging.
pub const DRY_RUN_REASON_PREFIX: &str = "dry-run: ";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub action: Action,
    pub paths: Vec<PathBuf>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoEntry {
    pub timestamp: String,
    pub action: Action,
    pub source: PathBuf,
    pub destination: Option<PathBuf>,
    pub reason: String,
    /// 受影响字节数（目录 = 递归文件合计，符号链接/联接不计入目标内容）。
    /// serde default 兼容 26.1.0 之前无此字段的 undo.jsonl 历史行（反序列化为 None）。
    #[serde(default)]
    pub bytes: Option<u64>,
}

/// NEVER_TOUCH 系统保护区段表（v26.1.2 高危修复 · Rust 兜底层）。
/// 段边界匹配：path 与保护名都按 `\` / `/` 切段后做 ASCII 不区分大小写的
/// 整段比较——`C:\Windows` 命中 `windows`；`C:\WindowsExcl`（段
/// `windowsexcl`）不误命中；带空格段（`program files (x86)`）整段比较不受
/// 分隔符差异影响。与前端 apps/desktop/src/triage.ts 的 isNeverTouch 同规则，
/// 构成双层防线：前端层只影响判定/队列，本层在 execute() 里拒绝执行。
/// 自 auto_patrol.rs 的同名单提升而来（补 recovery / windows.old，
/// 原表缺失 C:\Recovery 曾被巡查放行）。documents 等用户内容段一并在此，
/// 保护语义只收紧不放松。
pub const NEVER_TOUCH_SEGMENTS: &[&str] = &[
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "$recycle.bin",
    "system volume information",
    "$extend",
    "boot",
    "recovery",
    "windows.old",
    "documents",
    "pictures",
    "music",
    "videos",
    "desktop",
    "downloads",
];

/// path 是否命中 NEVER_TOUCH 保护区（任一路径段整段等于保护名）。
pub fn is_never_touch(path: &str) -> bool {
    path.to_ascii_lowercase()
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .any(|seg| NEVER_TOUCH_SEGMENTS.contains(&seg))
}

/// 递归统计路径字节数。文件 = len；目录 = 逐项累加，符号链接/联接跳过
/// （既不进入也不计大小——联接指向的字节不属于本次操作）。
pub(crate) fn path_bytes(p: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(p) else {
        return 0;
    };
    if meta.is_symlink() {
        return 0;
    }
    if meta.is_file() {
        return meta.len();
    }
    let mut total = 0u64;
    let Ok(rd) = std::fs::read_dir(p) else {
        return 0;
    };
    for e in rd.flatten() {
        let Ok(m) = e.metadata() else { continue };
        if m.is_symlink() {
            continue;
        }
        if m.is_dir() {
            total += path_bytes(&e.path());
        } else {
            total += m.len();
        }
    }
    total
}

/// 保留原签名：无取消令牌的 execute（既有调用方：src-tauri execute_plan /
/// execute_scope / auto_patrol / 本文件测试——零改动，补全式纪律）。
pub fn execute(
    plan: &Plan,
    dry_run: bool,
    undo_log: &Path,
    quarantine_root: &Path,
) -> anyhow::Result<Vec<UndoEntry>> {
    execute_with_cancel(plan, dry_run, undo_log, quarantine_root, None)
}

/// NEVER_TOUCH 整单拦截（v26.1.2 高危修复语义，原样抽出复用）。
/// 整单 fail-closed 拒绝（不做部分执行）；Err 逐条列出命中路径。
pub(crate) fn reject_never_touch(paths: &[PathBuf]) -> anyhow::Result<()> {
    let hits: Vec<String> = paths
        .iter()
        .filter(|p| is_never_touch(&p.to_string_lossy()))
        .map(|p| format!("{}（命中系统保护区）", p.to_string_lossy()))
        .collect();
    if !hits.is_empty() {
        anyhow::bail!(
            "拒绝执行：计划包含 NEVER_TOUCH 系统保护路径（Windows/ProgramData/用户文档/Recovery 等），整单拦截：{}",
            hits.join("；")
        );
    }
    Ok(())
}

/// 探 bug 修复（排除四处生效一致性）：把「子树内命中排除规则」的顶层目录
/// 展开成**最大不含排除内容的子树**集合——被排除子树整枝保留（连同其所在
/// 的未命中内容一起按最大单元动作），顶层目录本身不再被整体删除，父目录壳
/// 保留。返回 None = 子树内无排除命中（保持整目录动作，零回归）。
///
/// 单趟 walkdir（filter_entry 在排除子树处整枝剪断，被剪内容根本不进集合），
/// 收集后做祖先去重得到最大单元；symlink/联接条目沿用既有纪律不进动作面。
fn expand_dir_respecting_excludes(
    dir: &Path,
    excludes: &pinkbin_excludes::Excludes,
) -> Option<Vec<PathBuf>> {
    let mut kept: Vec<PathBuf> = Vec::new();
    let mut had_excluded = false;
    let iter = walkdir::WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true; // 父目录自身放行（不被当成排除对象）
            }
            let hit = excludes.matches(e.path());
            if hit {
                had_excluded = true;
            }
            !hit // 命中：整枝剪断（不进集合、不下钻）
        });
    for entry in iter {
        let Ok(entry) = entry else { continue };
        if entry.depth() == 0 {
            continue;
        }
        if entry.file_type().is_symlink() {
            continue; // 联接/符号链接不进动作面（与 quarantine 纪律一致）
        }
        kept.push(entry.path().to_path_buf());
    }
    if !had_excluded {
        return None;
    }
    // 祖先去重 → 最大不含排除内容的子树（浅者在先，深者被覆盖）。
    kept.sort_by_key(|p| p.as_os_str().len());
    let mut result: Vec<PathBuf> = Vec::new();
    for p in kept {
        if result.iter().any(|k| p.starts_with(k)) {
            continue;
        }
        result.push(p);
    }
    Some(result)
}

/// 执行面排除的嵌套一致化：对每个顶层目录，若其子树内确有排除命中，则用
/// [`expand_dir_respecting_excludes`] 的展开集合替代整目录；文件与无命中的
/// 目录原样保留。规则集为空时零开销直通（零回归保障）。
fn expand_respecting_excludes(
    paths: &[PathBuf],
    excludes: &pinkbin_excludes::Excludes,
) -> Vec<PathBuf> {
    if excludes.is_empty() {
        return paths.to_vec();
    }
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        if excludes.matches(p) {
            continue; // 顶层命中：剔除（既有语义）
        }
        if p.is_dir() {
            match expand_dir_respecting_excludes(p, excludes) {
                Some(children) => {
                    tracing::info!(
                        "execute: {} 子树内含排除内容，展开为 {} 个动作单元（被排除子树保留）",
                        p.display(),
                        children.len()
                    );
                    out.extend(children);
                }
                None => out.push(p.clone()),
            }
        } else {
            out.push(p.clone());
        }
    }
    out
}

/// 带取消令牌 + 用户排除规则复核的执行面（v26.1.4.0 菜3/菜4 接线点）。
///
/// 顺序锁死（测试 move_cancel_exclude_layering）：
/// 1. NEVER_TOUCH 整单拦截——26.1.3.1 语义逐字不变，用户规则永远排在它
///    后面，因此**用户排除不可能解除系统保护**（叠加只会收紧）；
/// 2. 用户排除规则过滤——命中 `excludes.json` 的路径从计划剔除（收紧
///    可清面），剔除后为空则空手而回（不是错误）；
/// 3. Quarantine 的跨盘兜底走 MoveEngine（菜单 6：并行复制 + SHA-256
///    校验 + 校验通过删源 + 失败回滚），取消令牌透传。
pub fn execute_with_cancel(
    plan: &Plan,
    dry_run: bool,
    undo_log: &Path,
    quarantine_root: &Path,
    cancel: Option<&Arc<AtomicBool>>,
) -> anyhow::Result<Vec<UndoEntry>> {
    execute_checked(
        plan,
        dry_run,
        undo_log,
        quarantine_root,
        cancel,
        &pinkbin_excludes::Excludes::load_default(),
    )
}

/// 同 execute_with_cancel，但排除规则集由调用方注入（测试与未来缓存面用；
/// 传入 Excludes::empty() 即等价于无用户规则）。
pub fn execute_checked(
    plan: &Plan,
    dry_run: bool,
    undo_log: &Path,
    quarantine_root: &Path,
    cancel: Option<&Arc<AtomicBool>>,
    excludes: &pinkbin_excludes::Excludes,
) -> anyhow::Result<Vec<UndoEntry>> {
    if let Action::Migrate = plan.action {
        anyhow::bail!("migrate 不走 execute：请使用 move_engine::move_paths（migrate_paths 命令面）");
    }
    // 1) NEVER_TOUCH（先于用户排除：保护语义不受用户规则影响）。
    reject_never_touch(&plan.paths)?;

    // 2) 用户排除规则收紧可清面：顶层命中的剔除；顶层目录子树内命中的
    //    展开成最大不含排除内容的子树集合（被排除嵌套内容不参与动作，
    //    独立探 bug 修复——原先只过滤顶层，Delete/迁移父目录会连带清掉
    //    用户看不见的被排除子目录）。
    let paths: Vec<PathBuf> = if excludes.is_empty() {
        plan.paths.clone()
    } else {
        let kept: Vec<PathBuf> = plan
            .paths
            .iter()
            .filter(|p| !excludes.matches(p))
            .cloned()
            .collect();
        let dropped = plan.paths.len() - kept.len();
        if dropped > 0 {
            tracing::info!(
                "execute: {dropped} 条路径命中用户排除规则，已从计划剔除（收紧不放松）"
            );
        }
        expand_respecting_excludes(&kept, excludes)
    };

    let mut out: Vec<UndoEntry> = Vec::new();
    let now = || chrono::Utc::now().to_rfc3339();

    // 复核修补：dry-run 是预览，不是操作——只构造返回值供调用方展示，
    // 绝不 append 进 undo.jsonl。旧行为把预览条目混进操作台账，记录视图
    // 会把它们当真实操作渲染（recycle 预览条目甚至渲染「打开回收站」按钮）。
    // reason 仍带 DRY_RUN_REASON_PREFIX，供 list_undo 过滤存量文件里
    // 旧版本写入的预览条目。
    if dry_run {
        for p in &paths {
            out.push(UndoEntry {
                timestamp: now(),
                action: plan.action,
                source: p.clone(),
                destination: None,
                reason: format!("{DRY_RUN_REASON_PREFIX}{}", plan.reason),
                bytes: Some(path_bytes(p)),
            });
        }
        return Ok(out);
    }

    if paths.is_empty() {
        // 排除规则吃掉了整个计划：空手而回（不是错误）。
        return Ok(out);
    }

    // 体积在动作前取样（删除/隔离之后路径已不存在，无从统计）。
    let sizes: Vec<u64> = paths.iter().map(|p| path_bytes(p)).collect();

    match plan.action {
        Action::Recycle => {
            trash::delete_all(&paths)?;
            for (p, bytes) in paths.iter().zip(&sizes) {
                out.push(UndoEntry {
                    timestamp: now(),
                    action: Action::Recycle,
                    source: p.clone(),
                    destination: None,
                    reason: plan.reason.clone(),
                    bytes: Some(*bytes),
                });
            }
        }
        Action::Quarantine => {
            std::fs::create_dir_all(quarantine_root)?;
            for (src, bytes) in paths.iter().zip(&sizes) {
                let stamp = chrono::Utc::now().timestamp_millis();
                let leaf = src
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "item".into());
                let dst = quarantine_root.join(format!("{stamp}-{leaf}"));
                if let Err(e) = std::fs::rename(src, &dst) {
                    // 跨盘（或被锁导致 rename 失败）：改走 MoveEngine
                    // （菜单 6）——并行复制 + SHA-256 校验 + 校验通过删源 +
                    // 失败回滚已复制目标，绝不删源。取消令牌透传。
                    tracing::warn!(
                        "rename failed ({}); falling back to MoveEngine cross-volume pipeline",
                        e
                    );
                    move_engine::move_one_cross_volume(src, &dst, excludes, cancel, &mut |_| {})
                        .map_err(|f| match f {
                            move_engine::ItemFailure::Cancelled => {
                                anyhow::anyhow!("隔离被取消：{}", src.display())
                            }
                            move_engine::ItemFailure::Io(e) => {
                                anyhow::anyhow!("隔离跨盘复制失败（{}）：{e}", src.display())
                            }
                        })?;
                }
                out.push(UndoEntry {
                    timestamp: now(),
                    action: Action::Quarantine,
                    source: src.clone(),
                    destination: Some(dst),
                    reason: plan.reason.clone(),
                    bytes: Some(*bytes),
                });
            }
        }
        Action::Delete => {
            for (p, bytes) in paths.iter().zip(&sizes) {
                if p.is_dir() {
                    std::fs::remove_dir_all(p)?;
                } else if p.exists() {
                    std::fs::remove_file(p)?;
                }
                out.push(UndoEntry {
                    timestamp: now(),
                    action: Action::Delete,
                    source: p.clone(),
                    destination: None,
                    reason: plan.reason.clone(),
                    bytes: Some(*bytes),
                });
            }
        }
        Action::Migrate => unreachable!("已在函数头显式拒绝"),
    }

    write_log(undo_log, &out)?;
    Ok(out)
}

pub(crate) fn write_log(undo_log: &Path, entries: &[UndoEntry]) -> anyhow::Result<()> {
    if let Some(parent) = undo_log.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(undo_log)?;
    for e in entries {
        writeln!(f, "{}", serde_json::to_string(e)?)?;
    }
    Ok(())
}

/// v26.1.4.0 菜6 后 quarantine 跨盘兜底改走 MoveEngine（move_engine.rs），
/// 本函数已无调用点。按补全式纪律保留本体（不删既有能力），供潜在回滚/
/// 工具复用；死代码豁免以保留为前提。
#[allow(dead_code)]
fn copy_then_remove(src: &Path, dst: &Path) -> std::io::Result<()> {
    // 复核修补：顶层 src 是联接/符号链接时拒绝复制整棵目标树。
    // Path::is_dir() 会跟随链接，junction 报 true——走 copy_dir_recursive 会把
    // 联接指向的真实数据整树复制进隔离区（体积不可控）。与 copy_dir_recursive
    // 内部跳过 symlink 项的纪律一致，顶层这一层也必须拦住。rename 本身不跟随
    // 链接（移动的是联接本体），所以这层拒绝只影响 rename 失败后的跨盘兜底
    // 路径；此处报错会让整个 quarantine 动作失败、联接原地保留——宁可失败，
    // 不可把联接目标复制走。
    if std::fs::symlink_metadata(src)?.file_type().is_symlink() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!(
                "refusing to copy a reparse point tree into quarantine: {}",
                src.display()
            ),
        ));
    }
    if src.is_dir() {
        copy_dir_recursive(src, dst)?;
        std::fs::remove_dir_all(src)?;
    } else {
        std::fs::copy(src, dst)?;
        std::fs::remove_file(src)?;
    }
    Ok(())
}

/// v26.1.4.0 菜6 后唯一调用方 copy_then_remove 已被 MoveEngine 取代，
/// 本函数已无调用点。按补全式纪律保留本体（不删既有能力）。
#[allow(dead_code)]
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        // Quarantine 的跨盘兜底复制跳过 symlink 项（既不复制、也不进入）：
        // - 进入符号链接目录（junction / 目录符号链接，readdir file_type 均
        //   报 is_symlink()=true，rustc 1.97.1 实测）会把联接指向的真实数据
        //   整树复制进隔离区（体积不可控），目标若指回祖先还会无限递归；
        // - 把符号链接文件当普通文件 std::fs::copy，复制到的是目标内容，破坏
        //   “原样保留、可恢复”的隔离语义。
        // 判断必须用 read_dir 的 file_type（不跟随链接）；Path::is_dir() 会
        // 跟随链接，不能用它分流。
        let file_type = entry.file_type()?;
        if file_type.is_symlink() {
            continue;
        }
        let p = entry.path();
        let d = dst.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_recursive(&p, &d)?;
        } else {
            std::fs::copy(&p, &d)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "disksift-executor-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn recycle_records_bytes_and_legacy_rows_backcompat() {
        let root = temp_dir("recycle");
        let sub = root.join("data");
        std::fs::create_dir_all(&sub).unwrap();
        // fixture 写失败要让测试立刻响：静默丢 Result 会让字节断言给出误导性失败。
        std::fs::write(sub.join("a.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(sub.join("b.bin"), vec![0u8; 27]).unwrap();
        let lone = root.join("lone.txt");
        std::fs::write(&lone, vec![0u8; 11]).unwrap();

        let undo = root.join("undo.jsonl");
        let plan = Plan {
            action: Action::Recycle,
            paths: vec![sub.clone(), lone.clone()],
            reason: "test".into(),
        };
        let entries = execute(&plan, false, &undo, &root.join("q")).unwrap();

        // 目录 = 递归合计（100+27）；文件 = len
        assert_eq!(entries[0].bytes, Some(127));
        assert_eq!(entries[1].bytes, Some(11));

        // serde 兼容：无 bytes 字段的历史行反序列化为 None
        let legacy = r#"{"timestamp":"t","action":"recycle","source":"C:/x","destination":null,"reason":"old"}"#;
        let old: UndoEntry = serde_json::from_str(legacy).unwrap();
        assert_eq!(old.bytes, None);

        // jsonl 里的新行带 bytes 字段
        let line = std::fs::read_to_string(&undo).unwrap();
        assert!(line.contains("\"bytes\":127") || line.contains("\"bytes\": 127"));

        let _ = std::fs::remove_dir_all(&root);
    }

    // ── v26.1.2 高危修复：NEVER_TOUCH 双层防线 · Rust 兜底层用例 ──

    #[test]
    fn never_touch_segment_boundary() {
        // 根级路径（无尾分隔符）必须命中——旧版 is_never_touch 无此问题，
        // 但前端旧片段表有；此处锁死共享表语义。
        assert!(is_never_touch(r"C:\Windows"));
        assert!(is_never_touch(r"C:\ProgramData"));
        assert!(is_never_touch(r"C:\Users\demo-user\Documents"));
        assert!(is_never_touch(r"C:\Recovery"));
        assert!(is_never_touch(r"C:\Windows.old"));
        assert!(is_never_touch(r"C:\Windows\Temp"));
        assert!(is_never_touch(r"C:\Program Files (x86)\X"));
        assert!(is_never_touch("C:/Users/u/Documents/archive"));
        // 段边界：前缀相像但整段不同的目录不误命中
        assert!(!is_never_touch(r"C:\WindowsExcl"));
        assert!(!is_never_touch(r"C:\ProgramDataExcl"));
        assert!(!is_never_touch(r"C:\tools\windows-cleaner\cache"));
        assert!(!is_never_touch("C:/cache/reboot-helper"));
        assert!(!is_never_touch(r"D:\DocumentsOld\stuff"));
    }

    #[test]
    fn execute_rejects_never_touch_plan_wholesale() {
        // 混入受保护路径 → 整单拒绝（连 safe 路径也不执行），Err 带命中路径
        // 与保护语义说明，用户可见。
        let plan = Plan {
            action: Action::Recycle,
            paths: vec![
                PathBuf::from(r"C:\Windows"),
                PathBuf::from(r"C:\safe-cache"),
            ],
            reason: "test".into(),
        };
        let err = execute(
            &plan,
            true,
            Path::new("unused.jsonl"),
            Path::new("unused-q"),
        )
        .expect_err("never-touch plan must be refused");
        let msg = format!("{err}");
        assert!(msg.contains(r"C:\Windows"), "错误需点名命中路径：{msg}");
        assert!(msg.contains("NEVER_TOUCH"), "错误需说明保护语义：{msg}");
        // Quarantine / Delete 同样被拒（全动作覆盖）
        for action in [Action::Quarantine, Action::Delete] {
            let plan = Plan {
                action,
                paths: vec![PathBuf::from(r"C:\Windows")],
                reason: "test".into(),
            };
            assert!(
                execute(
                    &plan,
                    false,
                    Path::new("unused.jsonl"),
                    Path::new("unused-q")
                )
                .is_err(),
                "{action:?} 也必须被拒"
            );
        }
    }

    #[test]
    fn execute_allows_clean_plan() {
        let plan = Plan {
            action: Action::Recycle,
            paths: vec![PathBuf::from(r"C:\safe-cache")],
            reason: "test".into(),
        };
        let out = execute(
            &plan,
            true,
            Path::new("unused.jsonl"),
            Path::new("unused-q")
        )
        .unwrap();
        assert_eq!(out.len(), 1);
    }

    // ── v26.1.4.0 菜4：用户排除规则 × NEVER_TOUCH 叠加语义 ──

    use pinkbin_excludes::{ExcludeRule, Excludes, ExcludesConfig, RuleKind};

    fn one_rule(kind: RuleKind, value: &str) -> Excludes {
        Excludes::from_config(&ExcludesConfig {
            rules: vec![ExcludeRule {
                id: "t".into(),
                kind,
                value: value.into(),
                enabled: true,
            }],
        })
    }

    #[test]
    fn user_excludes_only_tighten_cleanup_plan() {
        // 真实文件系统小验证：排除规则命中的路径被从计划剔除，其余照常
        // Recycle 执行（收紧可清面，不放松、不报错）。
        let root = temp_dir("user-excl");
        let keep_me = root.join("keep-me");
        let drop_me = root.join("drop-me");
        std::fs::create_dir_all(&keep_me).unwrap();
        std::fs::create_dir_all(&drop_me).unwrap();
        std::fs::write(keep_me.join("a.txt"), b"x").unwrap();
        std::fs::write(drop_me.join("b.txt"), b"x").unwrap();

        let plan = Plan {
            action: Action::Recycle,
            paths: vec![keep_me.clone(), drop_me.clone()],
            reason: "test".into(),
        };
        let out = execute_checked(
            &plan,
            false,
            &root.join("undo.jsonl"),
            &root.join("q"),
            None,
            &one_rule(RuleKind::Path, &drop_me.to_string_lossy()),
        )
        .unwrap();

        assert_eq!(out.len(), 1, "只有未命中的路径被执行");
        assert_eq!(out[0].source, keep_me);
        assert!(!keep_me.exists(), "未命中路径已进回收站（正常执行）");
        assert!(drop_me.exists(), "被排除路径不参与清扫（用户规则收紧可清面）");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn user_excludes_cannot_lift_never_touch_protection() {
        // 叠加顺序锁死：NEVER_TOUCH 整单拦截先于用户排除过滤——即使计划里
        // 的其余路径全部被用户规则排除，含 NEVER_TOUCH 路径仍整单拒绝。
        let excl = one_rule(RuleKind::Path, r"C:\safe-cache");
        let plan = Plan {
            action: Action::Recycle,
            paths: vec![
                PathBuf::from(r"C:\Windows\Temp"),
                PathBuf::from(r"C:\safe-cache"),
            ],
            reason: "test".into(),
        };
        let err = execute_checked(
            &plan,
            false,
            Path::new("unused.jsonl"),
            Path::new("unused-q"),
            None,
            &excl,
        )
        .expect_err("NEVER_TOUCH 必须先于用户排除拦截整单");
        assert!(format!("{err}").contains("NEVER_TOUCH"));
    }

    // ── 探 bug 防回归：排除规则的嵌套一致性（执行面）──

    #[test]
    fn execute_delete_respects_excluded_nested_content() {
        // 对可见父目录执行 Delete 时，其内部命中规则的子目录不参与动作：
        // 其余内容照常清、被排除子树连文件原样保留、父目录壳保留。
        let root = temp_dir("nested-del");
        let parent = root.join("data");
        let keep = parent.join("keep");
        let cache = parent.join("cache");
        fs::create_dir_all(&keep).unwrap();
        fs::create_dir_all(&cache).unwrap();
        fs::write(keep.join("f.txt"), b"k").unwrap();
        fs::write(cache.join("x.tmp"), vec![7u8; 50]).unwrap();

        let plan = Plan {
            action: Action::Delete,
            paths: vec![parent.clone()],
            reason: "test".into(),
        };
        let out = execute_checked(
            &plan,
            false,
            &root.join("undo.jsonl"),
            &root.join("q"),
            None,
            &one_rule(RuleKind::Path, &cache.to_string_lossy()),
        )
        .unwrap();

        assert!(!keep.exists(), "未命中内容照常清除");
        assert!(
            cache.exists() && fs::read(cache.join("x.tmp")).unwrap() == vec![7u8; 50],
            "被排除子树必须原样保留（旧缺陷：父目录整体删除连带清掉）"
        );
        assert!(parent.exists(), "父目录壳保留（内含被排除内容）");
        assert_eq!(out.len(), 1, "台账对应展开后的动作单元（keep 子树）");

        // 对照组（零回归）：空规则集下 Delete 父目录仍是整体删除。
        let plan2 = Plan {
            action: Action::Delete,
            paths: vec![parent.clone()],
            reason: "test".into(),
        };
        execute_checked(
            &plan2,
            false,
            &root.join("undo.jsonl"),
            &root.join("q"),
            None,
            &Excludes::empty(),
        )
        .unwrap();
        assert!(!parent.exists(), "空规则集行为与既有语义一致：整目录删除");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn execute_dry_run_previews_expanded_units() {
        // dry-run 预览与真实执行同一展开：条目指向展开后的动作单元，
        // 不再是含排除内容的整父目录。
        let root = temp_dir("nested-dry");
        let parent = root.join("data");
        let keep = parent.join("keep");
        let cache = parent.join("cache");
        fs::create_dir_all(&keep).unwrap();
        fs::create_dir_all(&cache).unwrap();

        let plan = Plan {
            action: Action::Recycle,
            paths: vec![parent.clone()],
            reason: "test".into(),
        };
        let out = execute_checked(
            &plan,
            true,
            Path::new("unused.jsonl"),
            Path::new("unused-q"),
            None,
            &one_rule(RuleKind::Path, &cache.to_string_lossy()),
        )
        .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source, keep, "预览单元 = 最大不含排除内容的子树");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn all_paths_excluded_yields_empty_ok() {
        // 排除规则吃掉整个计划：空手而回（Ok 空台账），不报错、不写 undo、
        // 被排除路径原样保留。
        let root = temp_dir("all-excl");
        let a = root.join("a");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join("x.txt"), b"x").unwrap();
        let plan = Plan {
            action: Action::Recycle,
            paths: vec![a.clone()],
            reason: "test".into(),
        };
        let undo = root.join("undo.jsonl");
        let out = execute_checked(
            &plan,
            false,
            &undo,
            &root.join("q"),
            None,
            &one_rule(RuleKind::Path, &a.to_string_lossy()),
        )
        .unwrap();
        assert!(out.is_empty());
        assert!(a.exists(), "被排除路径不应被触碰");
        assert!(!undo.exists(), "空结果不写 undo");
        let _ = std::fs::remove_dir_all(&root);
    }
}
