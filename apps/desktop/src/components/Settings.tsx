import { useEffect, useState } from 'react';
import { Activity, X, CheckCircle2, Info, Eye, EyeOff, Settings2, CalendarClock } from 'lucide-react';
import { api, type AutoPatrolFrequency, type AutoPatrolStatus } from '../api';
import { isTauri } from '../env';
import { useStore } from '../store';
import { ExcludeRulesSection } from './ExcludeRulesSection';
import {
  loadSettings,
  saveSettings,
  clearSettings,
  ensureApiKey,
  detectProvider,
  type Provider,
} from '../advisorClient';

type Props = {
  onClose: () => void;
  /** 免费接入引导（triage-overlay-spec §7 决策 4）预填：给 Base URL/Model，
   *  让「去设置」一键直达可保存状态。提供时覆盖已存配置的对应字段。 */
  prefill?: { baseUrl: string; model: string } | null;
};

const PROVIDER_LABEL: Record<Provider, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama（本地，免 Key）',
};

// 手动开关里的选项要短，五个塞在一行；「已识别」标签用完整版说明。
const PROVIDER_LABEL_SHORT: Record<Provider, string> = {
  openai: 'OpenAI 兼容',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  ollama: 'Ollama',
};

// 定时巡查频率档位（auto_patrol.rs schedule_args 四档的实测时刻）：
// 档位名要短（四个塞一行），完整时刻放 title 与开启回显里。
const PATROL_FREQS: { id: AutoPatrolFrequency; label: string }[] = [
  { id: 'hourly', label: '每小时' },
  { id: 'daily', label: '每天' },
  { id: 'weekly', label: '每周日' },
  { id: 'monthly', label: '每月' },
];

const PATROL_FREQ_FULL: Record<AutoPatrolFrequency, string> = {
  hourly: '每小时（00:30 起）',
  daily: '每天 03:00',
  weekly: '每周日 03:00',
  monthly: '每月 1 日 04:00',
};

function isPatrolFreq(v: string): v is AutoPatrolFrequency {
  return v === 'hourly' || v === 'daily' || v === 'weekly' || v === 'monthly';
}

/** 盘符提取（App.tsx driveOf 同口径的本地副本，避免跨文件导出扩散）。 */
function driveOf(p: string): string {
  return /^[A-Za-z]:/.test(p) ? `${p[0]}:` : '';
}

function fmtRefresh(ms: number | null): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString();
}

/** 「实时监控」区（v26.1.4.0 §1.2）：总开关 + 每已扫描卷开关 + 状态行 +
 *  隐私说明。开关直接调 store 动作（api.monitorStart/Stop + status 快照），
 *  事件流由 App 挂的 useMonitor 统一订阅；浏览器模式走 mock 假变更序列，
 *  数字会动（规格：mock 层提供假变更序列驱动）。 */
