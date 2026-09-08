import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type {
  ObservabilityMode,
  ObservabilityPorts,
  PreparedConfiguration,
  ServiceSpec,
} from "./contracts.js";
import { dashboard } from "./dashboard.js";
import { componentPaths } from "./installer.js";

const host = "127.0.0.1";
const address = (port: number) => `${host}:${port}`;
const url = (port: number) => `http://${address(port)}`;

export function portMap(mode: ObservabilityMode): ObservabilityPorts {
  if (mode !== "lab" && mode !== "operational")
    throw new Error("Unknown observability mode");
  const base = mode === "lab" ? 15300 : 15400;
  return {
    grafana: base,
    prometheus: base + 1,
    loki: base + 2,
    lokiGrpc: base + 3,
    jaegerQuery: base + 4,
    jaegerOtlpGrpc: base + 5,
    jaegerOtlpHttp: base + 6,
    collectorOtlpHttp: base + 7,
    collectorOtlpGrpc: base + 8,
    collectorHealth: base + 9,
    collectorMetrics: base + 10,
    jaegerMetrics: base + 11,
    jaegerHealth: base + 12,
    appMetrics: base + 13,
    jaegerQueryGrpc: base + 14,
  };
}

/** Bounded machine fields only. IDs are metadata, never Loki index labels. */
const logFields = [
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
];
const traceFields = [
  ...logFields,
  "jarvis.run.id",
  "jarvis.step.id",
  "jarvis.usage.id",
  "jarvis.pricing.version",
  "jarvis.cost.currency",
  "jarvis.cost.estimated",
  "gen_ai.provider.name",
  "gen_ai.operation.name",
  "gen_ai.request.model",
  "gen_ai.response.model",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "error.type",
];
const machineValue = "^[a-zA-Z0-9_./:{}*-]{1,160}$";
const secretValue =
  "(?i)bearer|password|secret|api[-_]?key|token=|sk-[a-z0-9]|-----BEGIN";

function safeAttributes(fields: string[]): string[] {
  return [
    `keep_keys(attributes, ${JSON.stringify(fields)})`,
    ...fields.flatMap((field) => {
      const path = `attributes[${JSON.stringify(field)}]`;
      return [
        `delete_key(attributes, ${JSON.stringify(field)}) where ${path} != nil and not (IsString(${path}) or IsInt(${path}) or IsDouble(${path}) or IsBool(${path}))`,
        `set(${path}, "[redacted]") where IsString(${path}) and (not IsMatch(${path}, ${JSON.stringify(machineValue)}) or IsMatch(${path}, ${JSON.stringify(secretValue)}))`,
      ];
    }),
  ];
}

