import os
import json
from contextlib import asynccontextmanager
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field
from dotenv import load_dotenv

load_dotenv()

from core.memory import init_db, save_message, get_history
from core.router import route_and_stream
from core.telemetry import telemetry

@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield

# Deshabilitar documentación interactiva en producción para reducir superficie de ataque
is_prod = bool(os.environ.get("VERCEL")) and os.environ.get("DEBUG", "").lower() != "true"

app = FastAPI(
    title="Nova AI Engine",
    version="2.0.0",
    lifespan=lifespan,
    docs_url=None if is_prod else "/docs",
    redoc_url=None if is_prod else "/redoc",
    openapi_url=None if is_prod else "/openapi.json",
)

# CORS con lista blanca
allowed_origins = [
    "https://nova-ai.vercel.app",
    "http://localhost:3000",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]
extra_origins = os.environ.get("ALLOWED_ORIGINS", "")
if extra_origins:
    allowed_origins.extend([o.strip() for o in extra_origins.split(",") if o.strip()])

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_origin_regex=r"^https://nova-.*\.vercel\.app$",
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# ── Modelos Pydantic ──────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)
    mode: str = Field(default="auto", pattern=r"^(auto|reasoning|speed|code)$")
    session_id: str | None = Field(default=None, max_length=64)
    images: list[str] | None = Field(default=None, max_length=3)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    return {
        "status": "online",
        "engine": "Nova Multi-Provider Router v2",
        "providers_configured": {
            "gemini": bool(os.environ.get("GEMINI_API_KEY")),
            "groq": bool(os.environ.get("GROQ_API_KEY")),
            "openrouter": bool(os.environ.get("OPENROUTER_API_KEY")),
        }
    }


@app.get("/api/telemetry")
def get_telemetry():
    return telemetry.get_summary()


@app.get("/api/history")
def history(session_id: str):
    if not session_id:
        raise HTTPException(status_code=400, detail="session_id es requerido")
    return {"history": get_history(session_id)}


@app.post("/api/chat")
async def chat_stream(request: ChatRequest):
    session_id = request.session_id or "anonymous"
    user_msg = request.message.strip()

    # Validar imágenes si existen
    if request.images and len(request.images) > 3:
        raise HTTPException(status_code=400, detail="Máximo 3 imágenes por solicitud.")

    chat_history = get_history(session_id, limit=6)

    async def event_generator():
        final_text = ""
        used_provider = "Unknown"
        total_lat = 0.0

        async for event in route_and_stream(user_msg, mode=request.mode, history=chat_history, images=request.images):
            if event["type"] == "done":
                final_text = event.get("full_text", "")
                used_provider = event.get("provider", "Unknown")
                total_lat = event.get("latency_ms", 0.0)

            yield f"data: {json.dumps(event)}\n\n"

        # Guardar en persistencia tras completar el stream
        if final_text:
            save_message(
                session_id=session_id,
                message=user_msg,
                response=final_text,
                provider=used_provider,
                latency_ms=total_lat
            )

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ── Archivos Estáticos (Frontend) ─────────────────────────────────────────────
BASE = os.path.dirname(__file__)

app.mount("/css", StaticFiles(directory=os.path.join(BASE, "frontend", "css")), name="css")
app.mount("/js",  StaticFiles(directory=os.path.join(BASE, "frontend", "js")),  name="js")

@app.get("/")
def read_root():
    return FileResponse(os.path.join(BASE, "frontend", "index.html"))
