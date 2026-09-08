import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { portMap, prepareConfiguration } from "../src/observability/config.js";
import type { ObservabilityMode } from "../src/observability/contracts.js";

function temporary() {
  return realpathSync(
    mkdtempSync(join(tmpdir(), "jarvis-observability-config-")),
  );
}

function json(root: string, name: string) {
  return JSON.parse(readFileSync(join(root, "config", name), "utf8"));
}

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(path, entry.name))
      : [join(path, entry.name)],
  );
}

test("lab and operational have fifteen stable, disjoint loopback ports", () => {
  const lab = portMap("lab");
  const operational = portMap("operational");
  assert.equal(lab.grafana, 15300);
  assert.equal(lab.appMetrics, 15313);
  assert.equal(lab.jaegerQueryGrpc, 15314);
  assert.equal(operational.grafana, 15400);
  assert.equal(operational.appMetrics, 15413);
  assert.equal(operational.jaegerQueryGrpc, 15414);
  assert.equal(
    new Set([...Object.values(lab), ...Object.values(operational)]).size,
    30,
  );
  assert.deepEqual(
    Object.values(lab),
    Array.from({ length: 15 }, (_, index) => 15300 + index),
  );
  assert.throws(
    () => portMap("other" as ObservabilityMode),
    /Unknown observability mode/,
  );
});