function MonitorSection() {
  const root = useStore((s) => s.root);
  const monitorVolumes = useStore((s) => s.monitorVolumes);
  const monitorReason = useStore((s) => s.monitorReason);
  const monitorBacklog = useStore((s) => s.monitorBacklog);
  const monitorTotalChanges = useStore((s) => s.monitorTotalChanges);
  const dirtyPaths = useStore((s) => s.dirtyPaths);
  const startMonitor = useStore((s) => s.startMonitor);
  const stopMonitor = useStore((s) => s.stopMonitor);

  // 已扫描卷 = 当前扫描根的盘符（单扫描模型）；联合已在监控的卷（其他来源开启的）
  const scannedVolume = root ? driveOf(root.path) : null;
  const activeVolumes = monitorVolumes.filter((v) => v.running).map((v) => v.volume);
  const volumeList = Array.from(new Set([...(scannedVolume ? [scannedVolume] : []), ...activeVolumes]));
  const allOn = volumeList.length > 0 && volumeList.every((v) => activeVolumes.includes(v));
  const anyRunning = activeVolumes.length > 0;

  const totalPerSec = Math.round(monitorVolumes.reduce((a, v) => a + (v.running ? v.events_per_sec : 0), 0) * 10) / 10;
  const lastRefresh = monitorVolumes.reduce<number | null>(
    (acc, v) => (v.last_refresh != null && (acc == null || v.last_refresh > acc) ? v.last_refresh : acc), null,
  );
  const [busy, setBusy] = useState(false);
  const [opErr, setOpErr] = useState<string | null>(null);

  const toggleAll = async () => {
    setBusy(true); setOpErr(null);
    try {
      for (const v of volumeList) {
        if (allOn) await stopMonitor(v);
        else if (!activeVolumes.includes(v)) await startMonitor(v);
      }
    } catch (e) {
      setOpErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleOne = async (v: string) => {
    setBusy(true); setOpErr(null);
    try {
      if (activeVolumes.includes(v)) await stopMonitor(v);
      else await startMonitor(v);
    } catch (e) {
      setOpErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="monitor-section">
      <div className="settings-section-head">
        <Activity size={13} />
        <span>实时监控</span>
        <span className={'patrol-state' + (anyRunning ? ' on' : '')}>
          {anyRunning ? `监控中 · ${totalPerSec} 变更/秒 · 上次刷新 ${fmtRefresh(lastRefresh)}` : '未开启'}
        </span>
      </div>
      <p className="hint">
        <Info size={12} />
        <span>
          读取 NTFS USN 日志（只读），只收<b>路径变更</b>，绝不读取文件内容；变更目录的
          大小/文件数由后台按扫描同口径增量重算，空间图与树实时反映
          （本会话已应用 {monitorTotalChanges} 条变更{Object.keys(dirtyPaths).length > 0 ? ` · 脏目录 ${Object.keys(dirtyPaths).length} 个` : ''}）。
          积压过大时自动降级并建议重扫；关闭监控后零 CPU。
        </span>
      </p>

      <div className="patrol-row">
        <button
          type="button"
          className={allOn ? 'ghost' : 'primary'}
          disabled={busy || volumeList.length === 0}
          title={volumeList.length === 0
            ? '先扫描一个磁盘，才能开启该卷的实时监控'
            : allOn ? '停止全部已扫描卷的监控' : '对已扫描卷开启 USN 实时监控'}
          onClick={() => void toggleAll()}
        >
          {busy ? '处理中…' : allOn ? '全部停止' : '全部开启'}
        </button>
        {!scannedVolume && (
          <span className="muted small">还没有已扫描的卷 — 先选择磁盘并扫描。</span>
        )}
      </div>

      {volumeList.map((v) => {
        const st = monitorVolumes.find((x) => x.volume === v);
        const running = activeVolumes.includes(v);
        const reason = st?.reason ?? null;
        return (
          <div key={v} className="monitor-volume-row">
            <span className="mono monitor-vol-letter">{v}</span>
            <label className="excludes-toggle" title={running ? '点击停止该卷监控' : '点击开启该卷监控'}>
              <input type="checkbox" checked={running} disabled={busy} onChange={() => void toggleOne(v)} />
              {running ? '监控中' : '已停止'}
            </label>
            <span className="muted small monitor-vol-meta">
              {running
                ? `${st?.events_per_sec ?? 0} 变更/秒 · 上次刷新 ${fmtRefresh(st?.last_refresh ?? null)}`
                : reason ? `降级：${reason}` : '未监控'}
            </span>
            {reason && running && <span className="badge warn" title={reason}>降级</span>}
          </div>
        );
      })}

      {monitorBacklog && (
        <div className="error" role="status">
          变更积压过大，监控已降级 — 建议重新扫描以获得准确数据（App 顶部也有提示条）。
        </div>
      )}
      {monitorReason && !monitorBacklog && (
        <div className="muted small">最近状态：{monitorReason}</div>
      )}
      {opErr && <div className="error">{opErr}</div>}
      {!isTauri && (
        <p className="muted small" style={{ margin: 0 }}>
          浏览器预览模式：走 mock 层假变更序列（演示增量链路，无真实 USN）；真实监控仅桌面模式可用。
        </p>
      )}
    </div>
  );
}

export function Settings({ onClose, prefill }: Props) {
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // undefined = 自动识别；手动指定时存具体 Provider。默认收起，不常驻展示。
  const [providerOverride, setProviderOverride] = useState<Provider | undefined>(undefined);
  const [showManual, setShowManual] = useState(false);

  useEffect(() => {
    const existing = loadSettings();
    if (existing) {
      setModel(existing.model);
      setBaseUrl(existing.baseUrl);
      setProviderOverride(existing.providerOverride);
      setSaved(true);
      // 新格式下 localStorage 无明文（hasKey 标记）：异步从 DPAPI secure
      // storage 取回明文回填输入框，让用户能看/改 key，而不是留一个假输入框。
      ensureApiKey(existing).then((key) => {
        if (key) setApiKey(key);
      });
    }
    // 免费接入引导预填（spec §7 决策 4）：覆盖已存值，让「去设置」直达可保存状态
    if (prefill) {
      setBaseUrl(prefill.baseUrl);
      setModel(prefill.model);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const provider = providerOverride ?? detectProvider(baseUrl);
  const needsKey = provider !== 'ollama';

  // ── 定时自动巡查（auto-patrol）：注册状态只读自系统（Task Scheduler），
  // 开关/换档直接落 schtasks，不走「保存」——保存只管 AI 配置。 ──
  const [patrol, setPatrol] = useState<AutoPatrolStatus | null>(null);
  const [patrolFreq, setPatrolFreq] = useState<AutoPatrolFrequency>('weekly');
  const [patrolBusy, setPatrolBusy] = useState(false);
  const [patrolMsg, setPatrolMsg] = useState<string | null>(null);
  const [patrolErr, setPatrolErr] = useState<string | null>(null);

  useEffect(() => {
    api.autoPatrolStatus()
      .then((st) => {
        setPatrol(st);
        // 状态里带生效档位（未注册 = ''，识别不了 = 'unknown'），有合法档位才回填
        if (st.registered && isPatrolFreq(st.frequency)) setPatrolFreq(st.frequency);
      })
      .catch(() => setPatrol(null));
  }, []);

  const refreshPatrol = () =>
    api.autoPatrolStatus()
      .then(setPatrol)
      .catch(() => setPatrol(null));

  const patrolToggle = async () => {
    if (patrolBusy || patrol === null) return;
    setPatrolBusy(true); setPatrolErr(null); setPatrolMsg(null);
    try {
      if (patrol.registered) {
        await api.autoPatrolUnregister();
        setPatrolMsg('已关闭定时巡查');
      } else {
        // 后端回显生效档位（字符串）；非四档字面量时不带时刻后缀
        const f = await api.autoPatrolRegister(patrolFreq);
        setPatrolMsg(`已开启定时巡查${isPatrolFreq(f) ? ` · ${PATROL_FREQ_FULL[f]}` : ''}`);
      }
      await refreshPatrol();
    } catch (e) {
      setPatrolErr(String(e));
    } finally {
      setPatrolBusy(false);
    }
  };

  const patrolFreqChange = async (f: AutoPatrolFrequency) => {
    if (patrolBusy) return;
    setPatrolFreq(f);
    if (patrol?.registered !== true) return; // 未注册时只记档位，注册时生效
    // 已注册状态下换档 = /F 覆盖同名任务（auto_patrol_register 幂等改频）
    setPatrolBusy(true); setPatrolErr(null); setPatrolMsg(null);
    try {
      await api.autoPatrolRegister(f);
      setPatrolMsg(`巡查频率已改为${PATROL_FREQ_FULL[f]}`);
      await refreshPatrol();
    } catch (e) {
      setPatrolErr(String(e));
    } finally {
      setPatrolBusy(false);
    }
  };

  const save = async () => {
    setErr(null); setMsg(null);
    if (!baseUrl.trim()) { setErr('请填 Base URL'); return; }
    if (!model.trim())   { setErr('请填 Model 名'); return; }
    if (needsKey && !apiKey.trim()) { setErr('请填 API Key'); return; }
    try {
      // saveSettings 内部完成分流：Tauri 下明文进 DPAPI 加密存储，localStorage
      // 只落 hasKey 标记；浏览器预览模式没有后端，保持旧的全量 localStorage。
      await saveSettings({ provider, model, apiKey, baseUrl, providerOverride });
      if (isTauri) {
        await api.setAdvisor(provider, model, needsKey ? apiKey : undefined, baseUrl);
      }
      setMsg(isTauri ? '已保存 · key 已用 Windows DPAPI 加密存本机' : '已保存 · key 只存在你本机 localStorage');
      setSaved(true);
    } catch (e) {
      setErr(String(e));
    }
  };

  const wipe = () => {
    clearSettings();
    setApiKey('');
    setBaseUrl('');
    setModel('');
    setProviderOverride(undefined);
    setShowManual(false);
    setSaved(false);
    setMsg('已清除本地保存的配置');
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>设置 {saved && <CheckCircle2 size={16} style={{ verticalAlign: 'middle', marginLeft: 6, color: 'var(--pink-deep)' }} />}</div>
          <button className="ghost icon" onClick={onClose}><X size={16} /></button>
        </div>

        <p className="hint">
          <Info size={12} />
          <span>填你服务商给你的 Base URL、API Key 和模型名。OpenAI、DeepSeek、Kimi、各种中转都直接填就能用；本地 Ollama 不用 Key。</span>
        </p>

        <label className="field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </label>

        {baseUrl.trim() && (
          <div className="provider-detect">
            <span className="badge">
              已识别：{PROVIDER_LABEL[provider]}
              {providerOverride && ' · 手动'}
            </span>
            <button type="button" className="provider-detect-toggle" onClick={() => setShowManual((v) => !v)}>
              <Settings2 size={11} />
              手动指定
            </button>
          </div>
        )}

        {baseUrl.trim() && showManual && (
          <div className="seg seg-5">
            <button
              type="button"
              className={`seg-opt${providerOverride === undefined ? ' active' : ''}`}
              onClick={() => setProviderOverride(undefined)}
            >
              自动
            </button>
            {(Object.keys(PROVIDER_LABEL) as Provider[]).map((p) => (
              <button
                key={p}
                type="button"
                className={`seg-opt${providerOverride === p ? ' active' : ''}`}
                onClick={() => setProviderOverride(p)}
              >
                {PROVIDER_LABEL_SHORT[p]}
              </button>
            ))}
          </div>
        )}

        {needsKey && (
          <label className="field">
            <span>API Key（只存本机，永不上传）</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="ghost icon"
                onClick={() => setShowKey((v) => !v)}
                title={showKey ? '隐藏' : '显示'}
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </label>
        )}

        <label className="field">
          <span>Model · 模型名</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini · deepseek-chat · claude-haiku-4-5 …"
          />
        </label>

        {msg && <div className="ok">{msg}</div>}
        {err && <div className="error">{err}</div>}

        <div className="settings-divider" role="separator" />
        <div className="settings-section-head">
          <CalendarClock size={13} />
          <span>定时自动巡查</span>
          <span className="patrol-state">
            {patrol === null
              ? '状态未知'
              : patrol.registered
                ? (patrol.enabled ? '已开启' : '已开启 · 任务被禁用')
                : '未开启'}
          </span>
        </div>
        <p className="hint">
          <Info size={12} />
          <span>
            按档位在后台无头巡查：扫描系统盘 → 只把判定缓存里「可安全清理」（safe）的目录移入回收站（可还原）→ 写入操作记录后退出。注册的是 Windows 计划任务 {patrol?.task_name ?? 'DiskSiftAutoPatrol'}，指向本程序，随时可关闭。
          </span>
        </p>
        <div className="patrol-row">
          <button
            type="button"
            className={patrol?.registered ? 'primary' : 'ghost'}
            disabled={patrolBusy || patrol === null}
            title={patrol?.registered
              ? '注销 Windows 计划任务（未注册时幂等）'
              : '注册 Windows 计划任务并按所选档位定时巡查'}
            onClick={() => void patrolToggle()}
          >
            {patrolBusy ? '处理中…' : patrol === null ? '读取中…' : patrol.registered ? '关闭定时巡查' : '开启定时巡查'}
          </button>
          <div className="seg seg-4 patrol-freq" role="group" aria-label="巡查频率">
            {PATROL_FREQS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={'seg-opt' + (patrolFreq === f.id ? ' active' : '')}
                title={PATROL_FREQ_FULL[f.id] + (patrol?.registered ? ' · 点击立即生效' : ' · 注册时生效')}
                onClick={() => void patrolFreqChange(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        {patrol !== null && patrol.registered && (
          <div className="patrol-status muted small" title={patrol.status ?? undefined}>
            已注册 {patrol.task_name} · 下次运行：{patrol.next_run ?? '—'}
            {!patrol.enabled && ' · 任务当前被禁用（可在任务计划程序中重新启用）'}
          </div>
        )}
        {patrolMsg && <div className="ok">{patrolMsg}</div>}
        {patrolErr && <div className="error">{patrolErr}</div>}
        {!isTauri && (
          <p className="muted small" style={{ margin: 0 }}>
            浏览器预览模式没有系统计划任务语义，以上操作不会生效。
          </p>
        )}

        <div className="settings-divider" role="separator" />
        <MonitorSection />

        <div className="settings-divider" role="separator" />
        <ExcludeRulesSection />

        <div className="modal-actions">
          {saved && <button className="ghost" onClick={wipe}>清除</button>}
          <button className="primary" onClick={save}>保存</button>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>

        <p className="muted small" style={{ marginTop: 4 }}>
          DiskSift 只把目录元数据发给 AI（路径、大小、文件数、扩展名分布、抽样路径），<strong>不会</strong>读取或上传文件内容。
        </p>
      </div>
    </div>
  );
}
