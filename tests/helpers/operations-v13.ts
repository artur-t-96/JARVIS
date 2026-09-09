import { operationsV12 } from "./operations-v12.js";
// Literal v13 SQL from main f91c6b74f5b57b174eba673efa8656868787d5fd.
export function operationsV13(path: string) {
  const db = operationsV12(path);
  db.exec(`CREATE UNIQUE INDEX ops_purchase_quote_source ON ops_entities(
    tenant_id,json_extract(data_json,'$.requestId'),json_extract(data_json,'$.supplierId'),json_extract(data_json,'$.referenceKey'))
    WHERE module='purchases' AND json_extract(data_json,'$.kind')='quote';
    CREATE UNIQUE INDEX ops_purchase_order_request ON ops_entities(tenant_id,json_extract(data_json,'$.requestId'))
    WHERE module='purchases' AND json_extract(data_json,'$.kind')='order' AND json_extract(data_json,'$.procurementVersion')=1;
    INSERT INTO schema_versions_operations VALUES(13,'frozen-v13');`);
  return db;
}
