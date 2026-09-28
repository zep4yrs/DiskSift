//! Windows-only NTFS Master File Table direct reader.
//!
//! WizTree-class scanner: opens the volume as a raw block device, parses the
//! NTFS boot sector via the `ntfs` crate, then iterates every record in the
//! `$MFT` file. Each record yields parent FRN + filename + size in one pass,
//! so a 1M-file C: drive scans in seconds rather than minutes.
//!
//! Requires admin privileges (raw volume open is privileged). On non-NTFS
//! filesystems or access-denied, the caller should fall back to `walkdir`.

use anyhow::{anyhow, Context};
use ntfs::structured_values::{NtfsFileName, NtfsFileNamespace};
use ntfs::{KnownNtfsFileRecordNumber, Ntfs, NtfsAttributeType, NtfsReadSeek};
use std::collections::{HashMap, HashSet};
use std::fs::OpenOptions;
use std::io::BufReader;
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::{ExtShare, Node};

const FILE_SHARE_READ: u32 = 0x0000_0001;
const FILE_SHARE_WRITE: u32 = 0x0000_0002;
const FILE_FLAG_SEQUENTIAL_SCAN: u32 = 0x0800_0000;
const GENERIC_READ: u32 = 0x8000_0000;

// Reparse tags (win32/fileio/reparse-point-tags) that behave like the
// junction/symlink entries the walker chain prunes. Deliberately narrow:
// OneDrive placeholders (0x9000_0001, cloud) and deduped files (0x8000_0013)
// are reparse points too — pruning those would silently drop real user data
// from the tree.
const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xA000_0003; // directory junction
const IO_REPARSE_TAG_SYMLINK: u32 = 0xA000_000C; // file or dir symlink

#[derive(Debug, Clone)]
struct Entry {
    name: String,
    parent_frn: u64,
    own_size: u64, // file size from $DATA, or 0 for dirs
    is_dir: bool,
    children: Vec<u64>, // FRNs of direct children (filled in second pass)
    /// Reparse point with a junction/symlink tag (mount point / symlink).
    /// Such entries must never surface as child nodes: the walker chain cuts
    /// them in `process_read_dir` (BlueTidy discipline, lib.rs §2.4), while the
    /// MFT chain used to emit them as 0-byte empty dir nodes that could be
    /// selected and streamed out. Still reachable via `find_frn_for_path`, so
    /// scanning *through* a junction (subroot inside one) keeps working — same
    /// as the walker, which always scans its root.
    is_reparse_link: bool,
}

