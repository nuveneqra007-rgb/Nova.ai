import os
import json
import urllib.request
from typing import List, Dict, Any

url = os.environ.get("SUPABASE_URL", "").rstrip("/")
key = os.environ.get("SUPABASE_KEY", "")

_local_history: Dict[str, List[Dict[str, Any]]] = {}

# Adaptador híbrido: SDK oficial si está disponible, o REST API nativo vía HTTP
_use_sdk = False
supabase_client = None

if url and key and "your_supabase" not in url:
    try:
        from supabase import create_client
        supabase_client = create_client(url, key)
        _use_sdk = True
        print("[Supabase] Cliente SDK inicializado con éxito.")
    except Exception:
        print("[Supabase] Usando adaptador REST nativo para persistencia.")

def init_db():
    if url and key:
        print(f"[Supabase] Persistencia conectada a {url}")
    else:
        print("[Memory] Modo local en memoria activo (variables Supabase no detectadas).")

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

    # 1. Guardar en memoria local
    if sid not in _local_history:
        _local_history[sid] = []
    _local_history[sid].append(data)
    if len(_local_history[sid]) > 30:
        _local_history[sid].pop(0)

    # 2. Persistir en Supabase
    if not (url and key):
        return

    if _use_sdk and supabase_client:
        try:
            supabase_client.table("messages").insert(data).execute()
            return
        except Exception as e:
            print(f"[Supabase SDK] Error al guardar: {e}")

    # Fallback REST nativo
    try:
        req = urllib.request.Request(
            f"{url}/rest/v1/messages",
            data=json.dumps(data).encode("utf-8"),
            headers={
                "apikey": key,
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal"
            },
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=5) as res:
            pass
    except Exception as e:
        print(f"[Supabase REST] Error al guardar mensaje: {e}")

def get_history(session_id: str, limit: int = 10) -> List[Dict[str, Any]]:
    sid = str(session_id) if session_id else "anonymous"

    if url and key:
        if _use_sdk and supabase_client:
            try:
                res = (
                    supabase_client.table("messages")
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
                print(f"[Supabase SDK] Error al consultar: {e}")

        # Fallback REST nativo
        try:
            query_url = f"{url}/rest/v1/messages?select=message,response,provider,model,latency_ms&session_id=eq.{urllib.parse.quote(sid)}&order=id.desc&limit={limit}"
            req = urllib.request.Request(
                query_url,
                headers={
                    "apikey": key,
                    "Authorization": f"Bearer {key}"
                },
                method="GET"
            )
            with urllib.request.urlopen(req, timeout=5) as res:
                raw = res.read().decode("utf-8")
                data = json.loads(raw)
                data.reverse()
                return data
        except Exception as e:
            print(f"[Supabase REST] Error al consultar historial: {e}")

    # Fallback local
    return _local_history.get(sid, [])[-limit:]