test("prepares separate durable stores, pinned service arguments and only explicit loopback listeners", () => {
  const project = temporary();
  try {
    for (const mode of ["lab", "operational"] as const) {
      const prepared = prepareConfiguration({ projectDir: project, mode });
      const { ports, root } = prepared;
      assert.equal(
        root,
        join(resolve(project), ".data", "observability", mode),
      );
      assert.deepEqual(
        prepared.services.map((service) => service.id),
        ["prometheus", "loki", "jaeger", "collector", "grafana"],
      );
      assert.deepEqual(
        prepared.services
          .flatMap((service) => service.ports)
          .sort((a, b) => a - b),
        Object.values(ports)
          .filter((port) => port !== ports.appMetrics)
          .sort((a, b) => a - b),
      );
      for (const service of prepared.services) {
        assert.equal(service.cwd, root);
        assert.equal(new URL(service.healthUrl).hostname, "127.0.0.1");
        assert.ok(service.args.length > 0);
        assert.deepEqual(Object.keys(service.env), ["GOMEMLIMIT"]);
      }
      const prometheus = json(root, "prometheus.yaml");
      assert.deepEqual(prometheus.scrape_configs[0].static_configs[0].targets, [
        `127.0.0.1:${ports.appMetrics}`,
      ]);
      assert.ok(
        prometheus.scrape_configs.every(
          (job: { static_configs: { targets: string[] }[] }) =>
            job.static_configs.every((config) =>
              config.targets.every((target) =>
                /^127\.0\.0\.1:\d+$/.test(target),
              ),
            ),
        ),
      );
      const promService = prepared.services.find(
        (service) => service.id === "prometheus",
      )!;
      assert.ok(promService.args.includes("--storage.tsdb.retention.time=14d"));
      assert.ok(
        promService.args.includes("--storage.tsdb.retention.size=512MB"),
      );
      assert.ok(
        promService.args.includes(
          `--storage.tsdb.path=${join(root, "data", "prometheus")}`,
        ),
      );

      const loki = json(root, "loki.yaml");
      assert.equal(loki.server.http_listen_address, "127.0.0.1");
      assert.equal(loki.server.grpc_listen_address, "127.0.0.1");
      assert.equal(loki.server.http_listen_port, ports.loki);
      assert.equal(loki.server.grpc_listen_port, ports.lokiGrpc);
      assert.equal(
        loki.storage_config.filesystem.directory,
        join(root, "data", "loki", "chunks"),
      );
      assert.equal(loki.ingester.wal.enabled, true);
      assert.equal(loki.limits_config.retention_period, "168h");
      assert.equal(loki.compactor.retention_enabled, true);
      assert.equal(loki.analytics.reporting_enabled, false);

      const jaeger = json(root, "jaeger.yaml");
      const badger = jaeger.extensions.jaeger_storage.backends.jarvis.badger;
      assert.equal(badger.ephemeral, false);
      assert.equal(badger.ttl.spans, "48h");
      assert.equal(
        badger.directories.keys,
        join(root, "data", "jaeger", "keys"),
      );
      assert.equal(
        badger.directories.values,
        join(root, "data", "jaeger", "values"),
      );
      assert.equal(
        jaeger.extensions.jaeger_query.http.endpoint,
        `127.0.0.1:${ports.jaegerQuery}`,
      );
      assert.equal(
        jaeger.extensions.jaeger_query.grpc.endpoint,
        `127.0.0.1:${ports.jaegerQueryGrpc}`,
      );
      assert.notEqual(
        jaeger.extensions.jaeger_query.grpc.endpoint,
        jaeger.extensions.jaeger_query.http.endpoint,
      );
      assert.equal(
        jaeger.extensions.healthcheckv2.http.endpoint,
        `127.0.0.1:${ports.jaegerHealth}`,
      );
      assert.equal(jaeger.extensions.healthcheckv2.http.config.enabled, false);
      assert.equal(
        jaeger.receivers.otlp.protocols.grpc.endpoint,
        `127.0.0.1:${ports.jaegerOtlpGrpc}`,
      );
      assert.equal(
        jaeger.receivers.otlp.protocols.http.endpoint,
        `127.0.0.1:${ports.jaegerOtlpHttp}`,
      );
      assert.equal(
        jaeger.service.telemetry.metrics.readers[0].pull.exporter.prometheus
          .host,
        "127.0.0.1",
      );
      assert.equal(
        jaeger.service.telemetry.metrics.readers[0].pull.exporter.prometheus
          .port,
        ports.jaegerMetrics,
      );
      const collector = json(root, "collector.yaml");
      assert.equal(
        collector.extensions.health_check.endpoint,
        `127.0.0.1:${ports.collectorHealth}`,
      );
      assert.equal(
        collector.receivers.otlp.protocols.http.endpoint,
        `127.0.0.1:${ports.collectorOtlpHttp}`,
      );
      assert.equal(
        collector.receivers.otlp.protocols.grpc.endpoint,
        `127.0.0.1:${ports.collectorOtlpGrpc}`,
      );
      assert.equal(
        collector.service.telemetry.metrics.readers[0].pull.exporter.prometheus
          .host,
        "127.0.0.1",
      );
      assert.equal(
        collector.service.telemetry.metrics.readers[0].pull.exporter.prometheus
          .port,
        ports.collectorMetrics,
      );
      const grafana = prepared.services.find(
        (service) => service.id === "grafana",
      )!;
      assert.equal(grafana.args[0], "server");
      assert.equal(
        grafana.args[2],
        join(project, ".data", "observability", "bin", "grafana", "13.2.1"),
      );
      assert.ok(
        files(join(root, "config")).every(
          (path) => !readFileSync(path, "utf8").includes("0.0.0.0"),
        ),
      );
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Collector consumes only the selected JARVIS logs with durable bounded queues and fail-closed redaction", () => {
  const project = temporary();
  try {
    const prepared = prepareConfiguration({ projectDir: project, mode: "lab" });
    const { root, ports } = prepared;
    const collector = json(root, "collector.yaml");
    const receiver = collector.receivers["filelog/jarvis"];
    const log = join(project, ".data", "local-product", "lab.log");
    assert.deepEqual(receiver.include, [log, `${log}.1`, `${log}.2`]);
    assert.equal(receiver.storage, "file_storage");
    assert.equal(receiver.start_at, "beginning");
    assert.equal(receiver.include_file_path, false);
    assert.equal(receiver.operators[0].on_error, "drop_quiet");
    assert.equal(receiver.operators[1].type, "trace_parser");
    assert.equal(receiver.operators[1].on_error, "drop_quiet");
    assert.equal(
      collector.extensions.file_storage.directory,
      join(root, "data", "collector"),
    );
    assert.equal(collector.extensions.file_storage.max_size, 64 * 1024 * 1024);
    assert.equal(collector.extensions.file_storage.fsync, true);
    assert.equal(
      collector.processors["transform/log_privacy"].error_mode,
      "propagate",
    );
    const statements = collector.processors["transform/log_privacy"]
      .log_statements[0].statements as string[];
    assert.equal(statements[0], 'set(body, "invalid_event")');
    assert.ok(
      statements[1]?.startsWith('set(body, attributes["event"]) where'),
    );
    const keep = statements.find((line) =>
      line.startsWith("keep_keys(attributes,"),
    )!;
    for (const forbidden of [
      "body",
      "input",
      "prompt",
      "password",
      "error",
      "apiKey",
      "traceId",
    ])
      assert.ok(!keep.includes(`"${forbidden}"`));
    assert.ok(
      statements.some(
        (line) => line.includes("IsString") && line.includes("[redacted]"),
      ),
    );
    assert.ok(
      statements.some(
        (line) => line.includes("delete_key") && line.includes("IsBool"),
      ),
    );
    assert.ok(!collector.service.pipelines.logs.receivers.includes("otlp"));
    assert.equal(
      collector.exporters["otlp_http/loki"].endpoint,
      `http://127.0.0.1:${ports.loki}/otlp`,
    );
    assert.equal(
      collector.exporters["otlp_http/jaeger"].endpoint,
      `http://127.0.0.1:${ports.jaegerOtlpHttp}`,
    );
    for (const exporter of Object.values(collector.exporters) as {
      sending_queue: { storage: string; queue_size: number };
    }[]) {
      assert.equal(exporter.sending_queue.storage, "file_storage");
      assert.equal(exporter.sending_queue.queue_size, 512);
    }
    const loki = json(root, "loki.yaml");
    assert.deepEqual(
      loki.distributor.otlp_config.default_resource_attributes_as_index_labels,
      ["service.name", "deployment.environment.name"],
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("Grafana credentials remain private and stable without entering config, argv or environment", () => {
  const project = temporary();
  try {
    const first = prepareConfiguration({
      projectDir: project,
      mode: "operational",
    });
    const password = readFileSync(first.grafanaCredentialPath, "utf8").trim();
    assert.match(password, /^[a-zA-Z0-9_-]{43}$/);
    assert.equal(lstatSync(first.grafanaCredentialPath).mode & 0o777, 0o600);
    assert.equal(lstatSync(first.root).mode & 0o777, 0o700);
    chmodSync(first.grafanaCredentialPath, 0o644);
    const second = prepareConfiguration({
      projectDir: project,
      mode: "operational",
    });
    assert.equal(
      readFileSync(second.grafanaCredentialPath, "utf8").trim(),
      password,
    );
    assert.equal(lstatSync(second.grafanaCredentialPath).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(second).includes(password));
    const ini = readFileSync(
      join(second.root, "config", "grafana.ini"),
      "utf8",
    );
    assert.ok(
      ini.includes(`admin_password = $__file{${second.grafanaCredentialPath}}`),
    );
    assert.ok(ini.includes("[auth.anonymous]\nenabled = false"));
    assert.ok(ini.includes("login_cookie_name = jarvis_grafana_15400"));
    const lab = prepareConfiguration({ projectDir: project, mode: "lab" });
    assert.ok(
      readFileSync(join(lab.root, "config", "grafana.ini"), "utf8").includes(
        "login_cookie_name = jarvis_grafana_15300",
      ),
    );
    assert.ok(ini.includes("allow_sign_up = false"));
    for (const setting of [
      "reporting_enabled",
      "check_for_updates",
      "check_for_plugin_updates",
      "preinstall_auto_update",
      "news_feed_enabled",
    ])
      assert.ok(ini.includes(`${setting} = false`));
    assert.ok(ini.includes("preinstall_disabled = true"));
    assert.ok(ini.includes("public_key_retrieval_disabled = true"));
    assert.ok(ini.includes("enforce_domain = true"));
    for (const section of [
      "snapshots",
      "cloud_migration",
      "public_dashboards",
      "provisioning",
    ])
      assert.ok(
        ini.includes(
          `[${section}]\n${section === "provisioning" ? "# Grafana 13 Git Sync; classic file provisioning still uses [paths].provisioning.\n" : ""}enabled = false`,
        ),
      );
    assert.ok(ini.includes("external_enabled = false"));
    assert.ok(ini.includes("external_snapshot_url =\n"));
    assert.ok(
      ini.includes(
        `provisioning = """${join(second.root, "config", "provisioning")}"""`,
      ),
    );
    assert.equal(
      json(second.root, "provisioning/dashboards/jarvis.yaml").providers[0]
        .type,
      "file",
    );
    assert.equal(
      json(second.root, "provisioning/datasources/jarvis.yaml").datasources
        .length,
      3,
    );
    const other = prepareConfiguration({ projectDir: project, mode: "lab" });
    assert.notEqual(
      readFileSync(other.grafanaCredentialPath, "utf8").trim(),
      password,
    );
    for (const path of files(join(second.root, "config"))) {
      assert.equal(lstatSync(path).mode & 0o777, 0o600);
      if (path !== second.grafanaCredentialPath)
        assert.ok(!readFileSync(path, "utf8").includes(password));
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("provisions three real sources and a versioned dashboard with unavailable data left unavailable", () => {
  const project = temporary();
  try {
    const { root, ports } = prepareConfiguration({
      projectDir: project,
      mode: "lab",
    });
    const sources = json(
      root,
      "provisioning/datasources/jarvis.yaml",
    ).datasources;
    assert.deepEqual(
      sources.map((source: { type: string }) => source.type),
      ["prometheus", "loki", "jaeger"],
    );
    assert.deepEqual(
      sources.map((source: { url: string }) => source.url),
      [ports.prometheus, ports.loki, ports.jaegerQuery].map(
        (port) => `http://127.0.0.1:${port}`,
      ),
    );
    assert.ok(
      sources.every(
        (source: { access: string; editable: boolean }) =>
          source.access === "proxy" && !source.editable,
      ),
    );
    assert.equal(
      sources[1].jsonData.derivedFields[0].datasourceUid,
      sources[2].uid,
    );
    const dashboard = json(root, "dashboards/jarvis.json");
    assert.equal(dashboard.uid, "jarvis-lab");
    assert.equal(dashboard.version, 1);
    assert.ok(
      dashboard.panels.some((panel: { type: string }) => panel.type === "logs"),
    );
    for (const panel of dashboard.panels) {
      assert.ok(panel.targets.length > 0);
      for (const target of panel.targets)
        assert.ok(!target.expr.includes("vector(0)"));
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("refuses symlinked directories, credentials and config files without modifying their targets", () => {
  const project = temporary();
  const external = temporary();
  try {
    const target = join(external, "untouched");
    writeFileSync(target, "do not overwrite");
    symlinkSync(external, join(project, ".data"));
    assert.throws(
      () => prepareConfiguration({ projectDir: project, mode: "lab" }),
      /symlinks/,
    );
    assert.deepEqual(readdirSync(external), ["untouched"]);
    rmSync(join(project, ".data"));
    const prepared = prepareConfiguration({ projectDir: project, mode: "lab" });
    rmSync(prepared.grafanaCredentialPath);
    symlinkSync(target, prepared.grafanaCredentialPath);
    assert.throws(
      () => prepareConfiguration({ projectDir: project, mode: "lab" }),
      /regular private file/,
    );
    assert.equal(readFileSync(target, "utf8"), "do not overwrite");
    rmSync(prepared.grafanaCredentialPath);
    prepareConfiguration({ projectDir: project, mode: "lab" });
    const config = join(prepared.root, "config", "collector.yaml");
    rmSync(config);
    symlinkSync(target, config);
    assert.throws(
      () => prepareConfiguration({ projectDir: project, mode: "lab" }),
      /regular private file/,
    );
    assert.equal(readFileSync(target, "utf8"), "do not overwrite");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(external, { recursive: true, force: true });
  }
});
