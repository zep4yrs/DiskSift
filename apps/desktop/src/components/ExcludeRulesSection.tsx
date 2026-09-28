import { useEffect, useMemo, useState } from 'react';
import { Eye, Info, Plus, Save, Shield, Trash2, X } from 'lucide-react';
import { api } from '../api';
import { isTauri } from '../env';
import { matchExcludeRule } from '../excludes';
import { useStore } from '../store';
import type { ExcludeRule, ExcludeRuleType } from '../types';

// ── 设置页「排除规则」区（v26.1.4.0 §4）────────────────────────────────────
// 用户级 NEVER_TOUCH：三型规则（目录路径 / glob / 扩展名）+ 启停开关，存
// %APPDATA%/DiskSift/excludes.json（桌面：api.excludesGet/Set → Tauri 命令
// excludes_get / excludes_set，tmp+rename 原子写；浏览器：localStorage mock）。
// 与 NEVER_TOUCH 的关系（规格红线）：叠加生效，用户规则只能【收紧】可见面，
// 不能解除保护区——本 UI 不提供任何「豁免 NEVER_TOUCH」的入口。
// 预览工具：新增表单的值输入即时前端算「会命中哪些已扫目录」（草稿未保存，
// 后端 excludes_match 只认已保存规则，草稿预览走 src/excludes.ts 同口径镜像）。

const TYPE_LABEL: Record<ExcludeRuleType, string> = {
  path: '目录路径',
  glob: 'glob',
  ext: '扩展名',
};

const TYPE_HINT: Record<ExcludeRuleType, string> = {
  path: '绝对路径，如 C:\\Users\\me\\Downloads（该目录整支排除）',
  glob: '通配模式，如 **/node_modules/** 或 C:/temp/*（大小写不敏感）',
  ext: '扩展名，如 tmp 或 .tmp（任意层级的同名扩展文件）',
};

/** 新增草稿表单的预览命中数上限（列表截断，计数给全量）。 */
const PREVIEW_CAP = 12;

