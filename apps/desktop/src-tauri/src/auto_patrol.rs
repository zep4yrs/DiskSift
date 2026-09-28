//! 定时自动巡查（auto-patrol）后端。
//!
//! 两半：
//! 1) Task Scheduler 注册面（`auto_patrol_register` / `auto_patrol_unregister` /
//!    `auto_patrol_status`）——用 schtasks 管一个指向本 exe + `--auto` 的计划任务。
//!    `schtasks /Create` 默认「仅当前用户登录时运行」，注册本身不需要管理员权限。
//! 2) `--auto` 无头巡查（`run_headless`）——扫系统盘 → 读 triage-cache.json →
//!    只回收 verdict = "safe" 且签名（bytes + fileCount）仍匹配的目录 →
//!    走 pinkbin_executor 进回收站 + 追加 undo.jsonl → 退出，全程无 GUI。
//!
//! 安全纪律（绝不扩大）：只有 triage 缓存里 **safe 桶** 的目录可进回收站。
//! verdict 非 safe、签名不符（目录已变，判定过期，与前端 applyCache 同门槛）、
//! 体积低于巡查阈值、never-touch 片段命中、或落在本 app 数据目录内的一律跳过。
//! recycle 本身可恢复，但无人值守路径宁可漏清不可误清——本模块的守卫比前端
//! `isNeverTouch` 更严（整段名匹配而非子串）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use pinkbin_executor::{execute, is_never_touch, Action, Plan};
use pinkbin_scanner::{scan_with_stats, Node, ScanOptions};

/// 计划任务名。不加文件夹前缀（`\DiskSift\AutoPatrol` 形态要求文件夹已存在，
/// schtasks /Create 不会代建），平铺在根下最省事。
pub const AUTOPATROL_TASK_NAME: &str = "DiskSiftAutoPatrol";

/// 未指定 frequency 时的缺省档位：每周日 03:00（规格原始形态）。
pub const DEFAULT_FREQUENCY: &str = "weekly";

/// 巡查只对 ≥ 该体积的 safe 目录动手。triage-overlay-spec §6「只分析 > 阈值
/// （默认巡查阈值 1GB）」——小缓存清了没收益，只会给回收站制造噪音。
pub const AUTO_PATROL_MIN_BYTES: u64 = 1024 * 1024 * 1024;

/// 无头模式的数据目录。GUI 走 `app.path().app_data_dir()`，在 Windows 上就是
/// `%APPDATA%\{identifier}`；调度任务与 GUI 同用户运行，%APPDATA% 一定在，
/// 这里按 tauri.conf.json 的 identifier（dev.pinkbin.app）拼同一路径。
const HEADLESS_IDENTIFIER: &str = "dev.pinkbin.app";

// v26.1.2 高危修复：NEVER_TOUCH 段表与 is_never_touch 提升到公共位置
// pinkbin_executor::is_never_touch（execute() 的执行前守卫共用同一份），
// 本模块经 use 引入（见文件头 use 块）。共享表补了 recovery / windows.old，
// 语义只收紧不放松；无头巡查的逐目录过滤（原 :494）与 executor 的整单拒绝
// 构成无人值守路径的双保险。

// ── Task Scheduler 注册面 ────────────────────────────────────────────────────

/// frequency → `schtasks /Create` 的调度参数。时刻沿用规格缺省
/// （每周日 03:00），前端不需要让用户挑钟点。
fn schedule_args(frequency: &str) -> Result<Vec<&'static str>, String> {
    match frequency {
        "hourly" => Ok(vec!["/SC", "HOURLY", "/MO", "1", "/ST", "00:30"]),
        "daily" => Ok(vec!["/SC", "DAILY", "/ST", "03:00"]),
        "weekly" => Ok(vec!["/SC", "WEEKLY", "/D", "SUN", "/ST", "03:00"]),
        "monthly" => Ok(vec!["/SC", "MONTHLY", "/D", "1", "/ST", "04:00"]),
        other => Err(format!(
            "不支持的巡查频率: {other}（可选 hourly / daily / weekly / monthly）"
        )),
    }
}

