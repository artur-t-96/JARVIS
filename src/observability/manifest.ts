import type { ComponentId } from "./contracts.js";
export type { ComponentId } from "./contracts.js";

export interface ComponentDefinition {
  readonly id: ComponentId;
  readonly version: string;
  readonly platform: "darwin";
  readonly architecture: "arm64";
  readonly archiveName: string;
  readonly archiveType: "tar.gz" | "zip";
  readonly url: string;
  readonly sha256: string;
  /** Hash of sorted JSON [{path,size,sha256}], derived from the verified archive. */
  readonly treeSha256: string;
  readonly archiveBytes: number;
  readonly stripComponents: 0 | 1;
  readonly executablePath: string;
  readonly license: string;
  readonly licenseSource: string;
  readonly checksumSource: string;
  readonly releaseSource: string;
}

// Official checksums retrieved 2026-09-08. These are fixed downloads, never
// `latest`. Tree hashes were calculated from the SHA-verified official archives
// without executing their contents; they also anchor the installed receipt.
export const COMPONENTS: readonly ComponentDefinition[] = Object.freeze(
  [
    {
      id: "collector",
      version: "0.160.0",
      platform: "darwin",
      architecture: "arm64",
      archiveName: "otelcol-contrib_0.160.0_darwin_arm64.tar.gz",
      archiveType: "tar.gz",
      url: "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.160.0/otelcol-contrib_0.160.0_darwin_arm64.tar.gz",
      sha256:
        "ceb5309ba16f2587dbef765d54e15c803354d038b0495b0b691e1eb9876d17c9",
      treeSha256:
        "0f819fa744cdaace43d135bc44602f805f87715e65d43a6df3649d716264c21e",
      archiveBytes: 95034916,
      stripComponents: 0,
      executablePath: "otelcol-contrib",
      license: "Apache-2.0",
      licenseSource:
        "https://github.com/open-telemetry/opentelemetry-collector-releases/blob/v0.160.0/LICENSE",
      checksumSource:
        "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v0.160.0/otelcol-contrib_0.160.0_darwin_arm64.tar.gz.sha256",
      releaseSource:
        "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/tag/v0.160.0",
    },
    {
      id: "prometheus",
      version: "3.14.0",
      platform: "darwin",
      architecture: "arm64",
      archiveName: "prometheus-3.14.0.darwin-arm64.tar.gz",
      archiveType: "tar.gz",
      url: "https://github.com/prometheus/prometheus/releases/download/v3.14.0/prometheus-3.14.0.darwin-arm64.tar.gz",
      sha256:
        "a9623f7f4fe65b1b171b423c1a72bbf23dfdf41a171dcb33e7dd302af80dc01c",
      treeSha256:
        "c33cc59c3b08ae00fec0ccff754fc292ea9bcb2cdeac0f2d6f7c43385108bc7c",
      archiveBytes: 106416837,
      stripComponents: 1,
      executablePath: "prometheus",
      license: "Apache-2.0",
      licenseSource:
        "https://github.com/prometheus/prometheus/blob/v3.14.0/LICENSE",
      checksumSource:
        "https://github.com/prometheus/prometheus/releases/download/v3.14.0/sha256sums.txt",
      releaseSource:
        "https://github.com/prometheus/prometheus/releases/tag/v3.14.0",
    },
    {
      id: "loki",
      version: "3.7.7",
      platform: "darwin",
      architecture: "arm64",
      archiveName: "loki-darwin-arm64.zip",
      archiveType: "zip",
      url: "https://github.com/grafana/loki/releases/download/v3.7.7/loki-darwin-arm64.zip",
      sha256:
        "14bd87f38e38651efa2ed709997fa156a7869384bd2cf6818c4606a56a96e1ae",
      treeSha256:
        "6cbd398856d210668e19360150141d39ae67584a210f0749f41a8659b5301e96",
      archiveBytes: 42625315,
      stripComponents: 0,
      executablePath: "loki-darwin-arm64",
      license: "AGPL-3.0-only",
      licenseSource: "https://github.com/grafana/loki/blob/v3.7.7/LICENSING.md",
      checksumSource:
        "https://github.com/grafana/loki/releases/download/v3.7.7/SHA256SUMS",
      releaseSource: "https://github.com/grafana/loki/releases/tag/v3.7.7",
    },
    {
      id: "jaeger",
      version: "2.20.0",
      platform: "darwin",
      architecture: "arm64",
      archiveName: "jaeger-2.20.0-darwin-arm64.tar.gz",
      archiveType: "tar.gz",
      url: "https://github.com/jaegertracing/jaeger/releases/download/v2.20.0/jaeger-2.20.0-darwin-arm64.tar.gz",
      sha256:
        "b2d21051b27f06535c288dd63e15a42d5aae653d0113695014d7e6b502736e5d",
      treeSha256:
        "1b505abd88ec5f5b95f8a19b1907726129e86cac16df63cb01acfb0e77c249af",
      archiveBytes: 57635558,
      stripComponents: 1,
      executablePath: "jaeger",
      license: "Apache-2.0",
      licenseSource:
        "https://github.com/jaegertracing/jaeger/blob/v2.20.0/LICENSE",
      checksumSource:
        "https://github.com/jaegertracing/jaeger/releases/download/v2.20.0/jaeger-2.20.0.sha256sum.txt",
      releaseSource:
        "https://github.com/jaegertracing/jaeger/releases/tag/v2.20.0",
    },
    {
      id: "grafana",
      version: "13.2.1",
      platform: "darwin",
      architecture: "arm64",
      archiveName: "grafana_13.2.1_33191028959_darwin_arm64.tar.gz",
      archiveType: "tar.gz",
      url: "https://dl.grafana.com/grafana/release/13.2.1/grafana_13.2.1_33191028959_darwin_arm64.tar.gz",
      sha256:
        "d7a16f9f93a1b340a195e3e2f5dd7f3029820e08a8c76a6941ed7971acb9b7c6",
      treeSha256:
        "c1be36871a6cb85429bb03f2caedb4500b1b72c79211b93bcdc5b3b5c10c9757",
      archiveBytes: 449196841,
      stripComponents: 1,
      executablePath: "bin/grafana",
      license: "AGPL-3.0-only",
      licenseSource: "https://github.com/grafana/grafana/blob/v13.2.1/LICENSE",
      checksumSource:
        "https://grafana.com/grafana/download/13.2.1?edition=oss&platform=mac",
      releaseSource:
        "https://grafana.com/grafana/download/13.2.1?edition=oss&platform=mac",
    },
  ].map((component) => Object.freeze(component)) as ComponentDefinition[],
);

export function getComponent(id: ComponentId): ComponentDefinition {
  const component = COMPONENTS.find((entry) => entry.id === id);
  if (!component) throw new Error("Nieznany komponent observability.");
  return component;
}
