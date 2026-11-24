# ✦ Nova AI — Multi-Provider Intelligence Platform

> **Motor de inteligencia artificial resiliente con enrutamiento dinámico en tiempo real y conmutación por error (failover) transparente.**

[![FastAPI](https://img.shields.io/badge/FastAPI-0.110+-009688.svg?style=flat&logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB.svg?style=flat&logo=python&logoColor=white)](https://www.python.org)
[![Vercel](https://img.shields.io/badge/Deploy-Vercel%20Serverless-000000.svg?style=flat&logo=vercel&logoColor=white)](https://vercel.com)
[![Supabase](https://img.shields.io/badge/Database-PostgreSQL%2015-3ECF8E.svg?style=flat&logo=supabase&logoColor=white)](https://supabase.com)
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
│  (Gemini Flash)  │    │ (Llama 3/Vision) │    │  (Code / Free)   │
└──────────────────┘    └──────────────────┘    └──────────────────┘
```

---

## ⚡ Política de Enrutamiento y Resiliencia

1. **Canal Principal (Razonamiento y Contexto Extenso):**
   * **Google AI Studio (Gemini 1.5 Flash):** Diseñado para análisis complejo, síntesis conceptual y redacción estructurada.
2. **Canal Auxiliar (Ultra-Baja Latencia y Diálogo Rápido):**
   * **Groq LPU (`llama-3.3-70b-versatile`):** Respuestas instantáneas en menos de 150ms.
3. **Canal Especializado en Visión (Multimodal):**
   * **Groq Vision (`llama-3.2-11b-vision-preview`):** Procesamiento de hasta 3 imágenes simultáneas (límite de 20MB) con respaldo en OpenRouter Vision.
4. **Línea de Defensa y Generación de Código:**
   * **OpenRouter (`qwen-2.5-coder` / `openrouter/free`):** Modelos especializados en desarrollo de software con bloques de prueba ejecutables obligatorios (`// CÓMO PROBARLO`).

---

## 🛠️ Stack Tecnológico

* **Backend:** FastAPI (Python 3.12) asíncrono con streaming SSE (*Server-Sent Events*).
* **Persistencia:** PostgreSQL en Supabase con particionamiento por sesión (`session_id`) y auditoría de telemetría.
* **Frontend:** Vanilla HTML5, CSS3 moderno (OLED Deep Space, contraste WCAG 2.1 AA) y JavaScript modular sin sobrecarga de dependencias.
* **Seguridad & Sanitización:** Validación estricta Pydantic v2, mitigación XSS con DOMPurify, SRI Hashes en CDNs y políticas CSP estrictas.
* **Despliegue:** Arquitectura Serverless unificada en Vercel (`@vercel/python` + `@vercel/static`).

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
# Edita .env con tus claves de Google AI Studio, Groq, OpenRouter y Supabase
```

### 3. Instalar dependencias
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### 4. Ejecutar servidor de desarrollo
```bash
uvicorn main:app --reload --port 8000
```
Abre tu navegador en `http://localhost:8000`.

---

## 📊 Telemetría y "Proof of Routing"

Cada mensaje generado por Nova incluye un meta-badge transparente para auditoría técnica:
* Proveedor activo en la respuesta (`Gemini`, `Groq`, `OpenRouter`).
* Latencia calculada de extremo a extremo (ms).
* Nota de conmutación si ocurrió un failover en segundo plano:
  > *↳ Conmutado automáticamente a Groq por límite de cuota (429) en Google AI Studio.*

---

## 👨‍💻 Autor

Desarrollado por **Alexander López** ([@nuveneqra007-rgb](https://github.com/nuveneqra007-rgb))  
*Full-Stack Developer & Cyber Security Enthusiast · República Dominicana* 🇩🇴
