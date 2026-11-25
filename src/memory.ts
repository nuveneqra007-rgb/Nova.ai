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
  session_id: string;
  title: string;
  updated_at: string;
  message_count: number;
  last_provider: string;
}

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_LOCAL_SESSIONS = 500;
const MAX_DELETED_SESSIONS = 1000;
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

interface LocalSessionBucket {
  entries: HistoryEntry[];
  lastAccess: number;
}

const localHistory = new Map<string, LocalSessionBucket>();
// Almacena únicamente compositeKeys (userId::sessionId) para aislar entre usuarios
const deletedSessions = new Map<string, number>();

export function isValidId(value: string): boolean {
  return SAFE_ID_REGEX.test(value);
}

function sanitizeIdPart(value: string, fallback: string, maxLen: number): string {
  const cleaned = (value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, maxLen);
  return cleaned || fallback;
}

function escapeLikePattern(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function pruneMemory(): void {
  const now = Date.now();

  for (const [key, bucket] of localHistory.entries()) {
    if (now - bucket.lastAccess > SESSION_TTL_MS) {
      localHistory.delete(key);
    }
  }
  while (localHistory.size > MAX_LOCAL_SESSIONS) {
    const oldestKey = localHistory.keys().next().value;
    if (!oldestKey) break;
    localHistory.delete(oldestKey);
  }

  for (const [key, ts] of deletedSessions.entries()) {
    if (now - ts > SESSION_TTL_MS) {
      deletedSessions.delete(key);
    }
  }
  while (deletedSessions.size > MAX_DELETED_SESSIONS) {
    const oldestKey = deletedSessions.keys().next().value;
    if (!oldestKey) break;
    deletedSessions.delete(oldestKey);
  }
}

export function toCompositeSessionId(userId: string, sessionId: string): string {
  const cleanUser = sanitizeIdPart(userId, 'anonymous', 48);
  let rawSession = (sessionId || 'default').trim();
  if (rawSession.includes('::')) {
    const parts = rawSession.split('::');
    rawSession = parts[parts.length - 1];
  }
  const cleanSession = sanitizeIdPart(rawSession, 'default', 64);
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
    console.log('[Supabase] Persistencia conectada.');
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

  deletedSessions.delete(compositeKey);
  pruneMemory();

  const data: HistoryEntry = {
    session_id: compositeKey,
    message: params.message,
    response: params.response,
    provider: params.provider || 'Unknown',
    model: params.model || '',
    latency_ms: params.latencyMs ?? 0.0,
    created_at: nowIso,
  };

  const bucket = localHistory.get(compositeKey) || { entries: [], lastAccess: Date.now() };
  bucket.entries.push(data);
  if (bucket.entries.length > 30) {
    bucket.entries.shift();
  }
  bucket.lastAccess = Date.now();
  localHistory.delete(compositeKey);
  localHistory.set(compositeKey, bucket);

  const cfg = getSupabaseConfig();
  if (!cfg) return;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
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
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn('[Supabase REST] Error al guardar mensaje:', err instanceof Error ? err.name : 'Error');
  }
}

export async function getHistory(
  sessionId: string,
  userId = 'anonymous',
  limit = 20
): Promise<HistoryEntry[]> {
  const compositeKey = toCompositeSessionId(userId, sessionId);
  if (deletedSessions.has(compositeKey)) {
    return [];
  }
  const cfg = getSupabaseConfig();

  if (cfg) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const queryUrl = `${cfg.url}/rest/v1/messages?select=message,response,provider,model,latency_ms&session_id=eq.${encodeURIComponent(compositeKey)}&order=id.desc&limit=${limit}`;
        const res = await fetch(queryUrl, {
          method: 'GET',
          headers: {
            apikey: cfg.key,
            Authorization: `Bearer ${cfg.key}`,
          },
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as HistoryEntry[];
          if (Array.isArray(data) && data.length > 0) {
            data.reverse();
            return data;
          }
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn('[Supabase REST] Error al consultar historial:', err instanceof Error ? err.name : 'Error');
    }
  }

  const bucket = localHistory.get(compositeKey);
  if (!bucket) return [];
  bucket.lastAccess = Date.now();
  return bucket.entries.slice(-limit);
}

