//! pinkbin-excludes —— 用户自定义排除规则引擎（v26.1.4.0 菜4，规格
//! docs/release-plan-26.1.4.0.md §4）。
//!
//! # CONTRACT（前后端逐字一致）
//! 配置存 `%APPDATA%/DiskSift/excludes.json`：
//! ```json
//! { "rules": [ { "id": "uuid", "type": "path|glob|ext",
//!                "value": "...", "enabled": true } ] }
//! ```
//! **tmp+rename 原子写由前端负责，后端只读**（CONTRACT 原文）。
//!
//! # 语义
//! - 三型规则：`path`（目录路径：根值做组件边界安全的前缀匹配；非根值做
//!   路径段整段匹配）/ `glob`（globset，与 scaffold 运行时同编译参数
//!   literal_separator=false + case_insensitive=true）/ `ext`（扩展名精确
//!   段匹配，大小写不敏感，值可带可不带前导点）。
//! - `enabled=false` 的规则完全不参与匹配。
//! - 编译不了的 glob / 非法规则**跳过并 warn**（不整份配置作废）：一条
//!   手改坏掉的规则不能让其余规则失效；写入侧的前端校验是第一道闸。
//! - 与 NEVER_TOUCH 的叠加语义：本引擎只做「用户排除」（收紧可见面），
//!   不接触 executor 的 NEVER_TOUCH 保护层——用户规则只能让路径更不可见/
//!   更不可清，永远不能解除系统保护（executor 的 execute_with_cancel 里
//!   NEVER_TOUCH 整单拦截先于用户排除过滤，测试锁定该顺序）。
//!
//! # 四处遵守（统一判定函数 [`Excludes::matches`]）
//! ① scanner build_tree 剪枝：被排除目录在扫描阶段整树剔除、文件条目剔除
//!    （walkdir process_read_dir + MFT blocked 集双面）——分诊 classify 由此
//!    **间接达标**：被排除路径根本不进树，classify 天然看不到（独立复核
//!    登记：并非前端显式调用）；② 分诊 classify（经 src-tauri `excludes_match`
//!    命令的辅助查询面：管理 UI 预览工具用它保证与 scanner 同一实现）；
//!    ③ monitor filter；④ 一键清扫执行前复核（executor execute_with_cancel
//!    内置，NEVER_TOUCH 拦截之后、执行之前剔除命中路径）。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// 规则三型（CONTRACT `type` 字段的取值域）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuleKind {
    /// 目录/文件绝对路径（根值前缀匹配；非根值路径段整段匹配）。
    Path,
    /// glob 模式（与 scaffold 运行时同参数：literal_separator=false、大小写不敏感）。
    Glob,
    /// 扩展名精确段匹配（"tmp" / ".tmp" 均可）。
    Ext,
}

/// CONTRACT 单条规则。字段名冻结：id / type / value / enabled。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExcludeRule {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: RuleKind,
    pub value: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

/// CONTRACT 配置根结构。字段名冻结：rules。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExcludesConfig {
    #[serde(default)]
    pub rules: Vec<ExcludeRule>,
}

#[derive(Debug, Clone)]
struct CompiledRule {
    kind: RuleKind,
    /// path 型：归一化后的值（小写、反斜杠、去尾分隔符）。
    norm: String,
    /// glob 型：预编译 matcher。
    glob: Option<globset::GlobMatcher>,
    /// ext 型：去点小写后的扩展名。
    ext: String,
}

/// 编译好的排除规则集（ Clone 廉价——内部是小型 Vec）。
#[derive(Debug, Clone, Default)]
pub struct Excludes {
    rules: Vec<CompiledRule>,
    /// 读到的规则总条数（含禁用/非法，诊断用）。
    total: usize,
}

