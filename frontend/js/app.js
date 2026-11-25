// ==============================================================================
// NOVA AI — CLIENT CONTROLLER, STREAMING SSE & SESSION WORKSPACE
// ==============================================================================

const $ = (id) => document.getElementById(id);

// Core DOM
const sidebar = $('sidebar');
const drawerBackdrop = $('drawer-backdrop');
const menuToggleBtn = $('menu-toggle-btn');
const sidebarCloseBtn = $('sidebar-close-btn');
const newChatBtn = $('new-chat-btn');
const sessionSearchInput = $('session-search');
const historyList = $('history-list');
const activeSessionTitle = $('active-session-title');
const clearHistoryBtn = $('clear-history-btn');
const deleteActiveChatBtn = $('delete-active-chat-btn');

const messagesContainer = $('messages-container');
const messagesWrapper = $('messages-wrapper');
const welcomeHero = $('welcome-hero');
const chatTextarea = $('chat-textarea');
const sendBtn = $('send-btn');
const modeSelector = $('mode-selector');
const attachBtn = $('attach-btn');
const fileInput = $('file-input');
const imagePreviews = $('image-previews');
const dockNotice = $('dock-notice');

// Topbar & Telemetry Drawer DOM
const statusGemini = $('status-gemini');
const statusGroq = $('status-groq');
const statusOpenRouter = $('status-openrouter');
const telemetryToggleBtn = $('telemetry-toggle-btn');
const telemetryCloseBtn = $('telemetry-close-btn');
const telemetryDrawer = $('telemetry-drawer');

const healthGemini = $('health-gemini');
const healthGroq = $('health-groq');
const healthOpenRouter = $('health-openrouter');

const barGemini = $('bar-gemini');
const barGroq = $('bar-groq');
const barRouter = $('bar-router');
const txtGemini = $('txt-gemini');
const txtGroq = $('txt-groq');
const txtRouter = $('txt-router');
const metricRequests = $('metric-requests');
const metricFailovers = $('metric-failovers');
const metricLatGemini = $('metric-lat-gemini');
const metricLatGroq = $('metric-lat-groq');
const eventFeed = $('event-feed');

// Application State
let isStreaming = false;
let activeStreamController = null;
let attachedImages = [];
let sessionsCache = [];
let activeSessionId = getOrCreateSessionId();
let noticeTimer = null;

// ── Deleted Sessions Tombstone Manager (Persistencia en LocalStorage) ────────
const DELETED_SESSIONS_KEY = 'nova_deleted_sessions';
const SAFE_SESSION_ID_REGEX = /^chat_[a-zA-Z0-9_-]{4,64}$/;

function getDeletedSessionIds() {
  try {
    const raw = localStorage.getItem(DELETED_SESSIONS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((id) => typeof id === 'string' && SAFE_SESSION_ID_REGEX.test(id)));
  } catch {
    return new Set();
  }
}

function markSessionDeleted(sid) {
  if (!sid || !SAFE_SESSION_ID_REGEX.test(sid)) return;
  const set = getDeletedSessionIds();
  set.add(sid);
  try {
    const arr = Array.from(set).slice(-200);
    localStorage.setItem(DELETED_SESSIONS_KEY, JSON.stringify(arr));
  } catch {}
}

function isSessionDeleted(sid) {
  if (!sid) return false;
  return getDeletedSessionIds().has(sid);
}

function generateSessionId() {
  const rand = typeof crypto !== 'undefined' && crypto.getRandomValues
    ? Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
    : Math.random().toString(36).slice(2, 10);
  return `chat_${rand}`;
}

function getOrCreateSessionId() {
  let sid = localStorage.getItem('nova_active_chat_id') || localStorage.getItem('nova_session_id');
  if (!sid || !SAFE_SESSION_ID_REGEX.test(sid) || isSessionDeleted(sid)) {
    sid = generateSessionId();
    localStorage.setItem('nova_active_chat_id', sid);
  }
  return sid;
}

function setActiveSession(sid, titleText = 'Nueva consulta') {
  activeSessionId = sid;
  localStorage.setItem('nova_active_chat_id', sid);
  localStorage.setItem('nova_session_title', titleText);
  activeSessionTitle.textContent = titleText;
  renderSessionList();
}

