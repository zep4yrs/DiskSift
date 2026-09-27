//! Cross-platform disk scanner. Returns a tree of directories with size/file_count.
//!
//! v0.1.1: parallel walk via jwalk (rayon under the hood) + per-leaf file
//! children + progress callback. v0.2 will swap in direct NTFS MFT read on
//! Windows for sub-3s C: drive scans.

use jwalk::WalkDir as JWalk;
use serde::{Deserialize, Serialize};
use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

/// 系统级"垃圾/卷元数据"目录名（lowercase）。scanner 扫盘时整树跳过。
/// 不只是性能：让回收站进 Node tree 会被前端 fallback 的 name_contains
/// 当成"伪 app 数据 root"——用户曾把 xwechat_files 删进回收站后，
/// `C:\$Recycle.Bin\<SID>\$R*\xwechat_files` 会被识别为活的 WeChat 数据
/// 触发误删。System Volume Information 同时还能避开 VSS 权限拒绝噪音。
const PRUNED_SYSTEM_DIRS: &[&str] = &[
    "$recycle.bin",
    "system volume information",
    ".trash",
    ".trashes",
];

fn is_pruned_system_dir(name: &std::ffi::OsStr) -> bool {
    let Some(s) = name.to_str() else { return false };
    let lower = s.to_ascii_lowercase();
    PRUNED_SYSTEM_DIRS.iter().any(|p| *p == lower)
}

#[cfg(windows)]
mod mft;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub file_count: u64,
    pub children: Vec<Node>,
    #[serde(default)]
    pub scaffold_id: Option<String>,
    #[serde(default)]
    pub top_extensions: Vec<ExtShare>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtShare {
    pub ext: String,
    pub bytes: u64,
    pub count: u64,
}

#[derive(Debug, Default)]
struct DirAcc {
    size: u64,
    file_count: u64,
    ext_bytes: HashMap<String, u64>,
    ext_count: HashMap<String, u64>,
    // plan §2.2 / 必修#3（含复核修正）：每目录只留前 keep_files_per_dir
    // 大的文件。Reverse 把 BinaryHeap 变成最小堆——堆顶是保留集里最小的
    // 那个，消费循环里实时裁剪（超限先弹堆顶）；第二字段 Reverse(seq) 是
    // 消费到达序，并列大小时驱逐最晚到的，使保留集与排序同旧实现
    // （全量 Vec + 稳定排序 + take(k)）逐项等价。原先 Vec 全量保留、到
    // build_tree 才裁剪，npm/WinSxS 级平铺目录几万个 (String, u64) 常驻
    // 内存，是 16G 轻薄本进 swap 的主因。
    files: BinaryHeap<Reverse<(u64, Reverse<u64>, String)>>,
}

pub struct ScanOptions {
    /// jwalk `follow_links` 透传。语义说明（复核标注，pub API 语义变化）：
    /// 开启也会被安全剪枝压制——`process_read_dir` 对所有
    /// `file_type.is_symlink()` 条目无条件剪除（BlueTidy 纪律，plan §2.4），
    /// 而 jwalk 的下钻集合正是从过滤后的 children 派生的
    /// （jwalk-0.8.1 core/read_dir.rs:22-28），所以无论 true/false 都不会
    /// 进入联接/符号链接目录，该字段当前实际等于恒 false。保留字段仅为
    /// API 兼容；扫描根自身是链接时仍会被扫描（根不经过 process_read_dir），
    /// 两种取值行为一致。
    pub follow_symlinks: bool,
    pub max_depth: Option<usize>,
    /// How many files to keep per directory in the returned tree. None = all (memory hog on large dirs).
    pub keep_files_per_dir: Option<usize>,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            follow_symlinks: false,
            max_depth: None,
            keep_files_per_dir: Some(500),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct ScanProgress {
    pub files_seen: u64,
    pub bytes_seen: u64,
    pub current_path: String,
}

/// Phase-level timings for a scan. Diagnostic only — emit via the Tauri command
/// alongside the tree so the UI / packaged binary can show "where the time went"
/// without needing RUST_LOG=info.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScanStats {
    pub mode: String, // "mft" | "walkdir"
    pub mft_attempted: bool,
    pub mft_succeeded: bool,
    pub mft_ms: u64,  // total time spent in the MFT branch (success or fallback)
    pub walk_ms: u64, // jwalk consume loop (only set in walkdir mode)
    pub build_tree_ms: u64, // build_tree recursion (consumes walk-collected dir edges; no 2nd IO pass)
    pub total_ms: u64,
    pub files_seen: u64,
    pub bytes_seen: u64,
    pub dirs_in_acc: u64, // accs.len() — proxy for memory pressure (walkdir mode only)
}

