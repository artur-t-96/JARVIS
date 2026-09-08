import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { DomainError, type ToolContext } from "../src/contracts.js";
import { custodyFixture } from "./helpers/custody-fixture.js";
import { seedDocumentCase } from "./helpers/document-fixture.js";
test("document context rolls back with the record and receipt; damaged provenance cannot be reconciled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-document-integrity-")),
    f = custodyFixture(dir),
    db = new DatabaseSync(join(dir, "operations.sqlite"));
  try {
    const { prepared } = await seedDocumentCase(f);
    const tool = f.workspace
      .tools()
      .find((t) => t.id === "ops.documents.create")!;
    const ctx: ToolContext = {
      tenantId: "synthetic-a",
      actorId: "manager",
      approvedBy: "reviewer",
      runId: randomUUID(),
      stepId: "action",
      operationKey: randomUUID(),
      signal: new AbortController().signal,
    };
    db.exec(
      "CREATE TRIGGER reject_document_context BEFORE INSERT ON ops_document_versions BEGIN SELECT RAISE(ABORT,'synthetic document failure'); END",
    );
    await assert.rejects(
      tool.execute(ctx, prepared),
      /synthetic document failure/,
    );
    assert.equal(f.workspace.list(f.actor(), "documents").length, 0);
    for (const table of ["ops_commands", "ops_outbox"])
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM " + table + " WHERE operation_key=?")
          .get(ctx.operationKey)!.n,
        0,
      );
    db.exec("DROP TRIGGER reject_document_context");
    const result = await tool.execute(ctx, prepared),
      id = String(result.data.entityId);
    assert.equal((await tool.reconcile!(ctx, prepared)).status, "applied");
    const row = db
      .prepare(
        "SELECT context_json,context_hash,approved_by FROM ops_document_versions WHERE document_id=?",
      )
      .get(id)!;
    db.prepare(
      "UPDATE ops_document_versions SET context_json=NULL,context_hash=NULL WHERE document_id=?",
    ).run(id);
    assert.equal(f.workspace.documentReadiness(f.actor(), id).integrity, false);
    await assert.rejects(
      tool.reconcile!(ctx, prepared),
      (e: unknown) =>
        e instanceof DomainError && e.code === "DOCUMENT_STATE_INCONSISTENT",
    );
    db.prepare(
      "UPDATE ops_document_versions SET context_json=?,context_hash=? WHERE document_id=?",
    ).run(String(row.context_json), String(row.context_hash), id);
    db.prepare(
      "UPDATE ops_document_versions SET created_by='different-actor' WHERE document_id=?",
    ).run(id);
    await assert.rejects(
      tool.execute(ctx, prepared),
      (e: unknown) =>
        e instanceof DomainError && e.code === "DOCUMENT_STATE_INCONSISTENT",
    );
    assert.equal(f.workspace.list(f.actor(), "documents").length, 1);
  } finally {
    db.close();
    f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
