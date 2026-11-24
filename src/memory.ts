export interface HistoryEntry {
  session_id?: string;
  message: string;
  response: string;
  provider?: string;
  model?: string;
  latency_ms?: number;
  created_at?: string;
}

export interface SessionSummary {
  session_id: string; // ID individual del chat para el usuario
  title: string;
  updated_at: string;
  message_count: number;
  last_provider: string;
}

const localHistory = new Map<string, HistoryEntry[]>();

export function toCompositeSessionId(userId: string, sessionId: string): string {
  const cleanUser = (userId || 'anonymous').trim().replace(/[:]/g, '_').slice(0, 48);
  let cleanSession = (sessionId || 'default').trim().slice(0, 64);
  if (cleanSession.includes('::')) {
    const parts = cleanSession.split('::');
    cleanSession = parts[parts.length - 1];
  }
  return `${cleanUser}::${cleanSession}`;
}

export function extractSessionId(compositeId: string): string {
  if (compositeId.includes('::')) {
    const parts = compositeId.split('::');
    return parts[parts.length - 1];
  }
  return compositeId;
}

function getSupabaseConfig(): { url: string; key: string } | null {
  const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.SUPABASE_KEY || '').trim();
  if (!url || !key || url.includes('your_supabase')) {
    return null;
  }
  return { url, key };
}

export function initDb(): void {
  const cfg = getSupabaseConfig();
  if (cfg) {
    console.log(`[Supabase] Persistencia conectada a ${cfg.url}`);
  } else {
    console.log('[Memory] Modo local en memoria activo (variables Supabase no detectadas).');
  }
}

function buildTitle(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'Consulta sin título';
  return normalized.length > 56 ? `${normalized.slice(0, 56)}…` : normalized;
}