export function ExcludeRulesSection() {
  const root = useStore((s) => s.root);
  const [rules, setRules] = useState<ExcludeRule[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 新增草稿（表单即预览：输入值 → 即时算已扫目录命中）
  const [newType, setNewType] = useState<ExcludeRuleType>('path');
  const [newValue, setNewValue] = useState('');
  const [savedOnce, setSavedOnce] = useState(false);

  useEffect(() => {
    api
      .excludesGet()
      .then((cfg) => {
        setRules(cfg.rules);
        setSavedOnce(true);
      })
      .catch((e) => setErr(String(e)));
  }, []);

  /** 已扫目录里的命中预览（新增草稿即时算；root 未扫描时空表）。 */
  const previewHits = useMemo<string[]>(() => {
    if (!root || !newValue.trim()) return [];
    const draft = { type: newType, value: newValue.trim() };
    const hits: string[] = [];
    const walk = (n: { path: string; is_dir: boolean; children: { path: string; is_dir: boolean; children: unknown }[] }) => {
      if (!n.is_dir) return;
      if (matchExcludeRule(draft, n.path)) hits.push(n.path);
      for (const c of n.children) walk(c as never);
    };
    walk(root as never);
    return hits;
  }, [root, newType, newValue]);

  const mutate = (next: ExcludeRule[]) => {
    setRules(next);
    setDirty(true);
    setMsg(null);
  };

  const add = () => {
    const value = newValue.trim();
    if (!value) { setErr('请先填规则的值'); return; }
    if (rules?.some((r) => r.type === newType && r.value.toLowerCase() === value.toLowerCase())) {
      setErr('已存在同型同值的规则');
      return;
    }
    setErr(null);
    const rule: ExcludeRule = {
      id: typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: newType,
      value,
      enabled: true,
    };
    mutate([...(rules ?? []), rule]);
    setNewValue('');
  };

  const save = async () => {
    if (!rules) return;
    setBusy(true); setErr(null); setMsg(null);
    try {
      await api.excludesSet(rules);
      setDirty(false);
      setSavedOnce(true);
      setMsg(isTauri
        ? `已保存 ${rules.length} 条规则（tmp+rename 原子写 excludes.json · scanner/分诊/监控/清扫四处生效）`
        : `已保存 ${rules.length} 条规则（浏览器 mock：localStorage）`);
      // 桌面保存后用后端同一匹配器复验一条预览命中：确认写盘已生效、四处接线
      // 读到的是刚保存的规则（预览命中列表本身由前端镜像算出，此处闭环到真实现）。
      if (isTauri && previewHits[0]) {
        try {
          const verified = await api.excludesMatch(previewHits[0]);
          setMsg((m) => `${m ?? ''} · 后端复验：${verified ? '命中 ✓' : '未命中 ✗（规则可能未同步，请重开设置）'}`);
        } catch {
          /* 复验通道异常不推翻保存成功（excludes_match 缺失时静默跳过） */
        }
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="excludes-section">
      <div className="settings-section-head">
        <Shield size={13} />
        <span>排除规则</span>
        <span className="patrol-state">{rules === null ? '读取中…' : `${rules.length} 条`}</span>
      </div>
      <p className="hint">
        <Info size={12} />
        <span>
          自定义排除规则是<b>用户级 NEVER_TOUCH</b>：与内置保护区叠加生效，只能进一步收紧可见面（扫描剪枝、
          分诊、实时监控、清扫前复核四处一致），不能解除任何内置保护。
        </span>
      </p>

      {/* 新增表单（三型切换）+ 即时预览 */}
      <div className="excludes-add">
        <div className="seg seg-3 excludes-type" role="group" aria-label="规则类型">
          {(['path', 'glob', 'ext'] as ExcludeRuleType[]).map((t) => (
            <button
              key={t}
              type="button"
              className={'seg-opt' + (newType === t ? ' active' : '')}
              title={TYPE_HINT[t]}
              onClick={() => setNewType(t)}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </div>
        <div className="excludes-add-row">
          <input
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder={TYPE_HINT[newType]}
            onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          />
          <button type="button" className="btn" onClick={add} title="加入规则列表（保存后才落盘生效）">
            <Plus size={13} /> 添加
          </button>
        </div>
        {newValue.trim() && (
          <div className="excludes-preview">
            <Eye size={12} />
            {previewHits.length === 0 ? (
              <span className="muted small">当前扫描树里没有会命中该规则的目录。</span>
            ) : (
              <span className="small">
                将命中 <b>{previewHits.length}</b> 个已扫目录
                {previewHits.length > PREVIEW_CAP ? `（前 ${PREVIEW_CAP} 个）` : ''}：
                <span className="excludes-preview-list mono">
                  {previewHits.slice(0, PREVIEW_CAP).join(' · ')}
                </span>
              </span>
            )}
          </div>
        )}
      </div>

      {/* 规则列表：类型 / 值 / 启停 / 删除 */}
      {rules !== null && rules.length > 0 && (
        <div className="excludes-list" role="list">
          {rules.map((r) => (
            <div key={r.id} className="excludes-row" role="listitem">
              <span className={'badge info'} title={TYPE_HINT[r.type]}>{TYPE_LABEL[r.type]}</span>
              <span className="excludes-value mono path-clip" title={r.value}>{r.value}</span>
              <label className="excludes-toggle" title={r.enabled ? '启用中 · 点击停用' : '已停用 · 点击启用'}>
                <input
                  type="checkbox"
                  checked={r.enabled}
                  onChange={() => mutate(rules.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)))}
                />
                {r.enabled ? '启用' : '停用'}
              </label>
              <button
                type="button"
                className="ghost icon excludes-del"
                aria-label={`删除规则 ${r.value}`}
                title="删除该规则（保存后生效）"
                onClick={() => mutate(rules.filter((x) => x.id !== r.id))}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
      {rules !== null && rules.length === 0 && (
        <div className="excludes-empty muted small">还没有自定义规则 — 用上面的表单添加第一条。</div>
      )}

      {dirty && (
        <div className="excludes-save">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
            <Save size={13} /> {busy ? '保存中…' : `保存 ${rules?.length ?? 0} 条规则`}
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            title="放弃本次改动，重新读取已保存的规则"
            onClick={() => {
              api
                .excludesGet()
                .then((cfg) => { setRules(cfg.rules); setDirty(false); setMsg(null); setErr(null); })
                .catch((e) => setErr(String(e)));
            }}
          >
            <X size={13} /> 放弃改动
          </button>
          <span className="muted small">未保存的改动只在本窗口生效前预览，落盘后才四处生效。</span>
        </div>
      )}
      {msg && <div className="ok">{msg}</div>}
      {err && <div className="error">{err}</div>}
      {!isTauri && (
        <p className="muted small" style={{ margin: 0 }}>
          浏览器预览模式：规则存在 localStorage（mock 层），不落 excludes.json；桌面模式由后端命令原子写
          （excludes_get / excludes_set）。
        </p>
      )}
      {!savedOnce && rules !== null && rules.length === 0 && err === null && (
        <div className="muted small">excludes.json 尚未创建——首次保存时生成。</div>
      )}
    </div>
  );
}