/// schtasks 输出重定向到管道时的解码。两种实测形态：
/// - UTF-16LE（带 BOM，老系统）；
/// - OEM/ANSI 代码页（本机 Win11 26200 / zh-CN 实测是 cp936——lossy UTF-8
///   会把本地化状态文本变乱码，所以按系统 OEM 代码页解）。
///
/// XML / CSV 的结构标记全是 ASCII，任何代码页下字节一致，解析不受影响。
fn decode_console_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let units: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    decode_ansi(bytes)
}

#[cfg(windows)]
fn decode_ansi(bytes: &[u8]) -> String {
    use windows_sys::Win32::Globalization::{MultiByteToWideChar, CP_OEMCP};
    if !bytes.is_empty() {
        // SAFETY: 两段式调用（先量长度再解），输入指针指向调用方缓冲，
        // 输出缓冲按第一次调用返回的长度分配，两次调用间的窗口内无并发写。
        unsafe {
            let len = MultiByteToWideChar(
                CP_OEMCP,
                0,
                bytes.as_ptr(),
                bytes.len() as i32,
                std::ptr::null_mut(),
                0,
            );
            if len > 0 {
                let mut buf = vec![0u16; len as usize];
                let written = MultiByteToWideChar(
                    CP_OEMCP,
                    0,
                    bytes.as_ptr(),
                    bytes.len() as i32,
                    buf.as_mut_ptr(),
                    len,
                );
                if written > 0 {
                    buf.truncate(written as usize);
                    return String::from_utf16_lossy(&buf);
                }
            }
        }
    }
    String::from_utf8_lossy(bytes).into_owned()
}

#[cfg(not(windows))]
fn decode_ansi(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `<tag>value</tag>` 的朴素提取。schtasks 的 XML 是机器生成的单行规范输出，
/// 不值得为此引一个 XML 依赖。
fn extract_xml_element(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = start + xml[start..].find(&close)?;
    Some(xml[start..end].trim().to_string())
}

/// Task Scheduler XML 触发器形态 → frequency。形态全部按本机（Win11 26200）
/// schtasks 实测校准：
/// - weekly / monthly / daily 是 `<ScheduleBy*>` 日历触发；
/// - /SC HOURLY 是 TimeTrigger + `<Repetition><Interval>PT1H</Interval>`；
///   不能只查 "PT1H"——/SC DAILY 的 XML 里 `<IdleSettings><WaitTimeout>` 默认
///   就带一个 PT1H（实测），只查 PT1H 会把 daily 误判成 hourly。
/// - 老系统的 /SC HOURLY 形态是 ScheduleByDay + PT1H repetition，同样覆盖。
fn frequency_from_task_xml(xml: &str) -> String {
    if xml.contains("<ScheduleByWeek>") {
        "weekly".into()
    } else if xml.contains("<ScheduleByMonth>") {
        "monthly".into()
    } else if xml.contains("<ScheduleByDay>") {
        if xml.contains("<Interval>PT1H</Interval>") {
            "hourly".into()
        } else {
            "daily".into()
        }
    } else if xml.contains("<Repetition>") && xml.contains("<Interval>PT1H</Interval>") {
        "hourly".into()
    } else {
        "unknown".into()
    }
}

/// `schtasks /FO CSV /NH` 的一行 → (下次运行时间, 状态)。字段数随系统版本
/// 不同（实测 26200 为三格：TaskName, Next Run Time, Status；部分系统带
/// 主机名列四格）——锚定任务名字段后取后两格，不按固定下标猜。任务名在
/// CSV 里带根前缀（"\DiskSiftAutoPatrol"，实测），锚定前剥掉。状态文本随
/// 系统语言本地化，原样带出。
fn parse_status_csv(line: &str, task_name: &str) -> (Option<String>, Option<String>) {
    let fields = csv_quoted_fields(line);
    match fields
        .iter()
        .position(|f| f.trim_start_matches('\\') == task_name)
    {
        Some(pos) => (fields.get(pos + 1).cloned(), fields.get(pos + 2).cloned()),
        None => (None, None),
    }
}

/// `schtasks /FO CSV` 的一行 → 引号字段序列（`"a","b"` → [a, b]）。
/// 状态/下次运行时间的文本随系统语言本地化，原样带出，不解析含义。
fn csv_quoted_fields(line: &str) -> Vec<String> {
    line.split('"')
        .enumerate()
        .filter(|(i, _)| i % 2 == 1)
        .map(|(_, s)| s.to_string())
        .collect()
}

#[cfg(windows)]
fn run_schtasks(args: &[&str]) -> Result<(bool, String), String> {
    let out = std::process::Command::new("schtasks")
        .args(args)
        .output()
        .map_err(|e| format!("schtasks 启动失败: {e}"))?;
    let mut raw = out.stdout;
    raw.extend_from_slice(&out.stderr);
    Ok((out.status.success(), decode_console_output(&raw)))
}

/// 注册/更新巡查计划任务。/F 覆盖同名旧任务，重复注册 = 改频率。
/// 返回生效的 frequency（回显给前端）。
#[tauri::command]
pub fn auto_patrol_register(frequency: Option<String>) -> Result<String, String> {
    let freq = frequency.as_deref().unwrap_or(DEFAULT_FREQUENCY);
    let sched = schedule_args(freq)?;
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| format!("current_exe 失败: {e}"))?;
        // /TR 的值整体是一个命令行：exe 路径可能带空格，必须自带引号。
        let tr = format!("\"{}\" --auto", exe.display());
        let mut args: Vec<String> = vec![
            "/Create".into(),
            "/F".into(),
            "/TN".into(),
            AUTOPATROL_TASK_NAME.into(),
            "/TR".into(),
            tr,
        ];
        args.extend(sched.iter().map(|s| s.to_string()));
        let refs: Vec<&str> = args.iter().map(String::as_str).collect();
        let (ok, out) = run_schtasks(&refs)?;
        if !ok {
            return Err(format!("schtasks /Create 失败: {}", out.trim()));
        }
        tracing::info!("auto-patrol task registered: freq={freq} task={AUTOPATROL_TASK_NAME}");
        Ok(freq.to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = sched;
        Err("auto_patrol_register 仅在 Windows 上实现（Task Scheduler）".into())
    }
}