export async function saveMessage(params: {
  userId?: string;
  sessionId: string;
  message: string;
  response: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
}): Promise<void> {
  const uid = params.userId || 'anonymous';
  const compositeKey = toCompositeSessionId(uid, params.sessionId);
  const nowIso = new Date().toISOString();

  const data: HistoryEntry = {
    session_id: compositeKey,
    message: params.message,
    response: params.response,
    provider: params.provider || 'Unknown',
    model: params.model || '',
    latency_ms: params.latencyMs ?? 0.0,
    created_at: nowIso,
  };

  // 1. Guardar en memoria local aislada por usuario
  const entries = localHistory.get(compositeKey) || [];
  entries.push(data);
  if (entries.length > 30) {
    entries.shift();
  }
  localHistory.set(compositeKey, entries);

  // 2. Persistir en Supabase vía REST si está configurado
  const cfg = getSupabaseConfig();
  if (!cfg) return;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    await fetch(`${cfg.url}/rest/v1/messages`, {
      method: 'POST',
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        session_id: data.session_id,
        message: data.message,
        response: data.response,
        provider: data.provider,
        model: data.model,
        latency_ms: data.latency_ms,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    console.warn('[Supabase REST] Error al guardar mensaje:', err instanceof Error ? err.message : err);
  }
}

export async function getHistory(
  sessionId: string,
  userId = 'anonymous',
  limit = 20
): Promise<HistoryEntry[]> {
  const compositeKey = toCompositeSessionId(userId, sessionId);
  const cfg = getSupabaseConfig();

  if (cfg) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const queryUrl = `${cfg.url}/rest/v1/messages?select=message,response,provider,model,latency_ms&session_id=eq.${encodeURIComponent(compositeKey)}&order=id.desc&limit=${limit}`;
      const res = await fetch(queryUrl, {
        method: 'GET',
        headers: {
          apikey: cfg.key,
          Authorization: `Bearer ${cfg.key}`,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = (await res.json()) as HistoryEntry[];
        if (Array.isArray(data) && data.length > 0) {
          data.reverse();
          return data;
        }
      }
    } catch (err) {
      console.warn('[Supabase REST] Error al consultar historial:', err instanceof Error ? err.message : err);
    }
  }

  const local = localHistory.get(compositeKey) || [];
  return local.slice(-limit);
}

export async function getSessions(
  userId = 'anonymous',
  query = '',
  limit = 40
): Promise<SessionSummary[]> {
  const cleanUser = (userId || 'anonymous').trim().replace(/[:]/g, '_');
  const userPrefix = `${cleanUser}::`;
  const sessionsMap = new Map<string, SessionSummary>();

  // 1. Cargar sesiones locales filtradas ESTRICTAMENTE por este usuario
  for (const [key, entries] of localHistory.entries()) {
    if (!key.startsWith(userPrefix) || entries.length === 0) continue;
    const rawChatId = extractSessionId(key);
    const first = entries[0];
    const last = entries[entries.length - 1];
    sessionsMap.set(rawChatId, {
      session_id: rawChatId,
      title: buildTitle(first.message),
      updated_at: last.created_at || new Date().toISOString(),
      message_count: entries.length,
      last_provider: last.provider || 'Unknown',
    });
  }

  // 2. Complementar con Supabase buscando ÚNICAMENTE los registros de este usuario
  const cfg = getSupabaseConfig();
  if (cfg) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const queryUrl = `${cfg.url}/rest/v1/messages?select=session_id,message,provider,created_at&session_id=like.${encodeURIComponent(userPrefix)}*&order=id.desc&limit=200`;
      const res = await fetch(queryUrl, {
        method: 'GET',
        headers: {
          apikey: cfg.key,
          Authorization: `Bearer ${cfg.key}`,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const rows = (await res.json()) as Array<{
          session_id?: string;
          message?: string;
          provider?: string;
          created_at?: string;
        }>;
        if (Array.isArray(rows)) {
          const grouped = new Map<string, typeof rows>();
          for (const row of rows) {
            const sid = row.session_id || '';
            if (!sid.startsWith(userPrefix)) continue;
            const chatId = extractSessionId(sid);
            const list = grouped.get(chatId) || [];
            list.push(row);
            grouped.set(chatId, list);
          }
          for (const [chatId, list] of grouped.entries()) {
            const newest = list[0];
            const oldest = list[list.length - 1];
            if (!sessionsMap.has(chatId)) {
              sessionsMap.set(chatId, {
                session_id: chatId,
                title: buildTitle(oldest.message || ''),
                updated_at: newest.created_at || new Date().toISOString(),
                message_count: list.length,
                last_provider: newest.provider || 'Unknown',
              });
            }
          }
        }
      }
    } catch (err) {
      console.warn('[Supabase REST] Error al listar sesiones del usuario:', err instanceof Error ? err.message : err);
    }
  }

  let result = Array.from(sessionsMap.values()).sort((a, b) =>
    b.updated_at.localeCompare(a.updated_at)
  );

  const normalizedQuery = query.trim().toLowerCase();
  if (normalizedQuery) {
    result = result.filter(
      (s) =>
        s.title.toLowerCase().includes(normalizedQuery) ||
        s.last_provider.toLowerCase().includes(normalizedQuery)
    );
  }

  return result.slice(0, limit);
}

export async function deleteSession(userId: string, sessionId: string): Promise<boolean> {
  const compositeKey = toCompositeSessionId(userId, sessionId);
  localHistory.delete(compositeKey);

  const cfg = getSupabaseConfig();
  if (cfg) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const deleteUrl = `${cfg.url}/rest/v1/messages?session_id=eq.${encodeURIComponent(compositeKey)}`;
      await fetch(deleteUrl, {
        method: 'DELETE',
        headers: {
          apikey: cfg.key,
          Authorization: `Bearer ${cfg.key}`,
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
    } catch (err) {
      console.warn('[Supabase REST] Error al eliminar sesión:', err instanceof Error ? err.message : err);
    }
  }

  return true;
}
