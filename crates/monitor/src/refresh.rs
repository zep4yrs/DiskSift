//! 脏子树增量重算（release-plan-26.1.4.0 §1 菜1）。
//!
//! 聚合出的每个受影响目录用 walkdir **限深 + 限量预算**重算 size /
//! file_count，产出 CONTRACT 里 `dirs[]` 的数值面。口径与扫描器一致：
//! `$RECYCLE.BIN` / `System Volume Information` / `.trash` / `.trashes`
//! 整树剪掉、junction/符号链接条目不进、不下钻（26.1.3.1 collectDirs 口径，
//! 保证监控刷出的数字与整页扫描数字可比）。
//!
//! 产出节流：[`Pacer`] 保证「每秒最多一次产出」（规格 1s 节流）；
//! [`RefreshBudget`] 限定每次重算的深度与目录项预算，脏到天边的目录也
//! 不能把监控线程拖成常驻 IO。

use std::path::Path;
use std::time::{Duration, Instant};

use crate::filter::ChangeKind;

/// 系统级"垃圾/卷元数据"目录名（lowercase）。与 crates/scanner/src/lib.rs
/// 的 PRUNED_SYSTEM_DIRS 同一份口径——监控数字必须与扫描数字同源可比。
pub const PRUNED_SYSTEM_DIRS: &[&str] = &[
    "$recycle.bin",
    "system volume information",
    ".trash",
    ".trashes",
];

pub fn is_pruned_system_dir(name: &std::ffi::OsStr) -> bool {
    let Some(s) = name.to_str() else { return false };
    let lower = s.to_ascii_lowercase();
    PRUNED_SYSTEM_DIRS.iter().any(|p| *p == lower)
}

/// 单个脏目录的重算预算（规格「限深 walkdir」）。
#[derive(Debug, Clone)]
pub struct RefreshBudget {
    /// walkdir 最大深度（根目录本身是 depth 0）。
    pub max_depth: usize,
    /// 单目录最多走访的条目数；超出即截断（truncated=true），下轮变更
    /// 自然续算。防天边目录把监控线程拖成常驻 IO。
    pub max_entries: u64,
    /// 单次产出最多重算的目录数（超出部分留在聚合窗口，下个节拍继续）。
    pub max_dirs_per_batch: usize,
}

impl Default for RefreshBudget {
    fn default() -> Self {
        Self {
            max_depth: 12,
            max_entries: 20_000,
            max_dirs_per_batch: 32,
        }
    }
}

/// 一个子树的重算结果。size/file_count 是 CONTRACT 的数值面；
/// `truncated` 只是诊断信号（预算截断，数字偏小、下一轮变更会补齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SubtreeTotals {
    pub size: u64,
    pub file_count: u64,
    pub truncated: bool,
}

/// 重算 `root` 子树的 size / file_count。根不存在（已删除的目录）时返回
/// 全零——监控链路用零值让前端把节点清零/标记为已消失，不算错误。
pub fn compute_dir_totals(root: &Path, budget: &RefreshBudget) -> SubtreeTotals {
    let mut size: u64 = 0;
    let mut file_count: u64 = 0;
    let mut walked: u64 = 0;

    let iter = walkdir::WalkDir::new(root)
        .max_depth(budget.max_depth)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            // filter_entry：被剪目录整个子树不再进入。
            // (a) 系统垃圾/卷元数据目录整树剪；
            // (b) junction/符号链接条目剪（walker 链纪律：readdir 的
            //     file_type 对 reparse 点报 is_symlink()=true，walkdir
            //     本就不下钻，这里再从结果流拦一道，联接本体也不计入）。
            if e.file_type().is_dir() {
                return !e.file_type().is_symlink() && !is_pruned_system_dir(e.file_name());
            }
            !e.file_type().is_symlink()
        });

    for entry in iter {
        let Ok(entry) = entry else { continue };
        // 根自身也是一条 visited 条目（空目录也占预算），计入预算防呆。
        walked += 1;
        if walked > budget.max_entries {
            return SubtreeTotals {
                size,
                file_count,
                truncated: true,
            };
        }
        if !entry.file_type().is_file() {
            continue;
        }
        if let Ok(md) = entry.metadata() {
            size = size.saturating_add(md.len());
        }
        file_count += 1;
    }

    SubtreeTotals {
        size,
        file_count,
        truncated: false,
    }
}

/// CONTRACT `dirs[]` 单条（emit.rs 组装载荷用）。kind 来自聚合，不在这里。
#[derive(Debug, Clone, PartialEq)]
pub struct DirStat {
    pub path: String,
    pub size: u64,
    pub file_count: u64,
    pub kind: ChangeKind,
    pub truncated: bool,
}

/// 子树重算 + 聚合种类 → CONTRACT 条目。
pub fn build_dir_stat(root: &Path, kind: ChangeKind, budget: &RefreshBudget) -> DirStat {
    let t = compute_dir_totals(root, budget);
    DirStat {
        path: root.to_string_lossy().replace('/', "\\"),
        size: t.size,
        file_count: t.file_count,
        kind,
        truncated: t.truncated,
    }
}