/// 注销巡查计划任务。未注册时幂等成功（Settings 开关反复拨不报错）。
#[tauri::command]
pub fn auto_patrol_unregister() -> Result<(), String> {
    #[cfg(windows)]
    {
        let del_args = ["/Delete", "/TN", AUTOPATROL_TASK_NAME, "/F"];
        let (ok, out) = run_schtasks(&del_args)?;
        if ok {
            tracing::info!("auto-patrol task unregistered: task={AUTOPATROL_TASK_NAME}");
            return Ok(());
        }
        // 删除失败先问一句是否存在：不存在 = 本来就没注册，按幂等成功处理。
        let qargs = ["/Query", "/TN", AUTOPATROL_TASK_NAME];
        let (qok, _) = run_schtasks(&qargs)?;
        if !qok {
            return Ok(());
        }
        Err(format!("schtasks /Delete 失败: {}", out.trim()))
    }
    #[cfg(not(windows))]
    {
        Err("auto_patrol_unregister 仅在 Windows 上实现（Task Scheduler）".into())
    }
}

/// 巡查计划任务的注册状态。Settings UI 用 registered + frequency 渲染开关，
/// 其余字段是诊断信息（本地化文本原样展示）。
#[derive(serde::Serialize, Clone)]
pub struct AutoPatrolStatus {
    pub registered: bool,
    /// "hourly" | "daily" | "weekly" | "monthly"；未注册 = ""，识别不了 = "unknown"。
    pub frequency: String,
    pub task_name: String,
    /// 计划任务里登记的本 exe 路径（XML `<Command>`）。
    pub exe_path: Option<String>,
    /// 下次运行时间（schtasks CSV 原样文本，本地化格式）。
    pub next_run: Option<String>,
    /// 任务状态（schtasks CSV 原样文本，如「就绪」/ Ready）。
    pub status: Option<String>,
    /// 任务存在但被停用（schtasks /Change /DISABLE）时为 false。
    pub enabled: bool,
}

