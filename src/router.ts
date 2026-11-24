import Groq from 'groq-sdk';
import type { HistoryEntry } from './memory.ts';
import { telemetry } from './telemetry.ts';

const SYSTEM_PROMPT = `Eres "Nova", un motor de inteligencia multi-proveedor avanzado.
REGLAS:
1. Responde de forma directa, analítica y sin relleno superfluo.
2. Si generas código, entrega siempre código COMPLETO, ejecutable, con comentarios mínimos y OBLIGATORIAMENTE un bloque final:
\`\`\`text
// CÓMO PROBARLO
// [Instrucciones precisas de ejecución paso a paso]
\`\`\`
3. Mantén un formato Markdown limpio con tablas y listas cuando aporte claridad.`;

export interface RouterEvent {
  type: 'connecting' | 'chunk' | 'failover' | 'error' | 'done';
  provider?: string;
  text?: string;
  from_provider?: string;
  to_provider?: string;
  reason?: string;
  message?: string;
  details?: Array<{ from_provider: string; error: string; latency_ms: number }>;
  retry_seconds?: number;
  latency_ms?: number;
  failover_note?: string;
  full_text?: string;
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function extractErrorMessage(raw: unknown): string {
  if (!raw) return 'Error desconocido';
  const str = raw instanceof Error ? raw.message : String(raw);
  try {
    const parsed = JSON.parse(str);
    const msg = parsed?.error?.message || parsed?.[0]?.error?.message || parsed?.message;
    if (typeof msg === 'string') return msg.trim();
  } catch {
    // No es JSON simple, procesar string
  }
  const clean = str.replace(/[\r\n\t]+/g, ' ').trim();
  return clean.length > 70 ? `${clean.slice(0, 67)}…` : clean;
}

// ── Google AI Studio (Direct REST v1beta SSE con Multi-Model Fallback) ────────

async function* callGemini(
  prompt: string,
  history: HistoryEntry[] = [],
  images: string[] | null = null
): AsyncGenerator<string, void, unknown> {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY no configurada');
  }

  const configuredModel = (process.env.GEMINI_MODEL || '').trim();
  // Cadena completa de modelos de Google AI Studio en orden de prioridad:
  const candidateModels = Array.from(
    new Set(
      [
        configuredModel,
        'gemini-3-flash-preview',
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-2.5-pro',
        'gemini-2.0-flash',
        'gemini-2.0-flash-lite-preview-02-05',
        'gemini-1.5-flash',
        'gemini-1.5-flash-8b',
        'gemini-1.5-pro',
      ].filter(Boolean)
    )
  );

  const contents: Array<{
    role: 'user' | 'model';
    parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>;
  }> = [];

  for (const h of history) {
    contents.push({ role: 'user', parts: [{ text: h.message }] });
    contents.push({ role: 'model', parts: [{ text: h.response }] });
  }

  const userParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [];
  if (images && images.length > 0) {
    for (const img of images.slice(0, 3)) {
      const parsed = parseDataUrl(img);
      if (parsed) {
        userParts.push({ inlineData: parsed });
      }
    }
  }
  userParts.push({ text: prompt });
  contents.push({ role: 'user', parts: userParts });

  let lastError: string | null = null;
  let streamedAny = false;

  for (const modelName of candidateModels) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000);

      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents,
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }],
          },
          generationConfig: {
            temperature: 0.7,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!response.ok || !response.body) {
        const errBody = await response.text().catch(() => '');
        let cleanReason = `HTTP ${response.status}`;
        try {
          const errObj = JSON.parse(errBody);
          const detail = errObj?.[0]?.error?.message || errObj?.error?.message;
          if (detail) cleanReason = `${cleanReason}: ${detail}`;
        } catch {
          if (errBody) cleanReason = `${cleanReason}: ${errBody.slice(0, 60)}`;
        }
        lastError = `${modelName} [${cleanReason}]`;
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') break;
          try {
            const data = JSON.parse(dataStr) as {
              candidates?: Array<{
                content?: {
                  parts?: Array<{ text?: string }>;
                };
              }>;
            };
            const parts = data?.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              const text = part?.text || '';
              if (text) {
                streamedAny = true;
                yield text;
              }
            }
          } catch {
            continue;
          }
        }
      }

      if (streamedAny) {
        return;
      }
    } catch (err) {
      const parsedErr = extractErrorMessage(err);
      lastError = `${modelName}: ${parsedErr}`;
      continue;
    }
  }

  throw new Error(lastError || 'No se pudo conectar a ningún modelo candidato en Google AI Studio');
}

