//! 变更路径聚合（release-plan-26.1.4.0 §1 菜1）。
//!
//! filter 吐出的受影响目录在这里做三件事：
//! 1. **折叠**——同一目录 500ms 窗口内的 N 次变更合成 1 条（hits 计数）；
//! 2. **沿树向上聚合**——窗口到期时，若被折叠出的目录里同时存在祖先链
//!    （`C:\a` 与 `C:\a\b`），子目录折叠进最浅祖先：前端刷新祖先节点时
//!    子树本来就会一起重算，逐个上报只是浪费 IPC；
//! 3. **积压降级**——待聚合目录超过 [`AggregateConfig::soft_limit`]
//!    （规格：1000）时进入降级：不再接受新目录（计入 dropped），发出
//!    「建议重扫」状态；积压回落到 [`AggregateConfig::resume_limit`]
//!    以下自动恢复（迟滞防抖）。
//!
//! 全部时序用注入的 `Instant`，纯逻辑可单测。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::filter::ChangeKind;

/// 规格常量：500ms 折叠窗口；积压 >1000 目录降级「建议重扫」。
#[derive(Debug, Clone)]
pub struct AggregateConfig {
    /// 折叠窗口：目录首次入队的 500ms 内的后续变更全部并入同一条。
    pub window: Duration,
    /// 软上限：待聚合目录数超过它即进入降级（规格「积压 >1000 目录」）。
    pub soft_limit: usize,
    /// 恢复阈值（迟滞）：降级后积压回落到它以下才恢复接收。
    pub resume_limit: usize,
}

impl Default for AggregateConfig {
    fn default() -> Self {
        Self {
            window: Duration::from_millis(500),
            soft_limit: 1000,
            resume_limit: 500,
        }
    }
}

/// 聚合产出的一条受影响目录。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirHit {
    pub path: String,
    pub kind: ChangeKind,
    /// 窗口内并入的变更次数（含首次）。诊断用，不进 CONTRACT 载荷。
    pub hits: u64,
}

/// drain_due 的结果。`recovered` 是边沿信号（只在退出降级的那一次 drain
/// 上为 true），worker 用它发一次「已恢复」的 `usn://state`。降级导致的
/// 丢弃在 [`AggregateWindow::push`] 返回值里实时交给 worker 累计。
#[derive(Debug, Default)]
pub struct DrainOutcome {
    pub dirs: Vec<DirHit>,
    pub recovered: bool,
}

struct Pending {
    path: String,
    kind: ChangeKind,
    first_seen: Instant,
    hits: u64,
}

/// 一个卷的聚合窗口（worker 线程私有，无锁）。
pub struct AggregateWindow {
    cfg: AggregateConfig,
    entries: Vec<Pending>,
    index: HashMap<String, usize>,
    degraded: bool,
}

impl AggregateWindow {
    pub fn new(cfg: AggregateConfig) -> Self {
        Self {
            cfg,
            entries: Vec::new(),
            index: HashMap::new(),
            degraded: false,
        }
    }

