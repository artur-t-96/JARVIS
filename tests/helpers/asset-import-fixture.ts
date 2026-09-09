import { randomUUID } from "node:crypto";
import type { JsonObject } from "../../src/contracts.js";
import { custodyFixture } from "./custody-fixture.js";
export const csvBody = Buffer.from(
  "nazwa;typ;numer_seryjny;lokalizacja;stan;producent\r\nLaptop A;laptop;0000123;Magazyn;sprawny;Synthetic\r\nMonitor B;monitor;0000456;Serwis;wymaga naprawy;Synthetic\r\n",
  "utf8",
);
export function assetImportFixture(
  directory: string,
  options: Parameters<typeof custodyFixture>[1] = {},
) {
  const f = custodyFixture(directory, options);
  const source = (body = csvBody) => ({
    filename: "synthetic-equipment.csv",
    sourceName: "Syntetyczna ewidencja",
    observedOn: "2026-09-08",
    delimiter: ";" as const,
    contentBase64: body.toString("base64"),
  });
  const prepare = (
    tenant = "synthetic-a",
    body = csvBody,
    selectedRows?: number[],
  ) => {
    const p = f.actor("manager", tenant),
      input = source(body),
      preview = f.workspace.assetImportPreview(p, input);
    return f.workspace.prepareAssetImport(p, {
      ...input,
      uploadId: randomUUID(),
      previewHash: preview.previewHash,
      profileVersion: preview.profileVersion,
      selectedRows:
        selectedRows ??
        preview.rows.filter((r) => r.eligible).map((r) => r.sourceRow),
      note: "Syntetyczna próba; import danych bez fizycznego wydania.",
    }) as JsonObject;
  };
  return { ...f, source, prepare };
}