// ── Inline Non-Blocking Dock Notice ──────────────────────────────────────────
function showDockNotice(msg) {
  if (!msg) return;
  dockNotice.textContent = msg;
  dockNotice.hidden = false;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    dockNotice.hidden = true;
    dockNotice.textContent = '';
  }, 5000);
}

// ── Drawer & Sidebar Controls ────────────────────────────────────────────────
function syncBackdrop() {
  const isSidebarOpen = sidebar.classList.contains('open');
  const isTelemetryOpen = telemetryDrawer.classList.contains('open');
  if (isSidebarOpen || isTelemetryOpen) {
    drawerBackdrop.classList.add('visible');
  } else {
    drawerBackdrop.classList.remove('visible');
  }
}

function setTelemetryOpen(open) {
  telemetryDrawer.classList.toggle('open', open);
  telemetryDrawer.setAttribute('aria-hidden', String(!open));
  telemetryToggleBtn.setAttribute('aria-expanded', String(open));
  if (open) {
    fetchTelemetry();
    fetchHealth();
  }
  syncBackdrop();
}

function setSidebarOpen(open) {
  sidebar.classList.toggle('open', open);
  syncBackdrop();
}

telemetryToggleBtn.addEventListener('click', () => {
  const next = !telemetryDrawer.classList.contains('open');
  setTelemetryOpen(next);
});

telemetryCloseBtn.addEventListener('click', () => setTelemetryOpen(false));
menuToggleBtn.addEventListener('click', () => setSidebarOpen(true));
sidebarCloseBtn.addEventListener('click', () => setSidebarOpen(false));

drawerBackdrop.addEventListener('click', () => {
  setSidebarOpen(false);
  setTelemetryOpen(false);
});

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (window.innerWidth <= 768) setSidebarOpen(true);
    sessionSearchInput.focus();
  } else if (e.key === 'Escape') {
    if (telemetryDrawer.classList.contains('open')) setTelemetryOpen(false);
    if (sidebar.classList.contains('open')) setSidebarOpen(false);
  }
});

// ── Textarea Autoexpand & Input Handling ─────────────────────────────────────
function updateSendButtonState() {
  const hasText = Boolean(chatTextarea.value.trim());
  const hasImages = attachedImages.length > 0;
  sendBtn.disabled = (!hasText && !hasImages) || isStreaming;
}

chatTextarea.addEventListener('input', () => {
  chatTextarea.style.height = 'auto';
  chatTextarea.style.height = Math.min(chatTextarea.scrollHeight, 160) + 'px';
  updateSendButtonState();
});

chatTextarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) handleSend();
  }
});

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const SAFE_IMAGE_DATA_URL = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024; // 2 MB por imagen

async function processImageFiles(files) {
  if (attachedImages.length + files.length > 3) {
    showDockNotice('Máximo 3 imágenes permitidas por solicitud.');
    return;
  }
  for (const file of files) {
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      showDockNotice(`Formato no permitido (${file.type || 'desconocido'}). Usa PNG, JPEG, WEBP o GIF.`);
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      showDockNotice(`La imagen "${file.name || 'adjunta'}" supera el límite de 2 MB.`);
      continue;
    }
    try {
      const b64 = await toBase64(file);
      if (typeof b64 === 'string' && SAFE_IMAGE_DATA_URL.test(b64)) {
        attachedImages.push(b64);
      } else {
        showDockNotice('No se pudo validar el contenido de la imagen.');
      }
    } catch {
      showDockNotice('Error al leer la imagen adjunta.');
    }
  }
  renderImagePreviews();
}

chatTextarea.addEventListener('paste', async (e) => {
  const clipboardData = e.clipboardData;
  if (!clipboardData) return;
  const items = Array.from(clipboardData.items || []);
  const imageFiles = items
    .filter((item) => item.kind === 'file' && ALLOWED_IMAGE_TYPES.has(item.type))
    .map((item) => item.getAsFile())
    .filter(Boolean);

  if (imageFiles.length > 0) {
    await processImageFiles(imageFiles);
  }
});

sendBtn.addEventListener('click', () => {
  if (!sendBtn.disabled) handleSend();
});

// ── Mode Selector Listener ──────────────────────────────────────────────────
modeSelector.addEventListener('change', () => {
  chatTextarea.focus();
});

