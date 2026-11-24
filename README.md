# ✦ Nova AI — Multi-Provider Intelligence Platform

> **Motor de inteligencia artificial resiliente con enrutamiento dinámico en tiempo real y conmutación por error (failover) transparente.**

[![Express](https://img.shields.io/badge/Express-5.3-000000.svg?style=flat&logo=express&logoColor=white)](https://expressjs.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-3178C6.svg?style=flat&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933.svg?style=flat&logo=node.js&logoColor=white)](https://nodejs.org)
[![Vercel](https://img.shields.io/badge/Deploy-Vercel%20Serverless-000000.svg?style=flat&logo=vercel&logoColor=white)](https://vercel.com)
[![Supabase](https://img.shields.io/badge/Persistencia-Supabase%20(opcional)-3ECF8E.svg?style=flat&logo=supabase&logoColor=white)](https://supabase.com)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 🎯 Visión General

A diferencia de los wrappers convencionales de IA atados a un único proveedor o modelo, **Nova AI v2** implementa una arquitectura distribuida de **enrutamiento inteligente multi-proveedor**.

El sistema monitorea la disponibilidad de los canales en tiempo real y ejecuta **conmutaciones automáticas (*failover*) sin interrumpir la experiencia de usuario** en caso de límites de cuota (HTTP 429), fallos de servicio (5xx) o degradación de latencia.

```
                  ┌───────────────────────────────┐
                  │      Entrada del Usuario      │
                  └──────────────┬────────────────┘
                                 │
                  ┌──────────────▼────────────────┐
                  │   Motor de Enrutamiento Nova  │
                  └──────────────┬────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │ (Canal Principal)     │ (Canal Auxiliar)      │ (Línea de Defensa)
         ▼                       ▼                       ▼
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ Google AI Studio │ ─⚡─►│  Groq Inference  │ ─⚡─►│    OpenRouter    │
│  (Gemini 3/2.5)  │    │ (GPT-OSS / Qwen) │    │  (Free / Auto)   │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

---

## ⚡ Política de Enrutamiento y Resiliencia

### Canal Principal — Google AI Studio (Razonamiento complejo)
Cadena de modelos con cascada automática:
1. `gemini-3-flash-preview` — modelo Flash de nueva generación
2. `gemini-2.5-flash` / `gemini-2.5-flash-lite` — estables y confiables
3. `gemini-2.5-pro` — máximo razonamiento (cuotas más estrictas)
4. `gemini-2.0-flash` / `gemini-1.5-flash` / `gemini-1.5-pro` — respaldo

> Se utiliza la API REST v1beta directamente con streaming SSE (`alt=sse`), sin depender del SDK oficial de Google, para garantizar compatibilidad con modelos recientes.

### Canal Auxiliar — Groq (Diálogo rápido, ultra-baja latencia)
- **Texto:** `openai/gpt-oss-120b` → `llama-3.1-8b-instant` → `llama-3.3-70b-versatile`
- **Visión:** `qwen/qwen3.8-27b` → `llama-3.2-11b-vision-preview` → `llama-3.2-90b-vision-preview`

### Línea de Defensa — OpenRouter (Código y respaldo)
- **Descubrimiento dinámico** de modelos gratuitos mediante `/api/v1/models` con caché de 15 minutos.
- Fallback a `openrouter/free` y `openrouter/auto` si no se encuentran modelos específicos.

---

## 🛠️ Stack Tecnológico

| Capa | Tecnología |
|---|---|
| **Runtime** | Node.js 22+ con ESM nativo |
| **Backend** | Express 5.3 (TypeScript 7) con streaming SSE |
| **Lenguaje** | TypeScript estricto (`tsc --noEmit`) |
| **Frontend** | Vanilla HTML5, CSS3 moderno (tema OLED oscuro), JavaScript ES2022 sin frameworks |
| **IA — Gemini** | API REST directa a `v1beta` con SSE (sin SDK) |
| **IA — Groq** | SDK oficial `groq-sdk` v1.6 |
| **IA — OpenRouter** | API REST con descubrimiento dinámico de modelos |
| **Persistencia** | Supabase (PostgreSQL) vía REST — opcional, con fallback a memoria |
| **Despliegue** | Vercel Serverless (`api/index.ts` como entry point) |
| **Tipografía** | Plus Jakarta Sans + JetBrains Mono (Google Fonts) |

---

## ✨ Características

- **Interfaz minimalista** con bienvenida animada (*typewriter effect*) y vista completamente limpia sin distracciones.
- **Chat multi-sesión aislado por usuario** — cada visitante obtiene su propio historial con ID persistente en `localStorage`.
- **Eliminación permanente de chats** — sistema de *tombstones* en cliente que impide la reaparición de conversaciones eliminadas, incluso entre instancias serverless.
- **Soporte multimodal** — adjunta hasta 3 imágenes por mensaje con análisis visual automático.
- **Selector de modo de enrutamiento** — `Auto Router`, `Razonamiento`, `Velocidad` o `Código`.
- **Panel de telemetría en tiempo real** — distribución de uso por proveedor, latencias promedio, registro de conmutaciones y estado de cada canal.
- **Búsqueda en vivo** del historial de sesiones.
- **Responsivo** — diseño adaptativo para escritorio y móvil.

---

## 🚀 Instalación y Despliegue Local

### 1. Clonar el repositorio
```bash
git clone https://github.com/nuveneqra007-rgb/Nova.ai.git
cd Nova.ai
```

### 2. Configurar variables de entorno
```bash
cp .env.example .env
# Edita .env con tus claves:
#   GEMINI_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY
#   SUPABASE_URL, SUPABASE_KEY (opcional)
```

### 3. Instalar dependencias
```bash
npm install
```

### 4. Ejecutar servidor de desarrollo
```bash
npm run dev
```
Abre tu navegador en `http://localhost:3000`.

### 5. Build de producción
```bash
npm run build
```

---

## 📁 Estructura del Proyecto

```
Nova.ai/
├── api/
│   └── index.ts           # Entry point serverless (Vercel)
├── frontend/
│   ├── css/styles.css      # Sistema de diseño Obsidian Precision
│   ├── js/app.js           # Controlador del cliente (~950 líneas)
│   ├── index.html          # HTML principal
│   ├── favicon.svg         # Ícono vectorial Nova AI
│   └── favicon.png         # Ícono rasterizado
├── src/
│   ├── router.ts           # Motor multi-proveedor (Gemini REST, Groq SDK, OpenRouter)
│   ├── memory.ts           # Almacenamiento de sesiones con aislamiento por usuario
│   └── telemetry.ts        # Rastreador de métricas
├── server.ts               # Servidor Express con API router
├── vercel.json             # Configuración de despliegue
├── tsconfig.json
└── package.json
```

---

## 📊 Telemetría y «Proof of Routing»

Cada mensaje generado por Nova incluye un meta-badge transparente para auditoría técnica:
* Proveedor activo en la respuesta (`Gemini`, `Groq`, `OpenRouter`).
* Latencia calculada de extremo a extremo (ms).
* Nota de conmutación si ocurrió un failover en segundo plano:
  > *↳ Conmutado automáticamente a Groq por límite de cuota (429) en Google AI Studio.*

---

## 🔐 Seguridad

- API keys exclusivamente en el servidor (variables de entorno), nunca en el cliente.
- Validación y sanitización de todo input del usuario.
- Headers de seguridad configurados en `vercel.json` (`X-Content-Type-Options`, `X-Frame-Options`).
- CORS configurado con whitelist.
- Límite de payload de 64 MB en Express.

---

## 👨‍💻 Autor

Desarrollado por **Alexander López** ([@nuveneqra007-rgb](https://github.com/nuveneqra007-rgb))
*Full-Stack Developer & Cyber Security Enthusiast · República Dominicana* 🇩🇴
