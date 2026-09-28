//! pinkbin-monitor —— DiskSift USN Journal 实时监控（v26.1.4.0 菜1，
//! 规格 docs/release-plan-26.1.4.0.md §1）。
//!
//! 模块布局（规格五模块）：
//! - [`journal`]：卷句柄（CreateFileW `\\.\C:`）+ `FSCTL_READ_USN_JOURNAL`
//!   500ms 轮询循环 + journal 不存在时 `FSCTL_CREATE_USN_JOURNAL`（≤32MB），
//!   CloseHandle 生命周期由 Drop 管——应用停用不阻塞卷卸载；
//! - [`filter`]：只留 rename/create/delete/data-overwrite + 卷前缀过滤（纯函数）；
//! - [`aggregate`]：变更路径折叠到受影响目录并沿树向上聚合，500ms 窗口去抖，
//!   积压 >1000 目录降级「建议重扫」；
//! - [`refresh`]：脏子树限深 walkdir 增量重算 size/file_count，每秒最多一次
//!   产出（Pacer 1s 节流 + 条目/深度预算）；
//! - [`emit`]：Tauri v2 event 按 CONTRACT 推送 `usn://changes` 与 `usn://state`。
//!
//! **红线**：
//! - 监控只读——除创建 journal（规格明示例外）外不写任何卷数据；
//! - 非 NTFS 卷启动即降级：`monitor_status` 返回该卷 `running=false` + reason，
//!   不报错弹窗（失败只走状态与事件面）；
//! - monitor panic 不得拖垮主进程：线程体在 `catch_unwind` 里跑，panic 后
//!   状态回已停止并事件说明；
//! - 监控不改变 NEVER_TOUCH 语义：它只"展示"变更，不提供任何动作面。

mod aggregate;
mod emit;
mod filter;
mod journal;
mod refresh;

pub use aggregate::{AggregateConfig, DirHit};
pub use emit::{
    ChangesPayload, DirChange, EVENT_CHANGES, EVENT_STATE, StatePayload,
};
pub use filter::ChangeKind;
pub use journal::{
    fs_gate, normalize_volume, parse_usn_buffer, run_volume_loop, VolumeLoopCtx, VolumeSpec,
};

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::Serialize;
use tauri::AppHandle;

// ── CONTRACT：monitor_status 的返回体 ───────────────────────────────────────
// { running: bool, volumes: [{ volume, running, events_per_sec, last_refresh }] }
// reason 是规格「非 NTFS 卷启动即降级：返回该卷 running=false + reason」的
// 必要字段（正常态为 null）；last_refresh 是 epoch 毫秒，从未产出时为 null。

#[derive(Debug, Clone, Serialize)]
pub struct VolumeStatus {
    /// 规范卷键（`"C:"`）。
    pub volume: String,
    pub running: bool,
    /// 关注事件（过滤后的 USN 记录）的每秒速率（EMA 平滑）。
    pub events_per_sec: u64,
    /// 最近一次 refresh 产出的 epoch 毫秒；null = 尚未产出过。
    pub last_refresh: Option<u64>,
    /// 降级/停止原因；null = 正常（或从未启动过的卷）。
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MonitorStatus {
    /// 任一卷在监控中即为 true。
    pub running: bool,
    pub volumes: Vec<VolumeStatus>,
}

// ── 单卷共享统计面 ──────────────────────────────────────────────────────────

#[derive(Debug)]
struct RateState {
    initialized: bool,
    last_at: Instant,
    last_total: u64,
    ema: f64,
}

/// 一个卷的监控统计（worker 线程写、命令线程读，全原子/Mutex）。
#[derive(Debug)]
pub struct VolumeStats {
    running: AtomicBool,
    events_total: AtomicU64,
    dropped_total: AtomicU64,
    last_refresh_ms: AtomicU64,
    reason: Mutex<Option<String>>,
    rate: Mutex<RateState>,
}

impl VolumeStats {
    pub fn new() -> Self {
        Self {
            running: AtomicBool::new(false),
            events_total: AtomicU64::new(0),
            dropped_total: AtomicU64::new(0),
            last_refresh_ms: AtomicU64::new(0),
            reason: Mutex::new(None),
            rate: Mutex::new(RateState {
                initialized: false,
                last_at: Instant::now(),
                last_total: 0,
                ema: 0.0,
            }),
        }
    }

    pub fn is_running(&self) -> bool {
        self.running.load(Ordering::Relaxed)
    }

