import { readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { SpanStatusCode, type Span } from "@opentelemetry/api";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

export interface QueueSnapshot {
  queued?: number;
  running?: number;
  waitingApproval?: number;
  blocked?: number;
  failed?: number;
  needsReconciliation?: number;
  oldestPendingAgeMs?: number | null;
}

export interface DiagnosticsOptions {
  dataDir: string;
  version: string;
  staleAfterMs?: number;
  minimumFreeBytes?: number;
  backupMaxAgeMs?: number;
  clock?: () => number;
  writeLog?: (line: string) => void;
}

const logFields = new Set([
  "tenantId",
  "runId",
  "stepId",
  "operationKey",
  "requestId",
  "toolId",
  "durationMs",
  "status",
  "statusCode",
  "code",
  "method",
  "route",
  "count",
]);
const secretPattern =
  /bearer|password|secret|api[-_]?key|token=|sk-[a-z0-9]|-----BEGIN/i;

/** Only machine identifiers and numeric measurements may enter operational logs. */
export function redactLogFields(
  fields: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!logFields.has(key)) continue;
    if (typeof value === "number" && Number.isFinite(value))
      result[key] = value;
    else if (typeof value === "boolean") result[key] = value;
    else if (typeof value === "string")
      result[key] =
        value.length <= 160 &&
        /^[a-zA-Z0-9_./:{}*-]+$/.test(value) &&
        !secretPattern.test(value)
          ? value
          : "[redacted]";
  }
  return result;
}

class LocalMetricReader extends MetricReader {
  protected async onForceFlush() {}
  protected async onShutdown() {}
}