/// 1s 产出节流：两次产出间隔不足 `min_interval` 就不产出（规格「每秒最多
/// 一次产出」）。时钟由调用方注入（worker 传 `Instant::now()`，测试传
/// 构造值），无内部时钟依赖。
#[derive(Debug)]
pub struct Pacer {
    min_interval: Duration,
    last: Option<Instant>,
}

impl Pacer {
    pub fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last: None,
        }
    }

    /// 距上次产出是否已满间隔（从未产出过 = 就绪）。
    pub fn ready(&self, now: Instant) -> bool {
        match self.last {
            None => true,
            Some(l) => now.duration_since(l) >= self.min_interval,
        }
    }

    /// 记录一次产出。
    pub fn mark(&mut self, now: Instant) {
        self.last = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    fn make_tree(dir: &Path) {
        // a/f1(10)  a/sub/f2(20)  a/sub/deep/f3(30)  a/.trash/f4(99, 整树剪)
        fs::create_dir_all(dir.join("a/sub/deep")).unwrap();
        fs::create_dir_all(dir.join("a/.trash")).unwrap();
        fs::write(dir.join("a/f1"), vec![0u8; 10]).unwrap();
        fs::write(dir.join("a/sub/f2"), vec![0u8; 20]).unwrap();
        fs::write(dir.join("a/sub/deep/f3"), vec![0u8; 30]).unwrap();
        fs::write(dir.join("a/.trash/f4"), vec![0u8; 99]).unwrap();
    }

    #[test]
    fn totals_full_tree_matches_scanner_style_accounting() {
        let tmp = tempfile::tempdir().unwrap();
        make_tree(tmp.path());
        let a = tmp.path().join("a");
        let t = compute_dir_totals(&a, &RefreshBudget::default());
        // .trash 整树剪掉：只有 10+20+30。
        assert_eq!(t.size, 60);
        assert_eq!(t.file_count, 3);
        assert!(!t.truncated);
    }

    #[test]
    fn depth_limit_bounds_the_walk() {
        let tmp = tempfile::tempdir().unwrap();
        make_tree(tmp.path());
        let a = tmp.path().join("a");
        // max_depth=2：a(0) → f1(1), sub(1) → f2(2)；deep/f3 在深度 3，剪掉。
        let b = RefreshBudget {
            max_depth: 2,
            ..RefreshBudget::default()
        };
        let t = compute_dir_totals(&a, &b);
        assert_eq!(t.size, 30);
        assert_eq!(t.file_count, 2);
        assert!(!t.truncated, "深度剪枝不是预算截断");
    }

    #[test]
    fn entry_budget_truncates() {
        let tmp = tempfile::tempdir().unwrap();
        make_tree(tmp.path());
        let a = tmp.path().join("a");
        // 预算 2：a 本身 + f1（walkdir 字母序 .trash 最先但被剪、deep 次之
        // → 深度序 visit 序 a, deep, deep/f3, f1, sub, sub/f2 …），第 3 条
        // 触发截断。
        let b = RefreshBudget {
            max_entries: 2,
            ..RefreshBudget::default()
        };
        let t = compute_dir_totals(&a, &b);
        assert!(t.truncated, "预算耗尽必须打 truncated 标");
        assert!(t.file_count < 3, "截断后计数必须小于全量 3");
    }

    #[test]
    fn deleted_root_returns_zeros() {
        let tmp = tempfile::tempdir().unwrap();
        let gone = tmp.path().join("gone");
        let t = compute_dir_totals(&gone, &RefreshBudget::default());
        assert_eq!(t.size, 0);
        assert_eq!(t.file_count, 0);
        assert!(!t.truncated);
    }

    #[test]
    fn pacer_one_output_per_interval() {
        let t0 = Instant::now();
        let step = Duration::from_millis(400);
        let mut p = Pacer::new(Duration::from_millis(1000));
        assert!(p.ready(t0), "从未产出过：立即就绪");
        p.mark(t0);
        assert!(!p.ready(t0 + step), "400ms < 1s：不允许第二次产出");
        assert!(!p.ready(t0 + 2 * step), "800ms < 1s：仍不允许");
        assert!(p.ready(t0 + 3 * step), "1.2s ≥ 1s：允许产出");
        p.mark(t0 + 3 * step);
        assert!(!p.ready(t0 + 4 * step));
    }

    #[test]
    fn build_dir_stat_normalizes_path_separators() {
        let tmp = tempfile::tempdir().unwrap();
        make_tree(tmp.path());
        let a = tmp.path().join("a");
        let s = build_dir_stat(&a, ChangeKind::Rename, &RefreshBudget::default());
        assert_eq!(s.size, 60);
        assert_eq!(s.file_count, 3);
        assert_eq!(s.kind, ChangeKind::Rename);
        assert!(!s.path.contains('/'), "CONTRACT 路径统一反斜杠：{}", s.path);
    }
}