    /// worker 开跑（running=true、清原因）。
    pub fn mark_running(&self) {
        *self.reason.lock().unwrap() = None;
        self.running.store(true, Ordering::Relaxed);
    }

    /// 停止并记原因。`None` 不覆盖已有原因（hub.stop 先写「已停止」，
    /// worker 正常退出再 stop_with(None) 时保持不动）。
    pub fn stop_with(&self, reason: Option<String>) {
        if let Some(r) = reason {
            *self.reason.lock().unwrap() = Some(r);
        }
        self.running.store(false, Ordering::Relaxed);
    }

    /// worker 收到一条关注事件。
    pub fn note_event(&self) {
        self.events_total.fetch_add(1, Ordering::Relaxed);
    }

    pub fn add_dropped(&self, n: u64) {
        if n > 0 {
            self.dropped_total.fetch_add(n, Ordering::Relaxed);
        }
    }

    pub fn dropped_total(&self) -> u64 {
        self.dropped_total.load(Ordering::Relaxed)
    }

    pub fn set_last_refresh(&self, epoch_ms: u64) {
        self.last_refresh_ms.store(epoch_ms, Ordering::Relaxed);
    }

    pub fn reason_snapshot(&self) -> Option<String> {
        self.reason.lock().unwrap().clone()
    }

    /// 事件速率（EMA 平滑，调用节流 ≥200ms 一次——status 命令天然满足）。
    pub fn events_per_sec(&self) -> u64 {
        let mut st = self.rate.lock().unwrap();
        let total = self.events_total.load(Ordering::Relaxed);
        if !st.initialized {
            st.initialized = true;
            st.last_at = Instant::now();
            st.last_total = total;
            return 0;
        }
        let dt = st.last_at.elapsed().as_secs_f64();
        if dt < 0.2 {
            return st.ema.max(0.0) as u64;
        }
        let inst = (total.saturating_sub(st.last_total)) as f64 / dt;
        st.ema = if st.ema == 0.0 { inst } else { st.ema * 0.5 + inst * 0.5 };
        st.last_at = Instant::now();
        st.last_total = total;
        st.ema.max(0.0) as u64
    }

    pub fn last_refresh(&self) -> Option<u64> {
        match self.last_refresh_ms.load(Ordering::Relaxed) {
            0 => None,
            ms => Some(ms),
        }
    }
}

impl Default for VolumeStats {
    fn default() -> Self {
        Self::new()
    }
}

// ── 多卷任务集中管理 ────────────────────────────────────────────────────────

#[derive(Clone)]
struct HubEntry {
    stats: Arc<VolumeStats>,
    stop: Arc<AtomicBool>,
}

/// 多卷监控任务集中管理（AppState 持有）。每卷一个独立 OS 线程 +
/// 共享 [`VolumeStats`]；start/stop/status 都是非阻塞命令面。
pub struct MonitorHub {
    inner: Mutex<HashMap<String, HubEntry>>,
}

impl Default for MonitorHub {
    fn default() -> Self {
        Self::new()
    }
}

impl MonitorHub {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }

    /// 认领一个卷的监控槽位。运行中（含「正在启动」）返回 None（幂等）；
    /// 否则插入新条目并**同步** mark_running 占位，返回 (stats, stop)。
    ///
    /// 独立探 bug 修复：原先 running 要等 worker 线程跑起来执行
    /// mark_running 才置位——快速连续两次 start（开关双击/命令竞态）会
    /// 双双看到 running=false，第二次用新条目覆盖地图并再 spawn 一个
    /// worker，旧 worker 的 stop 旗标从此无人能置位（僵尸：持卷句柄
    /// 500ms 轮询、重复发 usn://changes 直到进程退出，status 也看不到）。
    /// 占位必须在 spawn 之前同步完成，把竞态窗口封死；worker 侧不再
    /// 重复 mark_running（避免 stop-后-慢启动的复活）。
    fn claim_slot(&self, key: &str) -> Option<(Arc<VolumeStats>, Arc<AtomicBool>)> {
        let mut map = self.inner.lock().unwrap();
        if let Some(e) = map.get(key) {
            if e.stats.is_running() {
                return None; // 已在监控/正在启动：幂等
            }
        }
        let stats = Arc::new(VolumeStats::new());
        stats.mark_running();
        let stop = Arc::new(AtomicBool::new(false));
        map.insert(
            key.to_string(),
            HubEntry {
                stats: stats.clone(),
                stop: stop.clone(),
            },
        );
        Some((stats, stop))
    }

