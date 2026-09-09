import { operationsV13 } from "./operations-v13.js";
// Literal v14 SQL from main dc8372f5bef848f6fe3034466b0feeece38ce251.
export function operationsV14(path: string) {
  const db = operationsV13(path);
  db.exec(`CREATE UNIQUE INDEX ops_delivery_document_line ON ops_entities(
    tenant_id,json_extract(data_json,'$.supplierId'),json_extract(data_json,'$.documentKey'),json_extract(data_json,'$.documentLine'))
    WHERE module='purchases' AND json_extract(data_json,'$.kind')='receipt';
    CREATE INDEX ops_delivery_order ON ops_entities(tenant_id,json_extract(data_json,'$.orderId'))
    WHERE module='purchases' AND json_extract(data_json,'$.kind')='receipt';
    INSERT INTO schema_versions_operations VALUES(14,'frozen-v14');`);
  return db;
}
