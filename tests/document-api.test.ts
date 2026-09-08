import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import {
  approveDocument,
  reviseDocumentCase,
  seedDocumentCase,
} from "./helpers/document-fixture.js";
test("HTTP scope preparation, document control and source refresh preserve tenant ACL and require fresh approval", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-document-api-")),
    f = custodyFixture(dir),
    app = createApp({
      ...f,
      planner: {
        kind: "test",
        async plan() {
          throw new Error("No model used");
        },
      },
    });
  const headers = (id = "manager", tenant = "synthetic-a") => ({
    authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
  });
  try {
    const { caseId } = await seedDocumentCase(f),
      scopeUrl = `/api/cases/${caseId}/document-scope`;
    assert.equal(
      (await app.inject({ url: scopeUrl, headers: headers() })).json().scope
        .source.kind,
      "case_scope",
    );
    const prepared = await app.inject({
      method: "POST",
      url: "/api/document-templates/prepare",
      headers: headers(),
      payload: {
        templateId: "case_scope",
        sourceId: caseId,
        idempotencyKey: randomUUID(),
      },
    });
    assert.equal(prepared.statusCode, 201, prepared.body);
    const run = prepared.json().run;
    f.engine.start(f.actor(), run.id);
    await f.engine.tick();
    f.approve(f.engine.getRun(f.actor(), run.id));
    await f.engine.tick();
    const complete = f.engine.getRun(f.actor(), run.id);
    assert.equal(complete.status, "completed");
    const id = String(complete.steps[0]!.output!.data.entityId);
    await approveDocument(f, id);
    for (const path of [
      scopeUrl,
      `/api/documents/${id}/readiness`,
      `/api/documents/${id}/refresh-sources`,
      `/api/documents/${id}/export`,
    ]) {
      assert.equal((await app.inject({ url: path })).statusCode, 401);
      assert.equal(
        (await app.inject({ url: path, headers: headers("it-one") }))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: path,
            headers: headers("manager", "synthetic-b"),
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url: path, headers: headers() })).statusCode,
        200,
      );
    }
    await reviseDocumentCase(f, caseId);
    const stale = await app.inject({
      url: `/api/documents/${id}/export`,
      headers: headers(),
    });
    assert.equal(stale.statusCode, 409);
    const refresh = (
      await app.inject({
        url: `/api/documents/${id}/refresh-sources`,
        headers: headers(),
      })
    ).json().input;
    assert.equal(refresh.sources[0].version, 2);
    assert.equal(
      f.get("documents", id).data.revision,
      1,
      "refresh is read-only",
    );
    f.actor().scopes = ["documents"];
    assert.equal(
      (
        await app.inject({
          url: `/api/documents/${id}/readiness`,
          headers: headers(),
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