export async function getSessions(
  userId = 'anonymous',
  query = '',
  limit = 40
): Promise<SessionSummary[]> {
  const cleanUser = sanitizeIdPart(userId, 'anonymous', 48);
  const userPrefix = `${cleanUser}::`;
  const sessionsMap = new Map<string, SessionSummary>();

  pruneMemory();

  for (const [key, bucket] of localHistory.entries()) {
    if (!key.startsWith(userPrefix) || bucket.entries.length === 0) continue;
    if (deletedSessions.has(key)) continue;

    const rawChatId = extractSessionId(key);
    const first = bucket.entries[0];
    const last = bucket.entries[bucket.entries.length - 1];
    sessionsMap.set(rawChatId, {
      session_id: rawChatId,
      title: buildTitle(first.message),
      updated_at: last.created_at || new Date().toISOString(),
      message_count: bucket.entries.length,
      last_provider: last.provider || 'Unknown',
    });
  }

  const cfg = getSupabaseConfig();
  if (cfg) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const escapedPrefix = escapeLikePattern(userPrefix);
        const queryUrl = `${cfg.url}/rest/v1/messages?select=session_id,message,provider,created_at&session_id=like.${encodeURIComponent(escapedPrefix)}%25&order=id.desc&limit=200`;
        const res = await fetch(queryUrl, {
          method: 'GET',
          headers: {
            apikey: cfg.key,
            Authorization: `Bearer ${cfg.key}`,
          },
          signal: controller.signal,
        });
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
              if (deletedSessions.has(sid)) continue;
              const chatId = extractSessionId(sid);
              const list = grouped.get(chatId) || [];
              list.push(row);
              grouped.set(chatId, list);
            }
            for (const [chatId, list] of grouped.entries()) {
              const compId = toCompositeSessionId(cleanUser, chatId);
              if (deletedSessions.has(compId)) continue;
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
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn('[Supabase REST] Error al listar sesiones del usuario:', err instanceof Error ? err.name : 'Error');
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
  deletedSessions.set(compositeKey, Date.now());
  localHistory.delete(compositeKey);
  pruneMemory();

  const cfg = getSupabaseConfig();
  if (cfg) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const deleteUrl = `${cfg.url}/rest/v1/messages?session_id=eq.${encodeURIComponent(compositeKey)}`;
        await fetch(deleteUrl, {
          method: 'DELETE',
          headers: {
            apikey: cfg.key,
            Authorization: `Bearer ${cfg.key}`,
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn('[Supabase REST] Error al eliminar sesión:', err instanceof Error ? err.name : 'Error');
    }
  }

  return true;
}

export async function clearAllUserSessions(userId: string): Promise<boolean> {
  const cleanUser = sanitizeIdPart(userId, 'anonymous', 48);
  const userPrefix = `${cleanUser}::`;
  const now = Date.now();

  for (const key of Array.from(localHistory.keys())) {
    if (key.startsWith(userPrefix)) {
      localHistory.delete(key);
      deletedSessions.set(key, now);
    }
  }
  pruneMemory();

  const cfg = getSupabaseConfig();
  if (cfg) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const escapedPrefix = escapeLikePattern(userPrefix);
        const deleteUrl = `${cfg.url}/rest/v1/messages?session_id=like.${encodeURIComponent(escapedPrefix)}%25`;
        await fetch(deleteUrl, {
          method: 'DELETE',
          headers: {
            apikey: cfg.key,
            Authorization: `Bearer ${cfg.key}`,
          },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      console.warn('[Supabase REST] Error al vaciar historial:', err instanceof Error ? err.name : 'Error');
    }
  }

  return true;
}
