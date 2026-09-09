import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { assetImportFixture, csvBody } from "./helpers/asset-import-fixture.js";
const headers = (id = "manager", tenant = "synthetic-a") => ({
  authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
  host: "127.0.0.1:4330",
  origin: "http://127.0.0.1:4330",
});
test("CSV preview is read-only; staged proposals are run-bound and authorized; replay, history and downloads remain tenant-local", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-import-api-")),
    f = assetImportFixture(dir),
    app = createApp({
      ...f,
      planner: {
        kind: "test",
        async plan() {
          throw Error("No provider");
        },
      },
    });
  try {
    const previewRequest = {
      method: "POST" as const,
      url: "/api/asset-imports/preview",
      headers: headers(),
      payload: f.source(),
    };
    assert.equal(
      (await app.inject({ ...previewRequest, headers: headers("it-one") }))
        .statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          ...previewRequest,
          headers: { host: "127.0.0.1:4330" },
        })
      ).statusCode,
      401,
    );
    const previewResponse = await app.inject(previewRequest);
    assert.equal(previewResponse.statusCode, 200, previewResponse.body);
    assert.equal(existsSync(join(dir, "attachments")), false);
    const preview = previewResponse.json().preview,
      uploadId = randomUUID(),
      payload = {
        ...f.source(),
        uploadId,
        previewHash: preview.previewHash,
        selectedRows: [1, 2],
        profileVersion: preview.profileVersion,
        note: "SYNTHETIC_SOURCE_NOTE",
      };
    const prepared = await app.inject({
      method: "POST",
      url: "/api/asset-imports/prepare",
      headers: headers(),
      payload,
    });
    assert.equal(prepared.statusCode, 201, prepared.body);
    const run = prepared.json().run;
    assert.equal(run.status, "planned");
    assert.equal(f.workspace.list(f.actor(), "assets").length, 0);
    assert.equal(
      JSON.stringify(run).includes("0000123"),
      false,
      "Raw source values must not enter the Core plan/model context",
    );
    const path = `/api/runs/${run.id}/asset-import/import`;
    const review = await app.inject({
      url: path,
      headers: headers("reviewer"),
    });
    assert.equal(review.statusCode, 200, review.body);
    assert.equal(
      review.json().proposal.preview.rows[0].asset.serial,
      "0000123",
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
      (await app.inject({ url: path, headers: headers("it-one") })).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/runs/${run.id}/asset-import/missing`,
          headers: headers(),
        })
      ).statusCode,
      404,
    );
    f.engine.start(f.actor(), run.id);
    await f.engine.tick();
    f.approve(f.engine.getRun(f.actor(), run.id));
    await f.engine.tick();
    assert.equal(f.engine.getRun(f.actor(), run.id).status, "completed");
    const replay = await app.inject({
      method: "POST",
      url: "/api/asset-imports/prepare",
      headers: headers(),
      payload,
    });
    assert.equal(replay.statusCode, 201, replay.body);
    assert.equal(replay.json().run.id, run.id);
    const changed = await app.inject({
      method: "POST",
      url: "/api/asset-imports/prepare",
      headers: headers(),
      payload: { ...payload, note: "Changed" },
    });
    assert.equal(changed.statusCode, 409, changed.body);
    for (const url of [
      `/api/asset-imports/${uploadId}`,
      `/api/asset-imports/${uploadId}/source`,
    ]) {
      assert.equal(
        (await app.inject({ url, headers: headers("manager", "synthetic-b") }))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url, headers: headers("it-one") })).statusCode,
        403,
      );
    }
    assert.equal(
      (await app.inject({ url: path, headers: headers("reviewer") })).json()
        .proposal.status,
      "applied",
    );
    const source = await app.inject({
      url: `/api/asset-imports/${uploadId}/source`,
      headers: headers(),
    });
    assert.equal(source.statusCode, 200, source.body);
    assert.deepEqual(source.rawPayload, csvBody);
    assert.equal(source.headers["x-content-type-options"], "nosniff");
    assert.match(String(source.headers["content-disposition"]), /^attachment;/);
    assert.equal(
      (
        await app.inject({
          url: "/api/asset-imports?limit=1",
          headers: headers(),
        })
      ).json().total,
      1,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/asset-imports?limit=0",
          headers: headers(),
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          ...previewRequest,
          payload: { ...f.source(), tenantId: "synthetic-b" },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          ...previewRequest,
          headers: { ...headers(), origin: "https://untrusted.invalid" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          ...previewRequest,
          payload: { ...f.source(), contentBase64: "A".repeat(800_000) },
        })
      ).statusCode,
      413,
    );
    const core = readFileSync(join(dir, "core.sqlite")).toString("utf8");
    assert.equal(core.includes("0000123"), false);
  } finally {
    await app.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
