//! Performs cleanup actions safely. Recycle (default), quarantine, or permanent delete.
//! Every performed action is appended to `undo.jsonl`. Dry-run previews are
//! computed and returned to the caller but never logged — a preview is not an
//! operation, and logging it would pollute the ledger the records view reads.

use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Recycle,
    Quarantine,
    Delete,
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

/// 递归统计路径字节数。文件 = len；目录 = 逐项累加，符号链接/联接跳过
/// （既不进入也不计大小——联接指向的字节不属于本次操作）。
fn path_bytes(p: &Path) -> u64 {
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

pub fn execute(
    plan: &Plan,
    dry_run: bool,
    undo_log: &Path,
    quarantine_root: &Path,
) -> anyhow::Result<Vec<UndoEntry>> {
    let mut out: Vec<UndoEntry> = Vec::new();
    let now = || chrono::Utc::now().to_rfc3339();

    // 复核修补：dry-run 是预览，不是操作——只构造返回值供调用方展示，
    // 绝不 append 进 undo.jsonl。旧行为把预览条目混进操作台账，记录视图
    // 会把它们当真实操作渲染（recycle 预览条目甚至渲染「打开回收站」按钮）。
    // reason 仍带 DRY_RUN_REASON_PREFIX，供 list_undo 过滤存量文件里
    // 旧版本写入的预览条目。
    if dry_run {
        for p in &plan.paths {
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

    // 体积在动作前取样（删除/隔离之后路径已不存在，无从统计）。
    let sizes: Vec<u64> = plan.paths.iter().map(|p| path_bytes(p)).collect();

    match plan.action {
        Action::Recycle => {
            trash::delete_all(&plan.paths)?;
            for (p, bytes) in plan.paths.iter().zip(&sizes) {
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
            for (src, bytes) in plan.paths.iter().zip(&sizes) {
                let stamp = chrono::Utc::now().timestamp_millis();
                let leaf = src
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "item".into());
                let dst = quarantine_root.join(format!("{stamp}-{leaf}"));
                if let Err(e) = std::fs::rename(src, &dst) {
                    tracing::warn!("rename failed ({}); falling back to copy+remove", e);
                    copy_then_remove(src, &dst)?;
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
            for (p, bytes) in plan.paths.iter().zip(&sizes) {
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
    }

    write_log(undo_log, &out)?;
    Ok(out)
}

fn write_log(undo_log: &Path, entries: &[UndoEntry]) -> anyhow::Result<()> {
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
        std::fs::write(sub.join("a.bin"), vec![0u8; 100]);
        std::fs::write(sub.join("b.bin"), vec![0u8; 27]);
        let lone = root.join("lone.txt");
        std::fs::write(&lone, vec![0u8; 11]);

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
}