function collectorConfig(
  root: string,
  project: string,
  mode: ObservabilityMode,
  ports: ObservabilityPorts,
) {
  // Schemas: opentelemetry-collector(-contrib) v0.160.0; otlp_http is the current component ID.
  const storage = join(root, "data", "collector");
  const logPath = join(project, ".data", "local-product", `${mode}.log`);
  const exporter = (endpoint: string) => ({
    endpoint,
    timeout: "5s",
    retry_on_failure: {
      initial_interval: "1s",
      max_interval: "10s",
      max_elapsed_time: "0s",
    },
    sending_queue: {
      enabled: true,
      num_consumers: 1,
      queue_size: 512,
      storage: "file_storage",
    },
  });
  return {
    extensions: {
      health_check: { endpoint: address(ports.collectorHealth), path: "/" },
      file_storage: {
        directory: storage,
        fsync: true,
        max_size: 64 * 1024 * 1024,
        compaction: {
          on_start: true,
          on_rebound: true,
          directory: join(storage, "compaction"),
          rebound_needed_threshold_mib: 32,
          rebound_trigger_threshold_mib: 8,
          check_interval: "5s",
        },
      },
    },
    receivers: {
      otlp: {
        protocols: {
          http: { endpoint: address(ports.collectorOtlpHttp) },
          grpc: { endpoint: address(ports.collectorOtlpGrpc) },
        },
      },
      "filelog/jarvis": {
        include: [logPath, `${logPath}.1`, `${logPath}.2`],
        start_at: "beginning",
        storage: "file_storage",
        max_log_size: "64KiB",
        include_file_name: false,
        include_file_path: false,
        resource: {
          "service.name": "jarvis",
          "deployment.environment.name": mode,
        },
        operators: [
          {
            type: "json_parser",
            on_error: "drop_quiet",
            parse_ints: true,
            timestamp: {
              parse_from: "attributes.time",
              layout_type: "gotime",
              layout: "2006-01-02T15:04:05.999999999Z07:00",
            },
            severity: { parse_from: "attributes.level" },
          },
          {
            type: "trace_parser",
            if: "attributes.traceId != nil and attributes.spanId != nil",
            trace_id: { parse_from: "attributes.traceId" },
            span_id: { parse_from: "attributes.spanId" },
            on_error: "drop_quiet",
          },
        ],
      },
    },
    processors: {
      memory_limiter: {
        check_interval: "1s",
        limit_mib: 128,
        spike_limit_mib: 32,
      },
      "transform/log_privacy": {
        error_mode: "propagate",
        log_statements: [
          {
            context: "log",
            statements: [
              'set(body, "invalid_event")',
              'set(body, attributes["event"]) where IsString(attributes["event"]) and IsMatch(attributes["event"], "^[a-z0-9_.-]{1,80}$")',
              ...safeAttributes(logFields),
            ],
          },
        ],
      },
      "transform/trace_privacy": {
        error_mode: "propagate",
        trace_statements: [
          {
            context: "resource",
            statements: [
              'keep_keys(attributes, ["service.version"])',
              'set(attributes["service.version"], "unknown") where not IsString(attributes["service.version"])',
              'set(attributes["service.version"], "unknown") where not IsMatch(attributes["service.version"], "^[a-zA-Z0-9_.-]{1,80}$")',
              'set(attributes["service.name"], "jarvis")',
              `set(attributes["deployment.environment.name"], "${mode}")`,
            ],
          },
          {
            context: "scope",
            statements: [
              'set(name, "jarvis")',
              'set(version, "")',
              "keep_keys(attributes, [])",
            ],
          },
          {
            context: "span",
            statements: [
              'set(name, "invalid_operation") where not IsMatch(name, "^[a-zA-Z0-9_. -]{1,120}$")',
              `set(name, "invalid_operation") where IsMatch(name, ${JSON.stringify(secretValue)})`,
              'set(status.message, "")',
              ...safeAttributes(traceFields),
            ],
          },
          {
            context: "spanevent",
            statements: ['set(name, "event")', "keep_keys(attributes, [])"],
          },
        ],
      },
      batch: { timeout: "1s", send_batch_size: 128, send_batch_max_size: 256 },
    },
    exporters: {
      "otlp_http/loki": exporter(`${url(ports.loki)}/otlp`),
      "otlp_http/jaeger": exporter(url(ports.jaegerOtlpHttp)),
    },
    service: {
      extensions: ["health_check", "file_storage"],
      telemetry: {
        resource: { "service.name": "jarvis-collector" },
        logs: { level: "warn", encoding: "json" },
        metrics: {
          readers: [
            {
              pull: {
                exporter: {
                  prometheus: { host, port: ports.collectorMetrics },
                },
              },
            },
          ],
        },
      },
      pipelines: {
        logs: {
          receivers: ["filelog/jarvis"],
          processors: ["memory_limiter", "transform/log_privacy", "batch"],
          exporters: ["otlp_http/loki"],
        },
        traces: {
          receivers: ["otlp"],
          processors: ["memory_limiter", "transform/trace_privacy", "batch"],
          exporters: ["otlp_http/jaeger"],
        },
      },
    },
  };
}

function prometheusConfig(mode: ObservabilityMode, ports: ObservabilityPorts) {
  return {
    global: {
      scrape_interval: "15s",
      scrape_timeout: "5s",
      evaluation_interval: "30s",
      external_labels: { jarvis_mode: mode },
    },
    scrape_configs: [
      ["jarvis", ports.appMetrics],
      ["prometheus", ports.prometheus],
      ["loki", ports.loki],
      ["collector", ports.collectorMetrics],
      ["jaeger", ports.jaegerMetrics],
    ].map(([job_name, port]) => ({
      job_name,
      static_configs: [{ targets: [address(Number(port))] }],
    })),
  };
}