pub fn scan<P: AsRef<Path>>(root: P) -> anyhow::Result<Node> {
    scan_with(root, ScanOptions::default(), |_| {})
}

pub fn scan_with<P, F>(root: P, opts: ScanOptions, on_progress: F) -> anyhow::Result<Node>
where
    P: AsRef<Path>,
    F: Fn(&ScanProgress) + Send + Sync,
{
    scan_with_stats(root, opts, on_progress).map(|(n, _)| n)
}

/// Same as `scan_with`, but also returns phase-level timings. Internal API for
/// the desktop app's diagnostics bar — keeps `scan` / `scan_with` unchanged.
pub fn scan_with_stats<P, F>(
    root: P,
    opts: ScanOptions,
    on_progress: F,
) -> anyhow::Result<(Node, ScanStats)>
where
    P: AsRef<Path>,
    F: Fn(&ScanProgress) + Send + Sync,
{
    let root = root.as_ref().to_path_buf();
    let total_t0 = Instant::now();
    let mut stats = ScanStats::default();
    tracing::info!("scan: start root={:?}", root);

    // Try the MFT fast path on Windows when the root is on an NTFS volume.
    #[cfg(windows)]
    {
        if let Some(letter) = drive_letter_of(&root) {
            // #26 MFT 兼容修复：进快路径前先问操作系统卷类型。ntfs crate 的
            // BootSector/bpb 解析对非 NTFS 卷会 binrw 意外错误（用户实测
            // os error 87）乃至 unreachable panic——catch_unwind 只能事后兜底
            // 降级（功能不丢但性能卖点整卷失效），这道预检让 ReFS/exFAT/
            // BitLocker 卷零成本直达 walkdir。
            let mft_allowed = match mft::volume_fs_check(letter) {
                VolumeFsDecision::Ntfs | VolumeFsDecision::Unknown => true,
                VolumeFsDecision::OtherFs(name) => {
                    tracing::info!(
                        "scan: 卷 {letter}: 文件系统为 {name}（非 NTFS），跳过 MFT 直接 walkdir"
                    );
                    false
                }
                VolumeFsDecision::BitLockerLocked => {
                    tracing::warn!(
                        "scan: 卷 {letter}: 疑似 BitLocker 加锁（DEVICE LOCKER / ACCESS_DENIED），跳过 MFT 直接 walkdir；解锁该卷后重扫可恢复 MFT 快路径"
                    );
                    false
                }
            };
            // 预检否决时不设 mft_attempted，直接落到底下的 walkdir 段——
            // 诊断面板自然显示走了慢路径。
            if mft_allowed {
                let subroot = if is_drive_root(&root) {
                    None
                } else {
                    Some(root.as_path())
                };
                let progress = &on_progress;
                stats.mft_attempted = true;
                let mft_t0 = Instant::now();
                // The `ntfs` crate can panic on non-NTFS volumes (e.g. CI runners,
                // ReFS, removable media) instead of returning an Err. Catch it so
                // we always fall back to walkdir cleanly. AssertUnwindSafe is OK
                // because we don't observe partial state on panic.
                let mft_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    mft::scan_volume(letter, subroot, |records, bytes| {
                        progress(&ScanProgress {
                            files_seen: records,
                            bytes_seen: bytes,
                            current_path: format!("MFT record {}", records),
                        });
                    })
                }))
                .unwrap_or_else(|_| {
                    Err(anyhow::anyhow!(
                        "MFT scan panicked (likely non-NTFS volume)"
                    ))
                });
                match mft_result {
                    Ok(n) => {
                        stats.mft_ms = mft_t0.elapsed().as_millis() as u64;
                        stats.mft_succeeded = true;
                        stats.mode = "mft".into();
                        stats.files_seen = n.file_count;
                        stats.bytes_seen = n.size;
                        stats.total_ms = total_t0.elapsed().as_millis() as u64;
                        tracing::info!(
                            "scan: mode=mft mft_ms={} total_ms={} files={} bytes={}",
                            stats.mft_ms,
                            stats.total_ms,
                            stats.files_seen,
                            stats.bytes_seen,
                        );
                        progress(&ScanProgress {
                            files_seen: n.file_count,
                            bytes_seen: n.size,
                            current_path: "done (mft)".into(),
                        });
                        return Ok((n, stats));
                    }
                    Err(e) => {
                        stats.mft_ms = mft_t0.elapsed().as_millis() as u64;
                        tracing::warn!(
                            "MFT scan failed after {} ms, falling back to walkdir: {e:#}",
                            stats.mft_ms
                        );
                    }
                }
            }
        }
    }

    stats.mode = "walkdir".into();
    let files_seen = Arc::new(AtomicU64::new(0));
    let bytes_seen = Arc::new(AtomicU64::new(0));
    let last_emit = Arc::new(AtomicU64::new(0));

    // Phase 1: parallel walk, collect (path, size) pairs for every file.
    let mut walker = JWalk::new(&root)
        .skip_hidden(false)
        .follow_links(opts.follow_symlinks)
        .parallelism(jwalk::Parallelism::RayonDefaultPool {
            busy_timeout: std::time::Duration::from_secs(5),
        })
        .process_read_dir(|_, _, _, children| {
            children.retain(|res| {
                let Ok(entry) = res else { return true };
                // BlueTidy 纪律（plan §2.4）：junction/symlink 目录项一律剪掉
                // ——清理类 glob（literal_separator=false 的 **）穿过目录联接
                // 会把联接目标当成待删内容。这道检查必须放在 is_dir 之前：
                // 不同 std 版本对 reparse 点的 is_dir() 语义不一致（本机
                // stable 实测 junction 报 is_dir=false，老版本报 true），只有
                // is_symlink() 是版本无关的判据。剪在 process_read_dir 里能
                // 同时拦住下钻：jwalk 的 read_children_specs 只从过滤后的
                // results_list 派生（jwalk-0.8.1 core/read_dir.rs:22-28），
                // 被剪目录既不会被 yield 也不会被 read_dir。
                if entry.file_type.is_symlink() {
                    return false;
                }
                if !entry.file_type.is_dir() {
                    return true;
                }
                !is_pruned_system_dir(&entry.file_name)
            });
        });
    if let Some(d) = opts.max_depth {
        walker = walker.max_depth(d);
    }

    let mut accs: HashMap<PathBuf, DirAcc> = HashMap::new();
    // plan §2.3 / 必修#2：子目录关系在这趟 jwalk 里顺带收集，build_tree
    // 直接吃内存结构——原先扫完后再对全树串行 read_dir，等于 QLC/机械盘
    // 上把盘扫两遍，且发生在进度条停更之后，是用户眼里最直观的"卡死"。
    // 被剪枝的目录（系统垃圾目录、junction/symlink）从未被 yield，天然
    // 不会在这里复活；is_dir() 在现版 std 上只对真目录为 true（reparse
    // 点不算），所以这里记录的就是真实的目录树边。
    let mut child_dirs: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    let walk_t0 = Instant::now();

    for entry in walker.into_iter().flatten() {
        if entry.file_type().is_dir() {
            // 根条目（depth 0）不记：它的 parent_path 在扫描根之外，记了
            // 也只是一条不会被查询的垃圾边；真边全部来自根内部的目录项。
            if entry.depth > 0 {
                child_dirs
                    .entry(entry.parent_path().to_path_buf())
                    .or_default()
                    .push(entry.path());
            }
            continue;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_else(|| "(none)".into());
        let file_name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();

        // files_seen 的自增序 = 消费循环到达序，兼作 top-K 的并列裁决序
        //（与旧实现 Vec 的到达序一致）；顺带作为进度节流的计数。
        let total_files = files_seen.fetch_add(1, Ordering::Relaxed) + 1;
        bytes_seen.fetch_add(size, Ordering::Relaxed);

        // attribute to immediate parent (with files list) and walk upward (totals only)
        if let Some(parent) = path.parent() {
            let acc = accs.entry(parent.to_path_buf()).or_default();
            // plan §2.2 / 必修#3 + 复核修正：top-K 实时裁剪。堆未满
            // （len < k）时必须无条件入堆——旧实现全量保留后 sort+take(k)，
            // 未满时任何文件都可能进前 K；若未满就按"比堆顶大"设门槛，
            // 到达序里先来的一个大文件会把它之后所有更小文件永久丢掉
            // （arrivals=[100, 70×10002]、k=500 只剩 1 个，旧实现 500 个）。
            // 堆满后才驱逐：新文件严格大于堆顶（保留集里最小的）才弹堆顶。
            // 并列大小时驱逐最晚到的（Reverse(seq)），先到的留下——与旧
            // 实现稳定排序 + take(k) 的边界并列行为逐项一致。
            match opts.keep_files_per_dir {
                None => acc
                    .files
                    .push(Reverse((size, Reverse(total_files), file_name))),
                Some(0) => {}
                Some(k) => {
                    if acc.files.len() < k {
                        acc.files
                            .push(Reverse((size, Reverse(total_files), file_name)));
                    } else if let Some(&Reverse((min_size, _, _))) = acc.files.peek() {
                        if size > min_size {
                            acc.files.pop();
                            acc.files
                                .push(Reverse((size, Reverse(total_files), file_name)));
                        }
                    }
                }
            }
        }
        let mut cur = path.parent();
        while let Some(dir) = cur {
            let acc = accs.entry(dir.to_path_buf()).or_default();
            acc.size += size;
            acc.file_count += 1;
            *acc.ext_bytes.entry(ext.clone()).or_insert(0) += size;
            *acc.ext_count.entry(ext.clone()).or_insert(0) += 1;
            if dir == root || !dir.starts_with(&root) {
                break;
            }
            cur = dir.parent();
        }

        // Throttle progress to ~every 5k files to avoid IPC saturation.
        if total_files.wrapping_sub(last_emit.load(Ordering::Relaxed)) >= 5000 {
            last_emit.store(total_files, Ordering::Relaxed);
            on_progress(&ScanProgress {
                files_seen: total_files,
                bytes_seen: bytes_seen.load(Ordering::Relaxed),
                current_path: path.to_string_lossy().to_string(),
            });
        }
    }

    stats.walk_ms = walk_t0.elapsed().as_millis() as u64;
    stats.files_seen = files_seen.load(Ordering::Relaxed);
    stats.bytes_seen = bytes_seen.load(Ordering::Relaxed);
    stats.dirs_in_acc = accs.len() as u64;
    tracing::info!(
        "scan: walk done walk_ms={} files={} bytes={} dirs_in_acc={}",
        stats.walk_ms,
        stats.files_seen,
        stats.bytes_seen,
        stats.dirs_in_acc,
    );

    on_progress(&ScanProgress {
        files_seen: stats.files_seen,
        bytes_seen: stats.bytes_seen,
        current_path: "done".into(),
    });

    let build_t0 = Instant::now();
    let tree = build_tree(&root, &accs, &child_dirs);
    stats.build_tree_ms = build_t0.elapsed().as_millis() as u64;
    stats.total_ms = total_t0.elapsed().as_millis() as u64;
    tracing::info!(
        "scan: mode=walkdir walk_ms={} build_tree_ms={} total_ms={} dirs_in_acc={}",
        stats.walk_ms,
        stats.build_tree_ms,
        stats.total_ms,
        stats.dirs_in_acc,
    );
    Ok((tree, stats))
}

