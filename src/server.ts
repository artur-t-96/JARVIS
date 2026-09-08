import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createDemoTools } from "./tools.js";
import { AnthropicPlanner, DemoPlanner } from "./planner.js";
import { Engine } from "./engine.js";
import { createApp } from "./app.js";
import { WorkspaceStore } from "./workspace.js";
import { Conversations } from "./assistant.js";
import { Accounts } from "./accounts.js";
import { Diagnostics } from "./diagnostics.js";
import { InitiativeStore } from "./initiative.js";
import { LocalLaboratory } from "./laboratory.js";
import { VoiceService } from "./voice.js";
import { acquireDataLock } from "./backup.js";

process.umask(0o077);
const config = loadConfig();
const lock = acquireDataLock(config.dataDir, "runtime");
let version = process.env.GIT_SHA ?? "development";
try {
  const build = JSON.parse(
    readFileSync(new URL("./build.json", import.meta.url), "utf8"),
  );
  version = build.gitSha;
} catch {
  /* Source mode explicitly reports development. */
}
const diagnostics = new Diagnostics({ dataDir: config.dataDir, version });
const demo = createDemoTools(resolve(config.dataDir, "demo-effects.sqlite"));
const workspace = new WorkspaceStore(
  resolve(config.dataDir, "operations.sqlite"),
);
const initiatives = new InitiativeStore(
  resolve(config.dataDir, "initiatives.sqlite"),
  workspace,
);
workspace.setProfileProvider((tenantId) =>
  initiatives.profileForTenant(tenantId),
);
const accounts = new Accounts(resolve(config.dataDir, "accounts.sqlite"));
const laboratory = new LocalLaboratory(
  resolve(config.dataDir, "laboratory.sqlite"),
);
await laboratory.start();
const voice = new VoiceService(config.dataDir);
const tools = [
  ...demo.tools,
  ...workspace.tools(),
  ...laboratory.tools(),
  ...initiatives.tools(),
];
if (config.mode === "local") {
  config.policies[0] = {
    ...config.policies[0]!,
    version: "dynaminds-local-v1",
    name: "Dynaminds — laboratorium lokalne",
    allowedTools: tools.map((t) => t.id),
  };
} else if (config.mode === "accounts") {
  config.principals = accounts.principals();
  config.policies = [...new Set(config.principals.map((p) => p.tenantId))].map(
    (tenantId) => ({
      tenantId,
      name: tenantId,
      version: "workspace-accounts-v1",
      allowedTools: tools.map((t) => t.id),
      approvalTools: [],
      allowSelfApproval: true,
    }),
  );
}
const engine = new Engine({
  dbPath: resolve(config.dataDir, "jarvis.sqlite"),
  tools,
  policies: config.policies,
  principals: config.principals,
  onEvent: (event, details) =>
    diagnostics.log("info", `execution.${event}`, details),
});
const planner =
  config.plannerKind === "anthropic"
    ? AnthropicPlanner.fromEnv()
    : new DemoPlanner();
const conversations = new Conversations(
  resolve(config.dataDir, "assistant.sqlite"),
  workspace,
  engine,
  tools,
  config.plannerKind === "anthropic"
    ? {
        apiKey: process.env.ANTHROPIC_API_KEY!,
        model: process.env.ANTHROPIC_MODEL!,
        ...(process.env.JARVIS_MODEL_PRICING
          ? { pricing: JSON.parse(process.env.JARVIS_MODEL_PRICING) }
          : {}),
      }
    : undefined,
);
const app = createApp({
  engine,
  config,
  planner,
  tools,
  version,
  workspace,
  accounts,
  conversations,
  diagnostics,
  voice,
  initiatives,
});
let stopping = false;
let current: Promise<boolean> | undefined;
let lastScan = 0;
const interval = setInterval(() => {
  if (stopping || current) return;
  if (config.mode === "accounts") engine.setPrincipals(accounts.principals());
  if (Date.now() - lastScan > 30_000) {
    lastScan = Date.now();
    for (const p of config.mode === "accounts"
      ? accounts.principals()
      : config.principals) {
      try {
        initiatives.scan(p);
      } catch {
        diagnostics.log("warn", "initiative.scan.failed");
      }
    }
  }
  current = diagnostics
    .withWorkerTick(
      () => engine.tick(),
      () => engine.queue(),
    )
    .catch(() => false)
    .finally(() => {
      current = undefined;
    });
}, 300);
async function stop() {
  if (stopping) return;
  stopping = true;
  diagnostics.setMaintenance(true);
  clearInterval(interval);
  await app.close();
  if (current) await current;
  conversations.close();
  initiatives.close();
  engine.close();
  workspace.close();
  demo.close();
  accounts.close();
  await laboratory.close();
  await diagnostics.close();
  lock.release();
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
try {
  await app.listen({ host: config.host, port: config.port });
  diagnostics.log("info", "installation.started", { status: config.mode });
} catch {
  await stop();
  process.exitCode = 1;
}