function lokiConfig(root: string, ports: ObservabilityPorts) {
  const data = join(root, "data", "loki");
  return {
    auth_enabled: false,
    analytics: { reporting_enabled: false },
    server: {
      http_listen_address: host,
      http_listen_port: ports.loki,
      grpc_listen_address: host,
      grpc_listen_port: ports.lokiGrpc,
      log_level: "warn",
    },
    common: {
      instance_addr: host,
      path_prefix: data,
      replication_factor: 1,
      ring: { kvstore: { store: "inmemory" } },
    },
    schema_config: {
      configs: [
        {
          from: "2024-01-01",
          store: "tsdb",
          object_store: "filesystem",
          schema: "v13",
          index: { prefix: "index_", period: "24h" },
        },
      ],
    },
    storage_config: {
      tsdb_shipper: {
        active_index_directory: join(data, "index"),
        cache_location: join(data, "cache"),
      },
      filesystem: { directory: join(data, "chunks") },
    },
    ingester: {
      // Keep the WAL disk guard. 95% leaves ~23 GiB free on the current 460 GiB APFS volume.
      wal: { enabled: true, dir: join(data, "wal"), disk_full_threshold: 0.95 },
      lifecycler: { min_ready_duration: "1s" },
    },
    limits_config: {
      allow_structured_metadata: true,
      retention_period: "168h",
      ingestion_rate_mb: 4,
      ingestion_burst_size_mb: 8,
      max_entries_limit_per_query: 1000,
    },
    compactor: {
      working_directory: join(data, "compactor"),
      retention_enabled: true,
      retention_delete_delay: "1h",
      retention_delete_worker_count: 2,
      delete_request_store: "filesystem",
    },
    pattern_ingester: { enabled: false },
    distributor: {
      otlp_config: {
        default_resource_attributes_as_index_labels: [
          "service.name",
          "deployment.environment.name",
        ],
      },
    },
  };
}

function jaegerConfig(root: string, ports: ObservabilityPorts) {
  // Based on jaegertracing/jaeger v2.20.0/cmd/jaeger/config-badger.yaml.
  const data = join(root, "data", "jaeger");
  return {
    extensions: {
      jaeger_storage: {
        backends: {
          jarvis: {
            badger: {
              directories: {
                keys: join(data, "keys"),
                values: join(data, "values"),
              },
              ephemeral: false,
              ttl: { spans: "48h" },
            },
          },
        },
      },
      jaeger_query: {
        storage: { traces: "jarvis" },
        http: { endpoint: address(ports.jaegerQuery) },
        grpc: { endpoint: address(ports.jaegerQueryGrpc) },
        enable_tracing: false,
        max_trace_size: 10000,
      },
      healthcheckv2: {
        use_v2: true,
        http: {
          endpoint: address(ports.jaegerHealth),
          status: { enabled: true, path: "/status" },
          config: { enabled: false },
        },
      },
    },
    receivers: {
      otlp: {
        protocols: {
          http: { endpoint: address(ports.jaegerOtlpHttp) },
          grpc: { endpoint: address(ports.jaegerOtlpGrpc) },
        },
      },
    },
    processors: { batch: { timeout: "1s", send_batch_size: 128 } },
    exporters: { jaeger_storage_exporter: { trace_storage: "jarvis" } },
    service: {
      extensions: ["jaeger_storage", "jaeger_query", "healthcheckv2"],
      pipelines: {
        traces: {
          receivers: ["otlp"],
          processors: ["batch"],
          exporters: ["jaeger_storage_exporter"],
        },
      },
      telemetry: {
        resource: { "service.name": "jarvis-jaeger" },
        logs: { level: "warn", encoding: "json" },
        metrics: {
          readers: [
            {
              pull: {
                exporter: { prometheus: { host, port: ports.jaegerMetrics } },
              },
            },
          ],
        },
      },
    },
  };
}

