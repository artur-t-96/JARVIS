import { operationsV14 } from "./operations-v14.js";
// Literal v15 SQL from main 188ccdc6efec0e6aa2a52d6bd3970343fa853f92.
export function operationsV15(path: string) {
  const db = operationsV14(path);
  db.exec(`CREATE INDEX ops_license_terms_pool ON ops_entities(tenant_id,json_extract(data_json,'$.licenseId'))
    WHERE module='licenses' AND json_extract(data_json,'$.kind')='license_terms';
    CREATE UNIQUE INDEX ops_license_confirmation_source ON ops_entities(
    tenant_id,json_extract(data_json,'$.terms.supplierId'),json_extract(data_json,'$.confirmation.documentKey'),json_extract(data_json,'$.confirmation.line'))
    WHERE module='licenses' AND json_extract(data_json,'$.kind')='license_terms' AND status IN ('active','superseded');
    INSERT INTO schema_versions_operations VALUES(15,'frozen-v15');`);
  return db;
}