#[tauri::command]
pub fn auto_patrol_status() -> Result<AutoPatrolStatus, String> {
    #[cfg(windows)]
    {
        let unregistered = AutoPatrolStatus {
            registered: false,
            frequency: String::new(),
            task_name: AUTOPATROL_TASK_NAME.into(),
            exe_path: None,
            next_run: None,
            status: None,
            enabled: false,
        };
        let xml_args = ["/Query", "/TN", AUTOPATROL_TASK_NAME, "/XML"];
        let (ok, xml) = run_schtasks(&xml_args)?;
        if !ok {
            return Ok(unregistered);
        }
        let frequency = frequency_from_task_xml(&xml);
        // 实测 /TR 里的引号路径会被原样带进 <Command>（"C:\...\cmd.exe"），
        // 展示前剥掉包裹引号。
        let exe_path =
            extract_xml_element(&xml, "Command").map(|c| c.trim_matches('"').trim().to_string());
        // 任务 XML 省略 <Enabled> 时默认为 true。
        let enabled = extract_xml_element(&xml, "Enabled")
            .map(|v| v != "false")
            .unwrap_or(true);
        let mut next_run = None;
        let mut status_text = None;
        let csv_args = ["/Query", "/TN", AUTOPATROL_TASK_NAME, "/FO", "CSV", "/NH"];
        let (csv_ok, csv) = run_schtasks(&csv_args)?;
        if csv_ok {
            if let Some(line) = csv.lines().find(|l| l.contains(AUTOPATROL_TASK_NAME)) {
                let (next, st) = parse_status_csv(line, AUTOPATROL_TASK_NAME);
                next_run = next;
                status_text = st;
            }
        }
        Ok(AutoPatrolStatus {
            registered: true,
            frequency,
            task_name: AUTOPATROL_TASK_NAME.into(),
            exe_path,
            next_run,
            status: status_text,
            enabled,
        })
    }
    #[cfg(not(windows))]
    {
        Err("auto_patrol_status 仅在 Windows 上实现（Task Scheduler）".into())
    }
}

// ── `--auto` 无头巡查 ────────────────────────────────────────────────────────

/// triage-cache.json 的一条判定。缓存整文件由前端 cache_set_all 写入，
/// 键 = 扫描树 Node.path（原生分隔符），值 = 前端 CachedVerdict。
#[derive(serde::Deserialize, Default)]
struct TriageCacheFile {
    #[serde(default)]
    entries: HashMap<String, CachedVerdict>,
}

/// 字段名必须对齐前端 serializeCache（triage-cache.ts:102-107）的 camelCase
/// 落盘形态（`fileCount`）：Rust 侧若按裸 `file_count` 反序列化，该字段恒为
/// 默认 0，签名闸门（`entry.file_count != n.file_count`）会把每个真实目录都
/// 拒掉，巡查退化成静默 no-op（review 实测复现过）。verdict/bytes 单词名
/// 两种写法同形，不受 rename_all 影响。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedVerdict {
    #[serde(default)]
    verdict: String,
    #[serde(default)]
    bytes: u64,
    #[serde(default)]
    file_count: u64,
}

/// `--auto` 入口：无 GUI 巡查，返回进程退出码。
/// 0 = 正常（含「没有可清项」）；非零 = 失败（缓存读取/解析、扫描或清理），
/// 退出码不细分档位——调度任务里唯一消费者是用户看日志，细分没有意义。
pub fn run_headless() -> i32 {
    match patrol_once() {
        Ok((count, bytes)) => {
            tracing::info!("auto-patrol done: dirs={count} bytes={bytes}");
            eprintln!("auto-patrol done: dirs={count} bytes={bytes}");
            0
        }
        Err(e) => {
            tracing::error!("auto-patrol failed: {e}");
            eprintln!("auto-patrol failed: {e}");
            1
        }
    }
}

