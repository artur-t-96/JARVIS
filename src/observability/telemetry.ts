import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { ExportResult } from "@opentelemetry/core";

export type TelemetryMode = "lab" | "operational";
export function telemetryPorts(mode: TelemetryMode) {
  if (mode !== "lab" && mode !== "operational")
    throw new Error("Invalid JARVIS observability mode.");
  const base = mode === "lab" ? 15300 : 15400;
  return { collector: base + 7, metrics: base + 13, grafana: base };
}

/** Explicit loopback destination; never discover a remote exporter from ambient OTel settings. */
export class LocalTraceExporter implements SpanExporter {
  private readonly exporter: OTLPTraceExporter;
  readonly state = {
    status: "waiting" as "waiting" | "ready" | "unavailable",
    exportedSpans: 0,
    failedBatches: 0,
    lastSuccessAt: null as string | null,
  };
  constructor(readonly mode: TelemetryMode) {
    // The official exporter merges ambient headers even when headers:{} is supplied.
    // Managed JARVIS processes have a closed environment; refuse an ambiguous manual launch.
    if (Object.keys(process.env).some((key) => key.startsWith("OTEL_")))
      throw new Error(
        "Local telemetry requires a clean OTel environment. No environment values were logged.",
      );
    this.exporter = new OTLPTraceExporter({
      url: `http://127.0.0.1:${telemetryPorts(mode).collector}/v1/traces`,
      headers: {},
      timeoutMillis: 750,
      concurrencyLimit: 1,
      keepAlive: false,
      httpAgentOptions: { keepAlive: false, maxSockets: 1 },
    });
  }
  export(spans: ReadableSpan[], callback: (result: ExportResult) => void) {
    this.exporter.export(spans, (result) => {
      if (result.code === 0) {
        this.state.status = "ready";
        this.state.exportedSpans += spans.length;
        this.state.lastSuccessAt = new Date().toISOString();
      } else {
        this.state.status = "unavailable";
        this.state.failedBatches++;
      }
      callback(result);
    });
  }
  shutdown() {
    return this.exporter.shutdown();
  }
  forceFlush() {
    return this.exporter.forceFlush();
  }
}
