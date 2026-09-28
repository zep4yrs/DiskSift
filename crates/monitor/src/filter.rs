//! USN 变更过滤（release-plan-26.1.4.0 §1 菜1）。
//!
//! 只保留四类有用户可见意义的变更：rename / create / delete / data-overwrite，
//! 其余（security/EA/close/对象ID…）直接丢弃。卷前缀过滤是兜底防线：只有能
//! 解析到本卷根（如 `C:\`）之下的路径才进入聚合。
//!
//! 全模块纯函数、跨平台（常量值是 ABI 稳定的 Win32 错误/标志码，与
//! windows-sys-0.59 `Win32::System::Ioctl` 逐一核对过），可脱离物理卷单测。

/// USN reason 位（win32 fsctl USN_RECORD_V2.Reason）。与 windows-sys-0.59
/// `Win32::System::Ioctl` 的同名常量逐一相等（本文件故意自带一份，让纯逻辑
/// 可以在任意平台编译与单测，journal.rs 的 windows 路径直接引用这些常量）。
pub const USN_REASON_DATA_OVERWRITE: u32 = 0x0000_0001;
pub const USN_REASON_DATA_EXTEND: u32 = 0x0000_0002;
pub const USN_REASON_DATA_TRUNCATION: u32 = 0x0000_0004;
pub const USN_REASON_NAMED_DATA_OVERWRITE: u32 = 0x0000_0010;
pub const USN_REASON_NAMED_DATA_EXTEND: u32 = 0x0000_0020;
pub const USN_REASON_NAMED_DATA_TRUNCATION: u32 = 0x0000_0040;
pub const USN_REASON_FILE_CREATE: u32 = 0x0000_0100;
pub const USN_REASON_FILE_DELETE: u32 = 0x0000_0200;
pub const USN_REASON_RENAME_OLD_NAME: u32 = 0x0000_1000;
pub const USN_REASON_RENAME_NEW_NAME: u32 = 0x0000_2000;
// CLOSE 有意不订阅（实时监控按事件即刻上报，不等句柄关闭）；常量保留是
// 为了 reason_to_kind 的「显式丢弃」测试与文档完整性。
#[allow(dead_code)]
pub const USN_REASON_CLOSE: u32 = 0x8000_0000;

/// 订阅掩码：只向内核订阅我们有兴趣的四类（数据写入类按一个桶处理）。
/// 不订阅 CLOSE——实时监控按事件即刻上报，不等句柄关闭。
pub const INTEREST_REASONS: u32 = USN_REASON_DATA_OVERWRITE
    | USN_REASON_DATA_EXTEND
    | USN_REASON_DATA_TRUNCATION
    | USN_REASON_NAMED_DATA_OVERWRITE
    | USN_REASON_NAMED_DATA_EXTEND
    | USN_REASON_NAMED_DATA_TRUNCATION
    | USN_REASON_FILE_CREATE
    | USN_REASON_FILE_DELETE
    | USN_REASON_RENAME_OLD_NAME
    | USN_REASON_RENAME_NEW_NAME;

/// 变更种类（CONTRACT：`usn://changes` 载荷 dirs[].kind 的取值域）。
/// `as_str()` 的四个返回值就是前端/mock 看到的字符串，逐字冻结。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChangeKind {
    /// 数据被写入（overwrite/extend/truncation，含 ADS 命名流）——尺寸会变。
    Overwrite,
    /// 新建。
    Create,
    /// 改名/移动（同一批 rename 产 OLD+NEW 两条记录，两边的父目录都要上报）。
    Rename,
    /// 删除。
    Delete,
}

impl ChangeKind {
    /// CONTRACT 字符串。聚合合并时取优先级最高者（Ord 派生序即优先级：
    /// Delete > Rename > Create > Overwrite——删除对用户的冲击最大）。
    pub fn as_str(self) -> &'static str {
        match self {
            ChangeKind::Overwrite => "overwrite",
            ChangeKind::Create => "create",
            ChangeKind::Rename => "rename",
            ChangeKind::Delete => "delete",
        }
    }
}

/// 单条 USN 记录的 reason → 是否关心 + 归类。不关心的 reason 返回 None
/// （filter.rs 的「只留 rename/create/delete/data-overwrite」）。
pub fn reason_to_kind(reason: u32) -> Option<ChangeKind> {
    if reason & (USN_REASON_FILE_CREATE) != 0 {
        return Some(ChangeKind::Create);
    }
    if reason & (USN_REASON_FILE_DELETE) != 0 {
        return Some(ChangeKind::Delete);
    }
    if reason & (USN_REASON_RENAME_OLD_NAME | USN_REASON_RENAME_NEW_NAME) != 0 {
        return Some(ChangeKind::Rename);
    }
    if reason
        & (USN_REASON_DATA_OVERWRITE
            | USN_REASON_DATA_EXTEND
            | USN_REASON_DATA_TRUNCATION
            | USN_REASON_NAMED_DATA_OVERWRITE
            | USN_REASON_NAMED_DATA_EXTEND
            | USN_REASON_NAMED_DATA_TRUNCATION)
        != 0
    {
        return Some(ChangeKind::Overwrite);
    }
    None
}

