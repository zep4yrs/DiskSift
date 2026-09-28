import type { ExcludeRule, ExcludeRuleType } from './types';

// ── 排除规则前端匹配器（v26.1.4.0 §4）────────────────────────────────────
// 与后端 crates/excludes 同口径的前端镜像，仅供两处消费：
// ① mocks.excludesMatch（浏览器模式的 excludes_match 假实现）；
// ② 设置页「排除规则」的新增表单即时预览（对【未保存】草稿算命中面——后端
//    excludes_match 只认已保存规则，草稿预览只能前端算）。
// 真正的四处遵守（scanner 剪枝/分诊 classify/USN filter/清扫复核）永远走后端
// 同一份实现；本文件不参与任何安全决策，只是预览便利层。

/** 路径归一（对齐 crates/excludes：小写、反斜杠→正斜杠、去尾分隔符）。 */
export function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

/** glob → 正则（前端简化版：** 跨段、* 单段内、? 单字符；大小写不敏感）。
 *  与后端 globset（literal_separator=false、大小写不敏感）语义近似但不逐字
 *  等价——预览用，落盘后的真实匹配以后端为准。 */
export function globToRegExp(glob: string): RegExp {
  const norm = normalizePath(glob);
  let re = '';
  for (let i = 0; i < norm.length; i++) {
    const ch = norm[i];
    if (ch === '*') {
      if (norm[i + 1] === '*') { re += '.*'; i++; } else { re += '[^/]*'; }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** 单条规则匹配（type: path=glob=ext 三型，口径见 crates/excludes/src/lib.rs）。 */
export function matchExcludeRule(rule: Pick<ExcludeRule, 'type' | 'value'>, path: string): boolean {
  const p = normalizePath(path);
  if (!p) return false;
  if (rule.type === 'path') {
    const v = normalizePath(rule.value);
    if (!v) return false;
    if (v === p) return true;
    // 根值（"C:"）前缀匹配；非根值要求路径段整段匹配（不误命中 c:/windowsincl）
    if (/^[a-z]:$/.test(v)) return p.startsWith(v + '/');
    return p.startsWith(v + '/');
  }
  if (rule.type === 'ext') {
    const ext = rule.value.replace(/^\./, '').toLowerCase();
    if (!ext) return false;
    const last = p.split('/').pop() ?? '';
    return last.includes('.') && last.split('.').pop() === ext;
  }
  // glob
  const g = rule.value.trim();
  if (!g) return false;
  return globToRegExp(g).test(p);
}

/** 规则集匹配：只统计 enabled 规则（与后端一致）。 */
export function matchExcludeRules(rules: Pick<ExcludeRule, 'type' | 'value' | 'enabled'>[], path: string): boolean {
  return rules.some((r) => r.enabled && matchExcludeRule(r, path));
}

export type { ExcludeRuleType };
