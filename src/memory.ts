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

const localHistory = new Map<string, HistoryEntry[]>();

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
  sessionId: string;
  message: string;
  response: string;
  provider?: string;
  model?: string;
  latencyMs?: number;
}): Promise<void> {
  const sid = params.sessionId ? String(params.sessionId) : 'anonymous';
  const nowIso = new Date().toISOString();
  const data: HistoryEntry = {
    session_id: sid,
    message: params.message,
    response: params.response,
    provider: params.provider || 'Unknown',
    model: params.model || '',
    latency_ms: params.latencyMs ?? 0.0,
    created_at: nowIso,
  };

  // 1. Guardar en memoria local
  const entries = localHistory.get(sid) || [];
  entries.push(data);
  if (entries.length > 30) {
    entries.shift();
  }
  localHistory.set(sid, entries);

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

export async function getHistory(sessionId: string, limit = 20): Promise<HistoryEntry[]> {
  const sid = sessionId ? String(sessionId) : 'anonymous';
  const cfg = getSupabaseConfig();

  if (cfg) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const queryUrl = `${cfg.url}/rest/v1/messages?select=message,response,provider,model,latency_ms&session_id=eq.${encodeURIComponent(sid)}&order=id.desc&limit=${limit}`;
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

  const local = localHistory.get(sid) || [];
  return local.slice(-limit);
}

export async function getSessions(query = '', limit = 30): Promise<SessionSummary[]> {
  const sessionsMap = new Map<string, SessionSummary>();

  // 1. Cargar sesiones locales en memoria
  for (const [sid, entries] of localHistory.entries()) {
    if (entries.length === 0) continue;
    const first = entries[0];
    const last = entries[entries.length - 1];
    sessionsMap.set(sid, {
      session_id: sid,
      title: buildTitle(first.message),
      updated_at: last.created_at || new Date().toISOString(),
      message_count: entries.length,
      last_provider: last.provider || 'Unknown',
    });
  }

  // 2. Complementar con Supabase si está configurado
  const cfg = getSupabaseConfig();
  if (cfg) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const queryUrl = `${cfg.url}/rest/v1/messages?select=session_id,message,provider,created_at&order=id.desc&limit=150`;
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
            const sid = row.session_id || 'anonymous';
            const list = grouped.get(sid) || [];
            list.push(row);
            grouped.set(sid, list);
          }
          for (const [sid, list] of grouped.entries()) {
            const newest = list[0];
            const oldest = list[list.length - 1];
            if (!sessionsMap.has(sid)) {
              sessionsMap.set(sid, {
                session_id: sid,
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
      console.warn('[Supabase REST] Error al listar sesiones:', err instanceof Error ? err.message : err);
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