fn build_tree(
    dir: &Path,
    accs: &HashMap<PathBuf, DirAcc>,
    child_dirs: &HashMap<PathBuf, Vec<PathBuf>>,
) -> Node {
    let acc = accs.get(dir);
    let size = acc.map(|a| a.size).unwrap_or(0);
    let file_count = acc.map(|a| a.file_count).unwrap_or(0);
    let top_extensions = acc
        .map(|a| {
            let mut v: Vec<_> = a
                .ext_bytes
                .iter()
                .map(|(k, &b)| ExtShare {
                    ext: k.clone(),
                    bytes: b,
                    count: a.ext_count.get(k).copied().unwrap_or(0),
                })
                .collect();
            v.sort_by_key(|e| std::cmp::Reverse(e.bytes));
            v.truncate(8);
            v
        })
        .unwrap_or_default();

    let name = dir
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| dir.to_string_lossy().to_string());

    let mut children: Vec<Node> = Vec::new();

    // Subdirectories — plan 必修#2（§2.3）：不再 read_dir 第二趟全盘 IO，
    // 直接吃消费循环里收集的 child_dirs。语义等价性：
    // - 系统垃圾目录 / junction 剪枝已在 process_read_dir 生效，被剪目录
    //   从未被 yield，也就从未进入 child_dirs——不会在这里复活；
    // - 空目录（无文件、accs.get 落空）也会作为 dir entry 被 yield 并记录，
    //   照常成 0 字节节点，与旧行为一致；
    // - 大小降序展示由下方 children.sort 统一保证，与旧实现相同。
    if let Some(kids) = child_dirs.get(dir) {
        for child in kids {
            children.push(build_tree(child, accs, child_dirs));
        }
    }

    // Files — 堆内就是本目录的 top-K（消费循环已实时裁剪，default 500），
    // 这里直接消费。into_sorted_vec() 按元素 Ord 升序 = Reverse 的 Ord
    // 升序 = 内层 (size, Reverse(seq), name) 降序 = size 降序、并列按
    // 到达序升序——与旧实现 sort_by_key(Reverse(size)) 稳定排序的输出
    // 顺序一致。
    if let Some(a) = acc {
        let files = a.files.clone().into_sorted_vec();
        for Reverse((fsize, _, fname)) in files {
            let fpath = dir.join(&fname);
            children.push(Node {
                name: fname,
                path: fpath.to_string_lossy().to_string(),
                is_dir: false,
                size: fsize,
                file_count: 1,
                children: Vec::new(),
                scaffold_id: None,
                top_extensions: Vec::new(),
            });
        }
    }

    children.sort_by_key(|c| std::cmp::Reverse(c.size));

    Node {
        name,
        path: dir.to_string_lossy().to_string(),
        is_dir: true,
        size,
        file_count,
        children,
        scaffold_id: None,
        top_extensions,
    }
}