/// #26 MFT 兼容修复：进快路径前的卷类型预检。一次 GetVolumeInformationW
/// 内核调用拿文件系统名，判定交给 lib.rs 的纯函数 volume_fs_decision
/// （与 Win32 取数分离才能脱离物理卷做单元测试）。
pub(super) fn volume_fs_check(volume_letter: char) -> super::VolumeFsDecision {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetVolumeInformationW;

    let root: Vec<u16> =
        std::ffi::OsStr::new(&format!(r"{}:\", volume_letter.to_ascii_uppercase()))
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
    let mut fs_name = [0u16; 256];
    let ok = unsafe {
        // SAFETY: 两个缓冲都是本函数栈上的有效内存，wide 字符串带 NUL 终止。
        GetVolumeInformationW(
            root.as_ptr(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            fs_name.as_mut_ptr(),
            fs_name.len() as u32,
        )
    };
    if ok == 0 {
        // 卷锁着（BitLocker）/未就绪等：失败时名字缓冲不可信，只把 Win32
        // 错误码交给决策函数——ACCESS_DENIED 是 BitLocker 的指纹。
        let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
        tracing::debug!(
            "volume_fs_check: 卷 {}: GetVolumeInformationW failed win32_error={code}",
            volume_letter.to_ascii_uppercase()
        );
        return super::volume_fs_decision(None, Some(code));
    }
    let len = fs_name
        .iter()
        .position(|&c| c == 0)
        .unwrap_or(fs_name.len());
    super::volume_fs_decision(Some(&String::from_utf16_lossy(&fs_name[..len])), None)
}

/// Scan an entire NTFS volume by reading $MFT directly.
///
/// `volume_letter` is e.g. `'C'`. `subroot` lets you ask only for a subtree
/// of the volume (e.g. `D:\Foo`); when `None`, the whole volume is returned.
/// `cancel`（v26.1.4.0 菜3）在记录循环每 256 条检查一次，命中即停止收集并
/// 用已收集条目建部分树，返回 (node, cancelled=true)。`excludes`
/// （v26.1.4.0 菜4）按完整路径标记被排除子树/文件（blocked 集），
/// rollup 与建树一致跳过——卷上数字与可见树保持同口径。
pub fn scan_volume<F>(
    volume_letter: char,
    subroot: Option<&Path>,
    mut on_progress: F,
    cancel: Option<&Arc<AtomicBool>>,
    excludes: &pinkbin_excludes::Excludes,
) -> anyhow::Result<(Node, bool)>
where
    F: FnMut(u64, u64), // (records_seen, bytes_seen)
{
    let path = format!(r"\\.\{}:", volume_letter.to_ascii_uppercase());
    let file = OpenOptions::new()
        .read(true)
        .access_mode(GENERIC_READ)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_SEQUENTIAL_SCAN)
        .open(&path)
        .with_context(|| format!("opening volume {} (admin required)", path))?;

    let mut reader = BufReader::with_capacity(1 << 20, file);
    // #26：ntfs crate 对非标准卷会在 BootSector/bpb 解析上抛 binrw 意外错误
    // （用户实测 os error 87），甚至直接 unreachable panic（后者由 lib.rs 的
    // catch_unwind 兜住）。Err 形态在这里显式归类——降级必须带得上「为什么」，
    // 卷字母进 warn，别让用户看到一句干巴巴的 parsing failed。
    let mut ntfs = match Ntfs::new(&mut reader) {
        Ok(n) => n,
        Err(e) => {
            tracing::warn!(
                "MFT: 卷 {}:\\ boot sector 解析失败（{e}）——卷类型非标准 NTFS（如 ReFS/exFAT 伪装或 BitLocker 未解锁），降级 walkdir",
                volume_letter.to_ascii_uppercase()
            );
            return Err(anyhow!(
                "volume {} boot sector is not standard NTFS \
                 (ReFS/exFAT masquerade or locked BitLocker?): {e}",
                volume_letter.to_ascii_uppercase()
            ));
        }
    };
    ntfs.read_upcase_table(&mut reader).ok();

    // Read $MFT itself (record 0). Its $DATA attribute lists all clusters
    // belonging to the MFT — by reading them sequentially we get all records.
    let mft_file = ntfs
        .file(&mut reader, KnownNtfsFileRecordNumber::MFT as u64)
        .context("locating $MFT")?;
    let mft_data = mft_file
        .data(&mut reader, "")
        .ok_or_else(|| anyhow!("$MFT has no $DATA attribute"))?
        .context("reading $MFT $DATA")?;
    let mft_data_attribute = mft_data.to_attribute()?;
    let mft_data_value = mft_data_attribute.value(&mut reader)?;

    let record_size = ntfs.file_record_size() as u64;
    let total_size = mft_data_value.len();
    let total_records = (total_size / record_size) as u64;
    // Release the borrow chain on `reader` (mft_data_value → mft_data_attribute →
    // mft_file) before we re-borrow `reader` below for the per-record walk.
    // Plain `drop(x)` is what we want, but clippy's `drop_non_drop` whines about
    // it because none of these implement `Drop`. `let _ = x;` ends the binding
    // exactly the same way without the lint hit.
    let _ = mft_data_value;
    let _ = mft_data_attribute;
    let _ = mft_file;
    tracing::info!(
        "MFT scan: volume={} record_size={} total_records={}",
        volume_letter,
        record_size,
        total_records
    );

    // Pass 1: collect all entries by FRN.
    let mut entries: HashMap<u64, Entry> = HashMap::with_capacity(total_records as usize);
    let mut bytes_total: u64 = 0;
    let mut was_cancelled = false;
    let mut records_seen = total_records;

    for record_num in 0..total_records {
        // 菜3：每 256 条检查取消令牌——命中即停止收集，后续用部分条目建树。
        if record_num % 256 == 0 && super::cancelled_now(cancel) {
            was_cancelled = true;
            records_seen = record_num;
            tracing::info!("MFT scan: cancelled at record {record_num}（返回部分结果）");
            break;
        }
        let f = match ntfs.file(&mut reader, record_num) {
            Ok(f) => f,
            Err(_) => continue,
        };

        let mut best_name: Option<NtfsFileName> = None;
        let mut best_namespace_rank: u8 = 0;
        let mut size: u64 = 0;
        let is_dir = f.is_directory();
        let mut is_reparse_link = false;

        let mut attrs_iter = f.attributes();
        while let Some(item) = attrs_iter.next(&mut reader) {
            let item = match item {
                Ok(a) => a,
                Err(_) => continue,
            };
            let attr = match item.to_attribute() {
                Ok(a) => a,
                Err(_) => continue,
            };
            match attr.ty() {
                Ok(NtfsAttributeType::FileName) => {
                    if let Ok(name) = attr.structured_value::<_, NtfsFileName>(&mut reader) {
                        let rank = match name.namespace() {
                            NtfsFileNamespace::Posix => 4,
                            NtfsFileNamespace::Win32 => 3,
                            NtfsFileNamespace::Win32AndDos => 2,
                            NtfsFileNamespace::Dos => 1,
                        };
                        if rank > best_namespace_rank {
                            best_namespace_rank = rank;
                            best_name = Some(name);
                        }
                    }
                }
                Ok(NtfsAttributeType::Data) => {
                    if size != 0 {
                        continue;
                    }
                    let unnamed = attr.name().map(|n| n.is_empty()).unwrap_or(true);
                    if !unnamed {
                        continue;
                    }
                    if let Ok(value) = attr.value(&mut reader) {
                        size = value.len();
                    }
                }
                Ok(NtfsAttributeType::ReparsePoint) => {
                    // ReparseTag is the first DWORD of the reparse data.
                    // Only mount-point (junction) and symlink tags mark a link
                    // entry; cloud/dedup tags keep their entries visible. If
                    // the tag can't be read, keep the entry (fail open for
                    // visibility rather than hiding a real record).
                    if let Ok(mut value) = attr.value(&mut reader) {
                        let mut tag = [0u8; 4];
                        // NtfsReadSeek 要求每次读取都显式传入文件系统 reader（trait 设计如此，
                        // 返回的 NtfsAttributeValue 不持有 reader 借用）。
                        if value.read_exact(&mut reader, &mut tag).is_ok() {
                            let tag = u32::from_le_bytes(tag);
                            if tag == IO_REPARSE_TAG_MOUNT_POINT || tag == IO_REPARSE_TAG_SYMLINK {
                                is_reparse_link = true;
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        if let Some(fname) = best_name {
            let parent_frn = fname.parent_directory_reference().file_record_number();
            let name = fname.name().to_string_lossy();
            let own_size = if is_dir { 0 } else { size };
            bytes_total = bytes_total.saturating_add(own_size);
            entries.insert(
                record_num,
                Entry {
                    name,
                    parent_frn,
                    own_size,
                    is_dir,
                    children: Vec::new(),
                    is_reparse_link,
                },
            );
        }

        if record_num.is_multiple_of(50_000) {
            on_progress(record_num, bytes_total);
        }
    }
    on_progress(records_seen, bytes_total);

    // Pass 2: link children to parents.
    let frns: Vec<u64> = entries.keys().copied().collect();
    for frn in frns {
        let parent = entries.get(&frn).map(|e| e.parent_frn).unwrap_or(0);
        if parent != frn {
            if let Some(p) = entries.get_mut(&parent) {
                p.children.push(frn);
            }
        }
    }

    // Build the Node tree starting from FRN 5 (NTFS root directory).
    let root_frn = KnownNtfsFileRecordNumber::RootDirectory as u64;
    let volume_root = format!("{}:\\", volume_letter.to_ascii_uppercase());

    // 菜4：用户排除规则。自根向下 DFS 逐条目拼完整路径并匹配规则，命中的
    // 目录整树（不下钻）、命中的文件单独进 blocked 集——rollup 与建树共用
    // 同一集合，卷上 rollup 数字与可见树保持同口径。is_empty 时零开销跳过。
    let mut blocked: HashSet<u64> = HashSet::new();
    if !excludes.is_empty() {
        let mut stack: Vec<(u64, PathBuf)> = vec![(root_frn, PathBuf::from(&volume_root))];
        while let Some((frn, path)) = stack.pop() {
            let Some(e) = entries.get(&frn) else { continue };
            for &c in &e.children {
                if c == frn {
                    continue;
                }
                let Some(ce) = entries.get(&c) else { continue };
                if ce.is_reparse_link {
                    continue; // 本就剪枝的联接项
                }
                let cpath = path.join(&ce.name);
                if excludes.matches(&cpath) {
                    blocked.insert(c); // 目录：整树（不下钻）；文件：单条
                } else if ce.is_dir {
                    stack.push((c, cpath));
                }
            }
        }
        if !blocked.is_empty() {
            tracing::info!("MFT scan: {} 个条目命中用户排除规则，已剪枝", blocked.len());
        }
    }

    // Compute roll-up sizes once via DFS.
    fn rollup(
        frn: u64,
        entries: &HashMap<u64, Entry>,
        sizes: &mut HashMap<u64, (u64, u64)>,
        blocked: &HashSet<u64>,
    ) -> (u64, u64) {
        if let Some(c) = sizes.get(&frn) {
            return *c;
        }
        // Cycle guard.
        sizes.insert(frn, (0, 0));
        let mut total_bytes: u64 = 0;
        let mut total_files: u64 = 0;
        if let Some(e) = entries.get(&frn) {
            if !e.is_dir {
                total_bytes = e.own_size;
                total_files = 1;
            } else {
                for &c in &e.children {
                    if c == frn {
                        continue;
                    }
                    if let Some(centry) = entries.get(&c) {
                        // Same prune set as build_node below, so rolled-up
                        // totals always match what the visible tree shows.
                        // （v26.1.4.0 菜4：用户排除 blocked 集加入同一剪枝面。）
                        if centry.is_reparse_link
                            || blocked.contains(&c)
                            || (centry.is_dir
                                && super::is_pruned_system_dir(std::ffi::OsStr::new(&centry.name)))
                        {
                            continue;
                        }
                    }
                    let (b, n) = rollup(c, entries, sizes, blocked);
                    total_bytes = total_bytes.saturating_add(b);
                    total_files = total_files.saturating_add(n);
                }
            }
        }
        sizes.insert(frn, (total_bytes, total_files));
        (total_bytes, total_files)
    }

    let mut sizes: HashMap<u64, (u64, u64)> = HashMap::new();
    rollup(root_frn, &entries, &mut sizes, &blocked);

    // Build the visible Node tree, optionally rooted at `subroot`.
    let start_frn = if let Some(sub) = subroot {
        find_frn_for_path(sub, root_frn, &entries).unwrap_or(root_frn)
    } else {
        root_frn
    };
    let start_path = if let Some(sub) = subroot {
        sub.to_path_buf()
    } else {
        PathBuf::from(&volume_root)
    };

    let node = build_node(start_frn, &start_path, &entries, &sizes, &blocked, 0);
    Ok((node, was_cancelled))
}

fn find_frn_for_path(target: &Path, root_frn: u64, entries: &HashMap<u64, Entry>) -> Option<u64> {
    // Walk component-by-component from root looking for matching child names.
    let mut current = root_frn;
    let comps: Vec<String> = target
        .components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect();
    for c in comps {
        let e = entries.get(&current)?;
        let next = e.children.iter().copied().find(|frn| {
            entries
                .get(frn)
                .map(|x| x.name.eq_ignore_ascii_case(&c))
                .unwrap_or(false)
        })?;
        current = next;
    }
    Some(current)
}

fn build_node(
    frn: u64,
    path: &Path,
    entries: &HashMap<u64, Entry>,
    sizes: &HashMap<u64, (u64, u64)>,
    blocked: &HashSet<u64>,
    depth: usize,
) -> Node {
    let entry = entries.get(&frn);
    let (size, file_count) = sizes.get(&frn).copied().unwrap_or((0, 0));
    let name = match entry {
        Some(e) => e.name.clone(),
        None => path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string_lossy().to_string()),
    };
    let is_dir = entry.map(|e| e.is_dir).unwrap_or(true);

    let mut children_nodes: Vec<Node> = Vec::new();
    let mut ext_bytes: HashMap<String, u64> = HashMap::new();
    let mut ext_count: HashMap<String, u64> = HashMap::new();

    if let Some(e) = entry {
        // Sort children by size desc for nicer display.
        let mut kids: Vec<(u64, u64)> = e
            .children
            .iter()
            .filter(|&&c| c != frn)
            .map(|&c| (c, sizes.get(&c).map(|(b, _)| *b).unwrap_or(0)))
            .collect();
        kids.sort_by_key(|k| std::cmp::Reverse(k.1));

        // Cap depth/breadth so the JSON sent to the frontend stays sane.
        let breadth_cap = if depth < 2 {
            200
        } else if depth < 4 {
            80
        } else {
            25
        };
        for (cfrn, _) in kids.iter().take(breadth_cap) {
            let centry = match entries.get(cfrn) {
                Some(c) => c,
                None => continue,
            };
            // Junction/symlink entries (reparse-tag based) are never emitted as
            // child nodes — they must not surface as 0-byte empty dirs that the
            // frontend could select and act on. Mirrors the walker chain's
            // `file_type.is_symlink()` prune in scan_with_stats.
            // （v26.1.4.0 菜4：用户排除 blocked 集同面剪枝。）
            if centry.is_reparse_link
                || blocked.contains(cfrn)
                || (centry.is_dir
                    && super::is_pruned_system_dir(std::ffi::OsStr::new(&centry.name)))
            {
                continue;
            }
            let cpath = path.join(&centry.name);

            // Tally extension bytes for this directory.
            if !centry.is_dir {
                let ext = std::path::Path::new(&centry.name)
                    .extension()
                    .map(|e| e.to_string_lossy().to_lowercase())
                    .unwrap_or_else(|| "(none)".into());
                *ext_bytes.entry(ext.clone()).or_insert(0) += centry.own_size;
                *ext_count.entry(ext).or_insert(0) += 1;
            }

            let cnode = build_node(*cfrn, &cpath, entries, sizes, blocked, depth + 1);
            children_nodes.push(cnode);
        }
    }

    let mut top_extensions: Vec<ExtShare> = ext_bytes
        .into_iter()
        .map(|(ext, bytes)| ExtShare {
            ext: ext.clone(),
            bytes,
            count: ext_count.get(&ext).copied().unwrap_or(0),
        })
        .collect();
    top_extensions.sort_by_key(|e| std::cmp::Reverse(e.bytes));
    top_extensions.truncate(8);

    Node {
        name,
        path: path.to_string_lossy().to_string(),
        is_dir,
        size,
        file_count,
        children: children_nodes,
        scaffold_id: None,
        top_extensions,
    }
}
