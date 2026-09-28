//! USN Journal 轮询（release-plan-26.1.4.0 §1 菜1）。
//!
//! 职责（规格 §1 的 `journal` 模块）：
//! - 卷句柄：`CreateFileW(\\.\C:)`（GENERIC_READ）；
//! - journal 不存在时 `FSCTL_CREATE_USN_JOURNAL`（MaximumSize 上限 32MB）；
//! - `FSCTL_READ_USN_JOURNAL` 500ms 轮询循环（BytesToWaitFor=0 即时返回，
//!   停止信号 ≤50ms 生效，退出即 CloseHandle——不阻塞卷卸载）；
//! - FRN → 目录路径解析（OpenFileById + GetFinalPathNameByHandleW，带缓存）。
//!
//! **监控只读红线**：除创建 journal 这一条规格明示的例外，本模块对卷零写入
//! （query/read 全程只读；路径解析只要 FILE_READ_ATTRIBUTES）。
//!
//! 纯逻辑（USN_RECORD_V2 字节流解析、卷标识归一、verbatim 剥离、卷类型闸门）
//! 与 Win32 取数分离，固定字节喂入即可单测，不依赖物理卷。

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::aggregate::{AggregateConfig, AggregateWindow};
use crate::emit::{self, ChangesPayload, DirChange, StatePayload};
use crate::filter::{reason_to_kind, starts_with_volume};
use crate::refresh::{build_dir_stat, Pacer, RefreshBudget};
use crate::VolumeStats;

/// USN journal 创建上限（规格：MaximumSize 上限 32MB）。
const JOURNAL_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// 分配增量（微软默认量级，8MB）。
const JOURNAL_ALLOC_BYTES: u64 = 8 * 1024 * 1024;
/// USN 读取缓冲：起步 64KB，遇 ERROR_MORE_DATA 翻倍到 1MB 封顶。
const READ_BUF_START: usize = 64 * 1024;
const READ_BUF_MAX: usize = 1024 * 1024;
/// FRN→路径缓存的条目上限（防天边工作集把内存拖爆；超过整体清空重来）。
const PATH_CACHE_CAP: usize = 100_000;
/// 轮询周期（规格：500ms）。
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// 归一后的卷标识。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolumeSpec {
    /// 规范键（`"C:"`）——hub 地图键与 CONTRACT 载荷里的 `volume` 字段。
    pub key: String,
    pub letter: char,
    /// `\\.\C:` — CreateFileW 目标。
    pub device_path: String,
    /// `C:\` — 卷根前缀 / GetVolumeInformationW 参数。
    pub root_path: String,
}