// ── Image Attachments (Vision) ───────────────────────────────────────────────
attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (files.length > 0) {
    await processImageFiles(files);
  }
  fileInput.value = '';
});

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result);
    reader.onerror = (error) => reject(error);
  });
}

function renderImagePreviews() {
  imagePreviews.innerHTML = '';
  if (attachedImages.length === 0) {
    imagePreviews.hidden = true;
    updateSendButtonState();
    return;
  }
  imagePreviews.hidden = false;
  attachedImages.forEach((src, idx) => {
    const thumb = document.createElement('div');
    thumb.className = 'preview-thumb';

    const img = document.createElement('img');
    img.src = src;
    img.alt = `Imagen adjunta ${idx + 1}`;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'preview-remove-btn';
    removeBtn.setAttribute('aria-label', `Quitar imagen ${idx + 1}`);
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', () => {
      attachedImages.splice(idx, 1);
      renderImagePreviews();
    });

    thumb.appendChild(img);
    thumb.appendChild(removeBtn);
    imagePreviews.appendChild(thumb);
  });
  updateSendButtonState();
}

// ── Markdown, Sanitization & Copyable Code Blocks ────────────────────────────
if (typeof DOMPurify !== 'undefined' && typeof DOMPurify.addHook === 'function') {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

function sanitizeMarkdown(text) {
  const safeText = String(text ?? '');
  // Fail-closed: solo renderizar Markdown si tanto marked como DOMPurify están disponibles
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    const raw = marked.parse(safeText);
    return DOMPurify.sanitize(raw, {
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select', 'button', 'iframe', 'object', 'embed', 'img'],
    });
  }
  return escapeHTML(safeText);
}

function escapeHTML(str) {
  const p = document.createElement('p');
  p.textContent = str;
  return p.innerHTML.replace(/\n/g, '<br>');
}

function enhanceCodeBlocks(container) {
  const pres = container.querySelectorAll('pre');
  pres.forEach((pre) => {
    if (pre.parentElement && pre.parentElement.classList.contains('code-block-wrapper')) {
      return;
    }

    const codeEl = pre.querySelector('code');
    let lang = 'código';
    if (codeEl && codeEl.className) {
      const match = codeEl.className.match(/language-([a-zA-Z0-9_+-]+)/);
      if (match) lang = match[1];
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';

    const header = document.createElement('div');
    header.className = 'code-block-header';

    const langLabel = document.createElement('span');
    langLabel.textContent = lang;

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy-code-btn';
    copyBtn.textContent = 'Copiar';
    copyBtn.addEventListener('click', async () => {
      const rawCode = codeEl ? codeEl.textContent : pre.textContent;
      try {
        await navigator.clipboard.writeText(rawCode || '');
        copyBtn.textContent = 'Copiado';
        copyBtn.classList.add('copied');
        setTimeout(() => {
          copyBtn.textContent = 'Copiar';
          copyBtn.classList.remove('copied');
        }, 1800);
      } catch {
        showDockNotice('No se pudo copiar al portapapeles.');
      }
    });

    header.appendChild(langLabel);
    header.appendChild(copyBtn);

    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });
}

// ── Chat Bubble Rendering ────────────────────────────────────────────────────
function getProviderClass(providerName) {
  const p = (providerName || '').toLowerCase();
  if (p.includes('gemini') || p.includes('google')) return 'gemini';
  if (p.includes('groq')) return 'groq';
  if (p.includes('openrouter')) return 'openrouter';
  return '';
}

function renderUserMessage(text, images = []) {
  const row = document.createElement('div');
  row.className = 'message-row user';

  const bubble = document.createElement('div');
  bubble.className = 'user-bubble';

  if (images && images.length > 0) {
    const imgsGrid = document.createElement('div');
    imgsGrid.className = 'user-images-grid';
    images.forEach((src, i) => {
      const img = document.createElement('img');
      img.src = src;
      img.alt = `Adjunto ${i + 1}`;
      img.className = 'user-image-thumb';
      imgsGrid.appendChild(img);
    });
    bubble.appendChild(imgsGrid);
  }

  const textNode = document.createElement('div');
  textNode.innerHTML = escapeHTML(text);
  bubble.appendChild(textNode);

  row.appendChild(bubble);
  messagesWrapper.appendChild(row);
}

function createAssistantBubble({ initialProvider = 'Conectando...', initialLatency = null, isStatic = false } = {}) {
  const row = document.createElement('div');
  row.className = 'message-row';

  const bubble = document.createElement('div');
  bubble.className = 'assistant-bubble';

  const header = document.createElement('div');
  header.className = 'proof-of-routing';

  const metaLeft = document.createElement('div');
  metaLeft.className = 'routing-meta-left';

  const providerEl = document.createElement('span');
  providerEl.className = `routing-provider ${getProviderClass(initialProvider)}`;
  providerEl.textContent = initialProvider;

  const latencyEl = document.createElement('span');
  latencyEl.className = 'routing-latency';
  latencyEl.textContent = initialLatency !== null ? `· ${initialLatency} ms` : '';

  metaLeft.appendChild(providerEl);
  metaLeft.appendChild(latencyEl);

  const labelEl = document.createElement('span');
  labelEl.className = 'routing-label';
  labelEl.textContent = 'Proof of Routing';

  header.appendChild(metaLeft);
  header.appendChild(labelEl);

  const contentEl = document.createElement('div');
  contentEl.className = 'assistant-content';
  if (!isStatic) {
    contentEl.innerHTML = `
      <div class="skeleton-loader">
        <div class="skeleton-line skeleton-w-82"></div>
        <div class="skeleton-line skeleton-w-64"></div>
        <div class="skeleton-line skeleton-w-44"></div>
      </div>
    `;
  }

  const routingNoteEl = document.createElement('div');
  routingNoteEl.className = 'routing-note';

  bubble.appendChild(header);
  bubble.appendChild(contentEl);
  bubble.appendChild(routingNoteEl);
  row.appendChild(bubble);
  messagesWrapper.appendChild(row);

  return { bubbleEl: bubble, contentEl, providerEl, latencyEl, routingNoteEl };
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  });
}

