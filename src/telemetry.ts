export type TelemetryEventType = 'success' | 'failover';

export interface TelemetryEvent {
  timestamp: string;
  type: TelemetryEventType;
  provider?: string;
  from_provider?: string;
  to_provider?: string;
  reason?: string;
  latency_ms: number;
  tokens?: number;
  detail: string;
}

export interface TelemetryStats {
  gemini: number;
  groq: number;
  openrouter: number;
  total_requests: number;
  total_failovers: number;
  total_tokens: number;
}

export interface TelemetrySummary {
  stats: TelemetryStats;
  avg_latencies_ms: {
    gemini: number;
    groq: number;
    openrouter: number;
  };
  recent_events: TelemetryEvent[];
}

type ProviderBucket = 'gemini' | 'groq' | 'openrouter';

function normalizeProvider(provider: string): ProviderBucket | null {
  const p = provider.toLowerCase();
  if (p.includes('gemini') || p.includes('google')) return 'gemini';
  if (p.includes('groq')) return 'groq';
  if (p.includes('openrouter')) return 'openrouter';
  return null;
}

function formatUtcTime(): string {
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, '0');
  const mm = String(now.getUTCMinutes()).padStart(2, '0');
  const ss = String(now.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export class TelemetryTracker {
  private maxEvents: number;
  private stats: TelemetryStats;
  private latencies: Record<ProviderBucket, number[]>;
  private eventLog: TelemetryEvent[];

  constructor(maxEvents = 100) {
    this.maxEvents = maxEvents;
    this.stats = {
      gemini: 0,
      groq: 0,
      openrouter: 0,
      total_requests: 0,
      total_failovers: 0,
      total_tokens: 0,
    };
    this.latencies = {
      gemini: [],
      groq: [],
      openrouter: [],
    };
    this.eventLog = [];
  }

  private pushEvent(event: TelemetryEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > this.maxEvents) {
      this.eventLog.shift();
    }
  }

  recordRequest(provider: string, latencyMs: number, tokens = 0): void {
    const bucket = normalizeProvider(provider);
    if (bucket) {
      this.stats[bucket] += 1;
      this.latencies[bucket].push(latencyMs);
      if (this.latencies[bucket].length > 50) {
        this.latencies[bucket].shift();
      }
    }
    this.stats.total_requests += 1;
    this.stats.total_tokens += tokens;

    const roundedLatency = Math.round(latencyMs * 10) / 10;
    this.pushEvent({
      timestamp: formatUtcTime(),
      type: 'success',
      provider,
      latency_ms: roundedLatency,
      tokens,
      detail: `${provider} respondió exitosamente (${roundedLatency}ms)`,
    });
  }

  recordFailover(fromProv: string, toProv: string, reason: string, latencyMs: number): void {
    this.stats.total_failovers += 1;
    const roundedLatency = Math.round(latencyMs * 10) / 10;
    this.pushEvent({
      timestamp: formatUtcTime(),
      type: 'failover',
      from_provider: fromProv,
      to_provider: toProv,
      reason,
      latency_ms: roundedLatency,
      detail: `Conmutación automática: ${fromProv} [${reason}] ➔ ${toProv}`,
    });
  }

  getSummary(): TelemetrySummary {
    const avg = (vals: number[]): number =>
      vals.length > 0
        ? Math.round((vals.reduce((acc, v) => acc + v, 0) / vals.length) * 10) / 10
        : 0.0;

    return {
      stats: { ...this.stats },
      avg_latencies_ms: {
        gemini: avg(this.latencies.gemini),
        groq: avg(this.latencies.groq),
        openrouter: avg(this.latencies.openrouter),
      },
      recent_events: this.eventLog.slice(-15),
    };
  }
}

export const telemetry = new TelemetryTracker();
