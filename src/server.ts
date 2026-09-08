import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { createDemoTools } from "./tools.js";
import { AnthropicPlanner, DemoPlanner } from "./planner.js";
import { Engine } from "./engine.js";
import { createApp } from "./app.js";

process.umask(0o077);
const config = loadConfig();
const demo = createDemoTools(resolve(config.dataDir, "demo-effects.sqlite"));
const engine = new Engine({
  dbPath: resolve(config.dataDir, "jarvis.sqlite"),
  tools: demo.tools,
  policies: config.policies,
  principals: config.principals,
});
const planner =
  config.plannerKind === "anthropic"
    ? AnthropicPlanner.fromEnv()
    : new DemoPlanner();
let version = process.env.GIT_SHA ?? "development";
if (version === "development") {
  try {
    version = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    /* fresh checkout */
  }
}
const app = createApp({ engine, config, planner, tools: demo.tools, version });
let stopping = false;
let current: Promise<boolean> | undefined;
const interval = setInterval(() => {
  if (!stopping && !current) {
    current = engine
      .tick()
      .catch(() => {
        process.stderr.write(
          "JARVIS worker: nie udało się obsłużyć przebiegu; szczegóły dostawcy nie są logowane.\n",
        );
        return false;
      })
      .finally(() => {
        current = undefined;
      });
  }
}, 300);
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(interval);
  await app.close();
  if (current) await current;
  engine.close();
  demo.close();
}
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
await app.listen({ host: config.host, port: config.port });
process.stdout.write(
  `JARVIS Core v0.1 — http://${config.host}:${config.port} — ${config.mode} — planner: ${planner.kind}\n`,
);
