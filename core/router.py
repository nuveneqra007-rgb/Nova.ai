import os
import time
import json
from typing import AsyncGenerator, List, Dict, Any, Optional
import httpx
from core.telemetry import telemetry

SYSTEM_PROMPT = """Eres "Nova", un motor de inteligencia multi-proveedor avanzado.
REGLAS:
1. Responde de forma directa, analítica y sin relleno superfluo.
2. Si generas código, entrega siempre código COMPLETO, ejecutable, con comentarios mínimos y OBLIGATORIAMENTE un bloque final:
```text
// CÓMO PROBARLO
// [Instrucciones precisas de ejecución paso a paso]
```
3. Mantén un formato Markdown limpio con tablas y listas cuando aporte claridad."""

# Claves de entorno
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GROQ_KEY = os.environ.get("GROQ_API_KEY", "")
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "")

# Configuración de modelos
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-1.5-flash")
GROQ_MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
GROQ_VISION_MODEL = os.environ.get("GROQ_VISION_MODEL", "llama-3.2-11b-vision-preview")
OPENROUTER_FREE_MODEL = os.environ.get("OPENROUTER_FREE_MODEL", "openrouter/free")
OPENROUTER_CODE_MODEL = os.environ.get("OPENROUTER_CODE_MODEL", "qwen/qwen-2.5-coder-32b-instruct:free")


# ── Clientes y Proveedores ───────────────────────────────────────────────────

async def call_gemini(prompt: str, history: List[Dict[str, Any]] = None) -> AsyncGenerator[str, None]:
    """Canal Principal: Google AI Studio (Gemini Flash)."""
    if not GEMINI_KEY:
        raise RuntimeError("GEMINI_API_KEY no configurada")

    import google.generativeai as genai
    genai.configure(api_key=GEMINI_KEY)

    model = genai.GenerativeModel(
        model_name=GEMINI_MODEL,
        system_instruction=SYSTEM_PROMPT
    )

    # Construir historial si existe
    contents = []
    if history:
        for h in history:
            contents.append({"role": "user", "parts": [h["message"]]})
            contents.append({"role": "model", "parts": [h["response"]]})
    contents.append({"role": "user", "parts": [prompt]})

    response = model.generate_content(contents, stream=True)
    for chunk in response:
        if chunk.text:
            yield chunk.text


async def call_groq(prompt: str, history: List[Dict[str, Any]] = None, images: List[str] = None) -> AsyncGenerator[str, None]:
    """Canal Auxiliar: Groq (Baja latencia y Visión)."""
    if not GROQ_KEY:
        raise RuntimeError("GROQ_API_KEY no configurada")

    from groq import Groq
    client = Groq(api_key=GROQ_KEY)

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if history:
        for h in history:
            messages.append({"role": "user", "content": h["message"]})
            messages.append({"role": "assistant", "content": h["response"]})

    # Soporte visión si hay imágenes
    if images:
        content_parts = [{"type": "text", "text": prompt}]
        for img in images[:3]:  # Máximo 3 imágenes
            content_parts.append({
                "type": "image_url",
                "image_url": {"url": img}
            })
        messages.append({"role": "user", "content": content_parts})
        model_name = GROQ_VISION_MODEL
    else:
        messages.append({"role": "user", "content": prompt})
        model_name = GROQ_MODEL

    completion = client.chat.completions.create(
        model=model_name,
        messages=messages,
        temperature=0.7,
        max_tokens=2000,
        stream=True
    )

    for chunk in completion:
        text = chunk.choices[0].delta.content or ""
        if text:
            yield text


