import { randomUUID } from "node:crypto";
import type { JsonObject } from "../../src/contracts.js";
import type { CustodyFixture } from "./custody-fixture.js";
import { seedDocumentCase } from "./document-fixture.js";
export const fileBody = Buffer.from(
  "Syntetyczny dokument odbiorowy\nZażółć gęślą jaźń.\nTreść kontrolowana lokalnie.\n",
);
export async function seedFileDocument(
  f: CustodyFixture,
  tenant = "synthetic-a",
  fileRequired = false,
) {
  const { caseId, prepared } = await seedDocumentCase(f, tenant, fileRequired),
    r = await f.complete("ops.documents.create", prepared, "manager", tenant);
  return { caseId, documentId: String(r.steps[0]!.output!.data.entityId) };
}
export async function stageFile(
  f: CustodyFixture,
  id: string,
  tenant = "synthetic-a",
  body = fileBody,
  uploadId = randomUUID(),
): Promise<JsonObject> {
  const version = f.get("documents", id, tenant).version,
    staged = await f.workspace.prepareDocumentFile(
      f.actor("manager", tenant),
      id,
      version,
      uploadId,
      "Odbiór współpracy.txt",
      "text/plain",
      body,
    );
  return {
    id,
    expectedVersion: version,
    uploadId: staged.id,
    manifestHash: staged.manifestHash,
    filename: staged.filename,
    mediaType: staged.mediaType,
    bytes: staged.bytes,
    sha256: staged.sha256,
    expiresAt: staged.expiresAt,
    changeNote: "Syntetyczne powiązanie oryginalnego pliku z rewizją.",
  };
}
