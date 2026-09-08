export type ObservabilityMode = "lab" | "operational";

export type ComponentId =
  "collector" | "prometheus" | "loki" | "jaeger" | "grafana";

export interface ObservabilityPorts {
  grafana: number;
  prometheus: number;
  loki: number;
  lokiGrpc: number;
  jaegerQuery: number;
  jaegerOtlpGrpc: number;
  jaegerOtlpHttp: number;
  collectorOtlpHttp: number;
  collectorOtlpGrpc: number;
  collectorHealth: number;
  collectorMetrics: number;
  jaegerMetrics: number;
  jaegerHealth: number;
  appMetrics: number;
  jaegerQueryGrpc: number;
}

/** The runtime resolves and verifies the executable independently of configuration. */
export interface ServiceSpec {
  id: ComponentId;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  healthUrl: string;
  ports: number[];
}

export interface PreparedConfiguration {
  root: string;
  ports: ObservabilityPorts;
  services: ServiceSpec[];
  /** Private UTF-8 password file, read by Grafana's file provider. Login: admin. */
  grafanaCredentialPath: string;
}