fn patrol_once() -> Result<(usize, u64), String> {
    let data_dir = headless_data_dir();
    let undo_log = data_dir.join("undo.jsonl");
    let quarantine_root = data_dir.join("quarantine");

    // 缓存缺失（首次使用）= 没有判定，本轮无事可做——不是错误。
    let cache_text = match std::fs::read_to_string(data_dir.join("triage-cache.json")) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => "{}".to_string(),
        Err(e) => return Err(format!("triage-cache.json 读取失败: {e}")),
    };
    // 缓存损坏按致命处理而不是当空表：无人值守路径上，"静默清零"和
    // "带病运行"都不如实话实说退出非零。
    let cache: TriageCacheFile = serde_json::from_str(&cache_text)
        .map_err(|e| format!("triage-cache.json 解析失败: {e}"))?;

    let root = system_drive_root();
    let (tree, _stats) = scan_with_stats(&root, ScanOptions::default(), |_| {})
        .map_err(|e| format!("{} 扫描失败: {e}", root.display()))?;

    let mut candidates: Vec<PathBuf> = Vec::new();
    collect_safe_candidates(&tree, false, &cache.entries, &data_dir, &mut candidates);
    if candidates.is_empty() {
        return Ok((0, 0));
    }

    // 一次性进回收站：Action::Recycle 由 executor 落系统回收站并追加
    // undo.jsonl——与 GUI 的 execute_plan 同一条写入路径。
    let plan = Plan {
        action: Action::Recycle,
        paths: candidates,
        reason: "auto-patrol: --auto 定时巡查（safe 桶）".into(),
    };
    let entries = execute(&plan, false, &undo_log, &quarantine_root)
        .map_err(|e| format!("巡查清理失败: {e}"))?;
    let bytes = entries.iter().filter_map(|e| e.bytes).sum();
    Ok((entries.len(), bytes))
}

/// 与 GUI 相同的数据目录（undo.jsonl / triage-cache.json 都在这里）。
fn headless_data_dir() -> PathBuf {
    std::env::var("APPDATA")
        .ok()
        .map(|base| PathBuf::from(base).join(HEADLESS_IDENTIFIER))
        .unwrap_or_else(|| PathBuf::from(".pinkbin"))
}

/// 巡查扫描根。规格写的是 C 盘；用系统盘环境变量（绝大多数机器就是 C:）
/// 兜住系统盘不在 C: 的少数派。
fn system_drive_root() -> PathBuf {
    system_drive_root_from(std::env::var("SystemDrive").ok().as_deref())
}

/// 纯函数形态（可脱离进程环境单测）。
fn system_drive_root_from(system_drive: Option<&str>) -> PathBuf {
    let drive = system_drive.unwrap_or("C:");
    PathBuf::from(format!("{}\\", drive.trim_end_matches('\\')))
}

/// DFS 收集本轮可回收目录。`covered` = 祖先已被接受（整目录进回收站时
/// 子目录不用重复动手）。先序遍历保证 out 里祖先在前，覆盖判断无需排序。
fn collect_safe_candidates(
    node: &Node,
    covered: bool,
    cache: &HashMap<String, CachedVerdict>,
    data_dir: &Path,
    out: &mut Vec<PathBuf>,
) {
    for child in &node.children {
        if !child.is_dir {
            continue;
        }
        let accepted = if covered {
            false
        } else {
            consider_candidate(child, cache, data_dir, out)
        };
        collect_safe_candidates(child, covered || accepted, cache, data_dir, out);
    }
}