    /// 入队一条受影响目录。返回是否因积压降级被丢弃（1=丢弃）。
    ///
    /// 沿树向上聚合的另一半在这里：入队前先沿 `parent_of` 找已在窗口的
    /// 祖先——命中就并进去（子目录不再单独占位）；反过来，入队的是祖先时，
    /// 已在窗口的子孙也并进来。保证同一祖先链在窗口里只有一条，到期的
    /// 一定是链上最浅的祖先。
    pub fn push(&mut self, path: impl Into<String>, kind: ChangeKind, now: Instant) -> u64 {
        let path = path.into();
        if let Some(&i) = self.index.get(&path) {
            // 已在窗口内：合并种类（取优先级最高）+ 计数。降级也不丢这条
            // ——它已经占着位置，丢弃与否不改变积压水位。
            let e = &mut self.entries[i];
            if kind > e.kind {
                e.kind = kind;
            }
            e.hits += 1;
            return 0;
        }
        // ① 向上找已入窗祖先：子目录并入。卷根（"C:\"，3 字符）是整卷桶，
        //    不参与折叠——否则根下一条 500ms 窗口会把全卷变更吸进去，
        //    定向刷新退化成整卷重算。
        let mut cur = parent_of(&path);
        while let Some(anc) = cur {
            if anc.len() > 3 {
                if let Some(&i) = self.index.get(&anc) {
                    let e = &mut self.entries[i];
                    if kind > e.kind {
                        e.kind = kind;
                    }
                    e.hits += 1;
                    return 0;
                }
            }
            cur = parent_of(&anc);
        }
        // 降级判定必须先行：降级时绝不能先吸收子孙——那会把已入窗条目的
        // 变更直接丢掉（比丢弃新条目更糟）。
        if self.degraded || self.entries.len() >= self.cfg.soft_limit {
            // 边沿触发：越线的那一条也丢弃，同时置位降级。
            self.degraded = true;
            return 1;
        }
        // ② 向下收已入窗子孙：新入窗的祖先吸收它们（保持自己的 first_seen）。
        //    卷根同 ① 不吸收（各子树照常定向刷新）。
        let mut hits = 1u64;
        let mut absorbed: Vec<usize> = Vec::new();
        if path.len() > 3 {
            for (i, e) in self.entries.iter().enumerate() {
                if is_ancestor(&path, &e.path) {
                    hits += e.hits;
                    absorbed.push(i);
                }
            }
        }
        for &i in absorbed.iter().rev() {
            let e = self.entries.swap_remove(i);
            self.index.remove(&e.path);
        }
        if !absorbed.is_empty() {
            self.compact_index();
        }
        self.index.insert(path.clone(), self.entries.len());
        self.entries.push(Pending {
            path,
            kind,
            first_seen: now,
            hits,
        });
        0
    }

    /// 当前待聚合目录数（诊断/降级水位）。
    pub fn backlog(&self) -> usize {
        self.entries.len()
    }

    pub fn is_degraded(&self) -> bool {
        self.degraded
    }

    /// 折叠并取出窗口已到期（首次入队 ≥ 500ms 前）的目录，最多 `max_take`
    /// 条（refresh 预算）；没取完的留在队里，下个节拍继续。同批内的祖先
    /// 链折叠：子目录并入最浅祖先。
    pub fn drain_due(&mut self, now: Instant, max_take: usize) -> DrainOutcome {
        // 1) 顺序分区：到期条目按入队序（最老先出）取走至多 max_take 条，
        //    其余（含到期但超预算的）原序保留——不动 first_seen，下个节拍
        //    立即到期。分区而非按下标 swap_remove：swap 会把未到期条目挪进
        //    已处理位置，误删/误改别人的窗口。
        let mut hits: Vec<DirHit> = Vec::new();
        let mut keep: Vec<Pending> = Vec::with_capacity(self.entries.len());
        for e in self.entries.drain(..) {
            if hits.len() < max_take && now.duration_since(e.first_seen) >= self.cfg.window {
                hits.push(DirHit {
                    path: e.path,
                    kind: e.kind,
                    hits: e.hits,
                });
            } else {
                keep.push(e);
            }
        }
        self.entries = keep;
        self.compact_index();

        // 2) 沿树向上折叠（防御性第二道：push 侧已保证祖先链在窗口里唯一，
        //    同批出现祖先+子孙理论上不会再发生；保留使折叠语义与窗口内部
        //    排布解耦）。卷根（≤3 字符）同样不作为折叠目标。
        let mut folded: Vec<DirHit> = Vec::with_capacity(hits.len());
        for hit in hits {
            if let Some(a) = folded
                .iter_mut()
                .find(|f| f.path.len() > 3 && is_ancestor(&f.path, &hit.path))
            {
                a.hits += hit.hits;
                if hit.kind > a.kind {
                    a.kind = hit.kind;
                }
                continue;
            }
            folded.push(hit);
        }

        // 3) 降级迟滞边沿。
        let degraded_edge = self.degraded && self.entries.len() < self.cfg.resume_limit;
        if degraded_edge {
            self.degraded = false;
        }

        DrainOutcome {
            dirs: folded,
            recovered: degraded_edge,
        }
    }
}

