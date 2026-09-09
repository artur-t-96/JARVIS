import type { DatabaseSync } from "node:sqlite";
import { DomainError } from "./contracts.js";
import {
  MAX_REPORT_ROWS,
  type ReportDefinition,
} from "./operational-reports.js";

/** Fixed local queries. A limit is a refusal, never evidence that the remaining set is empty. */
export function reportCandidateIds(
  db: DatabaseSync,
  tenant: string,
  definition: ReportDefinition,
  module: "assets" | "cases" | "purchases" | "licenses",
): string[] {
  let where = "",
    join = "";
  const params: (string | number)[] = [tenant, module];
  const missingOrInvalid = (column: string) =>
    `(${column} IS NULL OR ${column}='' OR date(${column}) IS NULL OR date(${column}) != ${column})`;
  if (definition.kind === "equipment" && module === "assets") {
    if (definition.location) {
      where += " AND json_extract(e.data_json,'$.location')=?";
      params.push(definition.location);
    }
    if (definition.status) {
      where += " AND e.status=?";
      params.push(definition.status);
    }
  } else if (definition.kind === "starts" && module === "cases") {
    where = ` AND json_extract(e.data_json,'$.caseType')='onboarding' AND (${missingOrInvalid("json_extract(e.data_json,'$.employmentStartDate')")} OR json_extract(e.data_json,'$.employmentStartDate') BETWEEN ? AND ?)`;
    params.push(definition.from, definition.to);
  } else if (
    (definition.kind === "deliveries" || definition.kind === "commitments") &&
    module === "purchases"
  ) {
    where = ` AND json_extract(e.data_json,'$.kind')='order' AND (${missingOrInvalid("json_extract(e.data_json,'$.expectedDelivery')")} OR json_extract(e.data_json,'$.expectedDelivery') BETWEEN ? AND ?)`;
    params.push(definition.from, definition.to);
  } else if (definition.kind === "commitments" && module === "licenses") {
    join =
      " LEFT JOIN ops_entities t ON t.tenant_id=e.tenant_id AND t.module='licenses' AND t.id=json_extract(e.data_json,'$.activeTermsId')";
    where = ` AND coalesce(json_extract(e.data_json,'$.kind'),'pool')!='license_terms' AND (t.id IS NULL OR ${missingOrInvalid("json_extract(t.data_json,'$.terms.validFrom')")} OR ${missingOrInvalid("json_extract(t.data_json,'$.terms.expiresOn')")} OR json_extract(t.data_json,'$.terms.validFrom')>json_extract(t.data_json,'$.terms.expiresOn') OR (json_extract(t.data_json,'$.terms.validFrom')<=? AND json_extract(t.data_json,'$.terms.expiresOn')>=?))`;
    params.push(definition.to, definition.from);
  } else
    throw new DomainError(
      "REPORT_KIND_INVALID",
      "Nieobsługiwane źródło tej definicji raportu.",
      400,
    );
  const found = db
    .prepare(
      `SELECT e.id FROM ops_entities e${join} WHERE e.tenant_id=? AND e.module=?${where} ORDER BY e.id LIMIT ?`,
    )
    .all(...params, MAX_REPORT_ROWS + 1);
  if (found.length > MAX_REPORT_ROWS)
    throw new DomainError(
      "REPORT_SCOPE_TOO_LARGE",
      `Raport ma więcej niż ${MAX_REPORT_ROWS} pozycji. Zawęź zakres.`,
      409,
    );
  return found.map((r) => String(r.id));
}
