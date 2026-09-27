// Browser-side AI advisor client — talks to OpenAI / Anthropic / Ollama directly
// from the browser, so the preview mode can give real answers.
//
// Settings persist to localStorage under "pinkbin.advisor". In Tauri builds the
// apiKey itself never hits localStorage: it goes through DPAPI secure storage
// (api.secureSet / secure_get) and only lives in memory + the encrypted store;
// localStorage keeps a `hasKey` marker instead.

import { api } from './api';
import { isTauri } from './env';
import type { AdvisorRequest, AdvisorResponse } from './types';

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'ollama';

export interface AdvisorSettings {
  provider: Provider;
  model: string;
  /** 内存态明文。Tauri 下 localStorage 不再有此字段；浏览器预览模式（无后端）仍是全量 localStorage。 */
  apiKey: string;
  baseUrl: string;
  /** 用户在 Settings 里手动指定的协议，覆盖 detectProvider 的自动判断；不存在则走自动识别。 */
  providerOverride?: Provider;
  /** true = 密钥在 DPAPI secure storage 里（localStorage 无明文）。 */
  hasKey?: boolean;
}

const STORAGE_KEY = 'pinkbin.advisor';
/** secure.json 里 advisor apiKey 的条目名。 */
const SECURE_KEY = 'advisor.apiKey';

// 明文 key 只活在模块内存里（随进程消亡）；localStorage 只存 hasKey 标记。
let memoryApiKey: string | null = null;
// loadSettings 每次调用都会重读 localStorage，用这个标记让一次性迁移只触发一次。
let migrationStarted = false;

// 从 Base URL 猜协议，让用户不用管"协议"这个概念。覆盖的是用户实际会遇到的
// case；其余一律落到 OpenAI（中转 / 国产大模型事实上的通用标准）。
// 11434 是 Ollama 默认端口；本机跑的 OpenAI 兼容中转（one-api/new-api/vLLM/
// LM Studio 等，如 http://localhost:20128/v1）同样常绑在 localhost，不能靠
// "本地地址"判 ollama——之前 localhost/127.0.0.1 判据把这类中转错判成
// ollama，请求打到 /api/chat 404。误判后用户在 Settings 里手动指定协议兜底。
export function detectProvider(baseUrl: string): Provider {
  const u = baseUrl.toLowerCase();
  if (!u) return 'openai';
  if (u.includes('11434') || u.includes('/api/chat')) return 'ollama';
  // 识别带 anthropic 字样的代理子域名（如 anthropic.novadiffusion.com），
  // 不仅是官方 anthropic.com。误识别风险极小——OpenAI 协议代理几乎不会
  // 把 anthropic 写进域名里。
  if (u.includes('anthropic') || u.includes('/v1/messages')) return 'anthropic';
  if (u.includes('googleapis.com') || u.includes('generativelanguage')) return 'gemini';
  return 'openai';
}

export function loadSettings(): AdvisorSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AdvisorSettings;
    if (!parsed.provider || !parsed.model) return null;
    // 收紧 detectProvider 之前，本机中转（如 localhost:20128/v1）会被误判
    // 存成 provider: 'ollama'。没手动 override 的老数据在这里按新规则
    // 用 baseUrl 重判一次，让升级后的用户自动痊愈，不用手动去 Settings 改。
    if (!parsed.providerOverride) parsed.provider = detectProvider(parsed.baseUrl);
    if (parsed.apiKey) {
      // 旧格式（明文 key 在 localStorage）：触发一次性 DPAPI 迁移；迁移完成前
      // 返回值仍带明文，保持旧行为不中断。
      migrateLegacyPlaintextKey(parsed);
    } else if (parsed.hasKey) {
      // 新格式：localStorage 无明文，只把内存缓存回填；真正的解密走 ensureApiKey。
      parsed.apiKey = memoryApiKey ?? '';
    }
    return parsed;
  } catch {
    return null;
  }
}