#[cfg(windows)]
fn drive_letter_of(p: &Path) -> Option<char> {
    let s = p.to_string_lossy();
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        let c = bytes[0] as char;
        if c.is_ascii_alphabetic() {
            return Some(c);
        }
    }
    None
}

#[cfg(windows)]
fn is_drive_root(p: &Path) -> bool {
    let s = p.to_string_lossy();
    matches!(s.as_ref(), "C:" | "D:" | "E:" | "F:" | "G:" | "H:")
        || (s.len() == 3
            && s.as_bytes()[1] == b':'
            && (s.as_bytes()[2] == b'\\' || s.as_bytes()[2] == b'/'))
}

/// MFT 快路径的卷类型预检决策（#26 MFT 兼容修复）。数据来自
/// GetVolumeInformationW（文件系统名字符串 / 查询错误码，Win32 取数在
/// mft::volume_fs_check）；判定本身是纯函数，CI 模拟不了非 NTFS 物理卷，
/// 单元测试用 mock 字符串输入锁死决策矩阵。
#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum VolumeFsDecision {
    /// 文件系统名明确为 NTFS → 放行 MFT 快路径。
    Ntfs,
    /// BitLocker 未解锁卷：FS 名报 "DEVICE LOCKER"（过滤驱动名，不是真文件
    /// 系统），或查询直接撞 ACCESS_DENIED。ntfs crate 解不了锁着的卷。
    BitLockerLocked,
    /// 其它文件系统（ReFS / exFAT / FAT32 / CDFS…），携带原始名供日志。
    OtherFs(String),
    /// 无法判定（查询因无关原因失败、名字为空）→ 仍放行 MFT，catch_unwind
    /// 兜底；不因信息缺失阉割快路径。
    Unknown,
}

