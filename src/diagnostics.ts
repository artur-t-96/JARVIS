import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statfsSync } from "node:fs";
import { join } from "node:path";
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Span,
  type SpanContext,
  type Tracer,
  type Meter,
  type Counter,
  type Histogram,
} from "@opentelemetry/api";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { resourceFromAttributes } from "@opentelemetry/resources";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import {
  LocalTraceExporter,
  telemetryPorts,
  type TelemetryMode,
} from "./observability/telemetry.js";

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
  telemetryMode?: TelemetryMode;
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
  "attempt",
  "usageId",
  "provider",
  "model",
  "inputTokens",
  "outputTokens",
  "estimatedCost",
  "pricingVersion",
  "currency",
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

/** Explicit providers; exporting requires a selected, fixed loopback environment. */
export class Diagnostics {
  private readonly clock: () => number;
  private readonly createdAt: number;
  private readonly staleAfterMs: number;
  private readonly exporter = new InMemorySpanExporter();
  private readonly traceProvider: BasicTracerProvider;
  private readonly metricReader = new LocalMetricReader({
    cardinalitySelector: () => 64,
  });
  private readonly meterProvider: MeterProvider;
  private readonly tracer: Tracer;
  private readonly meter: Meter;
  private readonly tickCounter: Counter;
  private readonly tickDuration: Histogram;
  private readonly requestCounter: Counter;
  private readonly requestDuration: Histogram;
  private readonly modelCounter: Counter;
  private readonly modelDuration: Histogram;
  private readonly modelTokens: Counter;
  private readonly modelCost: Counter;
  private readonly executionEvents: Counter;
  private readonly networkExporter?: LocalTraceExporter;
  private readonly prometheus?: PrometheusExporter;
  private metricsState: "disabled" | "starting" | "ready" | "unavailable" =
    "disabled";
  private readonly requestSpans = new WeakMap<object, Span>();
  private readonly spanContext = new AsyncLocalStorage<Span>();
  private readonly activeSpans = new Set<Span>();
  private evictedActiveTraces = 0;
  private workerSpan: Span | undefined;
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
    const resource = resourceFromAttributes({
      "service.name": "jarvis",
      "service.version": options.version,
      "deployment.environment.name": options.telemetryMode ?? "local",
    });
    if (options.telemetryMode) {
      this.networkExporter = new LocalTraceExporter(options.telemetryMode);
      this.prometheus = new PrometheusExporter({
        host: "127.0.0.1",
        port: telemetryPorts(options.telemetryMode).metrics,
        endpoint: "/metrics",
        preventServerStart: true,
        withoutScopeInfo: true,
        withResourceConstantLabels: /^deployment\.environment\.name$/,
      });
      this.metricsState = "starting";
    }
    this.traceProvider = new BasicTracerProvider({
      resource,
      sampler: new AlwaysOnSampler(),
      spanProcessors: [
        new SimpleSpanProcessor(this.exporter),
        ...(this.networkExporter
          ? [
              new BatchSpanProcessor(this.networkExporter, {
                maxQueueSize: 256,
                maxExportBatchSize: 64,
                scheduledDelayMillis: 500,
                exportTimeoutMillis: 1000,
              }),
            ]
          : []),
      ],
    });
    this.meterProvider = new MeterProvider({
      resource,
      views: [{ instrumentName: "jarvis.*", aggregationCardinalityLimit: 64 }],
      readers: [
        this.metricReader,
        ...(this.prometheus ? [this.prometheus] : []),
      ],
    });
    this.tracer = this.traceProvider.getTracer("jarvis.operations", "1");
    this.meter = this.meterProvider.getMeter("jarvis.local", "1");
    this.tickCounter = this.meter.createCounter("jarvis.worker.ticks");
    this.tickDuration = this.meter.createHistogram("jarvis.worker.duration", {
      unit: "ms",
    });
    this.requestCounter = this.meter.createCounter("jarvis.http.requests");
    this.requestDuration = this.meter.createHistogram("jarvis.http.duration", {
      unit: "ms",
    });
    this.executionEvents = this.meter.createCounter("jarvis.execution.events");
    this.modelCounter = this.meter.createCounter("jarvis.model.calls");
    this.modelDuration = this.meter.createHistogram("jarvis.model.duration", {
      unit: "ms",
    });
    this.modelTokens = this.meter.createCounter("jarvis.model.tokens");
    this.modelCost = this.meter.createCounter("jarvis.model.estimated_cost");
    this.meter
      .createObservableGauge("jarvis.queue.jobs")
      .addCallback((result) => {
        for (const [state, value] of Object.entries(this.queue))
          if (state !== "oldestPendingAgeMs" && typeof value === "number")
            result.observe(value, { state });
      });
    this.meter
      .createObservableGauge("jarvis.worker.age", { unit: "s" })
      .addCallback((result) => {
        if (this.tickCompletedAt !== null)
          result.observe(
            Math.max(0, this.clock() - this.tickCompletedAt) / 1000,
          );
      });
    this.meter
      .createObservableGauge("jarvis.worker.healthy")
      .addCallback((result) => {
        result.observe(
          !this.closed &&
            this.tickCompletedAt !== null &&
            this.clock() - this.tickCompletedAt <= this.staleAfterMs &&
            !this.consecutiveFailures
            ? 1
            : 0,
        );
      });
  }

  async start(): Promise<void> {
    if (!this.prometheus || this.closed) return;
    try {
      await this.prometheus.startServer();
      this.metricsState = "ready";
    } catch {
      this.metricsState = "unavailable";
      this.log("warn", "telemetry.metrics.unavailable");
    }
  }
  async flush(): Promise<void> {
    // Export failures are counted by the exporter; a local monitoring outage is not a business failure.
    await Promise.allSettled([this.traceProvider.forceFlush()]);
  }

  currentContext(): SpanContext | undefined {
    const span = this.spanContext.getStore();
    return span?.isRecording() ? span.spanContext() : undefined;
  }
  startRequest(request: object, next: () => void): void {
    if (this.closed) {
      next();
      return;
    }
    const span = this.startSpan("http.request");
    this.requestSpans.set(request, span);
    this.spanContext.run(span, next);
  }
  finishRequest(
    request: object,
    input: Parameters<Diagnostics["recordRequest"]>[0],
  ): void {
    const span = this.requestSpans.get(request);
    if (!span) return;
    try {
      span.setAttributes(redactLogFields(input));
      span.setStatus({
        code:
          input.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
      });
      this.spanContext.run(span, () => this.recordRequest(input));
    } finally {
      this.requestSpans.delete(request);
      this.endSpan(span);
    }
  }
  recordExecution(event: string, fields: Record<string, unknown>) {
    if (
      [
        "run_completed",
        "verification_failed",
        "step_blocked",
        "outcome_unknown",
        "approval_requested",
        "approval_rejected",
        "step_verified",
      ].includes(event)
    )
      this.executionEvents.add(1, { event });
    this.spanContext.getStore()?.addEvent(event, redactLogFields(fields));
    this.log("info", `execution.${event}`, fields);
  }
  recordModel(input: {
    provider: string;
    model: string;
    usageId: string;
    status: "completed" | "failed";
    durationMs: number;
    inputTokens?: number;
    outputTokens?: number;
    estimatedCost?: number | null;
    currency?: string;
    pricingVersion?: string;
  }) {
    const safe = redactLogFields(input);
    const labels = {
      provider: String(safe.provider ?? "unknown"),
      model: String(safe.model ?? "unknown"),
      status: input.status,
    };
    this.modelCounter.add(1, labels);
    this.modelDuration.record(Math.max(0, input.durationMs), labels);
    if (Number.isFinite(input.inputTokens))
      this.modelTokens.add(Math.max(0, input.inputTokens!), {
        ...labels,
        direction: "input",
      });
    if (Number.isFinite(input.outputTokens))
      this.modelTokens.add(Math.max(0, input.outputTokens!), {
        ...labels,
        direction: "output",
      });
    if (
      typeof input.estimatedCost === "number" &&
      Number.isFinite(input.estimatedCost) &&
      input.estimatedCost >= 0 &&
      safe.currency &&
      safe.pricingVersion
    )
      this.modelCost.add(input.estimatedCost, {
        ...labels,
        currency: String(safe.currency),
        pricingVersion: String(safe.pricingVersion),
      });
    this.spanContext.getStore()?.setAttributes(safe);
    this.log(input.status === "failed" ? "warn" : "info", "model.call", safe);
  }

  workerTickStarted(): void {
    if (this.workerSpan || this.closed) return;
    this.tickStartedAt = this.clock();
    this.workerSpan = this.startSpan("worker.tick");
  }

  /** Scope correlation to this operation and its awaited work, never to other requests. */
  async withSpan<T>(
    name: string,
    operation: () => T | Promise<T>,
    fields: Record<string, unknown> = {},
    link?: SpanContext,
  ): Promise<T> {
    if (this.closed) throw new Error("Diagnostics is closed");
    const span = this.startSpan(name, fields, link);
    return this.spanContext.run(span, async () => {
      try {
        const result = await operation();
        if (span.isRecording()) span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        if (span.isRecording()) span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        this.endSpan(span);
      }
    });
  }

  async withWorkerTick<T>(
    operation: () => T | Promise<T>,
    queueSnapshot?: () => QueueSnapshot,
  ): Promise<T> {
    if (this.closed) throw new Error("Diagnostics is closed");
    if (this.workerSpan) throw new Error("Worker tick is already running");
    this.workerTickStarted();
    const span = this.workerSpan!;
    return this.spanContext.run(span, async () => {
      try {
        const result = await operation();
        this.workerTickCompleted({ queue: queueSnapshot?.() });
        return result;
      } catch (error) {
        this.workerTickCompleted({ errorCode: "worker_tick_failed" });
        throw error;
      } finally {
        this.endSpan(span);
        if (this.workerSpan === span) this.workerSpan = undefined;
      }
    });
  }

  workerTickCompleted(
    result: { queue?: QueueSnapshot; errorCode?: string } = {},
  ): void {
    const span = this.workerSpan;
    if (!span || this.tickStartedAt === null || this.closed) return;
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
    span.setStatus({
      code: failed ? SpanStatusCode.ERROR : SpanStatusCode.OK,
    });
    try {
      if (failed)
        this.spanContext.run(span, () =>
          this.log("error", "worker.tick.failed", {
            code: this.lastErrorCode,
            durationMs: this.lastDurationMs,
          }),
        );
    } finally {
      this.endSpan(span);
      this.workerSpan = undefined;
    }
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
    const span = this.spanContext.getStore();
    const context = span?.isRecording() ? span.spanContext() : undefined;
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
    const responseQueue = input.queue
      ? this.cleanQueue(input.queue)
      : this.queue;
    const now = this.clock();
    const ageMs =
      this.tickCompletedAt === null
        ? null
        : Math.max(0, now - this.tickCompletedAt);
    const inProgress = Boolean(this.workerSpan);
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
      queue: { ...responseQueue },
      disk,
      backup,
      telemetry: {
        mode: this.options.telemetryMode ? "local-oss" : "local",
        outboundExportEnabled: Boolean(this.networkExporter),
        externalExportEnabled: false,
        metricsState: this.metricsState,
        grafanaUrl: this.options.telemetryMode
          ? `http://127.0.0.1:${telemetryPorts(this.options.telemetryMode).grafana}`
          : null,
        exporter: this.networkExporter
          ? { ...this.networkExporter.state }
          : null,
        retainedTraces: this.exporter.getFinishedSpans().length,
        activeTraces: this.activeSpans.size,
        evictedActiveTraces: this.evictedActiveTraces,
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
    for (const span of this.activeSpans) this.endSpan(span);
    this.workerSpan = undefined;
    this.spanContext.disable();
    await Promise.allSettled([
      this.traceProvider.shutdown(),
      this.meterProvider.shutdown(),
    ]);
  }

  private startSpan(
    name: string,
    fields: Record<string, unknown> = {},
    link?: SpanContext,
  ): Span {
    // Bound diagnostic retention even if a future operation never settles.
    if (this.activeSpans.size >= 256) {
      const oldest = this.activeSpans.values().next().value!;
      oldest.setStatus({ code: SpanStatusCode.ERROR });
      this.endSpan(oldest);
      this.evictedActiveTraces++;
    }
    const parent = this.spanContext.getStore();
    const context = parent?.isRecording()
      ? trace.setSpan(ROOT_CONTEXT, parent)
      : ROOT_CONTEXT;
    const span = this.tracer.startSpan(
      /^[a-z0-9_.-]{1,80}$/.test(name) ? name : "invalid_operation",
      {
        attributes: redactLogFields(fields),
        ...(link ? { links: [{ context: link }] } : {}),
      },
      context,
    );
    this.activeSpans.add(span);
    return span;
  }

  private endSpan(span: Span): void {
    if (!this.activeSpans.delete(span)) return;
    if (this.exporter.getFinishedSpans().length >= 128) this.exporter.reset();
    span.end();
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
