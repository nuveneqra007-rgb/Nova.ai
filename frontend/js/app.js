// ==============================================================================
// NOVA AI v2 — CLIENT CONTROLLER & STREAMING ENGINE
// ==============================================================================

const $ = id => document.getElementById(id);

// DOM Elements
const messagesContainer = $('messages-container');
const messagesWrapper = $('messages-wrapper');
const welcomeHero = $('welcome-hero');
const chatTextarea = $('chat-textarea');
const sendBtn = $('send-btn');
const modeSelector = $('mode-selector');
const attachBtn = $('attach-btn');
const fileInput = $('file-input');
const imagePreviews = $('image-previews');
const menuToggleBtn = $('menu-toggle-btn');
const sidebar = $('sidebar');
const newChatBtn = $('new-chat-btn');
const historyList = $('history-list');

// Telemetry DOM
const barGemini = $('bar-gemini');
const barGroq = $('bar-groq');
const barRouter = $('bar-router');
const txtGemini = $('txt-gemini');
const txtGroq = $('txt-groq');
const txtRouter = $('txt-router');
const metricRequests = $('metric-requests');
const metricFailovers = $('metric-failovers');
const eventFeed = $('event-feed');

// State
let isStreaming = false;
let attachedImages = []; // base64 strings

// ── Manejo de Sesión Aislada ─────────────────────────────────────────────────
function getSessionId() {
  let sid = localStorage.getItem('nova_session_id');
  if (!sid) {
    sid = 'sess_' + Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('nova_session_id', sid);
  }
  return sid;
}

// ── Textarea Autoexpand & Input Handling ─────────────────────────────────────
chatTextarea.addEventListener('input', () => {
  chatTextarea.style.height = 'auto';
  chatTextarea.style.height = Math.min(chatTextarea.scrollHeight, 160) + 'px';
  sendBtn.disabled = !chatTextarea.value.trim() || isStreaming;
});

chatTextarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!sendBtn.disabled) handleSend();
  }
});

sendBtn.addEventListener('click', handleSend);

// ── Manejo de Imágenes (Visión) ──────────────────────────────────────────────
attachBtn.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (attachedImages.length + files.length > 3) {
    alert("Máximo 3 imágenes por solicitud.");
    return;
  }

  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) {
      alert(`La imagen "${file.name}" supera el límite estricto de 20MB.`);
      continue;
    }
    const b64 = await toBase64(file);
    attachedImages.push(b64);
  }
  renderImagePreviews();
  fileInput.value = '';
});

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result);
    reader.onerror = error => reject(error);
  });
}

function renderImagePreviews() {
  imagePreviews.innerHTML = '';
  attachedImages.forEach((src, idx) => {
    const thumb = document.createElement('div');
    thumb.style.cssText = 'position:relative; width:44px; height:44px; border-radius:6px; overflow:hidden; border:1px solid var(--border-focus);';
    thumb.innerHTML = `
      <img src="${src}" style="width:100%; height:100%; object-fit:cover;">
      <button style="position:absolute; top:2px; right:2px; background:rgba(0,0,0,0.7); color:#fff; border:none; border-radius:50%; width:14px; height:14px; font-size:10px; cursor:pointer;" onclick="removeImage(${idx})">×</button>
    `;
    imagePreviews.appendChild(thumb);
  });
}

window.removeImage = function(idx) {
  attachedImages.splice(idx, 1);
  renderImagePreviews();
};

// ── Envío y Streaming SSE ────────────────────────────────────────────────────
async function handleSend() {
  const text = chatTextarea.value.trim();
  if (!text || isStreaming) return;

  isStreaming = true;
  sendBtn.disabled = true;
  welcomeHero.style.display = 'none';

  // 1. Renderizar mensaje de usuario
  renderUserMessage(text, attachedImages);
  chatTextarea.value = '';
  chatTextarea.style.height = 'auto';
  const sentImages = [...attachedImages];
  attachedImages = [];
  renderImagePreviews();

  // 2. Renderizar burbuja del asistente con skeleton loader inicial
  const { bubbleEl, contentEl, badgeEl, routingNoteEl } = createAssistantBubble();
  scrollToBottom();

  const sid = getSessionId();
  const selectedMode = modeSelector.value;

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: text,
        mode: selectedMode,
        session_id: sid,
        images: sentImages.length > 0 ? sentImages : null
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulatedText = "";
    let isFirstChunk = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const rawChunk = decoder.decode(value);
      const lines = rawChunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6));

            if (event.type === 'connecting') {
              badgeEl.textContent = `✦ Conectando con ${event.provider}...`;
            } else if (event.type === 'failover') {
              badgeEl.textContent = `⚠ Conmutando a ${event.to_provider}...`;
              badgeEl.className = 'routing-badge groq';
            } else if (event.type === 'chunk') {
              if (isFirstChunk) {
                contentEl.innerHTML = ''; // Remover skeleton
                isFirstChunk = false;
              }
              accumulatedText += event.text;
              contentEl.innerHTML = sanitizeMarkdown(accumulatedText);
              scrollToBottom();
            } else if (event.type === 'done') {
              const provClass = (event.provider || '').toLowerCase().includes('gemini') ? 'gemini'
                              : (event.provider || '').toLowerCase().includes('groq') ? 'groq' : 'openrouter';
              badgeEl.className = `routing-badge ${provClass}`;
              badgeEl.textContent = `✦ ${event.provider} · ${event.latency_ms}ms`;

              if (event.failover_note) {
                routingNoteEl.innerHTML = sanitizeMarkdown(event.failover_note);
              }
            } else if (event.type === 'error') {
              contentEl.innerHTML = `<span style="color:var(--status-error)">⚠️ ${event.message}</span>`;
            }
          } catch (e) {
            // Ignorar fragmentos parciales JSON
          }
        }
      }
    }

    updateHistorySidebar(text);
    fetchTelemetry();

  } catch (err) {
    contentEl.innerHTML = `<span style="color:var(--status-error)">⚠️ Error de conexión con el motor Nova. Verifica tu red.</span>`;
  }

  isStreaming = false;
  sendBtn.disabled = !chatTextarea.value.trim();
  scrollToBottom();
}