/// 归一化路径用于 path 型比较：剥 \\?\ 前缀、统一反斜杠、ASCII 小写、
/// 去尾分隔符（卷根 "C:\" 形态保留）。
fn normalize(p: &str) -> String {
    let s = p.trim();
    let s = s.strip_prefix(r"\\?\").unwrap_or(s);
    let mut s = s.replace('/', "\\").to_ascii_lowercase();
    while s.len() > 3 && s.ends_with('\\') {
        s.pop();
    }
    s
}

/// 归一化后是否是根形态（盘符或 UNC 开头）。
fn is_rooted(norm: &str) -> bool {
    (norm.len() >= 2 && norm.as_bytes()[1] == b':') || norm.starts_with(r"\\")
}

/// path 型规则匹配：根值 = 组件边界安全前缀（"C:\\Users" 不吃 "C:\\Users2"）；
/// 非根值（如 "node_modules"）= 任一路径段整段相等。
fn path_rule_matches(rule_norm: &str, path_norm: &str) -> bool {
    if path_norm == rule_norm {
        return true;
    }
    if is_rooted(rule_norm) {
        path_norm.starts_with(rule_norm)
            && (rule_norm.ends_with('\\')
                || path_norm.as_bytes().get(rule_norm.len()) == Some(&b'\\'))
    } else {
        path_norm.split('\\').any(|seg| seg == rule_norm)
    }
}

impl Excludes {
    /// 空规则集（Default 同义）——所有 matches 恒 false，四处调用点在
    /// is_empty 时直接短路，零开销。
    pub fn empty() -> Self {
        Self::default()
    }

    /// 从 CONTRACT 结构编译。enabled=false 与编译失败的规则跳过
    /// （warn 带规则 id 与原因）。
    pub fn from_config(cfg: &ExcludesConfig) -> Self {
        let mut rules = Vec::new();
        let total = cfg.rules.len();
        for r in &cfg.rules {
            if !r.enabled {
                continue;
            }
            match r.kind {
                RuleKind::Path => rules.push(CompiledRule {
                    kind: RuleKind::Path,
                    norm: normalize(&r.value),
                    glob: None,
                    ext: String::new(),
                }),
                RuleKind::Glob => {
                    match globset::GlobBuilder::new(r.value.trim())
                        .literal_separator(false)
                        .case_insensitive(true)
                        .build()
                    {
                        Ok(g) => rules.push(CompiledRule {
                            kind: RuleKind::Glob,
                            norm: String::new(),
                            glob: Some(g.compile_matcher()),
                            ext: String::new(),
                        }),
                        Err(e) => tracing::warn!(
                            "excludes: 规则 {} 的 glob {:?} 无法编译，已跳过: {e}",
                            r.id,
                            r.value
                        ),
                    }
                }
                RuleKind::Ext => rules.push(CompiledRule {
                    kind: RuleKind::Ext,
                    norm: String::new(),
                    glob: None,
                    ext: r.value.trim().trim_start_matches('.').to_ascii_lowercase(),
                }),
            }
        }
        Self { rules, total }
    }

    /// 从 JSON 文本编译。JSON 解析失败返回 Err（调用方决定策略——文件级
    /// 损坏无法按条跳过）。
    pub fn from_json(text: &str) -> Result<Self, String> {
        let cfg: ExcludesConfig =
            serde_json::from_str(text).map_err(|e| format!("excludes.json 解析失败: {e}"))?;
        Ok(Self::from_config(&cfg))
    }

    /// 读配置文件。缺文件（首次使用）与坏 JSON 一律得空集——排除规则
    /// 加载失败绝不能反过来挡住扫描/清扫主链路。
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => match Self::from_json(&text) {
                Ok(e) => e,
                Err(reason) => {
                    tracing::warn!("excludes: {}（按空规则集运行）", reason);
                    Self::empty()
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Self::empty(),
            Err(e) => {
                tracing::warn!("excludes: {} 读取失败: {e}（按空规则集运行）", path.display());
                Self::empty()
            }
        }
    }

    /// CONTRACT 固定路径：%APPDATA%/DiskSift/excludes.json。
    /// %APPDATA% 读不到（非 Windows 环境）返回 None。
    pub fn default_path() -> Option<PathBuf> {
        std::env::var_os("APPDATA").map(|appdata| {
            PathBuf::from(appdata).join("DiskSift").join("excludes.json")
        })
    }

    /// 从 CONTRACT 固定路径加载。
    pub fn load_default() -> Self {
        match Self::default_path() {
            Some(p) => Self::load(&p),
            None => Self::empty(),
        }
    }

    /// 没有任何生效规则（调用点短路用）。
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// 生效规则条数（诊断面）。
    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }

    /// 读到的规则总条数（含禁用/非法，诊断面）。
    pub fn total_rule_count(&self) -> usize {
        self.total
    }

    /// 统一判定：path（文件或目录）是否命中任一生效规则。
    /// 命中 = 用户要求该路径从可见面/可清面上消失（只能收紧，不能放松）。
    pub fn matches(&self, path: &Path) -> bool {
        if self.rules.is_empty() {
            return false;
        }
        let norm = normalize(&path.to_string_lossy());
        let forward = if norm.contains('\\') {
            norm.replace('\\', "/")
        } else {
            norm.clone()
        };
        let ext_of = || {
            Path::new(&norm)
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default()
        };
        self.rules.iter().any(|r| match r.kind {
            RuleKind::Path => path_rule_matches(&r.norm, &norm),
            RuleKind::Glob => r.glob.as_ref().map(|g| g.is_match(&forward)).unwrap_or(false),
            RuleKind::Ext => !r.ext.is_empty() && ext_of() == r.ext,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(kind: RuleKind, value: &str) -> ExcludeRule {
        ExcludeRule {
            id: format!("{kind:?}-{value}"),
            kind,
            value: value.into(),
            enabled: true,
        }
    }

    fn ex(rules: Vec<ExcludeRule>) -> Excludes {
        Excludes::from_config(&ExcludesConfig { rules })
    }

    #[test]
    fn path_rule_rooted_prefix_component_safe() {
        let e = ex(vec![rule(RuleKind::Path, r"C:\Users\x\cache")]);
        assert!(e.matches(Path::new(r"C:\Users\x\cache")));
        assert!(e.matches(Path::new(r"C:\Users\x\cache\sub\f.tmp")));
        assert!(e.matches(Path::new(r"c:/users/X/CACHE"))); // 大小写+斜杠归一
        // 组件边界：前缀相像不算。
        assert!(!e.matches(Path::new(r"C:\Users\x\cache2")));
        assert!(!e.matches(Path::new(r"C:\Users\x\cacheNew\a")));
        assert!(!e.matches(Path::new(r"D:\Users\x\cache")));
        // verbatim 前缀路径照常命中。
        assert!(e.matches(Path::new(r"\\?\C:\Users\x\cache\a")));
    }

    #[test]
    fn path_rule_unrooted_value_matches_segment() {
        let e = ex(vec![rule(RuleKind::Path, "node_modules")]);
        assert!(e.matches(Path::new(r"C:\proj\node_modules")));
        assert!(e.matches(Path::new(r"C:\proj\node_modules\bin\x.js")));
        assert!(e.matches(Path::new(r"D:\a\node_modules\b")));
        assert!(!e.matches(Path::new(r"C:\proj\node_modules.bak")));
        assert!(!e.matches(Path::new(r"C:\node_modulesx")));
    }

    #[test]
    fn glob_rule_same_compile_params_as_scaffold() {
        // `*` 跨目录分隔符（literal_separator=false）：与 scaffold 运行时一致，
        // 一个 `*.log` 能盖住任意深度的 .log 文件。
        let e = ex(vec![rule(RuleKind::Glob, "**/*.log")]);
        assert!(e.matches(Path::new(r"C:\a\b\c\app.log")));
        assert!(e.matches(Path::new(r"C:\x.log")));
        assert!(!e.matches(Path::new(r"C:\a\app.txt")));
        // 大小写不敏感。
        let e2 = ex(vec![rule(RuleKind::Glob, "**/CACHE/**")]);
        assert!(e2.matches(Path::new(r"C:\app\Cache\tmp\f")));
        // 坏 glob 被跳过：不 panic、不匹配任何路径。
        let bad = ex(vec![rule(RuleKind::Glob, "**/[")]);
        assert!(bad.is_empty());
        assert!(!bad.matches(Path::new(r"C:\anything")));
    }

    #[test]
    fn ext_rule_exact_segment_case_insensitive() {
        let e = ex(vec![rule(RuleKind::Ext, "tmp")]);
        assert!(e.matches(Path::new(r"C:\a\footmp.TMP")));
        assert!(e.matches(Path::new(r"C:\a\x.tmp")));
        // 精确段：不是后缀包含。
        assert!(!e.matches(Path::new(r"C:\a\x.tmplog")));
        assert!(!e.matches(Path::new(r"C:\a\tmp"))); // 无扩展名的名为 tmp 的项
        // 带前导点等价。
        let e2 = ex(vec![rule(RuleKind::Ext, ".Bak")]);
        assert!(e2.matches(Path::new(r"C:\a\f.bak")));
        // 目录名带扩展名同样命中（扫描剪枝对目录生效需要这个语义）。
        assert!(e.matches(Path::new(r"C:\a\junk.tmp")));
    }

    #[test]
    fn disabled_rules_do_not_match() {
        let mut r = rule(RuleKind::Path, r"C:\x");
        r.enabled = false;
        let e = ex(vec![r]);
        assert!(e.is_empty());
        assert_eq!(e.rule_count(), 0);
        assert_eq!(e.total_rule_count(), 1);
        assert!(!e.matches(Path::new(r"C:\x\a")));
    }

    #[test]
    fn contract_json_roundtrip_and_frozen_field_names() {
        let text = r#"{"rules":[{"id":"u1","type":"path","value":"C:\\cache","enabled":true},{"id":"u2","type":"glob","value":"**/*.tmp"},{"id":"u3","type":"ext","value":".log","enabled":false}]}"#;
        let cfg: ExcludesConfig = serde_json::from_str(text).unwrap();
        assert_eq!(cfg.rules.len(), 3);
        assert_eq!(cfg.rules[0].kind, RuleKind::Path);
        assert_eq!(cfg.rules[1].kind, RuleKind::Glob);
        assert_eq!(cfg.rules[2].kind, RuleKind::Ext);
        // enabled 缺省 = true（CONTRACT：写入侧总写 enabled，读侧容错）。
        assert!(cfg.rules[1].enabled);
        assert!(!cfg.rules[2].enabled);
        // 序列化字段名逐字冻结。
        let out = serde_json::to_value(&cfg.rules[0]).unwrap();
        for key in ["id", "type", "value", "enabled"] {
            assert!(out.as_object().unwrap().contains_key(key), "缺契约字段 {key}");
        }
        assert_eq!(out["type"], "path");
    }

    #[test]
    fn load_missing_and_corrupt_files_yield_empty() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("excludes.json");
        // 缺文件（首次使用）→ 空集，不报错。
        assert!(Excludes::load(&p).is_empty());
        // 坏 JSON → 空集 + 不 panic。
        std::fs::write(&p, "{not json").unwrap();
        assert!(Excludes::load(&p).is_empty());
        // 合法 JSON + 一条坏 glob：坏条跳过，好条生效。
        std::fs::write(
            &p,
            r#"{"rules":[{"id":"a","type":"path","value":"C:\\keep","enabled":true},{"id":"b","type":"glob","value":"**/["}]}"#,
        )
        .unwrap();
        let e = Excludes::load(&p);
        assert_eq!(e.rule_count(), 1, "坏 glob 跳过，好规则保留");
        assert_eq!(e.total_rule_count(), 2);
        assert!(e.matches(Path::new(r"C:\keep\x")));
    }

    #[test]
    fn mixed_rules_any_match_excludes() {
        let e = ex(vec![
            rule(RuleKind::Ext, "log"),
            rule(RuleKind::Path, r"D:\downloads"),
        ]);
        assert!(e.matches(Path::new(r"C:\a\b.log")));
        assert!(e.matches(Path::new(r"D:\downloads\f.txt")));
        assert!(e.matches(Path::new(r"D:\downloads\sub\f.txt")));
        assert!(!e.matches(Path::new(r"C:\a\b.txt")));
    }
}