    /// 启动一个卷的监控。任何失败都不报错：注册条目即降级（running=false +
    /// reason），原因随后由 worker 经状态与 `usn://state` 事件面送达。
    /// 对已在监控中的卷幂等（no-op，含启动中的窗口）。
    pub fn start(&self, volume: &str, app: AppHandle) {
        let spec = journal::normalize_volume(volume);
        let key = spec
            .as_ref()
            .map(|s| s.key.clone())
            .unwrap_or_else(|| volume.trim().to_string());

        // 同步占位（双开竞态修复）：运行中/启动中直接幂等返回。
        let Some((stats, stop)) = self.claim_slot(&key) else {
            return;
        };

        match spec {
            Some(spec) => {
                let ctx = VolumeLoopCtx {
                    spec,
                    stop,
                    stats: stats.clone(),
                    app: app.clone(),
                };
                let panic_app = app.clone();
                let panic_stats = stats.clone();
                let panic_key = key.clone();
                let spawned = std::thread::Builder::new()
                    .name(format!("usn-monitor-{key}"))
                    .spawn(move || {
                        // monitor panic 不得拖垮主进程：兜住后状态回已停止。
                        let result =
                            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                journal::run_volume_loop(ctx)
                            }));
                        if result.is_err() {
                            let reason = "监控线程异常（panic），已自动停止".to_string();
                            tracing::error!("monitor: 卷 {panic_key} panic，已兜底停止");
                            panic_stats.stop_with(Some(reason.clone()));
                            emit::emit_state(
                                &panic_app,
                                StatePayload {
                                    volume: panic_key,
                                    running: false,
                                    reason: Some(reason),
                                },
                            );
                        }
                    });
                if let Err(e) = spawned {
                    let reason = format!("监控线程启动失败：{e}");
                    stats.stop_with(Some(reason.clone()));
                    emit::emit_state(
                        &app,
                        StatePayload {
                            volume: key,
                            running: false,
                            reason: Some(reason),
                        },
                    );
                }
            }
            None => {
                // 无法识别的卷标识：注册即降级，不报错弹窗（规格红线）。
                let reason = format!("无法识别的卷标识：{volume:?}（需要形如 \"C:\" 的盘符卷）");
                stats.stop_with(Some(reason.clone()));
                emit::emit_state(
                    &app,
                    StatePayload {
                        volume: key,
                        running: false,
                        reason: Some(reason),
                    },
                );
            }
        }
    }

    /// 停止一个卷的监控。置位停止信号 + 状态回已停止 + 发 `usn://state`；
    /// worker ≤50ms 内看到信号自行退出并 CloseHandle（不阻塞卷卸载）。
    /// 对未知卷也发状态事件（幂等，不报错）。
    pub fn stop(&self, volume: &str, app: &AppHandle) {
        let key = journal::normalize_volume(volume)
            .map(|s| s.key)
            .unwrap_or_else(|| volume.trim().to_string());
        let entry = self.inner.lock().unwrap().get(&key).cloned();
        if let Some(e) = entry {
            e.stop.store(true, Ordering::Relaxed);
            e.stats.stop_with(Some("已停止".into()));
        }
        emit::emit_state(
            app,
            StatePayload {
                volume: key,
                running: false,
                reason: Some("已停止".into()),
            },
        );
    }

    /// CONTRACT：monitor_status() 的返回体。原因在列的卷保持可见
    /// （非 NTFS 降级后 status 一直能看到 running=false + reason）。
    pub fn status(&self) -> MonitorStatus {
        let map = self.inner.lock().unwrap();
        let mut volumes: Vec<VolumeStatus> = map
            .iter()
            .map(|(key, e)| VolumeStatus {
                volume: key.clone(),
                running: e.stats.is_running(),
                events_per_sec: e.stats.events_per_sec(),
                last_refresh: e.stats.last_refresh(),
                reason: e.stats.reason_snapshot(),
            })
            .collect();
        volumes.sort_by(|a, b| a.volume.cmp(&b.volume));
        MonitorStatus {
            running: volumes.iter().any(|v| v.running),
            volumes,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// VolumeStats 的状态机：mark_running / stop_with 覆盖语义 /
    /// last_refresh 的 0→None 归一。这些是 monitor_status 的数据面。
    #[test]
    fn volume_stats_lifecycle() {
        let s = VolumeStats::new();
        assert!(!s.is_running());
        assert_eq!(s.last_refresh(), None);
        assert_eq!(s.reason_snapshot(), None);
        assert_eq!(s.events_per_sec(), 0);

        s.mark_running();
        assert!(s.is_running());
        s.note_event();
        s.note_event();
        s.add_dropped(0); // 0 丢弃不计
        assert_eq!(s.dropped_total(), 0);
        s.add_dropped(3);
        assert_eq!(s.dropped_total(), 3);
        s.set_last_refresh(1_727_600_000_000);
        assert_eq!(s.last_refresh(), Some(1_727_600_000_000));

        // stop_with(Some) 覆盖原因；stop_with(None) 保留已有原因
        // （hub.stop 先写「已停止」，worker 正常退出不得覆盖）。
        s.stop_with(Some("非 NTFS 卷（exFAT），不支持实时监控".into()));
        assert!(!s.is_running());
        s.stop_with(None);
        assert_eq!(
            s.reason_snapshot().as_deref(),
            Some("非 NTFS 卷（exFAT），不支持实时监控")
        );
    }

    /// hub 空态：status 返回 running=false + 空 volumes（CONTRACT 形状）。
    /// start/stop 的完整链路依赖 AppHandle（测试无法构造 Tauri 上下文），
    /// 由 src-tauri 集成面与 worker 线程日志覆盖。
    #[test]
    fn hub_empty_status_shape() {
        let hub = MonitorHub::new();
        let st = hub.status();
        assert!(!st.running);
        assert!(st.volumes.is_empty());
    }

    /// events_per_sec 的 EMA 语义：首次调用是基线（返回 0），间隔不足
    /// 200ms 保持上一估计，事件累计后速率有限增长。
    #[test]
    fn events_per_sec_rate_basics() {
        let s = VolumeStats::new();
        assert_eq!(s.events_per_sec(), 0, "首次调用是基线");
        for _ in 0..100 {
            s.note_event();
        }
        // 立即再查（<200ms）：保持基线估计，不产出爆表值。
        assert_eq!(s.events_per_sec(), 0);
    }

    /// 探 bug 防回归：claim_slot 同步占位封死双开竞态——运行中（含「正在
    /// 启动」窗口）重复认领必须被拒，停止后允许用全新统计/旗标重启。
    /// 旧缺陷：占位靠 worker 线程 mark_running，快速双击 monitor_start
    /// 双开 worker 且旧 stop 旗标无人能置位（僵尸轮询直至进程退出）。
    #[test]
    fn claim_slot_is_idempotent_while_running() {
        let hub = MonitorHub::new();
        let (stats, stop) = hub.claim_slot("C:").expect("首次认领应成功");
        assert!(
            stats.is_running(),
            "占位必须在 spawn 前同步置 running（竞态窗口为零）"
        );
        assert!(
            hub.claim_slot("C:").is_none(),
            "运行中重复认领必须被拒（旧缺陷在此双开 worker）"
        );
        // 注：claim_slot 收到的是 start() 归一后的键（"C:"），不再重复归一；
        // 大小写变体的归一归 start() 管，属其入参契约。

        // 停止后允许重启：全新 stats/stop（旧 worker 的旗标作废也不影响新条目）。
        stop.store(true, Ordering::Relaxed);
        stats.stop_with(Some("已停止".into()));
        assert!(!stats.is_running());
        let (stats2, stop2) = hub.claim_slot("C:").expect("停止后可重新认领");
        assert!(stats2.is_running());
        assert!(
            !Arc::ptr_eq(&stats, &stats2),
            "重启必须换全新统计/旗标，不复用旧条目"
        );
        assert!(!stop2.load(Ordering::Relaxed), "新旗标必须是未置位状态");
    }

    /// monitor_status 顶层形状冻结：{running, volumes}；卷条目字段
    /// volume/running/events_per_sec/last_refresh(+reason)。
    #[test]
    fn monitor_status_json_shape() {
        let st = MonitorStatus {
            running: false,
            volumes: vec![VolumeStatus {
                volume: "C:".into(),
                running: false,
                events_per_sec: 0,
                last_refresh: None,
                reason: Some("已停止".into()),
            }],
        };
        let json = serde_json::to_value(&st).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("running"));
        assert!(obj.contains_key("volumes"));
        let vol = obj["volumes"].as_array().unwrap()[0].as_object().unwrap();
        for key in ["volume", "running", "events_per_sec", "last_refresh", "reason"] {
            assert!(vol.contains_key(key), "VolumeStatus 缺契约字段 {key}");
        }
        assert!(vol["last_refresh"].is_null());
        assert_eq!(vol["reason"], "已停止");
    }
}