/// 分区后把 index 里的条目位置重建到当前 entries 排布。
impl AggregateWindow {
    fn compact_index(&mut self) {
        for (i, e) in self.entries.iter().enumerate() {
            self.index.insert(e.path.clone(), i);
        }
    }
}

/// `anc` 是否是 `path` 的严格祖先（组件边界安全、大小写不敏感、分隔符归一）。
pub fn is_ancestor(anc: &str, path: &str) -> bool {
    let norm = |s: &str| {
        s.strip_prefix(r"\\?\")
            .unwrap_or(s)
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_ascii_lowercase()
    };
    let (a, p) = (norm(anc), norm(path));
    if a.is_empty() || a == p {
        return false;
    }
    if !p.starts_with(&a) {
        return false;
    }
    p.as_bytes().get(a.len()) == Some(&b'\\')
}

/// 目录路径的父目录（归一形态：无尾分隔符）。卷根（`C:\` / `C:`）没有
/// 父目录，返回 None——折叠链到根为止。UNC 与其它非盘符形态也返回 None。
pub fn parent_of(path: &str) -> Option<String> {
    let p = path.replace('/', "\\");
    let p = p.trim_end_matches('\\');
    if p.len() < 4 || p.as_bytes()[1] != b':' {
        return None; // "C:" / "C:\"（卷根无父）/ 过短 / UNC 不在监控面内
    }
    match p.rfind('\\') {
        Some(i) if i >= 3 => Some(p[..i].to_string()), // "C:\a\b" → "C:\a"
        Some(2) => Some(format!("{}\\", &p[..2])),     // "C:\a" → "C:\"
        _ => None,                                     // "C:foo" 等非规范形态
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn same_dir_folds_into_one_hit() {
        let mut w = AggregateWindow::new(AggregateConfig::default());
        let now = t0();
        assert_eq!(w.push(r"C:\a", ChangeKind::Overwrite, now), 0);
        assert_eq!(w.push(r"C:\a", ChangeKind::Overwrite, now), 0);
        assert_eq!(w.push(r"C:\a", ChangeKind::Create, now), 0);
        assert_eq!(w.backlog(), 1);
        // 窗口未到期：抽不出来。
        let out = w.drain_due(now + Duration::from_millis(499), 100);
        assert!(out.dirs.is_empty());
        let out = w.drain_due(now + Duration::from_millis(500), 100);
        assert_eq!(out.dirs.len(), 1);
        let h = &out.dirs[0];
        assert_eq!(h.path, r"C:\a");
        assert_eq!(h.kind, ChangeKind::Create, "窗口内合并取最高优先级");
        assert_eq!(h.hits, 3);
    }

    #[test]
    fn window_is_per_dir_not_global() {
        // 晚到的目录用自己的 500ms 窗口，不被先到者拖到期。
        let mut w = AggregateWindow::new(AggregateConfig::default());
        let now = t0();
        w.push(r"C:\a", ChangeKind::Create, now);
        w.push(r"C:\b", ChangeKind::Create, now + Duration::from_millis(400));
        let out = w.drain_due(now + Duration::from_millis(500), 100);
        assert_eq!(out.dirs.len(), 1);
        assert_eq!(out.dirs[0].path, r"C:\a");
        let out = w.drain_due(now + Duration::from_millis(900), 100);
        assert_eq!(out.dirs.len(), 1);
        assert_eq!(out.dirs[0].path, r"C:\b");
    }

    #[test]
    fn max_take_leaves_leftover_for_next_tick() {
        let mut w = AggregateWindow::new(AggregateConfig::default());
        let now = t0();
        for d in ["a", "b", "c"] {
            w.push(format!(r"C:\{d}"), ChangeKind::Create, now);
        }
        let out = w.drain_due(now + Duration::from_millis(500), 2);
        assert_eq!(out.dirs.len(), 2);
        assert_eq!(out.dirs[0].path, r"C:\a", "最老的先出");
        assert_eq!(out.dirs[1].path, r"C:\b");
        let out = w.drain_due(now + Duration::from_millis(501), 100);
        assert_eq!(out.dirs.len(), 1);
        assert_eq!(out.dirs[0].path, r"C:\c");
    }

    #[test]
    fn ancestor_fold_child_into_parent() {
        let mut w = AggregateWindow::new(AggregateConfig::default());
        let now = t0();
        w.push(r"C:\a", ChangeKind::Overwrite, now);
        w.push(r"C:\a\b", ChangeKind::Delete, now);
        w.push(r"C:\a\b\c", ChangeKind::Create, now);
        w.push(r"C:\x", ChangeKind::Create, now); // 无关子树，不折叠
        let out = w.drain_due(now + Duration::from_millis(500), 100);
        let paths: Vec<&str> = out.dirs.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(paths, vec![r"C:\a", r"C:\x"], "子目录折叠进最浅祖先");
        let a = &out.dirs[0];
        assert_eq!(a.kind, ChangeKind::Delete, "折叠合并取最高优先级");
        assert_eq!(a.hits, 3, "祖先 hits 吸收子目录 hits");
    }

    #[test]
    fn push_side_fold_child_first_then_ancestor() {
        // 子目录先入窗、祖先后来：祖先吸收子孙，窗口里只剩一条。
        let mut w = AggregateWindow::new(AggregateConfig::default());
        let now = t0();
        assert_eq!(w.push(r"C:\a\b", ChangeKind::Overwrite, now), 0);
        assert_eq!(w.backlog(), 1);
        assert_eq!(w.push(r"C:\a", ChangeKind::Delete, now + Duration::from_millis(100)), 0);
        assert_eq!(w.backlog(), 1, "祖先入窗吸收子孙，不新增条目");
        // 祖先的 first_seen 是自己的入队时刻（t0+100），t0+500 时窗口未满。
        let out = w.drain_due(now + Duration::from_millis(500), 100);
        assert!(out.dirs.is_empty(), "吸收后按祖先自己的窗口计时");
        let out = w.drain_due(now + Duration::from_millis(600), 100);
        assert_eq!(out.dirs.len(), 1);
        let a = &out.dirs[0];
        assert_eq!(a.path, r"C:\a");
        assert_eq!(a.kind, ChangeKind::Delete, "子孙的 Delete 优先级被吸收");
        assert_eq!(a.hits, 2);
    }

    #[test]
    fn volume_root_is_not_a_fold_bucket() {
        // 卷根是整卷桶，不参与折叠：根条目存在期间，子树变更照常定向入窗
        // ——否则根下一条 500ms 窗口会把全卷变更吸进去，退化成整卷重算。
        let mut w = AggregateWindow::new(AggregateConfig::default());
        let now = t0();
        assert_eq!(w.push(r"C:\", ChangeKind::Create, now), 0);
        assert_eq!(
            w.push(r"C:\users\a\cache", ChangeKind::Overwrite, now + Duration::from_millis(100)),
            0,
            "子树变更不得被卷根吸收"
        );
        assert_eq!(w.backlog(), 2);
        // 子树仍挂自己的（非根）祖先。
        assert_eq!(w.push(r"C:\users\a", ChangeKind::Create, now + Duration::from_millis(150)), 0);
        assert_eq!(w.backlog(), 2, "cache 折进 users\\a，根独立");
        let out = w.drain_due(now + Duration::from_millis(700), 100);
        let mut paths: Vec<&str> = out.dirs.iter().map(|d| d.path.as_str()).collect();
        paths.sort_unstable();
        assert_eq!(paths, vec![r"C:\", r"C:\users\a"], "根与子树各自上报");
    }

    #[test]
    fn ancestor_boundary_is_component_safe() {
        assert!(is_ancestor(r"C:\a", r"C:\a\b"));
        assert!(is_ancestor(r"C:\a\", r"C:\a\b"));
        assert!(!is_ancestor(r"C:\ab", r"C:\abc\d"));
        assert!(!is_ancestor(r"C:\a", r"C:\a"), "自身不算严格祖先");
        assert!(is_ancestor(r"c:/a", r"C:\A\B"), "大小写/斜杠归一");
        assert!(!is_ancestor(r"C:\", r"C:\"));
    }

    #[test]
    fn parent_chain_walk() {
        assert_eq!(parent_of(r"C:\a\b").as_deref(), Some(r"C:\a"));
        assert_eq!(parent_of(r"C:\a").as_deref(), Some(r"C:\"));
        assert_eq!(parent_of(r"C:\").as_deref(), None, "卷根没有父目录");
        assert_eq!(parent_of(r"C:").as_deref(), None);
        assert_eq!(parent_of(r"C:/a/b"), parent_of(r"C:\a\b"));
        assert_eq!(parent_of(r"\\srv\share"), None, "UNC 不在监控面");
    }

    #[test]
    fn backlog_over_soft_limit_degrades_and_recovers() {
        let cfg = AggregateConfig {
            window: Duration::from_millis(500),
            soft_limit: 4,
            resume_limit: 2,
        };
        let mut w = AggregateWindow::new(cfg);
        let now = t0();
        for d in ["a", "b", "c", "d"] {
            assert_eq!(w.push(format!(r"C:\{d}"), ChangeKind::Create, now), 0);
        }
        // 第 5 个新目录：越线，开始降级丢弃。
        assert_eq!(w.push(r"C:\e", ChangeKind::Create, now), 1);
        assert!(w.is_degraded());
        // 已存在的目录仍可合并，不算丢弃。
        assert_eq!(w.push(r"C:\a", ChangeKind::Create, now), 0);
        // 到期 drain（max_take 足够）：e 没进队，其余 4 条取出。
        let out = w.drain_due(now + Duration::from_millis(500), 100);
        assert_eq!(out.dirs.len(), 4);
        assert!(!w.is_degraded(), "积压 0 < resume_limit(2)，恢复");
        assert!(out.recovered, "恢复边沿必须置位，worker 据此发一次 state");
        // 恢复后重新接收。
        assert_eq!(w.push(r"C:\f", ChangeKind::Create, now + Duration::from_millis(501)), 0);
    }

    #[test]
    fn degrade_hysteresis_waits_below_resume_limit() {
        let cfg = AggregateConfig {
            window: Duration::from_millis(500),
            soft_limit: 3,
            resume_limit: 2,
        };
        let mut w = AggregateWindow::new(cfg);
        let now = t0();
        for d in ["a", "b", "c"] {
            w.push(format!(r"C:\{d}"), ChangeKind::Create, now);
        }
        assert_eq!(w.push(r"C:\d", ChangeKind::Create, now), 1);
        // 只取 1 条：剩 2 条 ≥ resume_limit(2)，不恢复。
        let out = w.drain_due(now + Duration::from_millis(500), 1);
        assert_eq!(out.dirs.len(), 1);
        assert!(w.is_degraded(), "迟滞：没降到 resume_limit 以下不恢复");
        assert!(!out.recovered);
        // 再取 1 条：剩 1 条 < 2，恢复。
        let out = w.drain_due(now + Duration::from_millis(600), 1);
        assert_eq!(out.dirs.len(), 1);
        assert!(out.recovered);
        assert!(!w.is_degraded());
    }
}