// ── Groq (Ultra-Fast Inference & Vision) ──────────────────────────────────────

async function* callGroq(
  prompt: string,
  history: HistoryEntry[] = [],
  images: string[] | null = null
): AsyncGenerator<string, void, unknown> {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('GROQ_API_KEY no configurada');
  }

  const client = new Groq({ apiKey });
  const maxTokens = Number(process.env.GROQ_MAX_TOKENS) || 2000;

  type GroqMessage =
    | { role: 'system' | 'assistant'; content: string }
    | {
        role: 'user';
        content:
          | string
          | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
      };

  const messages: GroqMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const h of history) {
    messages.push({ role: 'user', content: h.message });
    messages.push({ role: 'assistant', content: h.response });
  }

  const isVision = Boolean(images && images.length > 0);
  let candidateModels: string[];

  if (isVision && images) {
    const contentParts: Array<
      { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
    > = [{ type: 'text', text: prompt }];
    for (const img of images.slice(0, 3)) {
      contentParts.push({ type: 'image_url', image_url: { url: img } });
    }
    messages.push({ role: 'user', content: contentParts });

    const configuredVision = (process.env.GROQ_VISION_MODEL || '').trim();
    candidateModels = Array.from(
      new Set(
        [
          configuredVision,
          'qwen/qwen3.8-27b',
          'llama-3.2-11b-vision-preview',
          'llama-3.2-90b-vision-preview',
        ].filter(Boolean)
      )
    );
  } else {
    messages.push({ role: 'user', content: prompt });
    const configuredText = (process.env.GROQ_MODEL || '').trim();
    candidateModels = Array.from(
      new Set(
        [
          configuredText,
          'openai/gpt-oss-120b',
          'llama-3.1-8b-instant',
          'llama-3.3-70b-versatile',
        ].filter(Boolean)
      )
    );
  }

  let lastError: string | null = null;
  let streamedAny = false;

  for (const modelName of candidateModels) {
    try {
      const completion = await client.chat.completions.create({
        model: modelName,
        messages: messages as Parameters<typeof client.chat.completions.create>[0]['messages'],
        temperature: 0.7,
        max_tokens: maxTokens,
        stream: true,
      });

      for await (const chunk of completion) {
        const text = chunk.choices?.[0]?.delta?.content || '';
        if (text) {
          streamedAny = true;
          yield text;
        }
      }

      if (streamedAny) {
        return;
      }
    } catch (err) {
      const errMsg = extractErrorMessage(err);
      lastError = `${modelName}: ${errMsg}`;
      continue;
    }
  }

  throw new Error(lastError || 'No se pudo inicializar ningún modelo de Groq');
}

// ── OpenRouter (Dynamic Free Discovery & Fallback) ────────────────────────────

let cachedOpenRouterFreeModels: string[] = [];
let lastOpenRouterCacheTime = 0;

async function getLiveOpenRouterFreeModels(): Promise<string[]> {
  const now = Date.now();
  if (cachedOpenRouterFreeModels.length > 0 && now - lastOpenRouterCacheTime < 15 * 60 * 1000) {
    return cachedOpenRouterFreeModels;
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = (await res.json()) as {
        data?: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }>;
      };
      if (Array.isArray(data?.data)) {
        cachedOpenRouterFreeModels = data.data
          .filter(
            (m) =>
              m.id.endsWith(':free') ||
              (m.pricing && m.pricing.prompt === '0' && m.pricing.completion === '0')
          )
          .map((m) => m.id);
        lastOpenRouterCacheTime = now;
      }
    }
  } catch {
    // Si la llamada falla, conservar caché
  }
  return cachedOpenRouterFreeModels;
}