/// 纯决策：GetVolumeInformationW 的输出 → 是否走 MFT。与 Win32 取数分离
/// 才能脱离物理卷做单元测试。
#[cfg(windows)]
pub(crate) fn volume_fs_decision(
    fs_name: Option<&str>,
    query_error: Option<u32>,
) -> VolumeFsDecision {
    // ERROR_ACCESS_DENIED（windows_sys::Win32::Foundation）。值是 ABI 稳定的
    // Win32 错误码，硬编码让纯函数免引 windows-sys，可在任意平台单测。
    const ERROR_ACCESS_DENIED: u32 = 5;
    if query_error == Some(ERROR_ACCESS_DENIED) {
        // 锁着的 BitLocker 卷连文件系统名都问不出来，只回一个拒绝。
        return VolumeFsDecision::BitLockerLocked;
    }
    match fs_name {
        None => VolumeFsDecision::Unknown,
        Some(name) => {
            let trimmed = name.trim();
            if trimmed.eq_ignore_ascii_case("DEVICE LOCKER") {
                VolumeFsDecision::BitLockerLocked
            } else if trimmed.eq_ignore_ascii_case("NTFS") {
                VolumeFsDecision::Ntfs
            } else if trimmed.is_empty() {
                VolumeFsDecision::Unknown
            } else {
                VolumeFsDecision::OtherFs(trimmed.to_string())
            }
        }
    }
}