/** Explicit local providers: no globals, auto-instrumentation or outbound exporter. */
export class Diagnostics {
  private readonly clock: () => number;
  private readonly createdAt: number;
  private readonly staleAfterMs: number;
  private readonly exporter = new InMemorySpanExporter();
  private readonly traceProvider = new BasicTracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [new SimpleSpanProcessor(this.exporter)],
  });
  private readonly metricReader = new LocalMetricReader({
    cardinalitySelector: () => 64,
  });
  private readonly meterProvider = new MeterProvider({
    readers: [this.metricReader],
  });
  private readonly tracer = this.traceProvider.getTracer("jarvis.worker");
  private readonly meter = this.meterProvider.getMeter("jarvis.local");
  private readonly tickCounter = this.meter.createCounter(
    "jarvis.worker.ticks",
  );
  private readonly tickDuration = this.meter.createHistogram(
    "jarvis.worker.duration",
    { unit: "ms" },
  );
  private readonly requestCounter = this.meter.createCounter(
    "jarvis.http.requests",
  );
  private readonly requestDuration = this.meter.createHistogram(
    "jarvis.http.duration",
    { unit: "ms" },
  );
  private currentSpan: Span | undefined;
  private tickStartedAt: number | null = null;
  private tickCompletedAt: number | null = null;
  private lastDurationMs: number | null = null;
  private consecutiveFailures = 0;
  private lastErrorCode: string | null = null;
  private maintenance = false;
  private closed = false;
  private queue: QueueSnapshot = {};
  private readonly counters = {
    workerTicks: 0,
    workerErrors: 0,
    requests: 0,
    requestErrors: 0,
  };

  constructor(private readonly options: DiagnosticsOptions) {
    this.clock = options.clock ?? Date.now;
    this.createdAt = this.clock();
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
  }

  workerTickStarted(): void {
    if (this.currentSpan || this.closed) return;
    this.tickStartedAt = this.clock();
    if (this.exporter.getFinishedSpans().length >= 128) this.exporter.reset();
    this.currentSpan = this.tracer.startSpan("worker.tick");
  }

  workerTickCompleted(
    result: { queue?: QueueSnapshot; errorCode?: string } = {},
  ): void {
    if (!this.currentSpan || this.tickStartedAt === null || this.closed) return;
    this.tickCompletedAt = this.clock();
    this.lastDurationMs = Math.max(
      0,
      this.tickCompletedAt - this.tickStartedAt,
    );
    this.counters.workerTicks++;
    const failed = Boolean(result.errorCode);
    if (failed) this.counters.workerErrors++;
    this.consecutiveFailures = failed ? this.consecutiveFailures + 1 : 0;
    this.lastErrorCode = failed
      ? String(
          redactLogFields({ code: result.errorCode }).code ?? "worker_error",
        )
      : null;
    if (result.queue) this.queue = this.cleanQueue(result.queue);
    this.tickCounter.add(1, { outcome: failed ? "error" : "ok" });
    this.tickDuration.record(this.lastDurationMs);
    this.currentSpan?.setStatus({
      code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    this.currentSpan?.end();
    this.currentSpan = undefined;
    if (failed)
      this.log("error", "worker.tick.failed", {
        code: this.lastErrorCode,
        durationMs: this.lastDurationMs,
      });
  }

  setMaintenance(value: boolean): void {
    this.maintenance = value;
  }

  recordRequest(input: {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
    requestId?: string;
  }): void {
    this.counters.requests++;
    if (input.statusCode >= 500) this.counters.requestErrors++;
    const method = [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "HEAD",
      "OPTIONS",
    ].includes(input.method)
      ? input.method
      : "OTHER";
    // No dynamic path, tenant, run or request IDs in metric labels.
    const status = `${Math.floor(input.statusCode / 100)}xx`;
    this.requestCounter.add(1, { method, status });
    this.requestDuration.record(Math.max(0, input.durationMs), { method });
    this.log(input.statusCode >= 500 ? "error" : "info", "http.request", input);
  }

  log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown> = {},
  ): void {
    const safeEvent = /^[a-z0-9_.-]{1,80}$/.test(event)
      ? event
      : "invalid_event";
    const context = this.currentSpan?.spanContext();
    const line = JSON.stringify({
      time: new Date(this.clock()).toISOString(),
      level,
      event: safeEvent,
      ...redactLogFields(fields),
      ...(context ? { traceId: context.traceId, spanId: context.spanId } : {}),
    });
    (this.options.writeLog ?? ((entry) => process.stdout.write(`${entry}\n`)))(
      line,
    );
  }

  snapshot(input: { databaseHealthy: boolean; queue?: QueueSnapshot }) {
    if (input.queue) this.queue = this.cleanQueue(input.queue);
    const now = this.clock();
    const ageMs =
      this.tickCompletedAt === null
        ? null
        : Math.max(0, now - this.tickCompletedAt);
    const inProgress = Boolean(this.currentSpan);
    const tickAgeMs =
      inProgress && this.tickStartedAt !== null
        ? Math.max(0, now - this.tickStartedAt)
        : null;
    const state = this.closed
      ? "stopped"
      : this.tickCompletedAt === null &&
          (tickAgeMs ?? now - this.createdAt) <= this.staleAfterMs
        ? "starting"
        : ageMs === null ||
            ageMs > this.staleAfterMs ||
            (tickAgeMs ?? 0) > this.staleAfterMs
          ? "stale"
          : this.consecutiveFailures > 0
            ? "error"
            : "healthy";
    let disk: {
      status: string;
      freeBytes: number | null;
      minimumFreeBytes: number;
    };
    const minimumFreeBytes = this.options.minimumFreeBytes ?? 64 * 1024 * 1024;
    try {
      const stats = statfsSync(this.options.dataDir);
      const freeBytes = stats.bavail * stats.bsize;
      disk = {
        status: freeBytes >= minimumFreeBytes ? "healthy" : "low",
        freeBytes,
        minimumFreeBytes,
      };
    } catch {
      disk = { status: "unavailable", freeBytes: null, minimumFreeBytes };
    }
    const backup = this.backupStatus(now);
    const reasons = [
      ...(this.closed ? ["process_stopped"] : []),
      ...(this.maintenance ? ["maintenance"] : []),
      ...(!input.databaseHealthy ? ["database_unhealthy"] : []),
      ...(state !== "healthy" ? [`worker_${state}`] : []),
      ...(disk.status !== "healthy" ? [`disk_${disk.status}`] : []),
    ];
    return {
      live: !this.closed,
      ready: reasons.length === 0,
      reasons,
      version: this.options.version,
      uptimeMs: Math.max(0, now - this.createdAt),
      maintenance: this.maintenance,
      database: { healthy: input.databaseHealthy },
      worker: {
        state,
        inProgress,
        lastStartedAt: this.iso(this.tickStartedAt),
        lastCompletedAt: this.iso(this.tickCompletedAt),
        ageMs,
        tickAgeMs,
        staleAfterMs: this.staleAfterMs,
        lastDurationMs: this.lastDurationMs,
        consecutiveFailures: this.consecutiveFailures,
        lastErrorCode: this.lastErrorCode,
      },
      queue: { ...this.queue },
      disk,
      backup,
      telemetry: {
        mode: "local",
        outboundExportEnabled: false,
        retainedTraces: this.exporter.getFinishedSpans().length,
        counters: { ...this.counters },
      },
    };
  }

  async localMetrics() {
    return this.metricReader.collect();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.currentSpan?.end();
    this.currentSpan = undefined;
    await Promise.all([
      this.traceProvider.shutdown(),
      this.meterProvider.shutdown(),
    ]);
  }

  private iso(value: number | null) {
    return value === null ? null : new Date(value).toISOString();
  }

  private cleanQueue(queue: QueueSnapshot): QueueSnapshot {
    const result: QueueSnapshot = {};
    for (const key of [
      "queued",
      "running",
      "waitingApproval",
      "blocked",
      "failed",
      "needsReconciliation",
      "oldestPendingAgeMs",
    ] as const) {
      const value = queue[key];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        result[key] = value;
    }
    return result;
  }

  private backupStatus(now: number) {
    const maxAgeMs = this.options.backupMaxAgeMs ?? 24 * 60 * 60 * 1000;
    try {
      const data = JSON.parse(
        readFileSync(join(this.options.dataDir, "backup-status.json"), "utf8"),
      ) as Record<string, unknown>;
      const timestamp =
        typeof data.createdAt === "string" ? Date.parse(data.createdAt) : NaN;
      if (
        !Number.isFinite(timestamp) ||
        data.status !== "verified" ||
        typeof data.manifestHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(data.manifestHash)
      )
        return { status: "invalid", createdAt: null, ageMs: null, maxAgeMs };
      const ageMs = Math.max(0, now - timestamp);
      return {
        status: ageMs <= maxAgeMs ? "verified" : "stale",
        createdAt: data.createdAt,
        ageMs,
        maxAgeMs,
        manifestHash: data.manifestHash,
      };
    } catch (error) {
      return {
        status:
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "missing"
            : "invalid",
        createdAt: null,
        ageMs: null,
        maxAgeMs,
      };
    }
  }
}
