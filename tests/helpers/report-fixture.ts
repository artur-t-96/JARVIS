import { randomUUID } from "node:crypto";
import { stocktakeFixture } from "./stocktake-fixture.js";
import type { ReportDefinition } from "../../src/operational-reports.js";
import type { JsonObject } from "../../src/contracts.js";
export function reportFixture(
  directory: string,
  options: Parameters<typeof stocktakeFixture>[1] = {},
) {
  const f = stocktakeFixture(directory, options);
  const prepare = (
    tenant = "synthetic-a",
    definition: ReportDefinition = { kind: "equipment" },
    documentId?: string,
  ) => {
    const actor = f.actor("manager", tenant),
      preview = f.workspace.operationalReportPreview(actor, definition);
    return f.workspace.prepareOperationalReport(actor, {
      title: "Syntetyczny raport operacyjny",
      definition,
      previewHash: preview.previewHash,
      profileVersion: preview.profileVersion,
      idempotencyKey: randomUUID(),
      ...(documentId
        ? {
            id: documentId,
            expectedVersion: f.get("documents", documentId, tenant).version,
            changeNote: "Jawne odświeżenie syntetycznego raportu",
          }
        : {}),
    }) as JsonObject;
  };
  const createReport = async (
    tenant = "synthetic-a",
    definition: ReportDefinition = { kind: "equipment" },
  ) => {
    const input = prepare(tenant, definition),
      run = await f.complete(
        "ops.documents.createReport",
        input,
        "manager",
        tenant,
      );
    return {
      input,
      run,
      document: f.get(
        "documents",
        String(run.steps[0]!.output!.data.entityId),
        tenant,
      ),
    };
  };
  return { ...f, prepare, createReport };
}