async def call_openrouter(prompt: str, model_name: str = None, history: List[Dict[str, Any]] = None) -> AsyncGenerator[str, None]:
    """Canal de Código / Última Línea de Defensa: OpenRouter."""
    if not OPENROUTER_KEY:
        raise RuntimeError("OPENROUTER_API_KEY no configurada")

    chosen_model = model_name or OPENROUTER_FREE_MODEL

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    if history:
        for h in history:
            messages.append({"role": "user", "content": h["message"]})
            messages.append({"role": "assistant", "content": h["response"]})
    messages.append({"role": "user", "content": prompt})

    headers = {
        "Authorization": f"Bearer {OPENROUTER_KEY}",
        "HTTP-Referer": "https://nova-ai.vercel.app",
        "X-Title": "Nova AI",
        "Content-Type": "application/json"
    }

    payload = {
        "model": chosen_model,
        "messages": messages,
        "stream": True,
        "temperature": 0.6
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        async with client.stream("POST", "https://openrouter.ai/api/v1/chat/completions", headers=headers, json=payload) as response:
            if response.status_code >= 400:
                raise RuntimeError(f"OpenRouter error HTTP {response.status_code}: {await response.aread()}")

            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    data_str = line[6:].strip()
                    if data_str == "[DONE]":
                        break
                    try:
                        data = json.loads(data_str)
                        token = data["choices"][0]["delta"].get("content", "")
                        if token:
                            yield token
                    except Exception:
                        continue


# ── Motor de Enrutamiento Inteligente con Conmutación Automática ────────────

async def route_and_stream(
    prompt: str,
    mode: str = "auto",
    history: List[Dict[str, Any]] = None,
    images: List[str] = None
) -> AsyncGenerator[Dict[str, Any], None]:
    """
    Orquesta el flujo de proveedores siguiendo la política estricta:
    1. Si hay imágenes -> Groq Vision ➔ OpenRouter Vision.
    2. Si el modo es 'code' -> OpenRouter Code ➔ Gemini ➔ Groq.
    3. Flujo general (auto / reasoning) -> Google (Gemini) ➔ Groq ➔ OpenRouter.
    """
    history = history or []
    failover_log = []
    start_time = time.time()

    # Determinar cadena de prioridad según el tipo de solicitud
    if images and len(images) > 0:
        chain = [
            ("Groq Vision", lambda: call_groq(prompt, history, images=images)),
            ("OpenRouter Vision", lambda: call_openrouter(prompt, model_name=OPENROUTER_FREE_MODEL, history=history)),
        ]
    elif mode == "code":
        chain = [
            ("OpenRouter Code", lambda: call_openrouter(prompt, model_name=OPENROUTER_CODE_MODEL, history=history)),
            ("Google AI Studio", lambda: call_gemini(prompt, history=history)),
            ("Groq", lambda: call_groq(prompt, history=history)),
        ]
    elif mode == "speed":
        chain = [
            ("Groq", lambda: call_groq(prompt, history=history)),
            ("Google AI Studio", lambda: call_gemini(prompt, history=history)),
            ("OpenRouter", lambda: call_openrouter(prompt, model_name=OPENROUTER_FREE_MODEL, history=history)),
        ]
    else:
        # Modo Auto / General: Google -> Groq -> OpenRouter
        chain = [
            ("Google AI Studio", lambda: call_gemini(prompt, history=history)),
            ("Groq", lambda: call_groq(prompt, history=history)),
            ("OpenRouter", lambda: call_openrouter(prompt, model_name=OPENROUTER_FREE_MODEL, history=history)),
        ]

    active_provider = None
    stream_successful = False
    full_response_text = ""

    for provider_name, provider_callable in chain:
        prov_start = time.time()
        try:
            # Emitir evento de conexión al cliente
            yield {"type": "connecting", "provider": provider_name}

            first_chunk = True
            async for chunk in provider_callable():
                if first_chunk:
                    active_provider = provider_name
                    first_chunk = False

                full_response_text += chunk
                yield {"type": "chunk", "text": chunk, "provider": provider_name}

            stream_successful = True
            latency_ms = (time.time() - prov_start) * 1000
            telemetry.record_request(provider_name, latency_ms)
            break

        except Exception as e:
            err_msg = str(e)
            failover_latency = (time.time() - prov_start) * 1000
            failover_log.append({
                "from_provider": provider_name,
                "error": err_msg,
                "latency_ms": failover_latency
            })

            # Identificar el siguiente proveedor para registrar el failover
            next_idx = [p[0] for p in chain].index(provider_name) + 1
            if next_idx < len(chain):
                next_prov = chain[next_idx][0]
                telemetry.record_failover(provider_name, next_prov, err_msg[:50], failover_latency)
                yield {
                    "type": "failover",
                    "from_provider": provider_name,
                    "to_provider": next_prov,
                    "reason": err_msg[:60]
                }
            continue

    total_latency_ms = (time.time() - start_time) * 1000

    if not stream_successful:
        # Falla total en los 3 proveedores
        yield {
            "type": "error",
            "message": "Todos los proveedores se encuentran temporalmente agotados o con límite de cuota (429/5xx).",
            "details": failover_log,
            "retry_seconds": 60
        }
    else:
        # Metadata final para telemetría y UI
        failover_note = ""
        if len(failover_log) > 0:
            last_fail = failover_log[-1]
            failover_note = f"\n\n> ↳ *Conmutado automáticamente a {active_provider} por incidencia en {last_fail['from_provider']}.*"

        yield {
            "type": "done",
            "provider": active_provider,
            "latency_ms": round(total_latency_ms, 1),
            "failover_note": failover_note,
            "full_text": full_response_text
        }
