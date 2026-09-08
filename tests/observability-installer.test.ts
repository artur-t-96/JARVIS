import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPONENTS,
  type ComponentDefinition,
} from "../src/observability/manifest.js";
import {
  componentPaths,
  createInstallerForTest,
  installComponents,
} from "../src/observability/installer.js";

const sha = (body: string | Buffer) =>
  createHash("sha256").update(body).digest("hex");
type Member = {
  name: string;
  body?: string;
  kind?: "file" | "directory" | "symlink" | "hardlink" | "fifo";
  target?: string;
};
const BUILD_ARCHIVE = String.raw`
import sys,json,tarfile,zipfile,io,stat
path,kind,raw=sys.argv[1:]
members=json.loads(raw)
if kind=='zip':
    with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_DEFLATED) as archive:
        for m in members:
            info=zipfile.ZipInfo(m['name'])
            info.create_system=3
            mode=stat.S_IFLNK if m.get('kind')=='symlink' else stat.S_IFDIR if m.get('kind')=='directory' else stat.S_IFREG
            info.external_attr=(mode|0o700)<<16
            archive.writestr(info,m.get('target',m.get('body','')).encode())
else:
    with tarfile.open(path,'w:gz') as archive:
        for m in members:
            info=tarfile.TarInfo(m['name']);info.mode=0o700;info.mtime=0
            body=m.get('body','').encode()
            kind=m.get('kind','file')
            info.type={'file':tarfile.REGTYPE,'directory':tarfile.DIRTYPE,'symlink':tarfile.SYMTYPE,'hardlink':tarfile.LNKTYPE,'fifo':tarfile.FIFOTYPE}[kind]
            info.linkname=m.get('target','');info.size=len(body) if kind=='file' else 0
            archive.addfile(info,io.BytesIO(body) if kind=='file' else None)
`;