// 一次性迁移：secure_set 成功后重写 localStorage（抹掉明文字段，留 hasKey 标记）。
// 失败则保留旧行为（明文留在 localStorage），下次 load 再试。
function migrateLegacyPlaintextKey(legacy: AdvisorSettings): void {
  if (!isTauri || migrationStarted) return;
  migrationStarted = true;
  void (async () => {
    try {
      await api.secureSet(SECURE_KEY, legacy.apiKey);
      memoryApiKey = legacy.apiKey;
      const persist: AdvisorSettings = {
        provider: legacy.provider,
        model: legacy.model,
        apiKey: '',
        baseUrl: legacy.baseUrl,
        providerOverride: legacy.providerOverride,
        hasKey: true,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
    } catch (e) {
      migrationStarted = false;
      console.warn('[pinkbin] apiKey 迁移到 DPAPI 加密存储失败，暂留 localStorage 明文:', e);
    }
  })();
}

/**
 * 确保 apiKey 已解到内存：内存缓存 → DPAPI secure storage。返回 null 表示
 * 读不到（未配置 / 解密失败）。调用方拿 null 且 provider 需要 key 时应报错
 * 引导用户回 Settings 重存，而不是把空 key 打进请求头。
 */
export async function ensureApiKey(settings: AdvisorSettings | null): Promise<string | null> {
  if (!settings) return null;
  if (settings.apiKey) return settings.apiKey;
  if (!settings.hasKey) return null;
  if (memoryApiKey) return memoryApiKey;
  try {
    const key = await api.secureGet(SECURE_KEY);
    if (key) memoryApiKey = key;
    return key;
  } catch (e) {
    console.warn('[pinkbin] 从加密存储读取 API key 失败:', e);
    return null;
  }
}

/** 保存配置。Tauri：明文经 secure_set 进 DPAPI，localStorage 只落 hasKey 标记。 */
export async function saveSettings(s: AdvisorSettings): Promise<void> {
  if (isTauri) {
    if (s.apiKey) {
      await api.secureSet(SECURE_KEY, s.apiKey);
      memoryApiKey = s.apiKey;
    }
    const persist: AdvisorSettings = {
      provider: s.provider,
      model: s.model,
      apiKey: '',
      baseUrl: s.baseUrl,
      providerOverride: s.providerOverride,
      hasKey: Boolean(s.apiKey),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persist));
  } else {
    // 浏览器预览模式没有后端 / DPAPI，保持旧的全量 localStorage 行为。
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }
}

export function clearSettings() {
  localStorage.removeItem(STORAGE_KEY);
  memoryApiKey = null;
  if (isTauri) {
    // 命令面只有 set/get（无 delete）：覆写为空串让旧 key 失效——解出来是
    // 空串，ensureApiKey 的 `if (key)` 判空后等价于没有密钥。
    void api.secureSet(SECURE_KEY, '').catch(() => {});
  }
}

const SYSTEM_PROMPT = `You are DiskSift's local file advisor. Given a folder's metadata, decide what it is and whether it can be cleaned. Reply in strict JSON ONLY, matching this schema exactly:

{
  "what": "string",
  "category": "browser_cache|app_cache|package_cache|build_artifact|game_data|user_content|system|model_weights|unknown",
  "safe_to_delete": true|false,
  "risk": "low|medium|high",
  "action": "keep|recycle|delete|custom",
  "reasoning": "short string, one sentence",
  "needs_inspection": true|false,
  "suggested_scaffold": "string or null"
}

Rules:
- Be conservative. If uncertain, set needs_inspection=true and action="keep".
- "user_content" (Documents/Pictures/Music/Source code) is never safe_to_delete.
- "model_weights" (HuggingFace, Ollama models) is medium risk: deletable but expensive to redownload.
- Do not include any prose outside the JSON object.`;

function stripCodeFence(s: string): string {
  let t = s.trim();
  if (t.startsWith('```json')) t = t.slice(7);
  else if (t.startsWith('```')) t = t.slice(3);
  if (t.endsWith('```')) t = t.slice(0, -3);
  return t.trim();
}

// Anthropic 响应里 content 是 block 数组，extended-thinking 模型（如 DeepSeek
// 的 anthropic 兼容端点）会先返一个 {type:"thinking",...} 再返 {type:"text",...}，
// 不能假设 content[0] 是 text。stop_reason="max_tokens" 时还可能根本没 text
// block（thinking 把额度吃光），给明确错误而不是静默返回空串。
function extractAnthropicText(data: unknown): string {
  const d = data as { content?: Array<{ type?: string; text?: string }>; stop_reason?: string };
  const blocks = d?.content ?? [];
  const text = blocks
    .filter((b) => b?.type === 'text')
    .map((b) => b?.text ?? '')
    .join('')
    .trim();
  if (!text) {
    const stop = d?.stop_reason ?? 'unknown';
    if (stop === 'max_tokens') {
      throw new Error('AI 在 thinking 阶段被截断（max_tokens 太小，思考把额度吃光了）。把 max_tokens 调大重试。');
    }
    throw new Error(`Anthropic: 没拿到 text block（stop_reason=${stop}）`);
  }
  return text;
}

