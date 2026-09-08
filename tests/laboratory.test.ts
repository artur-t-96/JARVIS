import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { LocalLaboratory } from "../src/laboratory.js";
import { Engine } from "../src/engine.js";
import type { Principal } from "../src/contracts.js";

test("real isolated HTTP laboratory repairs only after exact approval and retains state across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-lab-http-"));
  let lab = new LocalLaboratory(join(dir, "lab.sqlite"));
  await lab.start();
  const actors: Principal[] = ["a", "b"].map((tenantId) => ({
    tenantId,
    id: "operator",
    roles: ["operator", "approver"],
    scopes: ["it"],
  }));
  let engine = new Engine({
    dbPath: join(dir, "core.sqlite"),
    tools: lab.tools(),
    principals: actors,
    policies: actors.map((p) => ({
      tenantId: p.tenantId,
      version: "1",
      name: "Test",
      allowedTools: lab.tools().map((t) => t.id),
      approvalTools: [],
      allowSelfApproval: true,
    })),
  });
  async function inspect(p: Principal) {
    let run = engine.createRun(
      p,
      "Read actual lab HTTP",
      {
        title: "HTTP",
        summary: "Local only",
        steps: [
          { id: "inspect", title: "HTTP", toolId: "lab.inspect", input: {} },
        ],
      },
      randomUUID(),
    );
    engine.start(p, run.id);
    for (let i = 0; i < 4; i++) await engine.tick();
    run = engine.getRun(p, run.id);
    assert.equal(run.status, "completed");
    return run.steps[0]!.output!.data;
  }
  try {
    assert.equal((await inspect(actors[0]!)).httpStatus, 503);
    let run = engine.createRun(
      actors[0]!,
      "Repair own lab",
      {
        title: "Repair",
        summary: "Only own lab",
        steps: [
          {
            id: "repair",
            title: "Repair",
            toolId: "lab.repair",
            input: { expectedVersion: 0 },
          },
        ],
      },
      randomUUID(),
    );
    engine.start(actors[0]!, run.id);
    await engine.tick();
    run = engine.getRun(actors[0]!, run.id);
    assert.equal(run.status, "waiting_approval");
    assert.equal((await inspect(actors[0]!)).httpStatus, 503);
    const approval = run.steps[0]!.approval!;
    engine.approve(actors[0]!, run.id, {
      approvalId: approval.id,
      bindingHash: approval.bindingHash,
      decision: "approved",
    });
    for (let i = 0; i < 4; i++) await engine.tick();
    run = engine.getRun(actors[0]!, run.id);
    assert.equal(run.status, "completed");
    assert.equal(
      run.steps[0]!.verification!.evidence[0]!.data!.httpStatus,
      200,
    );
    assert.equal(
      (await inspect(actors[1]!)).httpStatus,
      503,
      "another company fixture remains separate",
    );
    engine.close();
    await lab.close();
    lab = new LocalLaboratory(join(dir, "lab.sqlite"));
    await lab.start();
    engine = new Engine({
      dbPath: join(dir, "core.sqlite"),
      tools: lab.tools(),
      principals: actors,
      policies: actors.map((p) => ({
        tenantId: p.tenantId,
        version: "1",
        name: "Test",
        allowedTools: lab.tools().map((t) => t.id),
        approvalTools: [],
        allowSelfApproval: true,
      })),
    });
    assert.equal((await inspect(actors[0]!)).httpStatus, 200);
    assert.equal((await inspect(actors[0]!)).version, 1);
  } finally {
    engine.close();
    await lab.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