async function* callOpenRouter(
  prompt: string,
  options: { modelName?: string; history?: HistoryEntry[]; isCode?: boolean } = {}
): AsyncGenerator<string, void, unknown> {
  const apiKey = (process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY no configurada');
  }

  const { modelName, history = [], isCode = false } = options;
  const liveFree = await getLiveOpenRouterFreeModels();

  let candidateModels: string[];
  if (isCode) {
    const configuredCode = (process.env.OPENROUTER_CODE_MODEL || '').trim();
    const dynamicCode = liveFree.filter(
      (m) => m.includes('code') || m.includes('coder') || m.includes('gemma') || m.includes('nemotron')
    );
    candidateModels = Array.from(
      new Set(
        [
          modelName || configuredCode,
          'openrouter/free',
          'openrouter/auto',
          'google/gemma-4-31b-it:free',
          'nvidia/nemotron-3.5-lightning:free',
          'google/gemma-4-26b-a4b-it:free',
          'nvidia/nemotron-3-ultra-550b-a55b:free',
          ...dynamicCode,
          ...liveFree,
        ].filter(Boolean)
      )
    );
  } else {
    const configuredFree = (process.env.OPENROUTER_FREE_MODEL || '').trim();
    candidateModels = Array.from(
      new Set(
        [
          modelName || configuredFree,
          'openrouter/free',
          'openrouter/auto',
          'google/gemma-4-31b-it:free',
          'nvidia/nemotron-3.5-lightning:free',
          'google/gemma-4-26b-a4b-it:free',
          'inclusionai/ling-3.2-flash:free',
          'baidu/ernie-5.5-flash-preview:free',
          'nvidia/nemotron-3-ultra-550b-a55b:free',
          'recursive/flint-v1.0:free',
          ...liveFree,
        ].filter(Boolean)
      )
    );
  }

  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];
  for (const h of history) {
    messages.push({ role: 'user', content: h.message });
    messages.push({ role: 'assistant', content: h.response });
  }
  messages.push({ role: 'user', content: prompt });

  let lastError: string | null = null;
  let streamedAny = false;

  for (const chosenModel of candidateModels) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000);

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://nova-ai.vercel.app',
          'X-Title': 'Nova AI',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: chosenModel,
          messages,
          stream: true,
          temperature: isCode ? 0.6 : 0.7,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!response.ok || !response.body) {
        const errBody = await response.text().catch(() => '');
        let cleanReason = `HTTP ${response.status}`;
        try {
          const errObj = JSON.parse(errBody);
          const detail = errObj?.error?.message || errObj?.message;
          if (detail) cleanReason = `${cleanReason}: ${detail}`;
        } catch {
          if (errBody) cleanReason = `${cleanReason}: ${errBody.slice(0, 60)}`;
        }
        lastError = `${chosenModel} [${cleanReason}]`;
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]') break;
          try {
            const parsed = JSON.parse(dataStr) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning?: string;
                  reasoning_content?: string;
                };
              }>;
            };
            const delta = parsed.choices?.[0]?.delta;
            const token = delta?.content || delta?.reasoning || delta?.reasoning_content || '';
            if (token) {
              streamedAny = true;
              yield token;
            }
          } catch {
            continue;
          }
        }
      }

      if (streamedAny) {
        return;
      }
    } catch (err) {
      const errMsg = extractErrorMessage(err);
      lastError = `${chosenModel}: ${errMsg}`;
      continue;
    }
  }

  throw new Error(lastError || 'No se pudo conectar a ningún modelo candidato en OpenRouter');
}

// ── Routing Engine ────────────────────────────────────────────────────────────

