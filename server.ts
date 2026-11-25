import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import {
  initDb,
  saveMessage,
  getHistory,
  getSessions,
  deleteSession,
  clearAllUserSessions,
  isValidId,
} from './src/memory.ts';
import { routeAndStream } from './src/router.ts';
import { telemetry } from './src/telemetry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

app.disable('x-powered-by');
app.set('trust proxy', 1);

// ── Security Headers (Express fallback fuera de Vercel) ──────────────────────
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ── CORS Estricto ─────────────────────────────────────────────────────────────
const allowedOrigins = new Set<string>([
  'https://novaai-bay.vercel.app',
  'https://nova-ai.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);
if (process.env.VERCEL_URL) {
  allowedOrigins.add(`https://${process.env.VERCEL_URL.trim()}`);
}
const extraOrigins = process.env.ALLOWED_ORIGINS || '';
if (extraOrigins) {
  for (const origin of extraOrigins.split(',')) {
    const trimmed = origin.trim();
    if (trimmed) allowedOrigins.add(trimmed);
  }
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Origen no permitido por CORS'), false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);

app.use(express.json({ limit: '5mb' }));

// ── Signed HttpOnly Session Cookie (Anti-IDOR) ───────────────────────────────
const SESSION_COOKIE_NAME = 'nova_sid';
const USER_ID_REGEX = /^usr_[a-f0-9]{16,32}$/;
const SAFE_IMAGE_DATA_URL = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const MAX_IMAGE_BASE64_LENGTH = 3_000_000; // ~2.2 MB binario por imagen

function getSessionSecret(): string {
  const explicit = (process.env.SESSION_SECRET || '').trim();
  if (explicit) return explicit;
  const seed =
    process.env.GEMINI_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    'nova-local-dev-secret';
  return createHash('sha256').update(`nova_session_hmac::${seed}`).digest('hex');
}

const SESSION_SECRET = getSessionSecret();

function signUserId(userId: string): string {
  const sig = createHmac('sha256', SESSION_SECRET).update(userId).digest('hex');
  return `${userId}.${sig}`;
}

function verifySignedToken(token: string): string | null {
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return null;
  const userId = token.slice(0, dotIdx);
  const sigHex = token.slice(dotIdx + 1);
  if (!USER_ID_REGEX.test(userId) || !/^[a-f0-9]{64}$/.test(sigHex)) {
    return null;
  }
  const expectedHex = createHmac('sha256', SESSION_SECRET).update(userId).digest('hex');
  const a = Buffer.from(sigHex, 'hex');
  const b = Buffer.from(expectedHex, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }
  return userId;
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

function resolveAuthenticatedUser(req: express.Request, res: express.Response): string {
  const cookies = parseCookies(req.headers.cookie);
  const rawToken = cookies[SESSION_COOKIE_NAME];
  if (rawToken) {
    const verified = verifySignedToken(rawToken);
    if (verified) return verified;
  }

  const newUserId = `usr_${randomBytes(12).toString('hex')}`;
  const signed = signUserId(newUserId);
  const isHttps =
    req.secure ||
    req.headers['x-forwarded-proto'] === 'https' ||
    Boolean(process.env.VERCEL);

  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=31536000',
  ];
  if (isHttps) {
    cookieParts.push('Secure');
  }
  res.setHeader('Set-Cookie', cookieParts.join('; '));
  return newUserId;
}

// ── Rate Limiter (Sliding Window acotado en memoria) ─────────────────────────
interface RateBucket {
  count: number;
  resetAt: number;
}
const rateBuckets = new Map<string, RateBucket>();
const MAX_RATE_BUCKETS = 5000;

function checkRateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  if (rateBuckets.size > MAX_RATE_BUCKETS) {
    for (const [k, b] of rateBuckets.entries()) {
      if (now >= b.resetAt) rateBuckets.delete(k);
    }
    while (rateBuckets.size > MAX_RATE_BUCKETS) {
      const oldest = rateBuckets.keys().next().value;
      if (!oldest) break;
      rateBuckets.delete(oldest);
    }
  }

  const existing = rateBuckets.get(key);
  if (!existing || now >= existing.resetAt) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (existing.count >= maxRequests) {
    return false;
  }
  existing.count += 1;
  return true;
}

function getClientIp(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim().slice(0, 64);
  }
  return (req.ip || 'unknown').slice(0, 64);
}

// ── API Router ────────────────────────────────────────────────────────────────
const apiRouter = express.Router();

apiRouter.use((req, res, next) => {
  const ip = getClientIp(req);
  if (!checkRateLimit(`global:${ip}`, 120, 60_000)) {
    res.status(429).json({ detail: 'Demasiadas solicitudes. Intenta nuevamente en un minuto.' });
    return;
  }
  next();
});

apiRouter.get('/health', (_req, res) => {
  res.json({
    status: 'online',
    providers_configured: {
      gemini: Boolean(process.env.GEMINI_API_KEY),
      groq: Boolean(process.env.GROQ_API_KEY),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    },
  });
});

apiRouter.get('/telemetry', (_req, res) => {
  res.json(telemetry.getSummary());
});

apiRouter.get('/sessions', async (req, res) => {
  const userId = resolveAuthenticatedUser(req, res);
  const query = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  const sessions = await getSessions(userId, query);
  res.json({ sessions });
});

apiRouter.get('/history', async (req, res) => {
  const userId = resolveAuthenticatedUser(req, res);
  const sessionId =
    typeof req.query.session_id === 'string'
      ? req.query.session_id.trim()
      : typeof req.query.chat_id === 'string'
      ? req.query.chat_id.trim()
      : '';

  if (!sessionId || !isValidId(sessionId)) {
    res.status(400).json({ detail: 'session_id inválido o requerido' });
    return;
  }
  const history = await getHistory(sessionId, userId);
  res.json({ history, session_id: sessionId });
});

apiRouter.delete('/sessions', async (req, res) => {
  const userId = resolveAuthenticatedUser(req, res);
  await clearAllUserSessions(userId);
  res.json({ success: true, message: 'Historial vaciado correctamente' });
});

apiRouter.delete('/sessions/:id', async (req, res) => {
  const userId = resolveAuthenticatedUser(req, res);
  const sessionId = (req.params.id || '').trim();
  if (!sessionId || !isValidId(sessionId)) {
    res.status(400).json({ detail: 'id inválido o requerido' });
    return;
  }
  await deleteSession(userId, sessionId);
  res.json({ success: true, session_id: sessionId });
});

apiRouter.post('/chat', async (req, res) => {
  const userId = resolveAuthenticatedUser(req, res);
  const ip = getClientIp(req);
  if (!checkRateLimit(`chat:${ip}:${userId}`, 20, 60_000)) {
    res.status(429).json({ detail: 'Límite de consultas por minuto alcanzado. Espera unos segundos.' });
    return;
  }

  const body = req.body as {
    message?: unknown;
    mode?: unknown;
    session_id?: unknown;
    chat_id?: unknown;
    images?: unknown;
  };

  const rawMessage = typeof body?.message === 'string' ? body.message : '';
  let userMsg = rawMessage.trim();

  let images: string[] | null = null;
  if (body?.images !== undefined && body?.images !== null) {
    if (!Array.isArray(body.images) || body.images.length > 3) {
      res.status(400).json({ detail: 'Máximo 3 imágenes permitidas por solicitud.' });
      return;
    }
    const validatedImages: string[] = [];
    for (const item of body.images) {
      if (
        typeof item !== 'string' ||
        item.length > MAX_IMAGE_BASE64_LENGTH ||
        !SAFE_IMAGE_DATA_URL.test(item)
      ) {
        res.status(400).json({
          detail: 'Formato de imagen inválido. Solo se permiten PNG, JPEG, WEBP o GIF (máx. 2 MB).',
        });
        return;
      }
      validatedImages.push(item);
    }
    images = validatedImages;
  }

  if (!userMsg && images && images.length > 0) {
    userMsg = 'Analiza detalladamente esta imagen adjunta.';
  }

  if (userMsg.length < 1 || userMsg.length > 4000) {
    res.status(400).json({ detail: 'message debe tener entre 1 y 4000 caracteres.' });
    return;
  }

  const allowedModes = new Set(['auto', 'reasoning', 'speed', 'code']);
  const mode = typeof body?.mode === 'string' && allowedModes.has(body.mode) ? body.mode : 'auto';

  const rawSessionId =
    typeof body?.session_id === 'string' && body.session_id.trim()
      ? body.session_id.trim()
      : typeof body?.chat_id === 'string' && body.chat_id.trim()
      ? body.chat_id.trim()
      : 'default';

  if (!isValidId(rawSessionId)) {
    res.status(400).json({ detail: 'session_id inválido.' });
    return;
  }

  const chatHistory = await getHistory(rawSessionId, userId, 6);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  let finalText = '';
  let usedProvider = 'Unknown';
  let totalLatency = 0.0;

  try {
    for await (const event of routeAndStream({
      prompt: userMsg,
      mode,
      history: chatHistory,
      images,
      signal: abortController.signal,
    })) {
      if (abortController.signal.aborted) break;
      if (event.type === 'done') {
        finalText = event.full_text || '';
        usedProvider = event.provider || 'Unknown';
        totalLatency = event.latency_ms ?? 0.0;
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    if (finalText && !abortController.signal.aborted) {
      await saveMessage({
        userId,
        sessionId: rawSessionId,
        message: userMsg,
        response: finalText,
        provider: usedProvider,
        latencyMs: totalLatency,
      });
    }
  } catch (err) {
    console.error('[Chat API] Error interno:', err instanceof Error ? err.message : err);
    if (!abortController.signal.aborted) {
      res.write(
        `data: ${JSON.stringify({ type: 'error', message: 'Error interno al procesar la consulta.' })}\n\n`
      );
    }
  } finally {
    res.end();
  }
});

// Montar API únicamente bajo /api
app.use('/api', apiRouter);

// ── Static Frontend ───────────────────────────────────────────────────────────

const frontendDir = path.join(__dirname, 'frontend');
const publicDir = path.join(__dirname, 'public');

app.use('/css', express.static(path.join(frontendDir, 'css')));
app.use('/js', express.static(path.join(frontendDir, 'js')));
app.use(express.static(frontendDir));
app.use(express.static(publicDir));

app.get('/', (_req, res) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

initDb();

if (!process.env.VERCEL) {
  app.listen(PORT, HOST, () => {
    console.log(`Nova AI Engine listening on http://${HOST}:${PORT}`);
  });
}

export default app;
