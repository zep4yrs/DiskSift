import { useEffect, useState } from 'react';
import { X, CheckCircle2, ExternalLink, Info } from 'lucide-react';
import { api } from '../api';
import { isTauri } from '../env';
import { loadSettings, saveSettings, clearSettings, type Provider } from '../advisorClient';

type Props = { onClose: () => void };

type Source = 'official' | 'relay' | 'local';

const PROVIDER_DEFAULTS: Record<Provider, { model: string; baseUrl: string; helpUrl: string }> = {
  openai:    { model: 'gpt-4o-mini',         baseUrl: 'https://api.openai.com/v1',                helpUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { model: 'claude-haiku-4-5',    baseUrl: 'https://api.anthropic.com',                helpUrl: 'https://console.anthropic.com/settings/keys' },
  gemini:    { model: 'gemini-2.5-flash',    baseUrl: 'https://generativelanguage.googleapis.com', helpUrl: 'https://aistudio.google.com/apikey' },
  ollama:    { model: 'llama3.1:8b',         baseUrl: 'http://localhost:11434',                   helpUrl: 'https://ollama.com/download' },
};

// One-click presets for popular relay services. They give you a Base URL +
// token; you tell Diskwise which protocol the relay speaks.
const RELAY_PRESETS: { id: string; label: string; provider: Provider; baseUrl: string; modelHint: string }[] = [
  { id: 'luckyapi',  label: 'LuckyAPI（仿 Anthropic）',  provider: 'anthropic', baseUrl: 'https://cn.luckyapi.chat',     modelHint: 'claude-haiku-4-5' },
  { id: 'openrouter', label: 'OpenRouter（仿 OpenAI）',  provider: 'openai',    baseUrl: 'https://openrouter.ai/api/v1', modelHint: 'anthropic/claude-haiku-4-5' },
  { id: 'oneapi',     label: 'one-api / new-api 自建',   provider: 'openai',    baseUrl: 'https://your-relay.example.com/v1', modelHint: 'gpt-4o-mini' },
  { id: 'azure',      label: 'Azure OpenAI（暂未原生支持，用 OpenAI 协议代理）', provider: 'openai', baseUrl: 'https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT', modelHint: 'gpt-4o-mini' },
];

export function Settings({ onClose }: Props) {
  const [source, setSource] = useState<Source>('official');
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState(PROVIDER_DEFAULTS.anthropic.model);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const existing = loadSettings();
    if (existing) {
      setProvider(existing.provider);
      setModel(existing.model);
      setApiKey(existing.apiKey);
      setBaseUrl(existing.baseUrl);
      setSaved(true);
      // Infer source from existing settings.
      if (existing.provider === 'ollama') setSource('local');
      else if (existing.baseUrl && existing.baseUrl !== PROVIDER_DEFAULTS[existing.provider].baseUrl) setSource('relay');
      else setSource('official');
    }
  }, []);

  const save = async () => {
    setErr(null); setMsg(null);
    try {
      const finalBase = baseUrl || PROVIDER_DEFAULTS[provider].baseUrl;
      saveSettings({ provider, model, apiKey, baseUrl: finalBase });
      if (isTauri) {
        await api.setAdvisor(provider, model, provider === 'ollama' ? undefined : apiKey, finalBase);
      }
      setMsg('已保存 · key 只存在你的本机 localStorage');
      setSaved(true);
    } catch (e) {
      setErr(String(e));
    }
  };

  const wipe = () => {
    clearSettings();
    setApiKey('');
    setSaved(false);
    setMsg('已清除本地保存的 key');
  };

  const onSourceChange = (v: Source) => {
    setSource(v);
    if (v === 'local') {
      setProvider('ollama');
      setModel(PROVIDER_DEFAULTS.ollama.model);
      setBaseUrl('');
    } else if (v === 'official') {
      // Keep provider, but clear base URL so it falls back to default.
      if (provider === 'ollama') setProvider('anthropic');
      setBaseUrl('');
    }
    // For relay, leave provider alone — user picks protocol next.
  };

  const onProviderChange = (v: Provider) => {
    setProvider(v);
    setModel(PROVIDER_DEFAULTS[v].model);
    if (source === 'official') setBaseUrl('');
  };

  const applyPreset = (id: string) => {
    const p = RELAY_PRESETS.find((x) => x.id === id);
    if (!p) return;
    setProvider(p.provider);
    setBaseUrl(p.baseUrl);
    setModel(p.modelHint);
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>AI 顾问设置 {saved && <CheckCircle2 size={16} style={{ verticalAlign: 'middle', marginLeft: 6, color: 'var(--pink-deep)' }} />}</div>
          <button className="ghost icon" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="seg">
          <button className={'seg-opt' + (source === 'official' ? ' active' : '')} onClick={() => onSourceChange('official')}>
            官方直连
          </button>
          <button className={'seg-opt' + (source === 'relay' ? ' active' : '')} onClick={() => onSourceChange('relay')}>
            第三方中转 / 代理
          </button>
          <button className={'seg-opt' + (source === 'local' ? ' active' : '')} onClick={() => onSourceChange('local')}>
            本地（Ollama）
          </button>
        </div>

        {source === 'official' && (
          <p className="hint">
            <Info size={12} /> 直连官方接口。你只需要从下面选服务商、把 API Key 粘进来。
          </p>
        )}
        {source === 'relay' && (
          <p className="hint">
            <Info size={12} /> 用了第三方中转（LuckyAPI / OpenRouter / 自建 one-api 等）？服务商通常给你两个值：<strong>API Key</strong> 和 <strong>Base URL</strong>。
            根据他们文档说"兼容 OpenAI"还是"兼容 Anthropic"来选下面的协议。
          </p>
        )}
        {source === 'local' && (
          <p className="hint">
            <Info size={12} /> 在本机跑 Ollama，不上网、无需 key。先去 <a href="https://ollama.com/download" target="_blank" rel="noreferrer">ollama.com</a> 装好它，然后 <code>ollama pull llama3.1:8b</code> 拉模型。
          </p>
        )}

        {source === 'relay' && (
          <label className="field">
            <span>常见中转预设（点一下自动填）</span>
            <select onChange={(e) => { if (e.target.value) applyPreset(e.target.value); }} defaultValue="">
              <option value="">— 选一个或自己填 —</option>
              {RELAY_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
        )}

        {source !== 'local' && (
          <label className="field">
            <span>Provider · 协议（你的服务商兼容哪个就选哪个）</span>
            <select value={provider} onChange={(e) => onProviderChange(e.target.value as Provider)}>
              <option value="anthropic">Anthropic 协议（官方 Claude / LuckyAPI 等仿 Anthropic 中转）</option>
              <option value="openai">OpenAI 协议（官方 GPT / OpenRouter / one-api / 大多数中转）</option>
              <option value="gemini">Google Gemini 协议（Google AI Studio / Vertex 兼容）</option>
            </select>
          </label>
        )}

        <label className="field">
          <span>Model · 模型名（要和你服务商支持的型号一致）</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>

        {source !== 'local' && (
          <label className="field">
            <span>API Key（只存在你本机 localStorage，永不上传）</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider === 'openai' ? 'sk-...' : provider === 'gemini' ? 'AIza...' : 'sk-ant-api03-...'}
            />
          </label>
        )}

        <label className="field">
          <span>Base URL{source === 'official' ? '（官方默认，留空即可）' : '（你的服务商接口域名）'}</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={PROVIDER_DEFAULTS[provider].baseUrl}
          />
        </label>

        {source === 'official' && (
          <a className="muted small" href={PROVIDER_DEFAULTS[provider].helpUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            去哪里拿 {provider} 的 Key <ExternalLink size={12} />
          </a>
        )}

        {msg && <div className="ok">{msg}</div>}
        {err && <div className="error">{err}</div>}

        <div className="modal-actions">
          {saved && <button className="ghost" onClick={wipe}>清除</button>}
          <button className="primary" onClick={save}>保存</button>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>

        <p className="muted small" style={{ marginTop: 8 }}>
          Diskwise 只把目录元数据发给 AI（路径、大小、文件数、扩展名分布、抽样路径），<strong>不会</strong>读取或上传文件内容。
        </p>
      </div>
    </div>
  );
}