/// 剥 verbatim 前缀（`\\?\C:\x` → `C:\x`）。独立 fn 而非闭包：闭包推断
/// 会在返回借用上撞生命周期。
fn strip_verbatim(s: &str) -> &str {
    s.strip_prefix(r"\\?\").unwrap_or(s)
}

/// 卷前缀过滤：`path` 是否位于 `volume_root`（如 `C:\`）之下。
/// 大小写不敏感、分隔符归一、组件边界安全（`C:\Users2` 不算 `C:\Users` 之下）。
/// 允许 path 带verbatim前缀（`\\?\C:\x`，FRN 解析链可能带出来）。
pub fn starts_with_volume(path: &str, volume_root: &str) -> bool {
    let norm = |s: &str| strip_verbatim(s).replace('/', "\\").to_ascii_lowercase();
    let p = norm(path);
    let v = norm(volume_root);
    // 卷根归一到无尾分隔符形态（"c:\" → "c:"），做组件边界比较。
    let v_trim = v.trim_end_matches('\\');
    if v_trim.is_empty() {
        return false;
    }
    if !p.starts_with(v_trim) {
        return false;
    }
    let rest = &p[v_trim.len()..];
    rest.is_empty() || rest.starts_with('\\')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reason_kind_matrix() {
        // 四类各有一个代表 + 组合 reason（一次写入常同时 OVERWRITE|EXTEND）。
        assert_eq!(reason_to_kind(USN_REASON_FILE_CREATE), Some(ChangeKind::Create));
        assert_eq!(reason_to_kind(USN_REASON_FILE_DELETE), Some(ChangeKind::Delete));
        assert_eq!(reason_to_kind(USN_REASON_RENAME_OLD_NAME), Some(ChangeKind::Rename));
        assert_eq!(reason_to_kind(USN_REASON_RENAME_NEW_NAME), Some(ChangeKind::Rename));
        assert_eq!(reason_to_kind(USN_REASON_DATA_OVERWRITE), Some(ChangeKind::Overwrite));
        assert_eq!(
            reason_to_kind(USN_REASON_DATA_EXTEND | USN_REASON_DATA_TRUNCATION),
            Some(ChangeKind::Overwrite)
        );
        assert_eq!(
            reason_to_kind(USN_REASON_NAMED_DATA_OVERWRITE),
            Some(ChangeKind::Overwrite)
        );
        // create+delete 同记录（瞬间生灭）按 create 归类（判定顺序锁死）。
        assert_eq!(
            reason_to_kind(USN_REASON_FILE_CREATE | USN_REASON_FILE_DELETE),
            Some(ChangeKind::Create)
        );
        // 不关心的 reason 一律丢弃。
        assert_eq!(reason_to_kind(USN_REASON_CLOSE), None);
        assert_eq!(reason_to_kind(0), None);
        assert_eq!(reason_to_kind(0x0000_0400 /* EA_CHANGE */), None);
        assert_eq!(reason_to_kind(0x0000_0800 /* SECURITY_CHANGE */), None);
        assert_eq!(reason_to_kind(0x0010_0000 /* REPARSE_POINT_CHANGE */), None);
    }

    #[test]
    fn interest_mask_covers_all_kept_reasons() {
        // 订阅掩码必须是四类 reason 的并集：掩码漏一个位，内核就永远不会
        // 送来那一类事件，filter 单测再对也没用。
        for r in [
            USN_REASON_DATA_OVERWRITE,
            USN_REASON_DATA_EXTEND,
            USN_REASON_DATA_TRUNCATION,
            USN_REASON_NAMED_DATA_OVERWRITE,
            USN_REASON_NAMED_DATA_EXTEND,
            USN_REASON_NAMED_DATA_TRUNCATION,
            USN_REASON_FILE_CREATE,
            USN_REASON_FILE_DELETE,
            USN_REASON_RENAME_OLD_NAME,
            USN_REASON_RENAME_NEW_NAME,
        ] {
            assert_eq!(INTEREST_REASONS & r, r, "INTEREST_REASONS 缺 {r:#x}");
        }
        assert_eq!(INTEREST_REASONS & USN_REASON_CLOSE, 0, "不订阅 CLOSE");
    }

    #[test]
    fn kind_strings_are_frozen_contract() {
        assert_eq!(ChangeKind::Create.as_str(), "create");
        assert_eq!(ChangeKind::Delete.as_str(), "delete");
        assert_eq!(ChangeKind::Rename.as_str(), "rename");
        assert_eq!(ChangeKind::Overwrite.as_str(), "overwrite");
    }

    #[test]
    fn kind_priority_order() {
        // 聚合合并取 max（Ord 升序）：删除优先级最高，其次 rename/create。
        assert!(ChangeKind::Delete > ChangeKind::Rename);
        assert!(ChangeKind::Rename > ChangeKind::Create);
        assert!(ChangeKind::Create > ChangeKind::Overwrite);
    }

    #[test]
    fn volume_prefix_matrix() {
        let c = "C:\\";
        assert!(starts_with_volume(r"C:\Users\a\cache", c));
        assert!(starts_with_volume(r"c:/Users/a", c)); // 大小写 + 正斜杠
        assert!(starts_with_volume(r"\\?\C:\Users\a", c)); // verbatim 前缀
        assert!(starts_with_volume(r"C:\", c));
        // 组件边界：C:\Users2 不在 C:\Users 之下。
        assert!(!starts_with_volume(r"C:\Users2\x", r"C:\Users"));
        // 别的卷。
        assert!(!starts_with_volume(r"D:\data", c));
        assert!(!starts_with_volume(r"\\?\D:\data", c));
        // UNC 与空根。
        assert!(!starts_with_volume(r"\\server\share\x", c));
        assert!(!starts_with_volume(r"C:\x", ""));
    }
}