/// Pull up to `n` sample paths from a directory, ordered shallowest-first.
pub fn sample_paths<P: AsRef<Path>>(root: P, n: usize) -> Vec<String> {
    let root = root.as_ref();
    walkdir::WalkDir::new(root)
        .max_depth(3)
        .into_iter()
        .filter_entry(|e| !e.file_type().is_dir() || !is_pruned_system_dir(e.file_name()))
        .filter_map(|e| e.ok())
        // BlueTidy 纪律（plan §2.4）：junction/symlink 条目绝不作为采样
        // 路径流出。walkdir 2.5.0 本身不会下钻（handle_entry 的
        // is_normal_dir = !is_symlink && is_dir），但联接条目本身仍会被
        // yield，这里从结果流里再拦一道。
        .filter(|e| !e.file_type().is_symlink())
        .filter(|e| e.file_type().is_file())
        .take(n)
        .map(|e| e.path().to_string_lossy().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn scans_temp_dir() {
        let dir = tempdir_path();
        fs::create_dir_all(dir.join("a/b")).unwrap();
        fs::write(dir.join("a/file1.txt"), b"hello").unwrap();
        fs::write(dir.join("a/b/file2.txt"), b"world!").unwrap();

        let node = scan(&dir).unwrap();
        assert_eq!(node.size, 11);
        assert_eq!(node.file_count, 2);
        // file leaves should appear as children of their directory
        let a = node.children.iter().find(|c| c.name == "a").unwrap();
        assert!(a
            .children
            .iter()
            .any(|c| !c.is_dir && c.name == "file1.txt"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn scan_prunes_system_trash_dirs() {
        let dir = tempdir_path();
        fs::create_dir_all(dir.join("normal")).unwrap();
        fs::write(dir.join("normal/keep.txt"), b"x").unwrap();
        for trashy in &[
            "$RECYCLE.BIN",
            "System Volume Information",
            ".Trash",
            ".Trashes",
        ] {
            let d = dir.join(trashy);
            fs::create_dir_all(&d).unwrap();
            fs::write(d.join("inside.txt"), b"x").unwrap();
        }

        let node = scan(&dir).unwrap();

        let names: Vec<String> = node.children.iter().map(|c| c.name.clone()).collect();
        assert!(names.contains(&"normal".to_string()), "got: {names:?}");
        for trashy in &[
            "$RECYCLE.BIN",
            "System Volume Information",
            ".Trash",
            ".Trashes",
        ] {
            assert!(
                !names.iter().any(|n| n.eq_ignore_ascii_case(trashy)),
                "scanner leaked `{trashy}` into Node tree, names: {names:?}"
            );
        }
        assert_eq!(node.file_count, 1, "only `normal/keep.txt` should count");
        let _ = fs::remove_dir_all(&dir);
    }

    // BlueTidy 纪律（plan §2.4）：junction/symlink 目录绝不能被进入——
    // 清理类 glob（literal_separator=false 的 **）穿过目录联接会把联接
    // 目标当成待删内容。用 \\?\ verbatim 前缀绕开 MFT 快路径：本测试只
    // 针对 walker 链路（process_read_dir 剪枝 + build_tree 复用第一趟
    // 数据）；MFT 模式按 parent FRN 建树是另一条链路，不在本测试范围。
    #[cfg(windows)]
    #[test]
    fn scan_does_not_enter_junctions() {
        let dir = tempdir_path();
        let real = dir.join("real");
        fs::create_dir_all(&real).unwrap();
        fs::write(real.join("inside.txt"), b"payload").unwrap();

        let link = dir.join("link");
        let status = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(&link)
            .arg(&real)
            .status()
            .expect("spawn cmd for mklink /J");
        assert!(status.success(), "mklink /J failed: {status}");

        let verbatim_root = PathBuf::from(format!(r"\\?\{}", dir.display()));
        let node = scan(&verbatim_root).unwrap();

        let mut paths: Vec<String> = Vec::new();
        collect_paths(&node, &mut paths);
        let leaked: Vec<&String> = paths
            .iter()
            .filter(|p| {
                let lower = p.to_ascii_lowercase();
                lower.contains("\\link\\") || lower.ends_with("\\link")
            })
            .collect();
        assert!(
            leaked.is_empty(),
            "junction `link` leaked into the scan tree: {leaked:?}"
        );
        assert_eq!(
            node.file_count, 1,
            "junction content must not be counted a second time"
        );
        let real_node = node
            .children
            .iter()
            .find(|c| c.name == "real")
            .expect("`real` subdir missing from tree root");
        assert!(
            real_node
                .children
                .iter()
                .any(|c| !c.is_dir && c.name == "inside.txt"),
            "junction target content must appear exactly once, via its real path"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn collect_paths(node: &Node, out: &mut Vec<String>) {
        out.push(node.path.clone());
        for c in &node.children {
            collect_paths(c, out);
        }
    }

    // plan §2.2 / 必修#3（含复核修正）回归：锁死「len<k 无条件入堆」语义。
    // 复核员复现 case：同目录到达序 [100, 70×10002]、k=500。曾因"未满也按
    // 比堆顶大设门槛"，先到的 100 成为永久门槛，其后所有 70 被永久丢弃——
    // 堆里只剩 1 项；正确行为是未满即无条件入堆，最终保留恰好 500 项。
    // 到达序由 jwalk 并行消费决定、不可控，但本 case 与到达序无关：修复版
    // 无论顺序如何都恰好保留 500 项（100 要么未满时入堆、要么满堆后 >堆顶
    // 驱逐一个 70），而门槛 bug 版任何顺序下都只剩 1 项。
    #[test]
    fn topk_regression_len_lt_k_admits_all_arrivals() {
        let dir = tempdir_path();
        let bulk = dir.join("bulk");
        fs::create_dir_all(&bulk).unwrap();
        for i in 0..10002 {
            fs::write(bulk.join(format!("f{i}.bin")), vec![0u8; 70]).unwrap();
        }
        fs::write(bulk.join("big.txt"), vec![0u8; 100]).unwrap();

        let small = dir.join("small");
        fs::create_dir_all(&small).unwrap();
        fs::write(small.join("a.txt"), vec![0u8; 100]).unwrap();
        fs::write(small.join("b.txt"), vec![0u8; 50]).unwrap();
        fs::write(small.join("c.txt"), vec![0u8; 60]).unwrap();

        // 与 scan_does_not_enter_junctions 相同的 \\?\ verbatim 手法绕开 MFT
        // 快路径：top-K 堆只存在于 walker 链路，MFT 链路的 breadth cap 会把
        // 断言带偏。
        let scan_root = if cfg!(windows) {
            PathBuf::from(format!(r"\\?\{}", dir.display()))
        } else {
            dir.clone()
        };
        let node = scan(&scan_root).unwrap();

        let bulk_node = node
            .children
            .iter()
            .find(|c| c.is_dir && c.name == "bulk")
            .expect("bulk dir missing from tree root");
        let kept = bulk_node.children.iter().filter(|c| !c.is_dir).count();
        assert_eq!(
            kept, 500,
            "len<k 必须无条件入堆：[100, 70×10002] 在 k=500 下必须保留恰好 500 项（门槛 bug 只剩 1 项）"
        );
        // top-K 只裁展示不裁统计。
        assert_eq!(bulk_node.file_count, 10003);
        assert_eq!(bulk_node.size, 100 + 10002 * 70);

        let small_node = node
            .children
            .iter()
            .find(|c| c.is_dir && c.name == "small")
            .expect("small dir missing from tree root");
        let small_kept = small_node.children.iter().filter(|c| !c.is_dir).count();
        assert_eq!(small_kept, 3, "目录文件数 < k 时 [100,50,60] 必须全保留");
        let _ = fs::remove_dir_all(&dir);
    }

    fn tempdir_path() -> PathBuf {
        use std::sync::atomic::{AtomicU64, Ordering};
        // 只用时间戳命名会在 libtest 并行起线程时互踩：Windows 的 SystemTime
        // 来自 FILETIME，粒度 100ns（as_nanos 恒为 100 的倍数），两个测试在
        // 同一量子内各拿同一时间戳 → 同名 fixture 目录、彼此的文件混进对方
        // 断言（实测 scans_temp_dir 的 size 多 1 字节、trash 测试 file_count
        // 多 2，恰好是对方 fixture 的文件）。pid + 进程内序号保证同一进程内
        // 绝不重名，nanos 保证跨进程/跨运行不与残留目录相撞。
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = SEQ.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!(
            "pinkbin-test-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            seq,
        ));
        // create_dir（而非 create_dir_all）：重名即刻报错，而不是静默共享目录。
        std::fs::create_dir(&p).unwrap();
        p
    }

    // #26 MFT 兼容修复：卷类型预检是纯函数，CI 模拟不了非 NTFS 物理卷，
    // 这里 mock GetVolumeInformationW 的两类输出（FS 名字符串 / Win32 错误码）
    // 直接锁死决策矩阵——预检放错了卷，轻则白付一次 panic 降级，重则把
    // 可扫的卷挡在快路径外。
    #[cfg(windows)]
    #[test]
    fn volume_fs_decision_matrix() {
        use super::VolumeFsDecision as D;

        // NTFS（大小写不敏感）→ 放行。
        assert_eq!(super::volume_fs_decision(Some("NTFS"), None), D::Ntfs);
        assert_eq!(super::volume_fs_decision(Some("ntfs"), None), D::Ntfs);
        assert_eq!(super::volume_fs_decision(Some(" Ntfs "), None), D::Ntfs);

        // BitLocker 特征一：FS 名 "DEVICE LOCKER"（过滤驱动名，大小写不敏感）。
        assert_eq!(
            super::volume_fs_decision(Some("Device Locker"), None),
            D::BitLockerLocked
        );
        // BitLocker 特征二：查询撞 ACCESS_DENIED(5)，此时名字拿不到。
        assert_eq!(super::volume_fs_decision(None, Some(5)), D::BitLockerLocked);
        // ACCESS_DENIED 优先于任何名字（防异常组合下误放行）。
        assert_eq!(
            super::volume_fs_decision(Some("NTFS"), Some(5)),
            D::BitLockerLocked
        );

        // 其它文件系统：ReFS / exFAT 原样带出给日志。
        assert_eq!(
            super::volume_fs_decision(Some("ReFS"), None),
            D::OtherFs("ReFS".into())
        );
        assert_eq!(
            super::volume_fs_decision(Some("exFAT"), None),
            D::OtherFs("exFAT".into())
        );

        // 无法判定 → 放行（catch_unwind 兜底）：无关错误（21 = ERROR_NOT_READY）、
        // 空白名、无名无错。
        assert_eq!(super::volume_fs_decision(None, Some(21)), D::Unknown);
        assert_eq!(super::volume_fs_decision(Some("   "), None), D::Unknown);
        assert_eq!(super::volume_fs_decision(None, None), D::Unknown);
    }
}