// 契约：settings.apiKey 必须已解析（调用方先 await ensureApiKey 再把明文塞回
// settings）。本函数不自己去解密，因为浏览器/内存两条来源的取值时机在调用方手里。
export async function callAdvisor(
  settings: AdvisorSettings,
  req: AdvisorRequest,
): Promise<AdvisorResponse> {
  const userPrompt = JSON.stringify(req, null, 2);
  let raw = '';

  if (settings.provider === 'openai') {
    const url = (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const r = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
    const data = await r.json();
    raw = data?.choices?.[0]?.message?.content ?? '';
  } else if (settings.provider === 'anthropic') {
    const url = (settings.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const r = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    const data = await r.json();
    raw = extractAnthropicText(data);
  } else if (settings.provider === 'gemini') {
    const url = (settings.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    const r = await fetch(
      `${url}/v1beta/models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
        }),
      },
    );
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
    const data = await r.json();
    raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  } else if (settings.provider === 'ollama') {
    const url = (settings.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    const r = await fetch(`${url}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        format: 'json',
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
    const data = await r.json();
    raw = data?.message?.content ?? '';
  }

  if (!raw) throw new Error('Empty response from advisor');
  return JSON.parse(stripCodeFence(raw)) as AdvisorResponse;
}

export function isConfigured(s: AdvisorSettings | null): s is AdvisorSettings {
  if (!s) return false;
  if (s.provider === 'ollama') return Boolean(s.model);
  // hasKey = 密钥在 DPAPI 里（localStorage 无明文也算已配置）；解密失败留给
  // ensureApiKey 的调用方兜底报错。
  return Boolean(s.model && (s.apiKey || s.hasKey));
}

const CHAT_SYSTEM = `You are DiskSift's AI advisor — a friendly assistant that helps users figure out what their disk folders are and whether to delete them. Use the metadata you are given (the user's question references a folder by its path, size, samples). Be concise (2-4 sentences), in the user's language. If you suggest deleting, say what to delete (the whole folder vs a sub-scope) and via what mechanism (回收站 / 手动整理 / 卸载应用). Never recommend rm -rf on system paths.`;

const OVERVIEW_SYSTEM = `You are DiskSift's AI advisor. The user just finished scanning their disk. You receive a JSON summary of the largest folders. Write a friendly Chinese overview (~180-220 字) covering, in order, with empty lines between sections:

【整体】 一句话概括磁盘的整体结构（操作系统 / 用户数据 / 应用 各占多少）。

【这里都有什么】 点名 4-6 个最大的目录，每个一行：名字、大小、大致是什么 / 哪个软件的。要具体到软件名（例：WeChat Files = 微信聊天记录、node_modules = npm 包、HuggingFace = 模型权重）。

【可以删的】 直接列出 2-4 项可以删 / 可以清理的东西，每条说清楚 ① 路径或名字 ② 删了会怎样 ③ 怎么删（回收 / 卸载 / 跑脚本）。如果某个东西看起来可以删但有风险，就不要列在这里。

【不要动】 简短提一下扫描里看到的不该动的东西（系统目录 / 用户文档），一行带过。

口语化中文，不要 markdown bullet（用纯文本换行就行），不要客套话。`;

export interface ChatImage {
  /** Full data URL (e.g. `data:image/png;base64,...`). */
  dataUrl: string;
  /** Mime type — `image/png`, `image/jpeg`, etc. Used by Anthropic / Gemini
   *  which need it as a separate field. */
  mimeType: string;
}

/** 一轮已完成的对话历史（多轮上下文用）。 */
export interface ChatHistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}

// Anthropic / Gemini 要求 messages 里 user/assistant 严格交替（连续同角色直接
// 400 / 报错），而聊天记录里会出现连续同角色（系统通知插队、连续追问），发送前
// 必须合并。另外两家的首条都必须是 user，而本面板第一轮是扫描总览（assistant），
// 历史要从第一条 user 轮截起——开头的 assistant 轮没有对应的提问，条件不到它。
export function mergeConsecutiveTurns(turns: ChatHistoryTurn[]): ChatHistoryTurn[] {
  const out: ChatHistoryTurn[] = [];
  for (const t of turns) {
    if (!t.text.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === t.role) last.text = `${last.text}\n\n${t.text}`;
    else out.push({ ...t });
  }
  const firstUser = out.findIndex((t) => t.role === 'user');
  return firstUser < 0 ? [] : out.slice(firstUser);
}

// Anthropic 交替合并的兜底：历史最后一条是 user 时，当前消息（可能带图片块）
// 要并进那一条而不是新开一条。
function appendContent(a: unknown, b: unknown): unknown {
  if (typeof a === 'string' && typeof b === 'string') return `${a}\n\n${b}`;
  const toBlocks = (c: unknown): unknown[] => {
    if (typeof c === 'string') return [{ type: 'text', text: c }];
    return Array.isArray(c) ? [...c] : [];
  };
  return [...toBlocks(a), ...toBlocks(b)];
}

function dataUrlBase64(dataUrl: string): string {
  const i = dataUrl.indexOf(',');
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

export async function overviewChat(summary: object): Promise<string> {
  return runChatRaw(OVERVIEW_SYSTEM, JSON.stringify(summary, null, 2));
}

export async function freeChat(
  context: string,
  userMessage: string,
  images?: ChatImage[],
  history?: ChatHistoryTurn[],
): Promise<string> {
  const userText = context ? `${context}\n\n用户的问题：${userMessage}` : userMessage;
  return runChatRaw(CHAT_SYSTEM, userText, images, history);
}

async function runChatRaw(
  system: string,
  user: string,
  images?: ChatImage[],
  history?: ChatHistoryTurn[],
): Promise<string> {
  const settings = loadSettings();
  if (!isConfigured(settings)) {
    throw new Error('AI 未配置 — 在右上角的设置里填一个 API key');
  }
  // key 取值是 async（可能要走一次 DPAPI IPC），所以整条取 key 路径改 await。
  const apiKey = (await ensureApiKey(settings)) ?? '';
  if (!apiKey && settings.provider !== 'ollama') {
    throw new Error('API key 读取失败（加密存储里没有或已失效）— 打开设置重新保存一次');
  }
  const fullUser = user;
  const imgs = images ?? [];
  const hist = mergeConsecutiveTurns(history ?? []);

  if (settings.provider === 'openai') {
    const url = (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const userContent: unknown = imgs.length === 0
      ? fullUser
      : [
          { type: 'text', text: fullUser },
          ...imgs.map((img) => ({ type: 'image_url', image_url: { url: img.dataUrl } })),
        ];
    const messages: Array<{ role: string; content: unknown }> = [
      { role: 'system', content: system },
      ...hist.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user', content: userContent },
    ];
    const r = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        messages,
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data?.choices?.[0]?.message?.content?.trim() ?? '';
  }
  if (settings.provider === 'anthropic') {
    const url = (settings.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const userContent: unknown = imgs.length === 0
      ? fullUser
      : [
          ...imgs.map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mimeType, data: dataUrlBase64(img.dataUrl) },
          })),
          { type: 'text', text: fullUser },
        ];
    // 历史已合并连续同角色；若最后一条仍是 user，当前消息并进那一条（图片随之
    // 挂到这条），否则新开一条 user——保证整个数组严格交替。
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = hist.map((h) => ({
      role: h.role,
      content: h.text,
    }));
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.role === 'user') {
      lastMsg.content = appendContent(lastMsg.content, userContent);
    } else {
      messages.push({ role: 'user', content: userContent });
    }
    const r = await fetch(`${url}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: 4096,
        system,
        messages,
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return extractAnthropicText(data);
  }
  if (settings.provider === 'gemini') {
    const url = (settings.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    const parts: unknown[] = [{ text: fullUser }];
    for (const img of imgs) {
      parts.push({ inline_data: { mime_type: img.mimeType, data: dataUrlBase64(img.dataUrl) } });
    }
    // Gemini 的 role 是 'user'/'model'（assistant → model），contents 同样要求
    // 严格交替；历史末尾若是 user，当前消息并进那一条。
    const contents: Array<{ role: 'user' | 'model'; parts: unknown[] }> = hist.map((h) => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.text }],
    }));
    const lastContent = contents[contents.length - 1];
    if (lastContent && lastContent.role === 'user') {
      lastContent.parts.push(...parts);
    } else {
      contents.push({ role: 'user', parts });
    }
    const r = await fetch(
      `${url}/v1beta/models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          generationConfig: { temperature: 0.4 },
        }),
      },
    );
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  }
  // ollama — uses `images` field (array of base64) on the message.
  const url = (settings.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  const messages: Array<Record<string, unknown>> = [
    { role: 'system', content: system },
    ...hist.map((h) => ({ role: h.role, content: h.text })),
  ];
  const userMsg: Record<string, unknown> = { role: 'user', content: fullUser };
  if (imgs.length > 0) userMsg.images = imgs.map((i) => dataUrlBase64(i.dataUrl));
  messages.push(userMsg);
  const r = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      messages,
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data?.message?.content?.trim() ?? '';
}