function fixture(
  members: Member[],
  archiveType: "tar.gz" | "zip" = "tar.gz",
  stripComponents: 0 | 1 = 0,
) {
  const outer = mkdtempSync(join(tmpdir(), "jarvis-installer-"));
  const project = join(outer, "project");
  mkdirSync(project, { mode: 0o700 });
  const archiveName = `fixture.${archiveType}`;
  const archive = join(outer, archiveName);
  const result = spawnSync(
    "python3",
    ["-I", "-c", BUILD_ARCHIVE, archive, archiveType, JSON.stringify(members)],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const bytes = readFileSync(archive);
  const files = members
    .filter((m) => !m.kind || m.kind === "file")
    .map((m) => ({
      path: m.name.split("/").slice(stripComponents).join("/"),
      size: Buffer.byteLength(m.body ?? ""),
      sha256: sha(m.body ?? ""),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const component: ComponentDefinition = {
    id: "grafana",
    version: "1.2.3",
    platform: "darwin",
    architecture: "arm64",
    archiveName,
    archiveType,
    url: "https://dl.grafana.com/test-fixture",
    sha256: sha(bytes),
    treeSha256: sha(JSON.stringify(files)),
    archiveBytes: bytes.length,
    stripComponents,
    executablePath: "bin/grafana",
    license: "test-fixture",
    licenseSource: "https://example.invalid/license",
    checksumSource: "https://example.invalid/checksum",
    releaseSource: "https://example.invalid/release",
  };
  let downloads = 0;
  const download = async (
    _component: ComponentDefinition,
    destination: string,
  ) => {
    downloads++;
    copyFileSync(archive, destination);
    chmodSync(destination, 0o600);
  };
  return {
    outer,
    project,
    archive,
    component,
    download,
    downloads: () => downloads,
    installer: createInstallerForTest([component], download),
    cleanup: () => rmSync(outer, { recursive: true, force: true }),
  };
}

const simple: Member[] = [
  { name: "bin/grafana", body: "fixture, never executed\n" },
  { name: "public/index.html", body: "<h1>Fixture</h1>" },
  { name: "conf/defaults.ini", body: "synthetic=true\n" },
];

test("closed manifest pins five official darwin arm64 archives and normalized Grafana home", () => {
  assert.equal(COMPONENTS.length, 5);
  assert.deepEqual(
    COMPONENTS.map((c) => c.id),
    ["collector", "prometheus", "loki", "jaeger", "grafana"],
  );
  for (const component of COMPONENTS) {
    assert.match(component.sha256, /^[a-f0-9]{64}$/);
    assert.match(component.treeSha256, /^[a-f0-9]{64}$/);
    assert.ok(component.archiveBytes > 0);
    assert.equal(component.platform, "darwin");
    assert.equal(component.architecture, "arm64");
    assert.match(component.url, /^https:\/\/(github\.com|dl\.grafana\.com)\//);
    assert.ok(!component.url.includes("latest"));
    assert.ok(Object.isFrozen(component));
  }
  const paths = componentPaths("/example/jarvis", "grafana");
  assert.equal(
    paths.home,
    "/example/jarvis/.data/observability/bin/grafana/13.2.1",
  );
  assert.equal(paths.executable, paths.home + "/bin/grafana");
  assert.throws(() => componentPaths("/example", "../escape" as "grafana"));
});

test("valid distribution installs atomically, survives restart and does not redownload", async () => {
  const f = fixture(
    simple.map((entry) => ({ ...entry, name: `distribution/${entry.name}` })),
    "tar.gz",
    1,
  );
  try {
    const [first] = await f.installer.installComponents(f.project);
    assert.ok(first);
    assert.equal(
      readFileSync(join(first.home, "public/index.html"), "utf8"),
      "<h1>Fixture</h1>",
    );
    assert.equal(lstatSync(first.executable).mode & 0o777, 0o555);
    assert.equal(
      lstatSync(join(f.project, ".data/observability")).mode & 0o777,
      0o700,
    );
    const restarted = createInstallerForTest([f.component], async () => {
      throw new Error("unexpected network");
    });
    assert.deepEqual(
      restarted.getInstalledComponent(f.project, "grafana"),
      first,
    );
    assert.deepEqual(await restarted.installComponents(f.project), [first]);
    assert.equal(f.downloads(), 1);
    assert.deepEqual(
      readdirSync(join(f.project, ".data/observability/bin/grafana")),
      ["1.2.3"],
    );
    rmSync(join(f.project, ".data/observability/cache"), { recursive: true });
    assert.deepEqual(
      restarted.getInstalledComponent(f.project, "grafana"),
      first,
    );
  } finally {
    f.cleanup();
  }
});

test("parallel installation publishes one verified version", async () => {
  const f = fixture(simple, "zip");
  try {
    const [a, b] = await Promise.all([
      f.installer.installComponents(f.project),
      f.installer.installComponents(f.project),
    ]);
    assert.deepEqual(a, b);
    assert.equal(
      readdirSync(join(f.project, ".data/observability/bin/grafana")).length,
      1,
    );
    assert.equal(
      readdirSync(join(f.project, ".data/observability/cache")).length,
      1,
    );
  } finally {
    f.cleanup();
  }
});

test("wrong download SHA and interrupted downloads leave no installed version or temporary download", async () => {
  const f = fixture(simple);
  try {
    for (const interrupted of [false, true]) {
      const broken = createInstallerForTest(
        [f.component],
        async (_component, path) => {
          writeFileSync(path, Buffer.alloc(f.component.archiveBytes, 0), {
            mode: 0o600,
          });
          if (interrupted) throw new Error("synthetic interrupted download");
        },
      );
      await assert.rejects(broken.installComponents(f.project));
      assert.equal(
        existsSync(join(f.project, ".data/observability/bin/grafana/1.2.3")),
        false,
      );
      assert.deepEqual(
        readdirSync(join(f.project, ".data/observability/cache")),
        [],
      );
    }
    assert.equal((await f.installer.installComponents(f.project)).length, 1);
  } finally {
    f.cleanup();
  }
});

test("cached archive corruption is rejected before extracting", async () => {
  const f = fixture(simple);
  try {
    await f.installer.installComponents(f.project);
    rmSync(join(f.project, ".data/observability/bin/grafana/1.2.3"), {
      recursive: true,
    });
    const cache = join(
      f.project,
      ".data/observability/cache",
      `${f.component.sha256}-${f.component.archiveName}`,
    );
    writeFileSync(cache, Buffer.alloc(f.component.archiveBytes, 0));
    await assert.rejects(f.installer.installComponents(f.project), /cache/);
    assert.equal(f.downloads(), 1);
  } finally {
    f.cleanup();
  }
});

test("binary, Grafana asset and forged receipt tampering cannot pass the pinned tree hash", async () => {
  for (const target of ["bin/grafana", "public/index.html"]) {
    const f = fixture(simple);
    try {
      const [installed] = await f.installer.installComponents(f.project);
      assert.ok(installed);
      const file = join(installed.home, target);
      chmodSync(file, 0o600);
      writeFileSync(file, "tampered");
      chmodSync(file, 0o555);
      assert.throws(
        () => f.installer.getInstalledComponent(f.project, "grafana"),
        /Integralność/,
      );
      const receiptPath = join(installed.home, ".jarvis-receipt.json");
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
      receipt.files.find(
        (entry: { path: string }) => entry.path === target,
      ).sha256 = sha("tampered");
      receipt.files.find(
        (entry: { path: string }) => entry.path === target,
      ).size = Buffer.byteLength("tampered");
      receipt.treeSha256 = sha(JSON.stringify(receipt.files));
      chmodSync(receiptPath, 0o600);
      writeFileSync(receiptPath, JSON.stringify(receipt));
      chmodSync(receiptPath, 0o400);
      assert.throws(
        () => f.installer.getInstalledComponent(f.project, "grafana"),
        /Receipt/,
      );
      await assert.rejects(f.installer.installComponents(f.project), /Receipt/);
    } finally {
      f.cleanup();
    }
  }
});

test("extra files and symlinked directories/assets are rejected on startup", async () => {
  for (const variant of ["extra", "symlink", "directory"]) {
    const f = fixture(simple);
    try {
      const [installed] = await f.installer.installComponents(f.project);
      assert.ok(installed);
      if (variant === "extra")
        writeFileSync(join(installed.home, "injected.js"), "unexpected", {
          mode: 0o444,
        });
      if (variant === "symlink") {
        rmSync(join(installed.home, "public/index.html"));
        symlinkSync(f.archive, join(installed.home, "public/index.html"));
      }
      if (variant === "directory") {
        rmSync(join(installed.home, "public"), { recursive: true });
        symlinkSync(f.outer, join(installed.home, "public"));
      }
      assert.throws(() =>
        f.installer.getInstalledComponent(f.project, "grafana"),
      );
    } finally {
      f.cleanup();
    }
  }
});

test("project data/cache symlinks never redirect installation outside JARVIS", async () => {
  for (const variant of ["data", "cache"]) {
    const f = fixture(simple);
    try {
      const outside = join(f.outer, "outside");
      mkdirSync(outside, { mode: 0o700 });
      if (variant === "data") symlinkSync(outside, join(f.project, ".data"));
      else {
        mkdirSync(join(f.project, ".data/observability/bin"), {
          recursive: true,
          mode: 0o700,
        });
        symlinkSync(outside, join(f.project, ".data/observability/cache"));
      }
      await assert.rejects(
        f.installer.installComponents(f.project),
        /Niebezpieczny katalog/,
      );
      assert.deepEqual(readdirSync(outside), []);
    } finally {
      f.cleanup();
    }
  }
});

test("archive traversal, links, devices, reserved receipts and case aliases fail before publish", async () => {
  const evil: Array<{ type: "tar.gz" | "zip"; member: Member }> = [
    { type: "tar.gz", member: { name: "../escaped", body: "evil" } },
    { type: "zip", member: { name: "../../escaped", body: "evil" } },
    { type: "tar.gz", member: { name: "/absolute/escaped", body: "evil" } },
    { type: "zip", member: { name: "C:\\escaped", body: "evil" } },
    {
      type: "tar.gz",
      member: { name: "link", kind: "symlink", target: "../outside" },
    },
    {
      type: "zip",
      member: { name: "link", kind: "symlink", target: "../outside" },
    },
    {
      type: "tar.gz",
      member: { name: "linked", kind: "hardlink", target: "bin/grafana" },
    },
    { type: "tar.gz", member: { name: "device", kind: "fifo" } },
    { type: "tar.gz", member: { name: ".jarvis-receipt.json", body: "{}" } },
    { type: "tar.gz", member: { name: "PUBLIC/index.html", body: "alias" } },
    {
      type: "tar.gz",
      member: {
        name: "PUBLIC/different.html",
        body: "implicit-directory-alias",
      },
    },
    { type: "tar.gz", member: { name: "public", body: "file-parent" } },
  ];
  for (const item of evil) {
    const f = fixture([...simple, item.member], item.type);
    try {
      await assert.rejects(
        f.installer.installComponents(f.project),
        /Archiwum odrzucone/,
        JSON.stringify(item),
      );
      assert.deepEqual(
        readdirSync(join(f.project, ".data/observability/bin/grafana")),
        [],
      );
      assert.equal(existsSync(join(f.outer, "escaped")), false);
    } finally {
      f.cleanup();
    }
  }
});

test("bounded HTTPS transport follows only official redirects", async () => {
  const originalFetch = globalThis.fetch;
  const f = fixture(simple);
  try {
    const calls: string[] = [];
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      if (calls.length === 1)
        return new Response(null, {
          status: 302,
          headers: {
            location: "https://release-assets.githubusercontent.com/fixture",
          },
        });
      return new Response(readFileSync(f.archive));
    };
    const installer = createInstallerForTest([f.component]);
    const result = await installer.installComponents(f.project);
    assert.equal(result.length, 1);
    assert.deepEqual(calls, [
      f.component.url,
      "https://release-assets.githubusercontent.com/fixture",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    f.cleanup();
  }
});

test("transport refuses foreign redirects, downgrade, excess bytes and missing body", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const variant of ["foreign", "http", "oversize", "error", "loop"]) {
      const f = fixture(simple);
      try {
        let requests = 0;
        globalThis.fetch = async () => {
          requests++;
          if (variant === "foreign")
            return new Response(null, {
              status: 302,
              headers: { location: "https://example.invalid/component" },
            });
          if (variant === "http")
            return new Response(null, {
              status: 302,
              headers: { location: "http://dl.grafana.com/component" },
            });
          if (variant === "loop")
            return new Response(null, {
              status: 302,
              headers: { location: f.component.url },
            });
          if (variant === "error") return new Response(null, { status: 503 });
          return new Response(Buffer.alloc(f.component.archiveBytes + 1));
        };
        await assert.rejects(
          createInstallerForTest([f.component]).installComponents(f.project),
        );
        assert.equal(requests, variant === "loop" ? 6 : 1);
        assert.deepEqual(
          readdirSync(join(f.project, ".data/observability/cache")),
          [],
        );
        assert.deepEqual(
          readdirSync(join(f.project, ".data/observability/bin/grafana")),
          [],
        );
      } finally {
        f.cleanup();
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test(
  "normal installer refuses unsupported host without downloading",
  { skip: process.platform === "darwin" && process.arch === "arm64" },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "jarvis-installer-platform-"));
    try {
      await assert.rejects(installComponents(directory), /macOS arm64/);
      assert.deepEqual(readdirSync(directory), []);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