// ── Streaming SSE Chat Handler ───────────────────────────────────────────────
async function handleSend() {
  const text = chatTextarea.value.trim();
  const sentImages = [...attachedImages];
  if ((!text && sentImages.length === 0) || isStreaming) return;

  if (!activeSessionId || isSessionDeleted(activeSessionId)) {
    activeSessionId = generateSessionId();
    localStorage.setItem('nova_active_chat_id', activeSessionId);
  }

  isStreaming = true;
  sendBtn.disabled = true;
  welcomeHero.style.display = 'none';
  stopTypewriter();
  if (deleteActiveChatBtn) deleteActiveChatBtn.hidden = false;

  if (activeSessionTitle.textContent === 'Nueva consulta') {
    const shortTitle = text ? (text.length > 48 ? text.slice(0, 48) + '…' : text) : 'Análisis visual';
    activeSessionTitle.textContent = shortTitle;
  }

  const promptText = text || 'Analiza detalladamente esta imagen adjunta.';
  renderUserMessage(promptText, sentImages);

  chatTextarea.value = '';
  chatTextarea.style.height = 'auto';
  attachedImages = [];
  renderImagePreviews();

  const { contentEl, providerEl, latencyEl, routingNoteEl } = createAssistantBubble();
  scrollToBottom();

  try {
    activeStreamController = new AbortController();
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: promptText,
        mode: modeSelector.value,
        session_id: activeSessionId,
        images: sentImages.length > 0 ? sentImages : null,
      }),
      signal: activeStreamController.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`HTTP ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    let accumulatedText = '';
    let isFirstChunk = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith('data: ')) continue;

        try {
          const event = JSON.parse(line.slice(6));

          if (event.type === 'connecting') {
            providerEl.className = `routing-provider ${getProviderClass(event.provider)}`;
            providerEl.textContent = `Conectando · ${event.provider}`;
            latencyEl.textContent = '';
          } else if (event.type === 'failover') {
            providerEl.className = 'routing-provider failover';
            providerEl.textContent = `Conmutando ➔ ${event.to_provider}`;
            latencyEl.textContent = '';
          } else if (event.type === 'chunk') {
            if (isFirstChunk) {
              contentEl.innerHTML = '';
              isFirstChunk = false;
            }
            accumulatedText += event.text;
            contentEl.innerHTML = sanitizeMarkdown(accumulatedText);
            scrollToBottom();
          } else if (event.type === 'done') {
            providerEl.className = `routing-provider ${getProviderClass(event.provider)}`;
            providerEl.textContent = event.provider;
            latencyEl.textContent = `· ${event.latency_ms} ms`;
            enhanceCodeBlocks(contentEl);

            if (event.failover_note) {
              routingNoteEl.innerHTML = sanitizeMarkdown(event.failover_note);
            }
          } else if (event.type === 'error') {
            contentEl.innerHTML = `<div class="error-inline">${escapeHTML(event.message)}</div>`;
          }
        } catch {
          // Ignorar fragmento malformado
        }
      }
    }

    await fetchSessions(sessionSearchInput.value);
    fetchTelemetry();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return;
    }
    contentEl.innerHTML =
      '<div class="error-inline">Error de conexión con el motor Nova. Verifica tu red o la disponibilidad del servidor.</div>';
  } finally {
    activeStreamController = null;
    isStreaming = false;
    updateSendButtonState();
    scrollToBottom();
  }
}

// ── Typewriter Welcome Effect ────────────────────────────────────────────────
const typewriterEl = $('typewriter-text');
const WELCOME_PHRASES = [
  '¿Qué hay de nuevo hoy?',
  'Bienvenido a Nova AI',
  '¿En qué te puedo colaborar hoy?',
  '¿Qué vamos a crear hoy?',
  '¿Tienes alguna duda o idea?',
];

let typewriterTimer = null;
let phraseIdx = 0;
let charIdx = 0;
let isDeleting = false;

function stepTypewriter() {
  if (!typewriterEl || welcomeHero.style.display === 'none') {
    return;
  }

  const currentPhrase = WELCOME_PHRASES[phraseIdx];

  if (isDeleting) {
    charIdx--;
    typewriterEl.textContent = currentPhrase.slice(0, charIdx);
  } else {
    charIdx++;
    typewriterEl.textContent = currentPhrase.slice(0, charIdx);
  }

  let delay = isDeleting ? 30 : 60;

  if (!isDeleting && charIdx === currentPhrase.length) {
    delay = 2400;
    isDeleting = true;
  } else if (isDeleting && charIdx === 0) {
    isDeleting = false;
    phraseIdx = (phraseIdx + 1) % WELCOME_PHRASES.length;
    delay = 400;
  }

  typewriterTimer = setTimeout(stepTypewriter, delay);
}

function startTypewriter() {
  if (typewriterTimer) clearTimeout(typewriterTimer);
  charIdx = 0;
  isDeleting = false;
  if (typewriterEl) typewriterEl.textContent = '';
  stepTypewriter();
}

function stopTypewriter() {
  if (typewriterTimer) {
    clearTimeout(typewriterTimer);
    typewriterTimer = null;
  }
}

// ── Session History (Individual por usuario + Búsqueda en vivo) ──────────────
function startNewChat() {
  if (activeStreamController) {
    activeStreamController.abort();
    activeStreamController = null;
  }
  isStreaming = false;
  updateSendButtonState();

  const newSid = generateSessionId();
  setActiveSession(newSid, 'Nueva consulta');
  messagesWrapper.innerHTML = '';
  messagesWrapper.appendChild(welcomeHero);
  welcomeHero.style.display = 'flex';
  startTypewriter();
  if (deleteActiveChatBtn) deleteActiveChatBtn.hidden = true;
  if (window.innerWidth <= 768) setSidebarOpen(false);
  chatTextarea.focus();
}

newChatBtn.addEventListener('click', startNewChat);

if (deleteActiveChatBtn) {
  deleteActiveChatBtn.addEventListener('click', async () => {
    if (isStreaming) return;
    if (!confirm('¿Deseas eliminar esta conversación?')) return;
    await deleteChatSession(activeSessionId);
  });
}

if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', async () => {
    if (isStreaming) return;
    if (
      !confirm(
        '¿Estás seguro de que deseas vaciar todas tus conversaciones? Esta acción no se puede deshacer.'
      )
    ) {
      return;
    }

    // 1. Marcar todas las sesiones locales como eliminadas de inmediato
    sessionsCache.forEach((s) => {
      if (s && s.session_id) markSessionDeleted(s.session_id);
    });
    if (activeSessionId) {
      markSessionDeleted(activeSessionId);
    }

    // 2. Limpiar UI y abrir chat nuevo al instante
    sessionsCache = [];
    renderSessionList();
    startNewChat();
    showDockNotice('Historial vaciado correctamente.');

    // 3. Notificar al backend en segundo plano
    try {
      await fetch('/api/sessions', {
        method: 'DELETE',
      });
    } catch {
      // Ignorar fallo puntual
    }
  });
}

let searchDebounce = null;
sessionSearchInput.addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    fetchSessions(sessionSearchInput.value);
  }, 150);
});

async function fetchSessions(query = '') {
  try {
    const qs = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    const res = await fetch(`/api/sessions${qs}`);
    if (!res.ok) return;
    const data = await res.json();
    const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];

    // Filtro estricto: ninguna sesión marcada como eliminada podrá reaparecer
    const deletedSet = getDeletedSessionIds();
    sessionsCache = rawSessions.filter((s) => s && s.session_id && !deletedSet.has(s.session_id));
    renderSessionList();
  } catch {
    // Silencioso en fallo transitorio
  }
}

function renderSessionList() {
  historyList.innerHTML = '';

  if (clearHistoryBtn) {
    clearHistoryBtn.hidden = sessionsCache.length === 0;
  }

  if (sessionsCache.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = sessionSearchInput.value.trim()
      ? 'No se encontraron conversaciones que coincidan.'
      : 'Tus conversaciones aparecerán aquí.';
    historyList.appendChild(empty);
    return;
  }

  sessionsCache.forEach((sess) => {
    const item = document.createElement('div');
    item.className = `history-item${sess.session_id === activeSessionId ? ' active' : ''}`;
    item.setAttribute('role', 'listitem');

    const content = document.createElement('div');
    content.className = 'history-item-content';

    const title = document.createElement('span');
    title.className = 'history-item-title';
    title.textContent = sess.title;

    const meta = document.createElement('span');
    meta.className = 'history-item-meta';
    const msgLabel = sess.message_count === 1 ? '1 turno' : `${sess.message_count} turnos`;
    meta.textContent = `${sess.last_provider} · ${msgLabel}`;

    content.appendChild(title);
    content.appendChild(meta);
    item.appendChild(content);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'history-item-del-btn';
    delBtn.title = 'Eliminar conversación';
    delBtn.setAttribute('aria-label', `Eliminar conversación ${sess.title}`);
    delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteChatSession(sess.session_id);
    });

    item.appendChild(delBtn);
    item.addEventListener('click', () => loadSessionHistory(sess));
    historyList.appendChild(item);
  });
}

async function deleteChatSession(sid) {
  if (!sid) return;

  // 1. Marcar inmediatamente como eliminada permanentemente en el cliente
  markSessionDeleted(sid);

  // 2. Desaparecerla de inmediato del menú visible (sin esperar red)
  sessionsCache = sessionsCache.filter((s) => s.session_id !== sid);
  renderSessionList();

  // 3. Si era el chat abierto, resetear la pantalla e iniciar chat en blanco
  if (activeSessionId === sid) {
    startNewChat();
  }

  showDockNotice('Conversación eliminada.');

  // 4. Notificar al backend para que elimine en memoria y Supabase
  try {
    await fetch(`/api/sessions/${encodeURIComponent(sid)}`, {
      method: 'DELETE',
    });
  } catch (err) {
    console.warn('[Session] Error notificando eliminación:', err);
  }

  // 5. Re-sincronizar aplicando filtro estricto anti-reaparición
  await fetchSessions(sessionSearchInput.value);
}

async function loadSessionHistory(sess) {
  if (isStreaming || !sess || !sess.session_id) return;
  if (isSessionDeleted(sess.session_id)) {
    startNewChat();
    return;
  }

  try {
    const res = await fetch(`/api/history?session_id=${encodeURIComponent(sess.session_id)}`);
    if (!res.ok) return;
    const data = await res.json();
    const entries = Array.isArray(data.history) ? data.history : [];

    setActiveSession(sess.session_id, sess.title || 'Conversación');
    messagesWrapper.innerHTML = '';
    messagesWrapper.appendChild(welcomeHero);

    if (entries.length === 0) {
      welcomeHero.style.display = 'flex';
      startTypewriter();
      if (deleteActiveChatBtn) deleteActiveChatBtn.hidden = true;
    } else {
      welcomeHero.style.display = 'none';
      stopTypewriter();
      if (deleteActiveChatBtn) deleteActiveChatBtn.hidden = false;
      entries.forEach((entry) => {
        renderUserMessage(entry.message);
        const { contentEl } = createAssistantBubble({
          initialProvider: entry.provider || 'Nova',
          initialLatency: entry.latency_ms ?? null,
          isStatic: true,
        });
        contentEl.innerHTML = sanitizeMarkdown(entry.response || '');
        enhanceCodeBlocks(contentEl);
      });
    }

    if (window.innerWidth <= 768) setSidebarOpen(false);
    scrollToBottom();
  } catch {
    showDockNotice('No se pudo cargar el historial de la sesión.');
  }
}

// ── Health & Telemetry Polling ───────────────────────────────────────────────
async function fetchHealth() {
  try {
    const res = await fetch('/api/health');
    if (!res.ok) return;
    const data = await res.json();
    const cfg = data.providers_configured || {};

    applyChannelState(statusGemini, healthGemini, Boolean(cfg.gemini));
    applyChannelState(statusGroq, healthGroq, Boolean(cfg.groq));
    applyChannelState(statusOpenRouter, healthOpenRouter, Boolean(cfg.openrouter));
  } catch {
    // Silencioso
  }
}

function applyChannelState(topbarEl, drawerEl, isConfigured) {
  if (topbarEl) {
    topbarEl.classList.toggle('ready', isConfigured);
    topbarEl.classList.toggle('unconfigured', !isConfigured);
  }
  if (drawerEl) {
    drawerEl.textContent = isConfigured ? 'Disponible' : 'Sin clave';
    drawerEl.className = `health-state ${isConfigured ? 'ok' : 'missing'}`;
  }
}

async function fetchTelemetry() {
  try {
    const res = await fetch('/api/telemetry');
    if (!res.ok) return;
    const data = await res.json();

    const stats = data.stats || {};
    const avgLat = data.avg_latencies_ms || {};
    const sumProviders = (stats.gemini || 0) + (stats.groq || 0) + (stats.openrouter || 0);

    if (sumProviders > 0) {
      const pGemini = Math.round(((stats.gemini || 0) / sumProviders) * 100);
      const pGroq = Math.round(((stats.groq || 0) / sumProviders) * 100);
      const pRouter = Math.max(0, 100 - pGemini - pGroq);

      barGemini.style.width = pGemini + '%';
      barGroq.style.width = pGroq + '%';
      barRouter.style.width = pRouter + '%';

      txtGemini.textContent = `Gemini ${pGemini}%`;
      txtGroq.textContent = `Groq ${pGroq}%`;
      txtRouter.textContent = `Router ${pRouter}%`;
    } else {
      barGemini.style.width = '0%';
      barGroq.style.width = '0%';
      barRouter.style.width = '0%';
      txtGemini.textContent = 'Gemini 0%';
      txtGroq.textContent = 'Groq 0%';
      txtRouter.textContent = 'Router 0%';
    }

    metricRequests.textContent = stats.total_requests || 0;
    metricFailovers.textContent = stats.total_failovers || 0;
    metricLatGemini.textContent = `${avgLat.gemini || 0} ms`;
    metricLatGroq.textContent = `${avgLat.groq || 0} ms`;

    const events = data.recent_events || [];
    if (events.length === 0) {
      eventFeed.innerHTML = '<div class="event-empty">Sin eventos registrados aún.</div>';
    } else {
      eventFeed.innerHTML = events
        .slice(-10)
        .reverse()
        .map(
          (ev) => `
          <div class="event-row ${ev.type === 'failover' ? 'failover' : ''}">
            <span class="event-time">${escapeHTML(ev.timestamp)}</span>${escapeHTML(ev.detail)}
          </div>
        `
        )
        .join('');
    }
  } catch {
    // Silencioso
  }
}

// ── Boot Initialization ──────────────────────────────────────────────────────
fetchHealth();
startTypewriter();
fetchSessions().then(() => {
  if (activeSessionId && !isSessionDeleted(activeSessionId)) {
    const savedTitle = localStorage.getItem('nova_session_title') || 'Consulta anterior';
    loadSessionHistory({ session_id: activeSessionId, title: savedTitle });
  } else {
    startNewChat();
  }
});
fetchTelemetry();
setInterval(fetchTelemetry, 8000);
