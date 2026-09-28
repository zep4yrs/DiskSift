//! Tauri v2 事件推送（CONTRACT 面板，前后端逐字一致，不得改名）。
//!
//! # 事件与载荷（v26.1.4.0 接口契约）
//!
//! ## `'usn://changes'`
//! ```json
//! { "volume": "C:",
//!   "dirs": [ { "path": "C:\\Users\\a\\cache", "size": 12345,
//!               "file_count": 42, "kind": "delete" } ],
//!   "dropped": 0 }
//! ```
//! `kind` ∈ `"create" | "delete" | "rename" | "overwrite"`（filter::ChangeKind
//! 的冻结字符串）；`dropped` 是该卷自监控启动以来累计丢弃的变更数（路径解析
//! 失败 / 积压溢出）。dirs 的数值由 refresh 模块按扫描器同口径重算。
//!
//! ## `'usn://state'`
//! ```json
//! { "volume": "C:", "running": false,
//!   "reason": "非 NTFS 卷（exFAT），不支持实时监控" }
//! ```
//! `reason` 为 null 表示正常态（启动成功 / 积压恢复）；降级、停止、积压警告
//! 都走这里——规格红线：监控侧任何失败都不弹错误框，只走状态与事件面。
//!
//! 载荷字段名不做 serde 改名（默认 snake_case 即 CONTRACT 原文）；
//! 事件名是常量 [`EVENT_CHANGES`] / [`EVENT_STATE`]。

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// CONTRACT 事件名：增量变更流。
pub const EVENT_CHANGES: &str = "usn://changes";
/// CONTRACT 事件名：监控状态变化。
pub const EVENT_STATE: &str = "usn://state";

/// `usn://changes` 里的单条受影响目录。字段名冻结：path / size / file_count / kind。
#[derive(Debug, Clone, Serialize)]
pub struct DirChange {
    pub path: String,
    pub size: u64,
    pub file_count: u64,
    /// `"create" | "delete" | "rename" | "overwrite"`
    pub kind: String,
}

/// `usn://changes` 载荷。字段名冻结：volume / dirs / dropped。
#[derive(Debug, Clone, Serialize)]
pub struct ChangesPayload {
    /// 规范卷键（`"C:"`，与 monitor_start 传入值归一后一致）。
    pub volume: String,
    pub dirs: Vec<DirChange>,
    /// 自监控启动累计丢弃的变更数。
    pub dropped: u64,
}

/// `usn://state` 载荷。字段名冻结：volume / running / reason。
#[derive(Debug, Clone, Serialize)]
pub struct StatePayload {
    pub volume: String,
    pub running: bool,
    /// null = 正常态；有值 = 降级/停止/积压的人类可读原因。
    pub reason: Option<String>,
}

/// 推送 `usn://changes`。事件发送失败（窗口已关等）只记日志不上抛——
/// 监控链路不许因 IPC 抖动中断。
pub fn emit_changes(app: &AppHandle, payload: ChangesPayload) {
    if let Err(e) = app.emit(EVENT_CHANGES, payload) {
        tracing::warn!("emit {EVENT_CHANGES} 失败: {e}");
    }
}

/// 推送 `usn://state`。同上，失败不上抛。
pub fn emit_state(app: &AppHandle, payload: StatePayload) {
    if let Err(e) = app.emit(EVENT_STATE, payload) {
        tracing::warn!("emit {EVENT_STATE} 失败: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CONTRACT 字段名逐字冻结：serde 默认 snake_case 序列化必须原样产出
    /// 契约里的键名。前端 mock（api.ts）按同样的形状写死，这里改键名会
    /// 直接撕碎契约。
    #[test]
    fn payload_field_names_are_frozen_contract() {
        let changes = ChangesPayload {
            volume: "C:".into(),
            dirs: vec![DirChange {
                path: r"C:\a".into(),
                size: 1,
                file_count: 2,
                kind: "delete".into(),
            }],
            dropped: 3,
        };
        let json = serde_json::to_value(&changes).unwrap();
        let obj = json.as_object().unwrap();
        assert!(obj.contains_key("volume"));
        assert!(obj.contains_key("dirs"));
        assert!(obj.contains_key("dropped"));
        let dir = obj["dirs"].as_array().unwrap()[0].as_object().unwrap();
        for key in ["path", "size", "file_count", "kind"] {
            assert!(dir.contains_key(key), "DirChange 缺契约字段 {key}");
        }
        assert_eq!(dir["kind"], "delete");

        let state = StatePayload {
            volume: "C:".into(),
            running: false,
            reason: Some("非 NTFS 卷（exFAT），不支持实时监控".into()),
        };
        let json = serde_json::to_value(&state).unwrap();
        let obj = json.as_object().unwrap();
        for key in ["volume", "running", "reason"] {
            assert!(obj.contains_key(key), "StatePayload 缺契约字段 {key}");
        }
        // reason=None 序列化为 null（正常态语义）。
        let normal = serde_json::to_value(StatePayload {
            volume: "C:".into(),
            running: true,
            reason: None,
        })
        .unwrap();
        assert!(normal["reason"].is_null());
    }

    /// 事件名常量与 CONTRACT 逐字一致。
    #[test]
    fn event_names_are_frozen_contract() {
        assert_eq!(EVENT_CHANGES, "usn://changes");
        assert_eq!(EVENT_STATE, "usn://state");
    }
}
