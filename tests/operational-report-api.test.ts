import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { reportFixture } from "./helpers/report-fixture.js";
import { approveDocument } from "./helpers/document-fixture.js";
test("HTTP report preview and run-bound review require complete source access, use no model and export a separately approved document", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-report-api-")),
    f = reportFixture(dir);
  const app = createApp({
    ...f,
    planner: {
      kind: "test",
      async plan() {
        throw Error("Report must not call a model");
      },
    },
  });
  const headers = (actor = "manager", tenant = "synthetic-a") => ({
    authorization: `Bearer synthetic-custody-${tenant}-${actor}-aaaaaaaaaaaaaaaa`,
  });
  try {
    const asset = await f.newAsset();
    const preview = await app.inject({
      method: "POST",
      url: "/api/operational-reports/preview",
      headers: headers(),
      payload: { kind: "equipment" },
    });
    assert.equal(preview.statusCode, 200, preview.body);
    const p = preview.json().preview;
    const payload = {
      title: "Raport HTTP — wyposażenie",
      definition: p.definition,
      previewHash: p.previewHash,
      profileVersion: p.profileVersion,
      idempotencyKey: randomUUID(),
    };
    const prepare = () =>
      app.inject({
        method: "POST",
        url: "/api/operational-reports/prepare",
        headers: headers(),
        payload,
      });
    const response = await prepare();
    assert.equal(response.statusCode, 201, response.body);
    const run = response.json().run;
    assert.equal((await prepare()).json().run.id, run.id);
    assert.equal(JSON.stringify(run).includes(asset.title), false);
    const path = `/api/runs/${run.id}/operational-report/report`;
    assert.equal((await app.inject({ url: path })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          url: path,
          headers: headers("reviewer", "synthetic-b"),
        })
      ).statusCode,
      404,
    );
    const saved = await app.inject({ url: path, headers: headers("reviewer") });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().proposal.snapshot.rows[0].title, asset.title);
    f.actor("reviewer").scopes = ["documents", "assets"];
    assert.equal(
      (await app.inject({ url: path, headers: headers("reviewer") }))
        .statusCode,
      403,
    );
    f.actor("reviewer").scopes = ["*"];
    f.engine.start(f.actor(), run.id);
    await f.engine.tick();
    f.approve(f.engine.getRun(f.actor(), run.id));
    await f.engine.tick();
    const done = f.engine.getRun(f.actor(), run.id);
    assert.equal(done.status, "completed");
    const documentId = String(done.steps[0]!.output!.data.entityId);
    await approveDocument(f, documentId);
    const exported = await app.inject({
      url: `/api/documents/${documentId}/export?format=pdf`,
      headers: headers(),
    });
    assert.equal(exported.statusCode, 200, exported.body.slice(0, 200));
    assert.equal(exported.rawPayload.subarray(0, 5).toString(), "%PDF-");
    assert.equal(
      (
        await app.inject({
          url: `/api/documents/${documentId}/export?format=docx`,
          headers: headers("reviewer", "synthetic-b"),
        })
      ).statusCode,
      404,
    );
    await f.newAsset();
    assert.equal(
      (
        await app.inject({
          url: `/api/documents/${documentId}/export?format=pdf`,
          headers: headers(),
        })
      ).statusCode,
      409,
    );
    const other = await app.inject({
      method: "POST",
      url: "/api/operational-reports/preview",
      headers: headers("manager", "synthetic-b"),
      payload: { kind: "equipment" },
    });
    assert.equal(other.json().preview.summary.rows, 0);
    for (const actor of ["it-one", "observer"])
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/operational-reports/preview",
            headers: headers(actor),
            payload: { kind: "equipment" },
          })
        ).statusCode,
        403,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/operational-reports/preview",
          headers: headers(),
          payload: { kind: "starts", from: "2026-09-32", to: "2026-09-30" },
        })
      ).statusCode,
      400,
    );
  } finally {
    await app.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
