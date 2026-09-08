import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBackup, restoreBackup } from "../src/backup.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import {
  seedFileDocument,
  stageFile,
  fileBody,
} from "./helpers/document-file-fixture.js";
import { approveDocument } from "./helpers/document-fixture.js";
import { exportDocument } from "../src/document-export.js";
test("backup restores original file bytes and a pending approved-input plan without repeating the committed attachment", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-file-backup-")),
    data = join(root, "data");
  let f: ReturnType<typeof custodyFixture> | undefined;
  try {
    // Workspace owns the data directory in this fixture.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(data);
    f = custodyFixture(data);
    const { documentId } = await seedFileDocument(f),
      first = await stageFile(f, documentId),
      done = await f.complete("ops.documents.attachFile", first);
    await approveDocument(f, documentId);
    const before = await exportDocument(
      f.workspace,
      f.actor(),
      documentId,
      "pdf",
      () => f!.actor(),
    );
    const secondBody = Buffer.from("Syntetyczny drugi dokument — zażółć."),
      second = await stageFile(f, documentId, "synthetic-a", secondBody),
      pending = await f.stage("ops.documents.attachFile", second);
    f.close();
    f = undefined;
    const backup = await createBackup({
      dataDir: data,
      destination: join(root, "backup"),
      buildVersion: "synthetic-p09a2",
    });
    assert.ok(backup.manifest.files.some((v) => v.path.includes("/saved/")));
    assert.ok(backup.manifest.files.some((v) => v.path.includes("/staged/")));
    await restoreBackup({
      source: backup.destination,
      targetDir: join(root, "restored"),
    });
    f = custodyFixture(join(root, "restored"));
    assert.deepEqual(
      f.workspace.readDocumentFile(
        f.actor(),
        documentId,
        String(first.uploadId),
      ).body,
      fileBody,
    );
    assert.equal(
      (
        await exportDocument(f.workspace, f.actor(), documentId, "pdf", () =>
          f!.actor(),
        )
      ).sha256,
      before.sha256,
    );
    assert.equal(f.engine.getRun(f.actor(), done.id).status, "completed");
    f.approve(f.engine.getRun(f.actor(), pending.id));
    for (let i = 0; i < 3; i++) await f.engine.tick();
    const finished = f.engine.getRun(f.actor(), pending.id);
    assert.equal(finished.status, "completed");
    assert.equal(finished.steps[0]!.attempts, 1);
    assert.equal(finished.steps[0]!.verification!.ok, true);
    assert.equal(f.get("documents", documentId).data.revision, 3);
    assert.equal(f.workspace.documentFiles(f.actor(), documentId).length, 2);
    assert.deepEqual(
      f.workspace.readDocumentFile(
        f.actor(),
        documentId,
        String(second.uploadId),
      ).body,
      secondBody,
    );
  } finally {
    f?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
