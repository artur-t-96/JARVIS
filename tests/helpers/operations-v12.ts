import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
// Historical v12 fixture: frozen v9 plus verbatim v11/v12 SQL from
// main 856f367495bd5aeb68a1ac135fa8a48816fd03db. No current migration code.
export function operationsV12(path: string) {
  const db = new DatabaseSync(path);
  db.exec(
    readFileSync(
      new URL("../fixtures/operations-v9.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(`CREATE TABLE ops_employment_v11(
    tenant_id TEXT NOT NULL,id TEXT NOT NULL,person_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('internal','contractor')),
    start_date TEXT NOT NULL,end_date TEXT,
    status TEXT NOT NULL CHECK(status IN ('onboarding','active','offboarding','ended','cancelled')),
    role TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,
    onboarding_case_id TEXT,offboarding_case_id TEXT,engagement_module TEXT,
    engagement_id TEXT,engagement_key TEXT,end_reason TEXT,updated_at TEXT,
    cancellation_json TEXT,
    CHECK((status='cancelled' AND end_date IS NULL AND cancellation_json IS NOT NULL AND json_valid(cancellation_json))
      OR (status!='cancelled' AND cancellation_json IS NULL)),
    PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,person_id) REFERENCES ops_entities(tenant_id,id));
    INSERT INTO ops_employment_v11(tenant_id,id,person_id,kind,start_date,end_date,status,role,version,onboarding_case_id,offboarding_case_id,engagement_module,engagement_id,engagement_key,end_reason,updated_at)
    SELECT tenant_id,id,person_id,kind,start_date,end_date,status,role,version,onboarding_case_id,offboarding_case_id,engagement_module,engagement_id,engagement_key,end_reason,updated_at FROM ops_employment;
    DROP TABLE ops_employment;
    ALTER TABLE ops_employment_v11 RENAME TO ops_employment;
    CREATE UNIQUE INDEX ops_one_open_engagement ON ops_employment(tenant_id,person_id,engagement_key)
      WHERE status NOT IN('ended','cancelled') AND engagement_key IS NOT NULL;
    CREATE UNIQUE INDEX ops_one_open_internal ON ops_employment(tenant_id,person_id)
      WHERE status NOT IN('ended','cancelled') AND kind='internal';
 CREATE UNIQUE INDEX ops_open_laboratory_case ON ops_entities(
 tenant_id,json_extract(data_json,'$.laboratoryContext.targetId'))
 WHERE module='cases' AND json_extract(data_json,'$.laboratoryContext.targetId') IS NOT NULL
 AND status IN ('open','needs_changes','awaiting_acceptance');
 INSERT INTO schema_versions_operations VALUES(10,'frozen-v12'),(11,'frozen-v12'),(12,'frozen-v12');`);
  return db;
}