/// 全部闸门都过才返回 true（并 push 进 out）。任何一条不过 = 跳过。
fn consider_candidate(
    n: &Node,
    cache: &HashMap<String, CachedVerdict>,
    data_dir: &Path,
    out: &mut Vec<PathBuf>,
) -> bool {
    let Some(entry) = cache.get(&n.path) else {
        return false;
    };
    if entry.verdict != "safe" {
        return false;
    }
    // 签名不符 = 判定之后目录变过（前端 applyCache 同门槛，triage-cache.ts），
    // 过期判定绝不动手。
    if entry.bytes != n.size || entry.file_count != n.file_count {
        return false;
    }
    if n.size < AUTO_PATROL_MIN_BYTES {
        return false;
    }
    // 数据目录守卫不能用 Path::starts_with 裸判——它是字节级比较（大小写
    // 敏感），而 %APPDATA% 展开值与扫描器报出的路径大小写没有同源保证。
    // （data_dir 恒非空：headless_data_dir 的两条分支都带目录段。）
    let p_norm = n.path.replace('/', "\\").to_ascii_lowercase();
    let dd_norm = data_dir
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    if p_norm == dd_norm || p_norm.starts_with(&format!("{dd_norm}\\")) {
        return false;
    }
    if is_never_touch(&n.path) {
        return false;
    }
    out.push(PathBuf::from(&n.path));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1024 * 1024 * 1024;

    fn dir_node(name: &str, path: &str, size: u64, file_count: u64, children: Vec<Node>) -> Node {
        Node {
            name: name.into(),
            path: path.into(),
            is_dir: true,
            size,
            file_count,
            children,
            scaffold_id: None,
            top_extensions: Vec::new(),
        }
    }

    fn verdict(v: &str, bytes: u64, file_count: u64) -> CachedVerdict {
        CachedVerdict {
            verdict: v.into(),
            bytes,
            file_count,
        }
    }

    #[test]
    fn schedule_args_matrix() {
        assert_eq!(
            schedule_args("weekly").unwrap(),
            vec!["/SC", "WEEKLY", "/D", "SUN", "/ST", "03:00"]
        );
        assert_eq!(
            schedule_args("daily").unwrap(),
            vec!["/SC", "DAILY", "/ST", "03:00"]
        );
        assert_eq!(
            schedule_args("monthly").unwrap(),
            vec!["/SC", "MONTHLY", "/D", "1", "/ST", "04:00"]
        );
        assert_eq!(
            schedule_args("hourly").unwrap(),
            vec!["/SC", "HOURLY", "/MO", "1", "/ST", "00:30"]
        );
        assert!(schedule_args("yearly").is_err());
        assert!(schedule_args("").is_err());
    }

    #[test]
    fn decode_handles_utf16le_bom_and_plain_utf8() {
        // "ok" 的 UTF-16LE + BOM。
        assert_eq!(
            decode_console_output(&[0xFF, 0xFE, 0x6F, 0x00, 0x6B, 0x00]),
            "ok"
        );
        assert_eq!(decode_console_output(b"ready"), "ready");
    }

    /// 本机实测（Win11 26200 / zh-CN）：schtasks 管道输出是 cp936，锁住
    /// 「本地化状态文本不再乱码」这一行为。
    #[cfg(windows)]
    #[test]
    fn decode_gbk_console_output() {
        assert_eq!(decode_console_output(&[0xB4, 0xED, 0xCE, 0xF3]), "错误");
        assert_eq!(decode_console_output(b"ERROR:"), "ERROR:");
    }

    #[test]
    fn frequency_from_xml_variants() {
        // 形态全部取自本机 schtasks 实测输出（Win11 26200）。
        assert_eq!(
            frequency_from_task_xml(
                "<Triggers><TimeTrigger><StartBoundary>2026-09-28T00:30:00</StartBoundary>\
                 <Repetition><Interval>PT1H</Interval></Repetition></TimeTrigger></Triggers>"
            ),
            "hourly"
        );
        // 老系统 /SC HOURLY 形态：ScheduleByDay + PT1H repetition。
        assert_eq!(
            frequency_from_task_xml(
                "<CalendarTrigger><Repetition><Interval>PT1H</Interval></Repetition>\
                 <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>"
            ),
            "hourly"
        );
        // 回归锁：/SC DAILY 的 XML 默认带 IdleSettings/WaitTimeout=PT1H，
        // 只查 PT1H 会把 daily 误判成 hourly（实测踩过）。
        assert_eq!(
            frequency_from_task_xml(
                "<Settings><IdleSettings><Duration>PT10M</Duration>\
                 <WaitTimeout>PT1H</WaitTimeout></IdleSettings></Settings>\
                 <Triggers><CalendarTrigger><StartBoundary>2026-09-28T03:00:00</StartBoundary>\
                 <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>"
            ),
            "daily"
        );
        assert_eq!(
            frequency_from_task_xml(
                "<Triggers><CalendarTrigger><ScheduleByWeek><DaysOfWeek><Sunday /></DaysOfWeek>\
                 </ScheduleByWeek></CalendarTrigger></Triggers>"
            ),
            "weekly"
        );
        assert_eq!(
            frequency_from_task_xml(
                "<Triggers><CalendarTrigger><ScheduleByMonth><DayOfMonth>1</DayOfMonth>\
                 </ScheduleByMonth></CalendarTrigger></Triggers>"
            ),
            "monthly"
        );
        assert_eq!(
            frequency_from_task_xml("<Triggers><BootTrigger /></Triggers>"),
            "unknown"
        );
    }

    #[test]
    fn parse_status_csv_anchors_on_task_name() {
        // 本机实测行（/NH 三格：TaskName, Next Run, Status）。
        let line = r#""\DiskSiftAutoPatrol","2026/10/4 3:00:00","就绪""#;
        let (next, status) = parse_status_csv(line, "DiskSiftAutoPatrol");
        assert_eq!(next.as_deref(), Some("2026/10/4 3:00:00"));
        assert_eq!(status.as_deref(), Some("就绪"));
        // 四格形态（带主机名列的旧系统）同样锚定任务名取后两格。
        let with_host = r#""\\PC","DiskSiftAutoPatrol","2026/10/4 3:00:00","Ready""#;
        let (next, status) = parse_status_csv(with_host, "DiskSiftAutoPatrol");
        assert_eq!(next.as_deref(), Some("2026/10/4 3:00:00"));
        assert_eq!(status.as_deref(), Some("Ready"));
        // 找不到任务名 → 两项皆空。
        assert_eq!(
            parse_status_csv(r#""other","x","y""#, "DiskSiftAutoPatrol"),
            (None, None)
        );
    }

    #[test]
    fn extract_xml_element_and_csv_fields() {
        assert_eq!(
            extract_xml_element(
                "<Actions><Command>C:\\tools\\pinkbin.exe</Command></Actions>",
                "Command"
            ),
            Some("C:\\tools\\pinkbin.exe".into())
        );
        // /TR 的引号路径原样进 <Command>（实测）。
        assert_eq!(
            extract_xml_element(
                "<Command>\"C:\\Windows\\System32\\cmd.exe\"</Command>",
                "Command"
            ),
            Some("\"C:\\Windows\\System32\\cmd.exe\"".into())
        );
        assert_eq!(extract_xml_element("nothing here", "Command"), None);
        // 引号段切分语义：未加引号的前导主机名列（真实输出里主机名列要么
        // 不存在、要么带引号——见 parse_status_csv_anchors_on_task_name 的
        // 四格形态）不构成引号段，被丢弃；生产路径锚定的是任务名字段，
        // schtasks 对它恒加引号（实测）。
        assert_eq!(
            csv_quoted_fields(r#"\\PC,"DiskSiftAutoPatrol","2026/9/29 3:00:00","就绪","#),
            vec![
                "DiskSiftAutoPatrol".to_string(),
                "2026/9/29 3:00:00".to_string(),
                "就绪".to_string()
            ]
        );
    }

    #[test]
    fn never_touch_matches_whole_segments_only() {
        assert!(is_never_touch(r"C:\Windows\Temp"));
        assert!(is_never_touch(r"C:\Program Files (x86)\X"));
        assert!(is_never_touch("C:/Users/u/Documents/archive"));
        assert!(is_never_touch(r"C:\$Recycle.Bin\sid"));
        // 子串误伤检查：段名完整相等才算。
        assert!(!is_never_touch(r"C:\tools\windows-cleaner\cache"));
        assert!(!is_never_touch("C:/cache/reboot-helper"));
    }

    #[test]
    fn patrol_collects_only_fresh_safe_above_threshold() {
        let data_dir = PathBuf::from(r"C:\roam\dev.pinkbin.app");
        let mut cache = HashMap::new();
        cache.insert(r"C:\c\bigcache".to_string(), verdict("safe", 2 * GB, 10));
        cache.insert(
            r"C:\c\stale".to_string(),
            verdict("safe", 3 * GB, 10), // 签名不符：实际 2GB/10
        );
        cache.insert(
            r"C:\c\small".to_string(),
            verdict("safe", 5 * 1024 * 1024, 3), // 低于 1GB 阈值
        );
        cache.insert(
            r"C:\c\decided".to_string(),
            verdict("decide", 2 * GB, 7), // 非 safe 桶
        );
        cache.insert(r"C:\c\parent\fresh".to_string(), verdict("safe", 2 * GB, 4));

        let tree = dir_node(
            "C:",
            r"C:\",
            100 * GB,
            1000,
            vec![
                dir_node("bigcache", r"C:\c\bigcache", 2 * GB, 10, vec![]),
                dir_node("stale", r"C:\c\stale", 2 * GB, 10, vec![]),
                dir_node("small", r"C:\c\small", 5 * 1024 * 1024, 3, vec![]),
                dir_node("decided", r"C:\c\decided", 2 * GB, 7, vec![]),
                dir_node(
                    "parent",
                    r"C:\c\parent",
                    2 * GB,
                    4,
                    vec![dir_node("fresh", r"C:\c\parent\fresh", 2 * GB, 4, vec![])],
                ),
            ],
        );

        let mut out = Vec::new();
        collect_safe_candidates(&tree, false, &cache, &data_dir, &mut out);
        assert_eq!(
            out,
            vec![
                PathBuf::from(r"C:\c\bigcache"),
                PathBuf::from(r"C:\c\parent\fresh")
            ]
        );
    }

    #[test]
    fn patrol_ancestor_coverage_skips_descendants_and_data_dir() {
        let data_dir = PathBuf::from(r"C:\roam\dev.pinkbin.app");
        let mut cache = HashMap::new();
        // 祖先命中 → 子目录即使也有 fresh safe 判定也不再动手。
        // 签名必须与树上一致（outer 3GB/15 含 inner 的 1GB/5）。
        cache.insert(r"C:\c\outer".to_string(), verdict("safe", 3 * GB, 15));
        cache.insert(r"C:\c\outer\inner".to_string(), verdict("safe", GB, 5));
        // 本 app 数据目录整棵拒绝。
        cache.insert(
            r"C:\roam\dev.pinkbin.app\quarantine\junk".to_string(),
            verdict("safe", 2 * GB, 1),
        );

        let tree = dir_node(
            "C:",
            r"C:\",
            100 * GB,
            1000,
            vec![
                dir_node(
                    "outer",
                    r"C:\c\outer",
                    3 * GB,
                    15,
                    vec![dir_node("inner", r"C:\c\outer\inner", GB, 5, vec![])],
                ),
                dir_node(
                    "junk",
                    r"C:\roam\dev.pinkbin.app\quarantine\junk",
                    2 * GB,
                    1,
                    vec![],
                ),
            ],
        );

        let mut out = Vec::new();
        collect_safe_candidates(&tree, false, &cache, &data_dir, &mut out);
        assert_eq!(out, vec![PathBuf::from(r"C:\c\outer")]);
    }

    /// 回归锁（review high 修复）：serializeCache（triage-cache.ts:102-107）
    /// 落盘的判定是 camelCase `fileCount`——deserialize 侧漏 rename_all 时
    /// file_count 恒反序列化为 0，签名闸门拒绝所有真实目录，巡查静默 no-op
    /// （review 用 scratch crate 实测复现）。用前端真实序列化形态锁死。
    #[test]
    fn cached_verdict_parses_frontend_serializecache_shape() {
        let raw = r#"{"version":1,"entries":{"C:\\c\\big":{"verdict":"safe","bytes":2000000000,"fileCount":42,"reason":"npm · 标准缓存，可清","source":"ai","ts":1727500000000}}}"#;
        let cache: TriageCacheFile = serde_json::from_str(raw).unwrap();
        let e = cache
            .entries
            .get(r"C:\c\big")
            .expect("entry key must survive roundtrip");
        assert_eq!(e.verdict, "safe");
        assert_eq!(e.bytes, 2_000_000_000);
        assert_eq!(e.file_count, 42, "camelCase fileCount 必须落到 file_count");
    }

    #[test]
    fn system_drive_root_from_env_or_default() {
        assert_eq!(system_drive_root_from(None), PathBuf::from(r"C:\"));
        assert_eq!(system_drive_root_from(Some("C:")), PathBuf::from(r"C:\"));
        assert_eq!(system_drive_root_from(Some("D:")), PathBuf::from(r"D:\"));
    }
}