export async function* routeAndStream(params: {
  prompt: string;
  mode?: string;
  history?: HistoryEntry[];
  images?: string[] | null;
}): AsyncGenerator<RouterEvent, void, unknown> {
  const { prompt, mode = 'auto', history = [], images = null } = params;
  const failoverLog: Array<{ from_provider: string; error: string; latency_ms: number }> = [];
  const startTime = Date.now();

  type ChainEntry = [string, () => AsyncGenerator<string, void, unknown>];
  let chain: ChainEntry[];

  if (images && images.length > 0) {
    chain = [
      ['Groq Vision', () => callGroq(prompt, history, images)],
      ['Google AI Studio', () => callGemini(prompt, history, images)],
      ['OpenRouter Vision', () => callOpenRouter(prompt, { modelName: 'openrouter/free', history })],
    ];
  } else if (mode === 'code') {
    chain = [
      ['Google AI Studio', () => callGemini(prompt, history)],
      ['OpenRouter Code', () => callOpenRouter(prompt, { isCode: true, history })],
      ['Groq', () => callGroq(prompt, history)],
    ];
  } else if (mode === 'speed') {
    chain = [
      ['Groq', () => callGroq(prompt, history)],
      ['Google AI Studio', () => callGemini(prompt, history)],
      ['OpenRouter', () => callOpenRouter(prompt, { isCode: false, history })],
    ];
  } else {
    // Mode 'auto' or 'reasoning': Google AI Studio -> Groq -> OpenRouter
    chain = [
      ['Google AI Studio', () => callGemini(prompt, history)],
      ['Groq', () => callGroq(prompt, history)],
      ['OpenRouter', () => callOpenRouter(prompt, { isCode: false, history })],
    ];
  }

  let activeProvider: string | null = null;
  let streamSuccessful = false;
  let fullResponseText = '';

  for (let i = 0; i < chain.length; i++) {
    const [providerName, providerCallable] = chain[i];
    const provStart = Date.now();
    try {
      yield { type: 'connecting', provider: providerName };

      let firstChunk = true;
      for await (const chunk of providerCallable()) {
        if (firstChunk) {
          activeProvider = providerName;
          firstChunk = false;
        }
        fullResponseText += chunk;
        yield { type: 'chunk', text: chunk, provider: providerName };
      }

      if (!firstChunk) {
        streamSuccessful = true;
        const latencyMs = Date.now() - provStart;
        telemetry.recordRequest(providerName, latencyMs);
        break;
      }
      throw new Error(`${providerName} no devolvió contenido`);
    } catch (err) {
      const errMsg = extractErrorMessage(err);
      const failoverLatency = Date.now() - provStart;
      failoverLog.push({
        from_provider: providerName,
        error: errMsg,
        latency_ms: failoverLatency,
      });

      if (i + 1 < chain.length) {
        const nextProv = chain[i + 1][0];
        telemetry.recordFailover(providerName, nextProv, errMsg.slice(0, 50), failoverLatency);
        yield {
          type: 'failover',
          from_provider: providerName,
          to_provider: nextProv,
          reason: errMsg.slice(0, 60),
        };
      }
    }
  }

  const totalLatencyMs = Date.now() - startTime;

  if (!streamSuccessful || !activeProvider) {
    yield {
      type: 'error',
      message:
        'Todos los proveedores se encuentran temporalmente agotados o con límite de cuota (429/5xx).',
      details: failoverLog,
      retry_seconds: 60,
    };
  } else {
    let failoverNote = '';
    if (failoverLog.length > 0) {
      const lastFail = failoverLog[failoverLog.length - 1];
      failoverNote = `\n\n> ↳ *Conmutado automáticamente a ${activeProvider} por incidencia en ${lastFail.from_provider}.*`;
    }

    yield {
      type: 'done',
      provider: activeProvider,
      latency_ms: Math.round(totalLatencyMs * 10) / 10,
      failover_note: failoverNote,
      full_text: fullResponseText,
    };
  }
}
