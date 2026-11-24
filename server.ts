import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import { initDb, saveMessage, getHistory, getSessions } from './src/memory.ts';
import { routeAndStream } from './src/router.ts';
import { telemetry } from './src/telemetry.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// CORS configuration
const allowedOrigins = [
  'https://nova-ai.vercel.app',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];
const extraOrigins = process.env.ALLOWED_ORIGINS || '';
if (extraOrigins) {
  for (const origin of extraOrigins.split(',')) {
    const trimmed = origin.trim();
    if (trimmed) allowedOrigins.push(trimmed);
  }
}

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || /^https:\/\/nova-.*\.vercel\.app$/.test(origin)) {
        return callback(null, true);
      }
      return callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  })
);

app.use(express.json({ limit: '64mb' }));

// ── API Router ────────────────────────────────────────────────────────────────
const apiRouter = express.Router();

apiRouter.get('/health', (_req, res) => {
  res.json({
    status: 'online',
    engine: 'Nova Multi-Provider Router v2',
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
  const query = typeof req.query.q === 'string' ? req.query.q : '';
  const sessions = await getSessions(query);
  res.json({ sessions });
});

apiRouter.get('/history', async (req, res) => {
  const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id.trim() : '';
  if (!sessionId) {
    res.status(400).json({ detail: 'session_id es requerido' });
    return;
  }
  const history = await getHistory(sessionId);
  res.json({ history });
});

apiRouter.post('/chat', async (req, res) => {
  const body = req.body as {
    message?: unknown;
    mode?: unknown;
    session_id?: unknown;
    images?: unknown;
  };

  const rawMessage = typeof body?.message === 'string' ? body.message : '';
  const userMsg = rawMessage.trim();
  if (userMsg.length < 1 || userMsg.length > 4000) {
    res.status(400).json({ detail: 'message debe tener entre 1 y 4000 caracteres.' });
    return;
  }

  const allowedModes = new Set(['auto', 'reasoning', 'speed', 'code']);
  const mode = typeof body?.mode === 'string' && allowedModes.has(body.mode) ? body.mode : 'auto';

  const sessionId =
    typeof body?.session_id === 'string' && body.session_id.trim()
      ? body.session_id.trim().slice(0, 64)
      : 'anonymous';

  let images: string[] | null = null;
  if (Array.isArray(body?.images)) {
    if (body.images.length > 3) {
      res.status(400).json({ detail: 'Máximo 3 imágenes por solicitud.' });
      return;
    }
    images = body.images.filter((item): item is string => typeof item === 'string');
  }

  const chatHistory = await getHistory(sessionId, 6);

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let finalText = '';
  let usedProvider = 'Unknown';
  let totalLatency = 0.0;

  try {
    for await (const event of routeAndStream({
      prompt: userMsg,
      mode,
      history: chatHistory,
      images,
    })) {
      if (event.type === 'done') {
        finalText = event.full_text || '';
        usedProvider = event.provider || 'Unknown';
        totalLatency = event.latency_ms ?? 0.0;
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    if (finalText) {
      await saveMessage({
        sessionId,
        message: userMsg,
        response: finalText,
        provider: usedProvider,
        latencyMs: totalLatency,
      });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Error interno en el motor Nova';
    res.write(`data: ${JSON.stringify({ type: 'error', message: errMsg })}\n\n`);
  } finally {
    res.end();
  }
});

// Registrar el enrutador tanto en /api como en / para soportar reescrituras de Vercel y llamadas locales
app.use('/api', apiRouter);
app.use('/', apiRouter);

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
