import os
from typing import List, Dict, Any
from supabase import create_client, Client

url = os.environ.get("SUPABASE_URL")
key = os.environ.get("SUPABASE_KEY")

supabase: Client | None = None

if url and key and "your_supabase" not in url:
    try:
        supabase = create_client(url, key)
    except Exception as e:
        print(f"[Supabase] Warning: Error de inicialización: {e}")

_local_history: Dict[str, List[Dict[str, Any]]] = {}

def init_db():
    """
    DDL recomendado para Supabase SQL Editor:
    CREATE TABLE IF NOT EXISTS messages (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        message TEXT NOT NULL,
        response TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        latency_ms FLOAT,
        created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    """
    if supabase:
        print("[Supabase] Conexión establecida para persistencia.")
    else:
        print("[Memory] Modo local en memoria activo (sin persistencia Supabase).")

def save_message(session_id: str, message: str, response: str, provider: str = "Unknown", model: str = "", latency_ms: float = 0.0):
    sid = str(session_id) if session_id else "anonymous"
    data = {
        "session_id": sid,
        "message": message,
        "response": response,
        "provider": provider,
        "model": model,
        "latency_ms": latency_ms
    }

    # Guardar en memoria local
    if sid not in _local_history:
        _local_history[sid] = []
    _local_history[sid].append(data)
    if len(_local_history[sid]) > 30:
        _local_history[sid].pop(0)

    # Persistir en Supabase si está disponible
    if supabase:
        try:
            supabase.table("messages").insert(data).execute()
        except Exception as e:
            print(f"[Supabase] Error al guardar mensaje: {e}")

def get_history(session_id: str, limit: int = 10) -> List[Dict[str, Any]]:
    sid = str(session_id) if session_id else "anonymous"

    if supabase:
        try:
            res = (
                supabase.table("messages")
                .select("message, response, provider, model, latency_ms")
                .eq("session_id", sid)
                .order("id", desc=True)
                .limit(limit)
                .execute()
            )
            data = res.data or []
            data.reverse()
            return data
        except Exception as e:
            print(f"[Supabase] Error al obtener historial: {e}")

    # Fallback memoria local
    return _local_history.get(sid, [])[-limit:]
