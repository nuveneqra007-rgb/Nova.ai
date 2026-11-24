from collections import deque
from datetime import datetime, timezone
import time
from typing import Dict, Any, List

class TelemetryTracker:
    def __init__(self, max_events: int = 100):
        self.stats = {
            "gemini": 0,
            "groq": 0,
            "openrouter": 0,
            "total_requests": 0,
            "total_failovers": 0,
            "total_tokens": 0,
        }
        self.latencies = {
            "gemini": [],
            "groq": [],
            "openrouter": [],
        }
        self.event_log: deque = deque(maxlen=max_events)

    def record_request(self, provider: str, latency_ms: float, tokens: int = 0):
        prov = provider.lower()
        if prov in self.stats:
            self.stats[prov] += 1
        self.stats["total_requests"] += 1
        self.stats["total_tokens"] += tokens

        if prov in self.latencies:
            self.latencies[prov].append(latency_ms)
            if len(self.latencies[prov]) > 50:
                self.latencies[prov].pop(0)

        self.event_log.append({
            "timestamp": datetime.now(timezone.utc).strftime("%H:%M:%S"),
            "type": "success",
            "provider": provider,
            "latency_ms": round(latency_ms, 1),
            "tokens": tokens,
            "detail": f"{provider} respondió exitosamente ({round(latency_ms, 1)}ms)"
        })

    def record_failover(self, from_prov: str, to_prov: str, reason: str, latency_ms: float):
        self.stats["total_failovers"] += 1
        self.event_log.append({
            "timestamp": datetime.now(timezone.utc).strftime("%H:%M:%S"),
            "type": "failover",
            "from_provider": from_prov,
            "to_provider": to_prov,
            "reason": reason,
            "latency_ms": round(latency_ms, 1),
            "detail": f"Conmutación automática: {from_prov} [{reason}] ➔ {to_prov}"
        })

    def get_summary(self) -> Dict[str, Any]:
        avg_latencies = {}
        for prov, vals in self.latencies.items():
            avg_latencies[prov] = round(sum(vals) / len(vals), 1) if vals else 0.0

        return {
            "stats": self.stats,
            "avg_latencies_ms": avg_latencies,
            "recent_events": list(self.event_log)[-15:]
        }

telemetry = TelemetryTracker()