function grafanaConfig(
  root: string,
  ports: ObservabilityPorts,
  passwordPath: string,
) {
  const quoted = (value: string) => `"""${value}"""`;
  return `app_mode = production
instance_name = jarvis-local
[paths]
data = ${quoted(join(root, "data", "grafana"))}
logs = ${quoted(join(root, "logs"))}
plugins = ${quoted(join(root, "data", "grafana", "plugins"))}
provisioning = ${quoted(join(root, "config", "provisioning"))}
[server]
http_addr = ${host}
http_port = ${ports.grafana}
domain = ${host}
enforce_domain = true
root_url = ${url(ports.grafana)}/
[database]
type = sqlite3
path = ${quoted(join(root, "data", "grafana", "grafana.db"))}
[security]
admin_user = admin
admin_password = $__file{${passwordPath}}
cookie_samesite = strict
disable_gravatar = true
allow_embedding = false
[users]
allow_sign_up = false
allow_org_create = false
default_theme = light
[auth.anonymous]
enabled = false
[auth]
login_cookie_name = jarvis_grafana_${ports.grafana}
disable_login_form = false
login_maximum_inactive_lifetime_duration = 8h
login_maximum_lifetime_duration = 1d
[analytics]
enabled = false
reporting_enabled = false
check_for_updates = false
check_for_plugin_updates = false
feedback_links_enabled = false
[plugins]
plugin_admin_enabled = false
plugin_admin_external_manage_enabled = false
preinstall_disabled = true
preinstall_auto_update = false
public_key_retrieval_disabled = true
public_key_retrieval_on_startup = false
[news]
news_feed_enabled = false
[snapshots]
enabled = false
external_enabled = false
external_snapshot_url =
[cloud_migration]
enabled = false
[public_dashboards]
enabled = false
[provisioning]
# Grafana 13 Git Sync; classic file provisioning still uses [paths].provisioning.
enabled = false
[log]
mode = console
level = warn
[log.console]
format = json
`;
}

function dataSources(ports: ObservabilityPorts) {
  return {
    apiVersion: 1,
    datasources: [
      {
        name: "JARVIS Prometheus",
        uid: "jarvis-prometheus",
        type: "prometheus",
        access: "proxy",
        url: url(ports.prometheus),
        isDefault: true,
        editable: false,
        jsonData: { httpMethod: "POST", timeInterval: "15s" },
      },
      {
        name: "JARVIS Loki",
        uid: "jarvis-loki",
        type: "loki",
        access: "proxy",
        url: url(ports.loki),
        editable: false,
        jsonData: {
          maxLines: 500,
          derivedFields: [
            {
              name: "TraceID",
              matcherType: "label",
              matcherRegex: "trace_id",
              datasourceUid: "jarvis-jaeger",
              url: "$${__value.raw}",
            },
          ],
        },
      },
      {
        name: "JARVIS Jaeger",
        uid: "jarvis-jaeger",
        type: "jaeger",
        access: "proxy",
        url: url(ports.jaegerQuery),
        editable: false,
        jsonData: {
          tracesToLogsV2: {
            datasourceUid: "jarvis-loki",
            spanStartTimeShift: "-5m",
            spanEndTimeShift: "5m",
            // IDs are structured metadata, not substrings of the event-only log body.
            filterByTraceID: false,
            filterBySpanID: false,
            customQuery: true,
            query: '{service_name="jarvis"} | trace_id = "$${__span.traceId}"',
            tags: [{ key: "service.name", value: "service_name" }],
          },
        },
      },
    ],
  };
}

function privateDirectory(project: string, path: string): void {
  const suffix = relative(project, path);
  if (suffix.startsWith(`..${sep}`) || suffix === "..")
    throw new Error("Observability path escaped the project");
  let current = project;
  for (const part of suffix.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const state = lstatSync(current);
      if (!state.isDirectory() || state.isSymbolicLink())
        throw new Error("Observability directories must not be symlinks");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(current, { mode: 0o700 });
    }
    chmodSync(current, 0o700);
  }
}

function assertPrivateFile(path: string): void {
  const state = lstatSync(path);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1)
    throw new Error(
      "Observability configuration must be a regular private file",
    );
}

function writePrivate(path: string, content: string): void {
  try {
    assertPrivateFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function ensurePassword(path: string): void {
  try {
    const descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, `${randomBytes(32).toString("base64url")}\n`);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    assertPrivateFile(path);
    const descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      if (!/^[a-zA-Z0-9_-]{43}\n?$/.test(readFileSync(descriptor, "utf8")))
        throw new Error("Existing Grafana credential file is invalid");
      fchmodSync(descriptor, 0o600);
    } finally {
      closeSync(descriptor);
    }
  }
}

