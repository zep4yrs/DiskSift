import { useEffect, useState } from 'react';
import { X, CheckCircle2, Info, Eye, EyeOff } from 'lucide-react';
import { api } from '../api';
import { isTauri } from '../env';
import { loadSettings, saveSettings, clearSettings, type Provider } from '../advisorClient';

type Props = { onClose: () => void };

export function Settings({ onClose }: Props) {
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  // 大多数中转和国内厂商都"兼容 OpenAI 协议"，所以默认选它。需要 Claude
  // 官方 / Gemini / 本地 Ollama 的少数用户点"高级"展开自己改。
  const [provider, setProvider] = useState<Provider>('openai');
  const [advanced, setAdvanced] = useState(false);
  const [showKey, setShowKey] = useState(false);
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
      if (existing.provider !== 'openai') setAdvanced(true);
    }
  }, []);

  const save = async () => {
    setErr(null); setMsg(null);
    if (!baseUrl.trim()) { setErr('请填 Base URL'); return; }
    if (!model.trim())   { setErr('请填 Model 名'); return; }
    if (provider !== 'ollama' && !apiKey.trim()) { setErr('请填 API Key'); return; }
    try {
      saveSettings({ provider, model, apiKey, baseUrl });
      if (isTauri) {
        await api.setAdvisor(provider, model, provider === 'ollama' ? undefined : apiKey, baseUrl);
      }
      setMsg('已保存 · key 只存在你本机 localStorage');
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
    setProvider('openai');
    setAdvanced(false);
    setSaved(false);
    setMsg('已清除本地保存的配置');
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>AI 顾问设置 {saved && <CheckCircle2 size={16} style={{ verticalAlign: 'middle', marginLeft: 6, color: 'var(--pink-deep)' }} />}</div>
          <button className="ghost icon" onClick={onClose}><X size={16} /></button>
        </div>

        <p className="hint">
          <Info size={12} />
          填你服务商给你的 <strong>Base URL</strong>、<strong>API Key</strong> 和 <strong>模型名</strong>。OpenAI、DeepSeek、Kimi、MiniMax、OpenRouter、各种中转……绝大多数都"兼容 OpenAI 协议"，直接填就能用。少数（官方 Claude / Gemini / 本地 Ollama）点下面的"高级"切换协议。
        </p>

        <label className="field">
          <span>Base URL</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </label>

        {provider !== 'ollama' && (
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

        <button
          type="button"
          className="ghost"
          onClick={() => setAdvanced((v) => !v)}
          style={{ alignSelf: 'flex-start', fontSize: 11, padding: '2px 8px' }}
        >
          {advanced ? '收起高级' : '高级（切换协议）'}
        </button>

        {advanced && (
          <label className="field">
            <span>协议</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
              <option value="openai">OpenAI 协议（默认 · 多数中转、国产模型都用这个）</option>
              <option value="anthropic">Anthropic 协议（官方 Claude / 仿 Anthropic 中转）</option>
              <option value="gemini">Gemini 协议（Google AI Studio）</option>
              <option value="ollama">Ollama 本地（无需 API Key）</option>
            </select>
          </label>
        )}

        {msg && <div className="ok">{msg}</div>}
        {err && <div className="error">{err}</div>}

        <div className="modal-actions">
          {saved && <button className="ghost" onClick={wipe}>清除</button>}
          <button className="primary" onClick={save}>保存</button>
          <button className="ghost" onClick={onClose}>关闭</button>
        </div>

        <p className="muted small" style={{ marginTop: 4 }}>
          Diskwise 只把目录元数据发给 AI（路径、大小、文件数、扩展名分布、抽样路径），<strong>不会</strong>读取或上传文件内容。
        </p>
      </div>
    </div>
  );
}
