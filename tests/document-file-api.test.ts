import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import { seedFileDocument, fileBody } from "./helpers/document-file-fixture.js";
import { fileHash } from "../src/document-files.js";
test("HTTP binary upload prepares an exact approved command; downloads and exports enforce tenant/auth and original bytes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-file-api-")),
    f = custodyFixture(dir),
    app = createApp({
      ...f,
      planner: {
        kind: "test",
        async plan() {
          throw Error("No model used");
        },
      },
    });
  const auth = (id = "manager", tenant = "synthetic-a") => ({
    authorization: `Bearer synthetic-custody-${tenant}-${id}-aaaaaaaaaaaaaaaa`,
  });
  try {
    const { documentId } = await seedFileDocument(f),
      key = randomUUID(),
      url = `/api/documents/${documentId}/files/prepare`,
      headers = {
        ...auth(),
        "content-type": "application/octet-stream",
        "x-jarvis-upload-id": key,
        "x-jarvis-document-version": "1",
        "x-jarvis-file-name": encodeURIComponent("Źródło.txt"),
        "x-jarvis-file-type": "text/plain",
        "x-jarvis-change-note": encodeURIComponent(
          "Syntetyczne sprawdzenie uploadu",
        ),
      };
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: Object.fromEntries(
            Object.entries(headers).filter(
              ([name]) => name !== "authorization",
            ),
          ),
          payload: fileBody,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { ...headers, origin: "https://foreign.invalid" },
          payload: fileBody,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { ...headers, ...auth("manager", "synthetic-b") },
          payload: fileBody,
        })
      ).statusCode,
      404,
    );
    const result = await app.inject({
      method: "POST",
      url,
      headers,
      payload: fileBody,
    });
    assert.equal(result.statusCode, 201, result.body);
    const run = result.json().run;
    assert.equal(run.steps[0].input.sha256, fileHash(fileBody));
    assert.equal(f.workspace.documentFiles(f.actor(), documentId).length, 0);
    assert.equal(f.get("documents", documentId).version, 1);
    assert.equal(
      (
        await app.inject({ method: "POST", url, headers, payload: fileBody })
      ).json().run.id,
      run.id,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers,
          payload: Buffer.from("different"),
        })
      ).statusCode,
      409,
    );
    f.engine.start(f.actor(), run.id);
    await f.engine.tick();
    assert.equal(f.engine.getRun(f.actor(), run.id).status, "waiting_approval");
    f.approve(f.engine.getRun(f.actor(), run.id));
    await f.engine.tick();
    assert.equal(f.engine.getRun(f.actor(), run.id).status, "completed");
    assert.equal(
      (
        await app.inject({ method: "POST", url, headers, payload: fileBody })
      ).json().run.id,
      run.id,
      "lost response replay works after staging cleanup",
    );
    const fileUrl = `/api/documents/${documentId}/files/${key}`;
    for (const path of [
      `/api/documents/${documentId}/files`,
      fileUrl,
      `/api/documents/${documentId}/export?format=pdf`,
      `/api/documents/${documentId}/export?format=docx`,
    ]) {
      assert.equal((await app.inject({ url: path })).statusCode, 401);
      assert.equal(
        (await app.inject({ url: path, headers: auth("it-one") })).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            url: path,
            headers: auth("manager", "synthetic-b"),
          })
        ).statusCode,
        404,
      );
      const response = await app.inject({ url: path, headers: auth() });
      assert.equal(response.statusCode, 200, response.body.slice(0, 150));
      if (path === fileUrl) {
        assert.deepEqual(response.rawPayload, fileBody);
        assert.equal(response.headers["x-artifact-sha256"], fileHash(fileBody));
        assert.match(
          String(response.headers["content-disposition"]),
          /filename\*=UTF-8''%C5%B9r%C3%B3d%C5%82o.txt/,
        );
        assert.equal(response.headers["x-content-type-options"], "nosniff");
      }
    }
    assert.equal(
      (
        await app.inject({
          url: `/api/documents/${documentId}/export?format=html`,
          headers: auth(),
        })
      ).statusCode,
      400,
    );
    const other = await seedFileDocument(f);
    assert.equal(
      (
        await app.inject({
          url: `/api/documents/${other.documentId}/files/${key}`,
          headers: auth(),
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