/** Generate private configuration only. The runtime owns process lifecycle and validation. */
export function prepareConfiguration(input: {
  projectDir: string;
  mode: ObservabilityMode;
}): PreparedConfiguration {
  const ports = portMap(input.mode);
  const project = realpathSync(resolve(input.projectDir));
  // Prevent INI provider expansion or filelog glob interpretation in project paths.
  if (/[\r\n\0${}*?\[\]]|"""/.test(project))
    throw new Error("Unsupported observability project path");
  const root = join(project, ".data", "observability", input.mode);
  const config = join(root, "config");
  for (const suffix of [
    "config",
    "logs",
    "data/prometheus",
    "data/loki",
    "data/jaeger/keys",
    "data/jaeger/values",
    "data/collector/compaction",
    "data/grafana/plugins",
    "config/provisioning/datasources",
    "config/provisioning/dashboards",
    "config/dashboards",
  ])
    privateDirectory(project, join(root, suffix));
  const grafanaCredentialPath = join(config, "grafana-admin-password");
  ensurePassword(grafanaCredentialPath);
  const files: Record<string, unknown> = {
    "collector.yaml": collectorConfig(root, project, input.mode, ports),
    "prometheus.yaml": prometheusConfig(input.mode, ports),
    "loki.yaml": lokiConfig(root, ports),
    "jaeger.yaml": jaegerConfig(root, ports),
    "provisioning/datasources/jarvis.yaml": dataSources(ports),
    "provisioning/dashboards/jarvis.yaml": {
      apiVersion: 1,
      providers: [
        {
          name: "JARVIS",
          orgId: 1,
          folder: "JARVIS",
          type: "file",
          disableDeletion: true,
          allowUiUpdates: false,
          updateIntervalSeconds: 60,
          options: { path: join(config, "dashboards") },
        },
      ],
    },
    "dashboards/jarvis.json": dashboard(input.mode),
  };
  // JSON is a strict YAML subset accepted by all four native Go configuration parsers.
  for (const [name, value] of Object.entries(files))
    writePrivate(join(config, name), `${JSON.stringify(value, null, 2)}\n`);
  writePrivate(
    join(config, "grafana.ini"),
    grafanaConfig(root, ports, grafanaCredentialPath),
  );
  const spec = (
    id: ServiceSpec["id"],
    args: string[],
    healthUrl: string,
    servicePorts: number[],
    memory: string,
  ): ServiceSpec => ({
    id,
    args,
    cwd: root,
    env: { GOMEMLIMIT: memory },
    healthUrl,
    ports: servicePorts,
  });
  const grafanaHome = componentPaths(project, "grafana").home;
  const services = [
    spec(
      "prometheus",
      [
        `--config.file=${join(config, "prometheus.yaml")}`,
        `--storage.tsdb.path=${join(root, "data", "prometheus")}`,
        "--storage.tsdb.retention.time=14d",
        "--storage.tsdb.retention.size=512MB",
        `--web.listen-address=${address(ports.prometheus)}`,
        "--log.level=warn",
      ],
      `${url(ports.prometheus)}/-/ready`,
      [ports.prometheus],
      "256MiB",
    ),
    spec(
      "loki",
      [`-config.file=${join(config, "loki.yaml")}`],
      `${url(ports.loki)}/ready`,
      [ports.loki, ports.lokiGrpc],
      "256MiB",
    ),
    spec(
      "jaeger",
      ["--config", join(config, "jaeger.yaml")],
      `${url(ports.jaegerHealth)}/status`,
      [
        ports.jaegerQuery,
        ports.jaegerOtlpGrpc,
        ports.jaegerOtlpHttp,
        ports.jaegerMetrics,
        ports.jaegerHealth,
        ports.jaegerQueryGrpc,
      ],
      "256MiB",
    ),
    spec(
      "collector",
      ["--config", join(config, "collector.yaml")],
      `${url(ports.collectorHealth)}/`,
      [
        ports.collectorOtlpHttp,
        ports.collectorOtlpGrpc,
        ports.collectorHealth,
        ports.collectorMetrics,
      ],
      "160MiB",
    ),
    spec(
      "grafana",
      [
        "server",
        "--homepath",
        grafanaHome,
        "--config",
        join(config, "grafana.ini"),
        `cfg:default.paths.logs=${join(root, "logs")}`,
      ],
      `${url(ports.grafana)}/api/health`,
      [ports.grafana],
      "384MiB",
    ),
  ];
  return { root, ports, services, grafanaCredentialPath };
}