/// 归一用户/前端传入的卷标识：`C` / `c` / `C:` / `c:\` / `C:/` / `\\.\C:` /
/// `\\?\C:\` 都接受；UNC 与其它形态返回 None（hub 注册即降级，不报错弹窗）。
pub fn normalize_volume(input: &str) -> Option<VolumeSpec> {
    let s = input.trim();
    let s = s
        .strip_prefix(r"\\?\")
        .or_else(|| s.strip_prefix(r"\\.\"))
        .unwrap_or(s);
    let mut chars = s.chars();
    let letter = chars.next()?;
    if !letter.is_ascii_alphabetic() {
        return None;
    }
    let rest = chars.as_str().replace('/', "\\");
    if !matches!(rest.as_str(), "" | ":" | ":\\") {
        return None;
    }
    let upper = letter.to_ascii_uppercase();
    Some(VolumeSpec {
        key: format!("{upper}:"),
        letter: upper,
        device_path: format!(r"\\.\{upper}:"),
        root_path: format!(r"{upper}:\"),
    })
}

/// 剥掉 `\\?\` verbatim 前缀；`\\?\UNC\srv\share` 还原成 `\\srv\share`。
pub fn strip_verbatim(path: &str) -> String {
    match path.strip_prefix(r"\\?\") {
        None => path.to_string(),
        Some(rest) => match rest.strip_prefix("UNC\\") {
            Some(unc) => format!(r"\\{unc}"),
            None => rest.to_string(),
        },
    }
}

/// FS 闸门判定（与 crates/scanner volume_fs_decision 同矩阵：NTFS 放行，
/// exFAT/ReFS 等明示不支持，BitLocker 锁定明示不支持，未知放行交给后续
/// 环节自然失败并降级）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FsGate {
    Ntfs,
    OtherFs(String),
    BitLockerLocked,
    Unknown,
}

/// 纯判定：GetVolumeInformationW 的输出（FS 名 / 查询错误码）→ 闸门。
/// ERROR_ACCESS_DENIED(5) 是锁着的 BitLocker 的指纹（scanner 同款结论）。
pub fn fs_gate(fs_name: Option<&str>, query_error: Option<u32>) -> FsGate {
    const ERROR_ACCESS_DENIED: u32 = 5;
    if query_error == Some(ERROR_ACCESS_DENIED) {
        return FsGate::BitLockerLocked;
    }
    match fs_name {
        None => FsGate::Unknown,
        Some(name) => {
            let trimmed = name.trim();
            if trimmed.eq_ignore_ascii_case("DEVICE LOCKER") {
                FsGate::BitLockerLocked
            } else if trimmed.eq_ignore_ascii_case("NTFS") {
                FsGate::Ntfs
            } else if trimmed.is_empty() {
                FsGate::Unknown
            } else {
                FsGate::OtherFs(trimmed.to_string())
            }
        }
    }
}

/// 降级原因文案（有值 = 禁止启动监控；None = 放行）。
pub fn fs_gate_block_reason(gate: &FsGate) -> Option<String> {
    match gate {
        FsGate::Ntfs | FsGate::Unknown => None,
        FsGate::OtherFs(name) => Some(format!("非 NTFS 卷（{name}），不支持实时监控")),
        FsGate::BitLockerLocked => Some("卷已由 BitLocker 锁定，无法实时监控".into()),
    }
}

// ── USN_RECORD_V2 字节流解析（纯函数）────────────────────────────────────────

/// 解析出的一条 USN 记录（V2 字段子集：监控链路用到的那些）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsnRecord {
    pub record_length: u32,
    pub major: u16,
    pub minor: u16,
    pub frn: u64,
    pub parent_frn: u64,
    pub usn: i64,
    pub reason: u32,
    pub attributes: u32,
    pub name: String,
}

/// 一次读取的解析结果。`next_usn` 是缓冲头部的 journal NextUsn（下一次
/// FSCTL_READ_USN_JOURNAL 的 StartUsn 就传它）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedBuffer {
    pub next_usn: i64,
    pub records: Vec<UsnRecord>,
}

/// USN_RECORD_V2 固定头部 60 字节（FileName[1] 之前）。
const USN_RECORD_V2_HEADER: usize = 60;

/// 解析 FSCTL_READ_USN_JOURNAL 输出缓冲：前 8 字节 journal USN，其后是
/// 变长记录数组。防御式解析：record_length=0 / 越界 / 截断尾巴都安全停；
/// V3 记录（major≠2，我们只订阅 2..2，防御兜底）按长度跳过。
pub fn parse_usn_buffer(buf: &[u8]) -> ParsedBuffer {
    let mut out = ParsedBuffer {
        next_usn: 0,
        records: Vec::new(),
    };
    if buf.len() < 8 {
        return out;
    }
    out.next_usn = i64::from_le_bytes(buf[0..8].try_into().expect("8 bytes"));
    let mut off = 8usize;
    while off + USN_RECORD_V2_HEADER <= buf.len() {
        let rl = read_u32(buf, off);
        if rl == 0 {
            break; // 零填充（MORE_DATA 语义下未写入区）/ 损坏：停
        }
        let rl = rl as usize;
        if off + rl > buf.len() {
            break; // 截断尾巴：整条丢弃
        }
        let major = read_u16(buf, off + 4);
        let minor = read_u16(buf, off + 6);
        if major == 2 {
            let name_len = read_u16(buf, off + 56) as usize; // 字节数
            let name_off = read_u16(buf, off + 58) as usize; // 相对记录头
            let name_start = off + name_off;
            let name_end = name_start + name_len;
            let name = if name_off >= rl || name_end > off + rl || !name_len.is_multiple_of(2) {
                String::new() // 越界/半字符：名字不可信，路径解析不依赖它
            } else {
                let wide: Vec<u16> = buf[name_start..name_end]
                    .chunks_exact(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .collect();
                String::from_utf16_lossy(&wide)
            };
            out.records.push(UsnRecord {
                record_length: rl as u32,
                major,
                minor,
                frn: read_u64(buf, off + 8),
                parent_frn: read_u64(buf, off + 16),
                usn: i64::from_le_bytes(buf[off + 24..off + 32].try_into().expect("8 bytes")),
                reason: read_u32(buf, off + 40),
                attributes: read_u32(buf, off + 52),
                name,
            });
        }
        off += rl;
    }
    out
}

fn read_u16(buf: &[u8], off: usize) -> u16 {
    u16::from_le_bytes(buf[off..off + 2].try_into().expect("2 bytes"))
}

fn read_u32(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes(buf[off..off + 4].try_into().expect("4 bytes"))
}

fn read_u64(buf: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(buf[off..off + 8].try_into().expect("8 bytes"))
}

// ── worker 上下文与轮询循环 ─────────────────────────────────────────────────

/// 一个卷的监控 worker 上下文（hub 组装，线程持有）。
pub struct VolumeLoopCtx {
    pub spec: VolumeSpec,
    pub stop: Arc<std::sync::atomic::AtomicBool>,
    pub stats: Arc<VolumeStats>,
    pub app: tauri::AppHandle,
}

#[cfg(windows)]
mod win {
    use super::*;

    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFinalPathNameByHandleW, GetVolumeInformationW, OpenFileById,
        FILE_ID_DESCRIPTOR, FILE_ID_DESCRIPTOR_0, FILE_FLAG_BACKUP_SEMANTICS, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FileIdType, OPEN_EXISTING,
    };
    use windows_sys::Win32::System::IO::DeviceIoControl;
    use windows_sys::Win32::System::Ioctl::{
        CREATE_USN_JOURNAL_DATA, FSCTL_CREATE_USN_JOURNAL, FSCTL_QUERY_USN_JOURNAL,
        FSCTL_READ_USN_JOURNAL, READ_USN_JOURNAL_DATA_V1, USN_JOURNAL_DATA_V1,
    };

    /// Drop 即 CloseHandle 的句柄 guard：worker 任何一条 return 路径（含
    /// panic 展开）都保证关句柄——应用停用后不阻塞卷卸载（规格红线）。
    struct HandleGuard(HANDLE);

    impl Drop for HandleGuard {
        fn drop(&mut self) {
            if !self.0.is_null() && self.0 as isize != INVALID_HANDLE_VALUE as isize {
                // SAFETY: 句柄来自 CreateFileW/OpenFileById 的成功返回。
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    /// 一个已打开卷的 USN 会话。句柄生命周期由 Drop 管，绝不出本结构。
    pub struct VolumeSession {
        handle: HANDLE,
        pub journal_id: u64,
        pub next_usn: i64,
    }

    impl Drop for VolumeSession {
        fn drop(&mut self) {
            if !self.handle.is_null() && self.handle as isize != INVALID_HANDLE_VALUE as isize {
                // SAFETY: 同 HandleGuard。
                unsafe { CloseHandle(self.handle) };
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    /// GetVolumeInformationW 取 FS 名（与 scanner mft.rs volume_fs_check
    /// 同款取数）。返回（名字，失败时的 Win32 错误码）。
    pub fn query_fs_name(root: &str) -> (Option<String>, Option<u32>) {
        let root = wide(root);
        let mut fs_name = [0u16; 256];
        // SAFETY: root 带 NUL 终止；fs_name 是本函数栈上有效缓冲。
        let ok = unsafe {
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
            let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
            return (None, Some(code));
        }
        let len = fs_name.iter().position(|&c| c == 0).unwrap_or(fs_name.len());
        (Some(String::from_utf16_lossy(&fs_name[..len])), None)
    }

    impl VolumeSession {
        /// 打开卷句柄（GENERIC_READ——USN 读取的最低要求；非管理员进程会
        /// ACCESS_DENIED，调用方按降级处理）。共享读写删：绝不阻塞其它
        /// 进程访问或卸载卷。
        pub fn open(spec: &VolumeSpec) -> Result<Self, String> {
            let path = wide(&spec.device_path);
            // SAFETY: path 带 NUL 终止；其余参数是文档化的常量与空指针。
            let handle = unsafe {
                CreateFileW(
                    path.as_ptr(),
                    GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    0,
                    std::ptr::null_mut() as HANDLE,
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                let e = std::io::Error::last_os_error();
                return Err(format!(
                    "打开卷句柄失败（实时监控需要管理员权限）：{e}"
                ));
            }
            Ok(Self {
                handle,
                journal_id: 0,
                next_usn: 0,
            })
        }

        fn device_ioctl(
            &self,
            code: u32,
            inbuf: *const std::ffi::c_void,
            insize: u32,
            outbuf: *mut std::ffi::c_void,
            outsize: u32,
        ) -> Result<u32, u32> {
            let mut returned: u32 = 0;
            // SAFETY: 输入/输出缓冲由调用方持有且长度如实；overlapped 不用
            // （句柄以同步模式打开）。
            let ok = unsafe {
                DeviceIoControl(
                    self.handle,
                    code,
                    inbuf,
                    insize,
                    outbuf,
                    outsize,
                    &mut returned,
                    std::ptr::null_mut(),
                )
            };
            if ok != 0 {
                Ok(returned)
            } else {
                Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32)
            }
        }

        /// FSCTL_QUERY_USN_JOURNAL → (journal_id, next_usn)。
        fn query_journal(&self) -> Result<(u64, i64), u32> {
            let mut out = [0u8; std::mem::size_of::<USN_JOURNAL_DATA_V1>()];
            self.device_ioctl(
                FSCTL_QUERY_USN_JOURNAL,
                std::ptr::null(),
                0,
                out.as_mut_ptr() as *mut _,
                out.len() as u32,
            )?;
            // SAFETY: out 是刚被内核填写的栈缓冲，V1 结构 60 字节 ≤ 64 字节
            // 缓冲，按 repr(C) 布局读取前三个字段。
            let d = unsafe { &*(out.as_ptr() as *const USN_JOURNAL_DATA_V1) };
            Ok((d.UsnJournalID, d.NextUsn))
        }

        /// FSCTL_CREATE_USN_JOURNAL（规格：上限 32MB）。已存在时内核会拒绝，
        /// 调用方只在 query 失败后调它。
        fn create_journal(&self) -> Result<(), u32> {
            let data = CREATE_USN_JOURNAL_DATA {
                MaximumSize: JOURNAL_MAX_BYTES,
                AllocationDelta: JOURNAL_ALLOC_BYTES,
            };
            self.device_ioctl(
                FSCTL_CREATE_USN_JOURNAL,
                &data as *const _ as *const _,
                std::mem::size_of::<CREATE_USN_JOURNAL_DATA>() as u32,
                std::ptr::null_mut(),
                0,
            )?;
            Ok(())
        }

        /// 确保 journal 在线：先查询；不在（NOT_ACTIVE/INVALID_PARAMETER）
        /// 就创建（≤32MB）再查询。这是监控对卷的唯一写动作（规格明示例外）。
        pub fn ensure_journal(&mut self) -> Result<(), String> {
            const ERROR_JOURNAL_NOT_ACTIVE: u32 = 1179;
            const ERROR_INVALID_PARAMETER: u32 = 87;
            match self.query_journal() {
                Ok((id, next)) => {
                    self.journal_id = id;
                    self.next_usn = next;
                    Ok(())
                }
                Err(code) if code == ERROR_JOURNAL_NOT_ACTIVE || code == ERROR_INVALID_PARAMETER => {
                    tracing::info!(
                        "monitor: 卷 USN journal 不存在（win32 error {code}），创建（上限 32MB）"
                    );
                    self.create_journal().map_err(|e| {
                        format!("创建 USN journal 失败（win32 error {e}）——非 NTFS 卷不支持实时监控")
                    })?;
                    let (id, next) = self
                        .query_journal()
                        .map_err(|e| format!("创建 USN journal 后查询仍失败（win32 error {e}）"))?;
                    self.journal_id = id;
                    self.next_usn = next;
                    Ok(())
                }
                Err(code) => Err(format!("查询 USN journal 失败（win32 error {code}）")),
            }
        }

        /// FSCTL_READ_USN_JOURNAL 一批（BytesToWaitFor=0：有多少读多少，
        /// 立即返回）。返回写入 out 的字节数。
        pub fn read_batch(&self, next_usn: i64, out: &mut [u8]) -> Result<usize, u32> {
            let indata = READ_USN_JOURNAL_DATA_V1 {
                StartUsn: next_usn,
                ReasonMask: crate::filter::INTEREST_REASONS,
                ReturnOnlyOnClose: 0,
                Timeout: 0,
                BytesToWaitFor: 0,
                UsnJournalID: self.journal_id,
                MinMajorVersion: 2,
                MaxMajorVersion: 2,
            };
            self.device_ioctl(
                FSCTL_READ_USN_JOURNAL,
                &indata as *const _ as *const _,
                std::mem::size_of::<READ_USN_JOURNAL_DATA_V1>() as u32,
                out.as_mut_ptr() as *mut _,
                out.len() as u32,
            )
            .map(|n| n as usize)
        }

        /// FRN → 路径（OpenFileById + GetFinalPathNameByHandleW）。
        /// 只要 FILE_READ_ATTRIBUTES（只读红线）；FILE_FLAG_BACKUP_SEMANTICS
        /// 允许打开的是目录。
        fn path_for_frn(&self, frn: u64) -> Option<String> {
            // SAFETY: idesc 是按 ABI 组装的栈值；成功返回的句柄由 guard 关。
            unsafe {
                let idesc = FILE_ID_DESCRIPTOR {
                    dwSize: std::mem::size_of::<FILE_ID_DESCRIPTOR>() as u32,
                    Type: FileIdType,
                    Anonymous: FILE_ID_DESCRIPTOR_0 {
                        FileId: frn as i64,
                    },
                };
                let h = OpenFileById(
                    self.handle,
                    &idesc,
                    FILE_READ_ATTRIBUTES,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    std::ptr::null(),
                    FILE_FLAG_BACKUP_SEMANTICS,
                );
                if h == INVALID_HANDLE_VALUE {
                    return None;
                }
                let _guard = HandleGuard(h);
                for cap in [512u32, 4096u32] {
                    let mut wbuf = vec![0u16; cap as usize];
                    let n = GetFinalPathNameByHandleW(h, wbuf.as_mut_ptr(), cap, 0);
                    if n == 0 {
                        return None;
                    }
                    if n <= cap {
                        // 文档歧义（成功长度是否含 NUL，版本间有出入）：
                        // 按实际 NUL 定位，两种语义下都正确。
                        let len = wbuf
                            .iter()
                            .position(|&c| c == 0)
                            .unwrap_or(n as usize)
                            .min(cap as usize);
                        return Some(strip_verbatim(&String::from_utf16_lossy(&wbuf[..len])));
                    }
                    // n > cap：需要更大缓冲，下一轮容量重试。
                }
                None
            }
        }
    }

    /// Win32 错误码（windows_sys::Win32::Foundation 同值；本地常量让循环
    /// 逻辑可读且不重复 import）。
    const ERROR_MORE_DATA: u32 = 234;
    const ERROR_JOURNAL_DELETE_IN_PROGRESS: u32 = 1178;
    const ERROR_JOURNAL_NOT_ACTIVE: u32 = 1179;
    const ERROR_JOURNAL_ENTRY_DELETED: u32 = 1181;
    const ERROR_INVALID_PARAMETER: u32 = 87;

    fn is_journal_error(code: u32) -> bool {
        matches!(
            code,
            ERROR_JOURNAL_DELETE_IN_PROGRESS
                | ERROR_JOURNAL_NOT_ACTIVE
                | ERROR_JOURNAL_ENTRY_DELETED
                | ERROR_INVALID_PARAMETER
        )
    }

    pub fn query_fs_gate(spec: &VolumeSpec) -> crate::journal::FsGate {
        let (name, err) = query_fs_name(&spec.root_path);
        crate::journal::fs_gate(name.as_deref(), err)
    }

    /// FRN → 父目录路径，带缓存。None = 解析失败（计 dropped）。
    fn resolve_parent(
        session: &VolumeSession,
        frn: u64,
        cache: &mut HashMap<u64, Option<String>>,
    ) -> Option<String> {
        if let Some(hit) = cache.get(&frn) {
            return hit.clone();
        }
        let resolved = session.path_for_frn(frn);
        if cache.len() >= PATH_CACHE_CAP {
            cache.clear();
        }
        cache.insert(frn, resolved.clone());
        resolved
    }

    /// Windows 监控主循环（线程体；由 hub 的 catch_unwind 包裹）。
    /// running 占位由 hub.claim_slot 在 spawn 前同步完成（双开竞态修复），
    /// 这里不再重复 mark_running——否则 stop 之后慢启动的旧 worker 会把
    /// 状态复活成 running。
    pub fn run_volume_loop_windows(ctx: super::VolumeLoopCtx) {
        let VolumeLoopCtx {
            spec,
            stop,
            stats,
            app,
        } = ctx;
        emit::emit_state(
            &app,
            StatePayload {
                volume: spec.key.clone(),
                running: true,
                reason: None,
            },
        );

        // 1) 卷类型闸门：非 NTFS 启动即降级（规格红线）。
        if let Some(reason) = fs_gate_block_reason(&query_fs_gate(&spec)) {
            return fatal(&stats, &app, &spec.key, reason);
        }

        // 2) 卷句柄 + journal。
        let mut session = match VolumeSession::open(&spec) {
            Ok(s) => s,
            Err(reason) => return fatal(&stats, &app, &spec.key, reason),
        };
        if let Err(reason) = session.ensure_journal() {
            return fatal(&stats, &app, &spec.key, reason);
        }

        // 3) 轮询主循环。用户排除规则（四处之一：USN filter）在 worker 启动
        //    时快照加载——改动 excludes.json 后重开监控生效（规格：用户规则
        //    只收紧可见面，命中的目录变更不再上报，也不计入 dropped——那是
        //    策略性隐藏，不是丢失）。
        let excludes = pinkbin_excludes::Excludes::load_default();
        let budget = RefreshBudget::default();
        let agg_cfg = AggregateConfig::default();
        let mut window = AggregateWindow::new(agg_cfg.clone());
        let mut pacer = Pacer::new(Duration::from_secs(1));
        let mut cache: HashMap<u64, Option<String>> = HashMap::new();
        let mut buf: Vec<u8> = vec![0u8; READ_BUF_START];
        // 降级警告只发一次的边沿闩；恢复（out.recovered）时复位。
        let mut backlog_warned = false;
        let mut next_usn = session.next_usn;

        'tick: loop {
            if stop.load(Ordering::Relaxed) {
                break 'tick;
            }
            let now = Instant::now();

            // 读尽当前积压（≤32 批，防饿死停止信号）。
            let mut reads = 0usize;
            while reads < 32 {
                reads += 1;
                buf.fill(0);
                match session.read_batch(next_usn, &mut buf) {
                    Ok(n) if n <= 8 => break, // 无新记录
                    Ok(n) => {
                        let parsed = parse_usn_buffer(&buf[..n]);
                        next_usn = parsed.next_usn;
                        for rec in parsed.records {
                            let Some(kind) = reason_to_kind(rec.reason) else {
                                continue;
                            };
                            stats.note_event();
                            let Some(parent) =
                                resolve_parent(&session, rec.parent_frn, &mut cache)
                            else {
                                stats.add_dropped(1);
                                continue;
                            };
                            if !starts_with_volume(&parent, &spec.root_path) {
                                stats.add_dropped(1);
                                continue;
                            }
                            // 用户排除规则（四处之一）：命中的目录变更静默
                            // 跳过——可见面收紧，不算 dropped。
                            if !excludes.is_empty()
                                && excludes.matches(std::path::Path::new(&parent))
                            {
                                continue;
                            }
                            let d = window.push(parent, kind, Instant::now());
                            stats.add_dropped(d);
                        }
                    }
                    Err(ERROR_MORE_DATA) if buf.len() < READ_BUF_MAX => {
                        // 缓冲吃紧：翻倍后从同一 USN 重读。
                        let grown = (buf.len() * 2).min(READ_BUF_MAX);
                        buf.resize(grown, 0);
                    }
                    Err(code) if is_journal_error(code) => {
                        // journal 被删/失效：尽力自救（重建 + 重置游标）；
                        // 救不回就按降级退出。
                        match session.ensure_journal() {
                            Ok(()) => next_usn = session.next_usn,
                            Err(reason) => return fatal(&stats, &app, &spec.key, reason),
                        }
                    }
                    Err(code) => {
                        tracing::warn!("monitor: FSCTL_READ_USN_JOURNAL 失败（win32 error {code}），跳过本节拍");
                        break;
                    }
                }
            }

            // 积压降级（规格：>1000 目录 → 建议重扫），迟滞恢复。降级状态
            // 由窗口自己维护（push 在越线时置位），这里只做边沿事件面。
            if window.is_degraded() && !backlog_warned {
                backlog_warned = true;
                emit::emit_state(
                    &app,
                    StatePayload {
                        volume: spec.key.clone(),
                        running: true,
                        reason: Some(format!(
                            "变更积压超过 {} 个目录，已降级，建议重扫",
                            agg_cfg.soft_limit
                        )),
                    },
                );
            }

            // 产出：每秒最多一次（Pacer），取到期目录重算并推 `usn://changes`。
            if pacer.ready(now) {
                let out = window.drain_due(now, budget.max_dirs_per_batch);
                if out.recovered {
                    backlog_warned = false;
                    emit::emit_state(
                        &app,
                        StatePayload {
                            volume: spec.key.clone(),
                            running: true,
                            reason: None,
                        },
                    );
                }
                if !out.dirs.is_empty() {
                    let dirs: Vec<DirChange> = out
                        .dirs
                        .iter()
                        .map(|hit| {
                            let ds = build_dir_stat(std::path::Path::new(&hit.path), hit.kind, &budget);
                            DirChange {
                                path: ds.path,
                                size: ds.size,
                                file_count: ds.file_count,
                                kind: ds.kind.as_str().to_string(),
                            }
                        })
                        .collect();
                    stats.set_last_refresh(now_epoch_ms());
                    pacer.mark(now);
                    tracing::debug!(
                        "monitor: 卷 {} 产出 {} 个受影响目录，累计丢弃 {}，剩余积压 {}",
                        spec.key,
                        dirs.len(),
                        stats.dropped_total(),
                        window.backlog()
                    );
                    emit::emit_changes(
                        &app,
                        ChangesPayload {
                            volume: spec.key.clone(),
                            dirs,
                            dropped: stats.dropped_total(),
                        },
                    );
                }
            }

            // 500ms 分片睡眠：stop 信号 ≤50ms 生效。
            for _ in 0..10 {
                if stop.load(Ordering::Relaxed) {
                    break 'tick;
                }
                std::thread::sleep(POLL_INTERVAL / 10);
            }
        }

        // 正常停止：「已停止」的 state 事件由 hub.stop 统一发出（避免双发），
        // 这里只保证状态复位 + 句柄随 session Drop 关闭（不阻塞卷卸载）。
        // stop_with(None) 不覆盖 hub 已写入的「已停止」原因。
        stats.stop_with(None);
    }

    /// 降级/致命退出：状态回已停止 + 发 `usn://state`（规格：不报错弹窗，
    /// 原因走状态与事件面）。
    fn fatal(stats: &VolumeStats, app: &tauri::AppHandle, volume: &str, reason: String) {
        tracing::warn!("monitor: 卷 {volume} 停止：{reason}");
        stats.stop_with(Some(reason.clone()));
        emit::emit_state(
            app,
            StatePayload {
                volume: volume.to_string(),
                running: false,
                reason: Some(reason),
            },
        );
    }
}

/// 当前 Unix 时间毫秒（monitor_status.last_refresh 的载体）。
pub fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 监控 worker 入口（hub spawn 的线程体）。非 Windows 平台注册即降级：
/// 状态回已停止 + 事件面说明，绝不 panic 拖垮主进程。
pub fn run_volume_loop(ctx: VolumeLoopCtx) {
    #[cfg(windows)]
    {
        win::run_volume_loop_windows(ctx);
    }
    #[cfg(not(windows))]
    {
        let VolumeLoopCtx {
            spec,
            stop: _,
            stats,
            app,
        } = ctx;
        stats.stop_with(Some("实时监控仅支持 Windows（NTFS USN Journal）".into()));
        emit::emit_state(
            &app,
            StatePayload {
                volume: spec.key,
                running: false,
                reason: Some("实时监控仅支持 Windows（NTFS USN Journal）".into()),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::filter::{
        USN_REASON_DATA_OVERWRITE, USN_REASON_FILE_CREATE, USN_REASON_FILE_DELETE,
        USN_REASON_RENAME_NEW_NAME, USN_REASON_RENAME_OLD_NAME,
    };

    /// 按 USN_RECORD_V2 的 ABI 手工拼一条记录（固定字节喂入 parse 的夹具）。
    fn record_bytes(frn: u64, parent: u64, reason: u32, attributes: u32, name: &str) -> Vec<u8> {
        let wide: Vec<u16> = name.encode_utf16().collect();
        let rl = (USN_RECORD_V2_HEADER + wide.len() * 2) as u32;
        let mut b = Vec::with_capacity(rl as usize);
        b.extend_from_slice(&rl.to_le_bytes()); // +0 RecordLength
        b.extend_from_slice(&2u16.to_le_bytes()); // +4 MajorVersion
        b.extend_from_slice(&0u16.to_le_bytes()); // +6 MinorVersion
        b.extend_from_slice(&frn.to_le_bytes()); // +8
        b.extend_from_slice(&parent.to_le_bytes()); // +16
        b.extend_from_slice(&1234i64.to_le_bytes()); // +24 Usn
        b.extend_from_slice(&0i64.to_le_bytes()); // +32 TimeStamp
        b.extend_from_slice(&reason.to_le_bytes()); // +40
        b.extend_from_slice(&0u32.to_le_bytes()); // +44 SourceInfo
        b.extend_from_slice(&0u32.to_le_bytes()); // +48 SecurityId
        b.extend_from_slice(&attributes.to_le_bytes()); // +52 FileAttributes
        b.extend_from_slice(&((wide.len() * 2) as u16).to_le_bytes()); // +56
        b.extend_from_slice(&(USN_RECORD_V2_HEADER as u16).to_le_bytes()); // +58
        for w in wide {
            b.extend_from_slice(&w.to_le_bytes());
        }
        b
    }

    #[test]
    fn parse_single_record_fixed_bytes() {
        let rec = record_bytes(
            0x0012_3456_789a,
            5,
            USN_REASON_FILE_CREATE,
            0x20, // FILE_ATTRIBUTE_ARCHIVE
            "hello.txt",
        );
        let mut buf = Vec::new();
        buf.extend_from_slice(&7777i64.to_le_bytes()); // journal NextUsn 头
        buf.extend_from_slice(&rec);
        let parsed = parse_usn_buffer(&buf);
        assert_eq!(parsed.next_usn, 7777);
        assert_eq!(parsed.records.len(), 1);
        let r = &parsed.records[0];
        assert_eq!(r.major, 2);
        assert_eq!(r.minor, 0);
        assert_eq!(r.frn, 0x0012_3456_789a);
        assert_eq!(r.parent_frn, 5);
        assert_eq!(r.usn, 1234);
        assert_eq!(r.reason, USN_REASON_FILE_CREATE);
        assert_eq!(r.attributes, 0x20);
        assert_eq!(r.name, "hello.txt");
        assert_eq!(r.record_length as usize, USN_RECORD_V2_HEADER + 18);
        assert_eq!(reason_to_kind(r.reason), Some(crate::filter::ChangeKind::Create));
    }

    #[test]
    fn parse_multi_record_and_truncated_tail() {
        let r1 = record_bytes(1, 5, USN_REASON_FILE_DELETE, 0, "gone.log");
        let r2 = record_bytes(2, 6, USN_REASON_RENAME_OLD_NAME | USN_REASON_RENAME_NEW_NAME, 0, "new-name.bin");
        let r3 = record_bytes(3, 7, USN_REASON_DATA_OVERWRITE, 0, "data.db");
        let mut buf = Vec::new();
        buf.extend_from_slice(&42i64.to_le_bytes());
        buf.extend_from_slice(&r1);
        buf.extend_from_slice(&r2);
        buf.extend_from_slice(&r3);
        // 截断 r3 的尾巴：解析必须安全停在完整记录边界。
        buf.truncate(buf.len() - 10);
        let parsed = parse_usn_buffer(&buf);
        assert_eq!(parsed.next_usn, 42);
        assert_eq!(parsed.records.len(), 2);
        assert_eq!(parsed.records[0].name, "gone.log");
        assert_eq!(
            reason_to_kind(parsed.records[1].reason),
            Some(crate::filter::ChangeKind::Rename)
        );
    }

    #[test]
    fn parse_empty_and_minimal_buffers() {
        assert_eq!(parse_usn_buffer(&[]).records.len(), 0);
        // 只有 8 字节头（USN 轮询无新记录的常态返回）。
        let only_head = 5i64.to_le_bytes();
        let parsed = parse_usn_buffer(&only_head);
        assert_eq!(parsed.next_usn, 5);
        assert!(parsed.records.is_empty());
        // record_length=0 的损坏条目：立即停，不进死循环。
        let mut bad = Vec::new();
        bad.extend_from_slice(&0i64.to_le_bytes());
        bad.extend_from_slice(&0u32.to_le_bytes());
        assert!(parse_usn_buffer(&bad).records.is_empty());
    }

    #[test]
    fn parse_skips_v3_record_by_length() {
        // V3 记录我们只按长度跳过（订阅的是 2..2，不会真来；防御兜底）。
        let mut v3 = Vec::new();
        v3.extend_from_slice(&104u32.to_le_bytes()); // RecordLength
        v3.extend_from_slice(&3u16.to_le_bytes()); // MajorVersion = 3
        v3.extend_from_slice(&0u16.to_le_bytes());
        v3.extend_from_slice(&[0u8; 104 - 8]);
        let r2 = record_bytes(9, 8, USN_REASON_FILE_CREATE, 0, "after.txt");
        let mut buf = Vec::new();
        buf.extend_from_slice(&1i64.to_le_bytes());
        buf.extend_from_slice(&v3);
        buf.extend_from_slice(&r2);
        let parsed = parse_usn_buffer(&buf);
        assert_eq!(parsed.records.len(), 1);
        assert_eq!(parsed.records[0].name, "after.txt");
        assert_eq!(parsed.records[0].frn, 9);
        assert_eq!(parsed.records[0].parent_frn, 8);
        assert_eq!(reason_to_kind(parsed.records[0].reason), Some(crate::filter::ChangeKind::Create));
    }

    #[test]
    fn parse_keeps_reason_mix_for_filter_pipeline() {
        // 一批混合 reason：解析层只做结构还原，分类交给 filter。
        let cases = [
            (USN_REASON_FILE_CREATE, "a.txt"),
            (USN_REASON_FILE_DELETE, "b.txt"),
            (USN_REASON_DATA_OVERWRITE, "c.txt"),
            (USN_REASON_RENAME_NEW_NAME, "d.txt"),
        ];
        let mut buf = Vec::new();
        buf.extend_from_slice(&0i64.to_le_bytes());
        for (i, (reason, name)) in cases.iter().enumerate() {
            buf.extend_from_slice(&record_bytes(i as u64, 5, *reason, 0, name));
        }
        let parsed = parse_usn_buffer(&buf);
        let kinds: Vec<_> = parsed
            .records
            .iter()
            .filter_map(|r| reason_to_kind(r.reason))
            .collect();
        assert_eq!(kinds.len(), 4, "四类 reason 全部有归属");
    }

    #[test]
    fn normalize_volume_matrix() {
        let want_c = |s: &str| normalize_volume(s).map(|v| v.key);
        assert_eq!(want_c("C").as_deref(), Some("C:"));
        assert_eq!(want_c("c").as_deref(), Some("C:"));
        assert_eq!(want_c("C:").as_deref(), Some("C:"));
        assert_eq!(want_c(r"c:\").as_deref(), Some("C:"));
        assert_eq!(want_c("C:/").as_deref(), Some("C:"));
        assert_eq!(want_c(r"\\.\C:").as_deref(), Some("C:"));
        assert_eq!(want_c(r"\\?\d:\").as_deref(), Some("D:"));
        let spec = normalize_volume("c").unwrap();
        assert_eq!(spec.device_path, r"\\.\C:");
        assert_eq!(spec.root_path, r"C:\");
        assert_eq!(spec.letter, 'C');
        assert_eq!(normalize_volume("").map(|v| v.key), None);
        assert_eq!(normalize_volume("1:").map(|v| v.key), None);
        assert_eq!(normalize_volume(r"\\server\share").map(|v| v.key), None);
        assert_eq!(normalize_volume(r"C:\Users\x").map(|v| v.key), None, "只收卷级标识，不收目录");
    }

    #[test]
    fn strip_verbatim_matrix() {
        assert_eq!(strip_verbatim(r"\\?\C:\Users\x"), r"C:\Users\x");
        assert_eq!(strip_verbatim(r"C:\Users\x"), r"C:\Users\x");
        assert_eq!(strip_verbatim(r"\\?\UNC\server\share"), r"\\server\share");
        assert_eq!(strip_verbatim(r"\\?\C:\"), r"C:\");
    }

    #[test]
    fn fs_gate_matrix() {
        use FsGate as G;
        assert_eq!(fs_gate(Some("NTFS"), None), G::Ntfs);
        assert_eq!(fs_gate(Some("ntfs"), None), G::Ntfs);
        assert_eq!(fs_gate(Some(" Ntfs "), None), G::Ntfs);
        assert_eq!(fs_gate(Some("exFAT"), None), G::OtherFs("exFAT".into()));
        assert_eq!(fs_gate(Some("ReFS"), None), G::OtherFs("ReFS".into()));
        assert_eq!(fs_gate(Some("Device Locker"), None), G::BitLockerLocked);
        assert_eq!(fs_gate(None, Some(5)), G::BitLockerLocked, "ACCESS_DENIED = BitLocker 指纹");
        assert_eq!(fs_gate(Some("NTFS"), Some(5)), G::BitLockerLocked, "拒绝优先于名字");
        assert_eq!(fs_gate(None, Some(21)), G::Unknown);
        assert_eq!(fs_gate(Some("  "), None), G::Unknown);
        assert_eq!(fs_gate(None, None), G::Unknown);
        // 降级文案：非 NTFS 必须明示，NTFS/Unknown 放行（None）。
        assert_eq!(fs_gate_block_reason(&G::Ntfs), None);
        assert_eq!(fs_gate_block_reason(&G::Unknown), None);
        assert_eq!(
            fs_gate_block_reason(&G::OtherFs("exFAT".into())).as_deref(),
            Some("非 NTFS 卷（exFAT），不支持实时监控")
        );
        assert!(fs_gate_block_reason(&G::BitLockerLocked).is_some());
    }

    #[test]
    fn poll_interval_is_spec_500ms() {
        assert_eq!(POLL_INTERVAL, Duration::from_millis(500));
    }
}
