import { useEffect, useState } from 'react';
import { X, CheckCircle2, ExternalLink } from 'lucide-react';
import { api } from '../api';
import { isTauri } from '../env';
import { loadSettings, saveSettings, clearSettings, type Provider } from '../advisorClient';

type Props = { onClose: () => void };

const PROVIDER_DEFAULTS: Record<Provider, { model: string; baseUrl: string; helpUrl: string }> = {
  openai:    { model: 'gpt-4o-mini',     baseUrl: 'https://api.openai.com/v1',  helpUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { model: 'claude-haiku-4-5', baseUrl: 'https://api.anthropic.com',   helpUrl: 'https://console.anthropic.com/settings/keys' },
  ollama:    { model: 'llama3.1:8b',      baseUrl: 'http://localhost:11434',     helpUrl: 'https://ollama.com/download' },
};

export function Settings({ onClose }: Props) {
  const [provider, setProvider] = useState<Provider>('openai');
  const [model, setModel] = useState(PROVIDER_DEFAULTS.openai.model);
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
      setMsg('已保存。下一张 Auto-Walk 卡片就会用真实 AI 回答。');
      setSaved(true);
    } catch (e) {
      setErr(String(e));
    }
  };

  const wipe = () => {
    clearSettings();
    setApiKey('');
    setSaved(false);
    setMsg('已清除本地保存的 key。');
  };

  const onProviderChange = (v: Provider) => {
    setProvider(v);
    setModel(PROVIDER_DEFAULTS[v].model);
    setBaseUrl('');
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>AI 顾问设置 {saved && <CheckCircle2 size={16} style={{ verticalAlign: 'middle', marginLeft: 6, color: 'var(--pink)' }} />}</div>
          <button className="ghost icon" onClick={onClose}><X size={16} /></button>
        </div>

        <label className="field">
          <span>Provider · 提供商</span>
          <select value={provider} onChange={(e) => onProviderChange(e.target.value as Provider)}>
            <option value="openai">OpenAI（gpt-4o-mini 等，需要 sk- 开头的 key）</option>
            <option value="anthropic">Anthropic（Claude Haiku/Sonnet，需要 sk-ant- key）</option>
            <option value="ollama">Ollama（本地运行，无需 key）</option>
          </select>
        </label>

        <label className="field">
          <span>Model · 模型</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} />
        </label>

        {provider !== 'ollama' && (
          <label className="field">
            <span>API Key（只保存在你这台电脑的浏览器 localStorage 里，不会上传）</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={provider === 'openai' ? 'sk-proj-...' : 'sk-ant-api03-...'}
            />
          </label>
        )}

        <label className="field">
          <span>Base URL（可选，留空用默认）</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder={PROVIDER_DEFAULTS[provider].baseUrl}
          />
        </label>

        <a className="muted" href={PROVIDER_DEFAULTS[provider].helpUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          去哪里拿 key/装 Ollama <ExternalLink size={12} />
        </a>

        {msg && <div className="ok">{msg}</div>}
        {err && <div className="error">{err}</div>}

        <div className="modal-actions">
          {saved && <button className="ghost" onClick={wipe}>清除</button>}
          <button className="primary" onClick={save}>保存</button>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>

        <p className="muted" style={{ marginTop: 8 }}>
          Diskwise 只把目录元数据发给 AI（路径、大小、文件数、扩展名分布、抽样路径），<strong>不会</strong>读取或上传文件内容。
        </p>
      </div>
    </div>
  );
}
