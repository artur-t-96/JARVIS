import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  LocalRuntime,
  operationalAccountsReady,
  runtimePaths,
  validateNodeVersion,
} from "../src/local-runtime.js";
import { KeychainSecrets } from "../src/secrets.js";
import { rotatingLogWriter } from "../src/local-supervisor.js";

const commit = "a".repeat(40);
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}
function fixture(sha = commit) {
  const root = mkdtempSync(join(tmpdir(), "jarvis-local-runtime-"));
  writeFileSync(
    join(root, "package.json"),
    '{"name":"jarvis-core","type":"module"}',
  );
  writeFileSync(
    join(root, "package-lock.json"),
    '{"name":"jarvis-core","lockfileVersion":3}',
  );
  const runtime = new LocalRuntime(root, {
    sourceRevision: () => sha,
    stopTimeoutMs: 3000,
    startTimeoutMs: 4000,
    build: async () => {
      mkdirSync(join(root, "dist", "web"), { recursive: true });
      writeFileSync(
        join(root, "dist", "web", "index.html"),
        "<title>Fixture</title>",
      );
      writeFileSync(
        join(root, "dist", "build.json"),
        JSON.stringify({ gitSha: sha, node: process.version }),
      );
      writeFileSync(
        join(root, "dist", "local-supervisor.js"),
        `import{spawn}from'node:child_process';const child=spawn(process.execPath,[process.argv[2]],{env:process.env,stdio:'ignore'});process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('close',code=>{process.exitCode=code??0;});`,
      );
      writeFileSync(
        join(root, "dist", "server.js"),
        `import{createServer}from'node:http';import{writeFileSync,unlinkSync}from'node:fs';import{join}from'node:path';import{hostname}from'node:os';import{randomUUID}from'node:crypto';const lock=join(process.env.JARVIS_DATA_DIR,'.jarvis-data.lock');writeFileSync(lock,JSON.stringify({pid:process.pid,host:hostname(),token:randomUUID(),kind:'runtime'}));const server=createServer((req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true,version:process.env.GIT_SHA}));});server.listen(Number(process.env.PORT),'127.0.0.1');process.on('SIGTERM',()=>server.close(()=>{unlinkSync(lock);process.exit(0);}));`,
      );
    },
  });
  return {
    root,
    runtime,
    async close() {
      for (const mode of ["lab", "operational"] as const) {
        try {
          await runtime.stop(mode);
        } catch {
          /* Tests never signal an unowned process. */
        }
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function accounts(path: string, rows: [string, string[]][]) {
  mkdirSync(path, { recursive: true });
  const db = new DatabaseSync(join(path, "accounts.sqlite"));
  db.exec("CREATE TABLE users(tenant_id TEXT,roles TEXT,disabled INTEGER);");
  for (const [tenant, roles] of rows)
    db.prepare("INSERT INTO users VALUES(?,?,0)").run(
      tenant,
      JSON.stringify(roles),
    );
  db.close();
}

test("Node gate and separate mode paths reject wrong runtimes and unsupported mode", () => {
  validateNodeVersion("v22.23.0");
  validateNodeVersion("22.24.1");
  for (const version of ["v20.19.0", "v22.18.0", "v24.0.0", "unknown"])
    assert.throws(() => validateNodeVersion(version), /Node.js/);
  assert.notEqual(
    runtimePaths("/tmp/JARVIS", "lab").dataDir,
    runtimePaths("/tmp/JARVIS", "operational").dataDir,
  );
  assert.throws(() => runtimePaths("/tmp/JARVIS", "other" as "lab"), /Choose/);
});

test("install/start/status/stop prove actual local process identity and exact served SHA", async () => {
  const ctx = fixture();
  try {
    const installed = await ctx.runtime.install();
    assert.equal(installed.gitSha, commit);
    const started = await ctx.runtime.start({
      mode: "lab",
      port: await freePort(),
    });
    assert.equal(started.gitSha, commit);
    assert.equal(started.provider, "disabled");
    const status = await ctx.runtime.status("lab");
    assert.equal(status.running, true);
    assert.equal(status.ready, true);
    assert.equal(status.buildVerified, true);
    assert.equal(status.servedSha, commit);
    await assert.rejects(ctx.runtime.update(), /Stop both/);
    assert.equal((await ctx.runtime.stop("lab")).stopped, true);
    assert.equal((await ctx.runtime.status("lab")).running, false);
    assert.equal((await ctx.runtime.update()).gitSha, commit);
  } finally {
    await ctx.close();
  }
});

test("operational launch requires accounts from the same firm and a clean immutable build", async () => {
  const ctx = fixture();
  try {
    await ctx.runtime.install();
    await assert.rejects(
      ctx.runtime.start({ mode: "operational", port: await freePort() }),
      /accounts are required/,
    );
    const data = runtimePaths(ctx.root, "operational").dataDir;
    accounts(data, [
      ["tenant-a", ["operator"]],
      ["tenant-b", ["approver"]],
    ]);
    assert.equal(operationalAccountsReady(data), false);
    const db = new DatabaseSync(join(data, "accounts.sqlite"));
    db.prepare("INSERT INTO users VALUES(?,?,0)").run(
      "tenant-a",
      JSON.stringify(["approver"]),
    );
    db.close();
    assert.equal(operationalAccountsReady(data), true);
    const started = await ctx.runtime.start({
      mode: "operational",
      port: await freePort(),
    });
    assert.equal(started.mode, "operational");
    assert.equal((await ctx.runtime.status("lab")).running, false);
  } finally {
    await ctx.close();
  }
  const dirty = fixture(commit + "-dirty");
  try {
    await dirty.runtime.install();
    await assert.rejects(
      dirty.runtime.start({ mode: "operational" }),
      /exact clean commit/,
    );
  } finally {
    await dirty.close();
  }
});

test("changed document fonts and unmanifested assets block the installed runtime", async () => {
  const ctx = fixture();
  try {
    mkdirSync(join(ctx.root, "assets", "fonts"), { recursive: true });
    const font = join(ctx.root, "assets", "fonts", "synthetic.ttf");
    writeFileSync(font, "Synthetic font bytes for integrity test only");
    await ctx.runtime.install();
    writeFileSync(font, "Altered font");
    assert.throws(() => ctx.runtime.installed(), /build changed/);
    await ctx.runtime.update();
    const extra = join(ctx.root, "assets", "unexpected.ttf");
    writeFileSync(extra, "Unmanifested bytes");
    assert.throws(
      () => ctx.runtime.installed(),
      /outside the install manifest/,
    );
    rmSync(extra);
    assert.equal(ctx.runtime.installed().gitSha, commit);
    rmSync(font);
    assert.throws(() => ctx.runtime.installed());
  } finally {
    await ctx.close();
  }
});

test("tampered or extra build files block startup, and stale metadata never permits signalling an unrelated PID", async () => {
  const ctx = fixture();
  try {
    await ctx.runtime.install();
    writeFileSync(join(ctx.root, "dist", "web", "index.html"), "changed");
    assert.throws(() => ctx.runtime.installed(), /build changed/);
    await ctx.runtime.update();
    writeFileSync(join(ctx.root, "dist", "extra.js"), "unexpected");
    assert.throws(
      () => ctx.runtime.installed(),
      /outside the install manifest/,
    );
    rmSync(join(ctx.root, "dist", "extra.js"));
    const paths = runtimePaths(ctx.root, "lab");
    writeFileSync(
      paths.statePath,
      JSON.stringify({
        formatVersion: 1,
        mode: "lab",
        pid: process.pid,
        port: 4310,
        command: "unrelated-process",
        lockToken: "spoof",
      }),
    );
    assert.equal(
      (await ctx.runtime.status("lab")).reason,
      "unverified_process",
    );
    await assert.rejects(ctx.runtime.stop("lab"), /No process was signalled/);
    process.kill(process.pid, 0);
    assert.ok(readFileSync(paths.statePath, "utf8").includes("spoof"));
  } finally {
    await ctx.close();
  }
});

test("Keychain secret stays out of argv/status, is scoped by mode, and rejects stdin command injection", async () => {
  let stored = "";
  const calls: { args: string[]; stdin?: string }[] = [];
  const run = async (args: string[], stdin?: string) => {
    calls.push({ args, stdin });
    if (args[0] === "-i") stored = stdin!.trim().split(" ").at(-1)!;
    return {
      code: stored ? 0 : 1,
      stdout: args.includes("-w") ? stored + "\n" : "metadata-only",
    };
  };
  const keychain = new KeychainSecrets("/tmp/JARVIS", "operational", {
    platform: "darwin",
    run,
  });
  const secret = "fixture-provider-" + "a".repeat(24);
  await keychain.set(secret);
  assert.equal(await keychain.read(), secret);
  const status = await keychain.status();
  assert.equal(status.configured, true);
  assert.ok(!JSON.stringify(status).includes(secret));
  assert.ok(
    calls.every((call) => !call.args.some((arg) => arg.includes(secret))),
  );
  assert.equal(calls[0]!.args[0], "-i");
  await assert.rejects(
    keychain.set("safe\nremove-keychain"),
    /Invalid provider credential/,
  );
  const lab = new KeychainSecrets("/tmp/JARVIS", "lab", {
    platform: "darwin",
    run,
  });
  await lab.status();
  assert.notEqual(
    calls.at(-1)!.args[calls.at(-1)!.args.indexOf("-a") + 1],
    calls[1]!.args[calls[1]!.args.indexOf("-a") + 1],
  );
  const otherOS = new KeychainSecrets("/tmp/JARVIS", "lab", {
    platform: "linux",
    run,
  });
  assert.equal((await otherOS.status()).available, false);
  await assert.rejects(otherOS.read(), /macOS Keychain/);
});

test("supervisor logs have bounded files and private permissions even with an oversized native chunk", () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-log-rotation-"));
  const path = join(dir, "runtime.log");
  try {
    const write = rotatingLogWriter(path, 64, 2);
    for (let index = 0; index < 20; index++)
      write(`event-${index}-` + "a".repeat(40) + "\n");
    write("b".repeat(500));
    const files = readdirSync(dir);
    assert.equal(files.length, 3);
    for (const file of files) {
      assert.ok(statSync(join(dir, file)).size <= 64);
      assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
    }
    assert.equal(readFileSync(path, "utf8"), "b".repeat(64));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
