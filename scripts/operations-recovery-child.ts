import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Engine } from "../src/engine.js";
import type { Principal } from "../src/contracts.js";
import { WorkspaceStore } from "../src/workspace.js";

const [mode, directory, runId] = process.argv.slice(2);
if (!directory || !["seed", "apply", "resume"].includes(mode ?? ""))
  throw new Error("Synthetic recovery fixture arguments missing");
const emit = (message: object) =>
  process.stdout.write(`${JSON.stringify(message)}\n`);
const operator: Principal = {
  id: "operator",
  tenantId: "synthetic-a",
  roles: ["operator"],
  scopes: ["*"],
};
const approver: Principal = {
  ...operator,
  id: "approver",
  roles: ["approver"],
};
const workspace = new WorkspaceStore(join(directory, "operations.sqlite"));
const calls = new DatabaseSync(join(directory, "test-calls.sqlite"));
calls.exec(
  "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY)",
);
let hold: ReturnType<typeof setInterval> | undefined;
const tools = workspace.tools().map((tool) =>
  tool.id !== "ops.assets.create"
    ? tool
    : {
        ...tool,
        async execute(...args: Parameters<typeof tool.execute>) {
          calls.prepare("INSERT INTO calls DEFAULT VALUES").run();
          const result = await tool.execute(...args);
          if (mode === "apply") {
            hold = setInterval(() => {}, 1000);
            emit({ type: "effect_applied" });
            await new Promise<void>(() => {});
          }
          return result;
        },
      },
);
const engine = new Engine({
  dbPath: join(directory, "core.sqlite"),
  tools,
  principals: [operator, approver],
  policies: [
    {
      tenantId: operator.tenantId,
      name: "Synthetic",
      version: "1",
      allowedTools: tools.map((t) => t.id),
      approvalTools: [],
      allowSelfApproval: false,
    },
  ],
  leaseMs: 50,
  clock: () => (mode === "seed" ? 1000 : mode === "apply" ? 2000 : 3000),
  workerId: `ops-child-${mode}`,
});
try {
  if (mode === "seed") {
    const run = engine.createRun(
      operator,
      "Create a synthetic local asset",
      {
        title: "Synthetic asset",
        summary: "Test only",
        steps: [
          {
            id: "create",
            title: "Create",
            toolId: "ops.assets.create",
            input: {
              title: "SIGKILL TEST ONLY",
              data: {
                assetType: "laptop",
                serial: "SIGKILL-TEST-1",
                location: "Synthetic fixture",
                condition: "good",
              },
            },
          },
        ],
      },
      "ops-process-test",
    );
    engine.start(operator, run.id);
    await engine.tick();
    const current = engine.getRun(operator, run.id);
    if (current.status !== "waiting_approval")
      throw new Error("Approval wait missing");
    hold = setInterval(() => {}, 1000);
    emit({
      type: "waiting",
      runId: run.id,
      status: current.status,
      effects: workspace.list(operator, "assets").length,
    });
    await new Promise<void>(() => {});
  }
  if (!runId) throw new Error("Missing run ID");
  if (mode === "apply") {
    const run = engine.getRun(operator, runId),
      approval = run.steps[0]!.approval!;
    if (run.status !== "waiting_approval")
      throw new Error("Persisted approval lost");
    engine.approve(approver, runId, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    await engine.tick();
    throw new Error("Expected process kill after committed operations effect");
  }
  for (let i = 0; i < 10; i++) await engine.tick();
  const current = engine.getRun(operator, runId);
  const probe = new DatabaseSync(join(directory, "operations.sqlite"), {
    readOnly: true,
  });
  try {
    emit({
      type: "finished",
      status: current.status,
      effects: workspace.list(operator, "assets").length,
      calls: Number(calls.prepare("SELECT COUNT(*) AS n FROM calls").get()!.n),
      verified: current.steps.every((s) => s.verification?.ok === true),
      audit: Number(
        probe.prepare("SELECT COUNT(*) AS n FROM ops_audit").get()!.n,
      ),
      outbox: Number(
        probe.prepare("SELECT COUNT(*) AS n FROM ops_outbox").get()!.n,
      ),
    });
  } finally {
    probe.close();
  }
} finally {
  if (hold) clearInterval(hold);
  engine.close();
  workspace.close();
  calls.close();
}
