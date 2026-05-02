// Browser-side AI advisor client — talks to OpenAI / Anthropic / Ollama directly
// from the browser, so the preview mode can give real answers.
//
// Settings persist to localStorage under "diskwise.advisor".

import type { AdvisorRequest, AdvisorResponse } from './types';

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'ollama';

export interface AdvisorSettings {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl: string;
}

const STORAGE_KEY = 'diskwise.advisor';

export function loadSettings(): AdvisorSettings | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AdvisorSettings;
    if (!parsed.provider || !parsed.model) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveSettings(s: AdvisorSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
}

export function clearSettings() {
  localStorage.removeItem(STORAGE_KEY);
}

const SYSTEM_PROMPT = `You are Diskwise's local file advisor. Given a folder's metadata, decide what it is and whether it can be cleaned. Reply in strict JSON ONLY, matching this schema exactly:

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
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    const data = await r.json();
    raw = data?.content?.[0]?.text ?? '';
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
  return Boolean(s.apiKey && s.model);
}

const CHAT_SYSTEM = `You are Diskwise's AI advisor — a friendly assistant that helps users figure out what their disk folders are and whether to delete them. Use the metadata you are given (the user's question references a folder by its path, size, samples). Be concise (2-4 sentences), in the user's language. If you suggest deleting, say what to delete (the whole folder vs a sub-scope) and via what mechanism (回收站 / 手动整理 / 卸载应用). Never recommend rm -rf on system paths.`;

const OVERVIEW_SYSTEM = `You are Diskwise's AI advisor. The user just finished scanning their disk. You receive a JSON summary of the largest folders. Write a friendly Chinese overview (~180-220 字) covering, in order, with empty lines between sections:

【整体】 一句话概括磁盘的整体结构（操作系统 / 用户数据 / 应用 各占多少）。

【这里都有什么】 点名 4-6 个最大的目录，每个一行：名字、大小、大致是什么 / 哪个软件的。要具体到软件名（例：WeChat Files = 微信聊天记录、node_modules = npm 包、HuggingFace = 模型权重）。

【可以删的】 直接列出 2-4 项可以删 / 可以清理的东西，每条说清楚 ① 路径或名字 ② 删了会怎样 ③ 怎么删（回收 / 卸载 / 跑脚本）。如果某个东西看起来可以删但有风险，就不要列在这里。

【不要动】 简短提一下扫描里看到的不该动的东西（系统目录 / 用户文档），一行带过。

口语化中文，不要 markdown bullet（用纯文本换行就行），不要客套话。`;

export async function overviewChat(summary: object): Promise<string> {
  return runChatRaw(OVERVIEW_SYSTEM, JSON.stringify(summary, null, 2));
}

export async function freeChat(context: string, userMessage: string): Promise<string> {
  return runChatRaw(CHAT_SYSTEM, `${context}\n\n用户的问题：${userMessage}`);
}

async function runChatRaw(system: string, user: string): Promise<string> {
  const settings = loadSettings();
  if (!isConfigured(settings)) {
    throw new Error('AI 未配置 — 在右上角的设置里填一个 API key');
  }
  const fullUser = user;

  if (settings.provider === 'openai') {
    const url = (settings.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const r = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({
        model: settings.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: fullUser },
        ],
      }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data?.choices?.[0]?.message?.content?.trim() ?? '';
  }
  if (settings.provider === 'anthropic') {
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
        max_tokens: 600,
        system,
        messages: [{ role: 'user', content: fullUser }],
      }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data?.content?.[0]?.text?.trim() ?? '';
  }
  if (settings.provider === 'gemini') {
    const url = (settings.baseUrl || 'https://generativelanguage.googleapis.com').replace(/\/$/, '');
    const r = await fetch(
      `${url}/v1beta/models/${encodeURIComponent(settings.model)}:generateContent?key=${encodeURIComponent(settings.apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: fullUser }] }],
          generationConfig: { temperature: 0.4 },
        }),
      },
    );
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${await r.text()}`);
    const data = await r.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? '';
  }
  // ollama
  const url = (settings.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  const r = await fetch(`${url}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: settings.model,
      stream: false,
      messages: [
        { role: 'system', content: CHAT_SYSTEM },
        { role: 'user', content: fullUser },
      ],
    }),
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}: ${await r.text()}`);
  const data = await r.json();
  return data?.message?.content?.trim() ?? '';
}