function renderUserMessage(text, images) {
  const row = document.createElement('div');
  row.className = 'message-row user';

  let imgsHtml = '';
  if (images && images.length > 0) {
    imgsHtml = '<div style="display:flex; gap:6px; margin-bottom:8px;">' +
      images.map(src => `<img src="${src}" style="width:50px; height:50px; border-radius:6px; object-fit:cover;">`).join('') +
      '</div>';
  }

  row.innerHTML = `<div class="user-bubble">${imgsHtml}${escapeHTML(text)}</div>`;
  messagesWrapper.appendChild(row);
}

function createAssistantBubble() {
  const row = document.createElement('div');
  row.className = 'message-row';

  const bubble = document.createElement('div');
  bubble.className = 'assistant-bubble';

  bubble.innerHTML = `
    <div class="proof-of-routing">
      <div class="routing-left">
        <span class="routing-badge gemini" id="current-badge">✦ Conectando...</span>
      </div>
      <span style="color:var(--text-muted); font-size:11px;">Proof of Routing</span>
    </div>
    <div class="assistant-content">
      <div class="skeleton-loader">
        <div class="skeleton-line" style="width: 85%"></div>
        <div class="skeleton-line" style="width: 65%"></div>
        <div class="skeleton-line" style="width: 45%"></div>
      </div>
    </div>
    <div class="routing-note" style="padding:0 20px 12px; font-size:12px; color:var(--text-muted);"></div>
  `;

  row.appendChild(bubble);
  messagesWrapper.appendChild(row);

  return {
    bubbleEl: bubble,
    contentEl: bubble.querySelector('.assistant-content'),
    badgeEl: bubble.querySelector('.routing-badge'),
    routingNoteEl: bubble.querySelector('.routing-note')
  };
}

function sanitizeMarkdown(text) {
  if (typeof marked !== 'undefined') {
    const raw = marked.parse(text);
    return typeof DOMPurify !== 'undefined' ? DOMPurify.sanitize(raw) : raw;
  }
  return escapeHTML(text);
}

function escapeHTML(str) {
  const p = document.createElement('p');
  p.textContent = str;
  return p.innerHTML.replace(/\n/g, '<br>');
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  });
}

// ── Tarjetas de Inicio Rápido ────────────────────────────────────────────────
document.querySelectorAll('.action-card').forEach(card => {
  card.addEventListener('click', () => {
    chatTextarea.value = card.dataset.prompt;
    chatTextarea.dispatchEvent(new Event('input'));
    handleSend();
  });
});

// ── Controles de Sidebar y Sesión ───────────────────────────────────────────
newChatBtn.addEventListener('click', () => {
  const newSid = 'sess_' + Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  localStorage.setItem('nova_session_id', newSid);
  messagesWrapper.innerHTML = '';
  messagesWrapper.appendChild(welcomeHero);
  welcomeHero.style.display = 'flex';
  if (window.innerWidth <= 768) sidebar.classList.remove('open');
});

menuToggleBtn.addEventListener('click', () => {
  sidebar.classList.toggle('open');
});

function updateHistorySidebar(text) {
  const label = text.length > 28 ? text.slice(0, 28) + '…' : text;
  const item = document.createElement('div');
  item.className = 'history-item active';
  item.textContent = label;
  historyList.prepend(item);
}

// ── Telemetría Polling ───────────────────────────────────────────────────────
async function fetchTelemetry() {
  try {
    const res = await fetch('/api/telemetry');
    if (!res.ok) return;
    const data = await res.json();

    const stats = data.stats || {};
    const total = (stats.gemini || 0) + (stats.groq || 0) + (stats.openrouter || 0) || 1;

    const pGemini = Math.round(((stats.gemini || 0) / total) * 100);
    const pGroq = Math.round(((stats.groq || 0) / total) * 100);
    const pRouter = Math.max(0, 100 - pGemini - pGroq);

    barGemini.style.width = pGemini + '%';
    barGroq.style.width = pGroq + '%';
    barRouter.style.width = pRouter + '%';

    txtGemini.textContent = `Gemini ${pGemini}%`;
    txtGroq.textContent = `Groq ${pGroq}%`;
    txtRouter.textContent = `Router ${pRouter}%`;

    metricRequests.textContent = stats.total_requests || 0;
    metricFailovers.textContent = stats.total_failovers || 0;

    // Renderizar eventos
    const events = data.recent_events || [];
    if (events.length > 0) {
      eventFeed.innerHTML = events.slice(-6).reverse().map(ev => `
        <div class="event-row ${ev.type === 'failover' ? 'failover' : ''}">
          <span style="color:var(--text-muted)">${ev.timestamp}</span> ${escapeHTML(ev.detail)}
        </div>
      `).join('');
    }
  } catch (e) {
    // Silencioso si falla
  }
}

// Iniciar polling de telemetría cada 8 segundos
fetchTelemetry();
setInterval(fetchTelemetry, 8000);
