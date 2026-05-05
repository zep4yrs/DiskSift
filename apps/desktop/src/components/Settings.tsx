import { useEffect, useState } from 'react';
import { X, CheckCircle2, ExternalLink, Info, Eye, EyeOff } from 'lucide-react';
import { api } from '../api';
import { isTauri } from '../env';
import { loadSettings, saveSettings, clearSettings, type Provider } from '../advisorClient';

type Props = { onClose: () => void };

// 一组可一键填好 baseUrl + 协议 + 推荐模型的预设。包含官方接口 + 主流中转 + 国内厂商。
// 新增预设只需在这里追加；UI 不需要再改。
type Preset = {
  id: string;
  label: string;
  provider: Provider;
  baseUrl: string;
  modelHint: string;
  helpUrl?: string;
  isLocal?: boolean;
};

const PRESETS: Preset[] = [
  // 官方
  { id: 'anthropic',  label: 'Claude（Anthropic 官方）', provider: 'anthropic', baseUrl: 'https://api.anthropic.com',                modelHint: 'claude-haiku-4-5',  helpUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai',     label: 'OpenAI（GPT 官方）',       provider: 'openai',    baseUrl: 'https://api.openai.com/v1',                modelHint: 'gpt-4o-mini',       helpUrl: 'https://platform.openai.com/api-keys' },
  { id: 'gemini',     label: 'Gemini（Google AI Studio）', provider: 'gemini',  baseUrl: 'https://generativelanguage.googleapis.com', modelHint: 'gemini-2.5-flash',  helpUrl: 'https://aistudio.google.com/apikey' },
  // 国内大厂（多数兼容 OpenAI 协议）
  { id: 'deepseek',   label: 'DeepSeek（兼容 OpenAI）',   provider: 'openai',   baseUrl: 'https://api.deepseek.com/v1',              modelHint: 'deepseek-chat',     helpUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'kimi',       label: 'Kimi / Moonshot（兼容 OpenAI）', provider: 'openai', baseUrl: 'https://api.moonshot.cn/v1',           modelHint: 'moonshot-v1-8k',    helpUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { id: 'minimax',    label: 'MiniMax（兼容 OpenAI）',    provider: 'openai',   baseUrl: 'https://api.minimax.chat/v1',              modelHint: 'abab6.5s-chat',     helpUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key' },
  { id: 'dashscope',  label: '阿里通义千问（兼容 OpenAI）', provider: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelHint: 'qwen-turbo', helpUrl: 'https://bailian.console.aliyun.com/' },
  { id: 'zhipu',      label: '智谱 GLM（兼容 OpenAI）',    provider: 'openai',   baseUrl: 'https://open.bigmodel.cn/api/paas/v4',     modelHint: 'glm-4-flash',       helpUrl: 'https://open.bigmodel.cn/usercenter/apikeys' },
  { id: 'siliconflow',label: '硅基流动 SiliconFlow（兼容 OpenAI）', provider: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', modelHint: 'Qwen/Qwen2.5-7B-Instruct', helpUrl: 'https://cloud.siliconflow.cn/account/ak' },
  // 第三方中转
  { id: 'openrouter', label: 'OpenRouter（兼容 OpenAI）',  provider: 'openai',   baseUrl: 'https://openrouter.ai/api/v1',             modelHint: 'anthropic/claude-haiku-4-5', helpUrl: 'https://openrouter.ai/keys' },
  { id: 'luckyapi',   label: 'LuckyAPI（兼容 Anthropic）', provider: 'anthropic', baseUrl: 'https://cn.luckyapi.chat',                modelHint: 'claude-haiku-4-5' },
  { id: 'oneapi',     label: 'one-api / new-api 自建（兼容 OpenAI）', provider: 'openai', baseUrl: 'https://your-relay.example.com/v1', modelHint: 'gpt-4o-mini' },
  // 本地
  { id: 'ollama',     label: '本地 Ollama（无需 key、不上网）', provider: 'ollama', baseUrl: 'http://localhost:11434',              modelHint: 'llama3.1:8b',       helpUrl: 'https://ollama.com/download', isLocal: true },
  // 完全自定义
  { id: 'custom',     label: '其它 / 自定义',              provider: 'openai',   baseUrl: '',                                          modelHint: '' },
];

function inferPresetFrom(provider: Provider, baseUrl: string): string {
  const norm = baseUrl.replace(/\/$/, '').toLowerCase();
  const hit = PRESETS.find((p) => p.provider === provider && p.baseUrl.replace(/\/$/, '').toLowerCase() === norm);
  return hit?.id ?? 'custom';
}

export function Settings({ onClose }: Props) {
  const [presetId, setPresetId] = useState<string>('anthropic');
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [model, setModel] = useState('claude-haiku-4-5');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
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
      setPresetId(inferPresetFrom(existing.provider, existing.baseUrl));
      setSaved(true);
    }
  }, []);

  const applyPreset = (id: string) => {
    setPresetId(id);
    const p = PRESETS.find((x) => x.id === id);
    if (!p || p.id === 'custom') return;
    setProvider(p.provider);
    setBaseUrl(p.baseUrl);
    if (!model || model.length === 0 || PRESETS.some((x) => x.modelHint === model)) {
      setModel(p.modelHint);
    }
  };

  const save = async () => {
    setErr(null); setMsg(null);
    try {
      const finalBase = baseUrl;
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

  const preset = PRESETS.find((p) => p.id === presetId);
  const isLocal = preset?.isLocal === true;
  const placeholderKey =
    provider === 'openai' ? 'sk-...' :
    provider === 'gemini' ? 'AIza...' :
    provider === 'anthropic' ? 'sk-ant-api03-...' : '';

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>AI 顾问设置 {saved && <CheckCircle2 size={16} style={{ verticalAlign: 'middle', marginLeft: 6, color: 'var(--pink-deep)' }} />}</div>
          <button className="ghost icon" onClick={onClose}><X size={16} /></button>
        </div>

        <p className="hint">
          <Info size={12} />
          只填三件事：<strong>服务商</strong>、<strong>API Key</strong>、<strong>模型名</strong>。中转或自建接口就把 Base URL 改成它给你的地址；本地用 Ollama 不用 Key。
        </p>

        <label className="field">
          <span>服务商 / 协议</span>
          <select value={presetId} onChange={(e) => applyPreset(e.target.value)}>
            <optgroup label="官方接口">
              {PRESETS.slice(0, 3).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </optgroup>
            <optgroup label="国内大厂">
              {PRESETS.slice(3, 9).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </optgroup>
            <optgroup label="第三方中转">
              {PRESETS.slice(9, 12).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </optgroup>
            <optgroup label="其它">
              {PRESETS.slice(12).map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </optgroup>
          </select>
        </label>

        {!isLocal && (
          <label className="field">
            <span>API Key（只存在本机 localStorage，永不上传）</span>
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={placeholderKey}
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
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder={preset?.modelHint} />
        </label>

        <label className="field">
          <span>Base URL{presetId === 'custom' ? '（必填）' : ''}</span>
          <input
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); setPresetId(inferPresetFrom(provider, e.target.value)); }}
            placeholder={preset?.baseUrl}
          />
        </label>

        {presetId === 'custom' && (
          <label className="field">
            <span>协议（不知道选哪个？看你服务商文档说"兼容 OpenAI"还是"兼容 Anthropic"）</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
              <option value="openai">OpenAI 协议（绝大多数中转、国产模型都选这个）</option>
              <option value="anthropic">Anthropic 协议（官方 Claude / LuckyAPI 等）</option>
              <option value="gemini">Gemini 协议（Google AI Studio）</option>
              <option value="ollama">Ollama 协议（本机服务）</option>
            </select>
          </label>
        )}

        {preset?.helpUrl && (
          <a className="muted small" href={preset.helpUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            去哪里拿 Key / 装它 <ExternalLink size={12} />
          </a>
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
