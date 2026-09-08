-- Frozen from PR15 d32cf77ee48f73312177c9a4388b794abc501c36, operations v8.
CREATE TABLE schema_versions_operations (
      version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL
    );
CREATE TABLE ops_entities(tenant_id TEXT NOT NULL,id TEXT NOT NULL,module TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,data_json TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id));
CREATE TABLE ops_entity_versions(tenant_id TEXT NOT NULL,entity_id TEXT NOT NULL,version INTEGER NOT NULL,snapshot_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,PRIMARY KEY(tenant_id,entity_id,version),FOREIGN KEY(tenant_id,entity_id) REFERENCES ops_entities(tenant_id,id));
CREATE TABLE ops_commands(tenant_id TEXT NOT NULL,operation_key TEXT NOT NULL,tool_id TEXT NOT NULL,input_hash TEXT NOT NULL,receipt_json TEXT NOT NULL,changes_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,operation_key));
CREATE TABLE ops_audit(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,operation_key TEXT NOT NULL,run_id TEXT NOT NULL,step_id TEXT NOT NULL,actor_id TEXT NOT NULL,tool_id TEXT NOT NULL,entity_id TEXT NOT NULL,entity_version INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE ops_outbox(id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,operation_key TEXT NOT NULL,event_type TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','consumed')),created_at TEXT NOT NULL,UNIQUE(tenant_id,operation_key));
CREATE TABLE ops_employment(tenant_id TEXT NOT NULL,id TEXT NOT NULL,person_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('internal','contractor')),start_date TEXT NOT NULL,end_date TEXT,status TEXT NOT NULL CHECK(status IN ('onboarding','active','offboarding','ended')),role TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, onboarding_case_id TEXT, offboarding_case_id TEXT, engagement_module TEXT, engagement_id TEXT, engagement_key TEXT, end_reason TEXT, updated_at TEXT,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,person_id) REFERENCES ops_entities(tenant_id,id));
CREATE TABLE ops_evidence(tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,title TEXT NOT NULL,reference TEXT NOT NULL,note TEXT NOT NULL,reported_by TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));
CREATE TABLE ops_acceptances(tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,decision TEXT NOT NULL CHECK(decision IN ('accepted','rejected')),note TEXT NOT NULL,decided_by TEXT NOT NULL,created_at TEXT NOT NULL, scope_hash TEXT, bindings_hash TEXT, bindings_json TEXT NOT NULL DEFAULT '[]', contract_version TEXT NOT NULL DEFAULT 'legacy', requested_by TEXT, approved_by TEXT, person_id TEXT, employment_episode_id TEXT,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));
CREATE TABLE ops_allocations(tenant_id TEXT NOT NULL,id TEXT NOT NULL,asset_id TEXT NOT NULL,person_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('reserved','issued','released','returned')),reserved_until TEXT NOT NULL,issued_on TEXT,returned_on TEXT, employment_episode_id TEXT, case_id TEXT, version INTEGER NOT NULL DEFAULT 1, expires_at TEXT, timezone TEXT, profile_version INTEGER, created_at TEXT, updated_at TEXT, provenance TEXT NOT NULL DEFAULT 'legacy' CHECK(provenance IN('legacy','p05')), issue_event_id TEXT, return_event_id TEXT, last_event_id TEXT,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,asset_id) REFERENCES ops_entities(tenant_id,id),FOREIGN KEY(tenant_id,person_id) REFERENCES ops_entities(tenant_id,id));
CREATE TABLE ops_license_seats(tenant_id TEXT NOT NULL,id TEXT NOT NULL,license_id TEXT NOT NULL,person_id TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('assigned','revoked')),assigned_at TEXT NOT NULL,revoked_at TEXT, employment_episode_id TEXT, case_id TEXT,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,license_id) REFERENCES ops_entities(tenant_id,id),FOREIGN KEY(tenant_id,person_id) REFERENCES ops_entities(tenant_id,id));
CREATE TABLE ops_document_versions(tenant_id TEXT NOT NULL,document_id TEXT NOT NULL,revision INTEGER NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','review','approved','rejected')),decided_by TEXT,decision_note TEXT,decided_at TEXT,PRIMARY KEY(tenant_id,document_id,revision),FOREIGN KEY(tenant_id,document_id) REFERENCES ops_entities(tenant_id,id));
CREATE TABLE ops_worklogs(tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,description TEXT NOT NULL,minutes INTEGER NOT NULL CHECK(minutes>=0),performed_on TEXT NOT NULL,amount_minor INTEGER,currency TEXT,reported_by TEXT NOT NULL,approved_by TEXT,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));
CREATE TABLE ops_tasks(
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,
 title TEXT NOT NULL,assignee_id TEXT,required INTEGER NOT NULL CHECK(required IN(0,1)),
 status TEXT NOT NULL CHECK(status IN('unassigned','offered','accepted','declined','completed','cancelled')),
 completed_by TEXT,completed_at TEXT,evidence_note TEXT,due_date TEXT,depends_on_json TEXT NOT NULL DEFAULT '[]',
 kind TEXT NOT NULL DEFAULT 'work' CHECK(kind IN('information','decision','work','attestation')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),assignee_principal_id TEXT,assignee_role TEXT,
 required_scopes_json TEXT NOT NULL DEFAULT '[]',requirement_keys_json TEXT NOT NULL DEFAULT '[]',
 performed_by TEXT,requested_by TEXT,approved_by TEXT,created_at TEXT,updated_at TEXT,
 provenance TEXT NOT NULL DEFAULT 'p03', template_key TEXT,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));
CREATE TABLE ops_task_events(
 tenant_id TEXT NOT NULL,id TEXT NOT NULL,task_id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,
 task_version INTEGER NOT NULL,action TEXT NOT NULL,from_status TEXT,to_status TEXT NOT NULL,
 previous_assignee_principal_id TEXT,assignee_principal_id TEXT,requested_by TEXT,approved_by TEXT,performed_by TEXT,
 reason TEXT,run_id TEXT NOT NULL,step_id TEXT NOT NULL,operation_key TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,task_id,task_version),
 FOREIGN KEY(tenant_id,task_id) REFERENCES ops_tasks(tenant_id,id));
CREATE TABLE ops_case_requirements(tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,requirement_key TEXT NOT NULL,title TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('asset_issued','document_approved','access_attested','delivery_received','test_passed')),required INTEGER NOT NULL CHECK(required IN(0,1)),person_id TEXT,employment_episode_id TEXT,expected_json TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,case_id,scope_revision,requirement_key),FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));
CREATE TABLE ops_requirement_bindings(tenant_id TEXT NOT NULL,id TEXT NOT NULL,requirement_id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,source_module TEXT NOT NULL,source_id TEXT NOT NULL,source_version INTEGER NOT NULL,source_hash TEXT NOT NULL,source_revision INTEGER,source_identity_json TEXT NOT NULL,observed_at TEXT NOT NULL,requested_by TEXT NOT NULL,approved_by TEXT,run_id TEXT NOT NULL,step_id TEXT NOT NULL,operation_key TEXT NOT NULL,provenance TEXT NOT NULL CHECK(provenance='independent_local_read'),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,requirement_id),FOREIGN KEY(tenant_id,requirement_id) REFERENCES ops_case_requirements(tenant_id,id));
CREATE TABLE ops_case_exceptions(tenant_id TEXT NOT NULL,id TEXT NOT NULL,case_id TEXT NOT NULL,scope_revision INTEGER NOT NULL,requirement_id TEXT NOT NULL,rule TEXT NOT NULL,reason TEXT NOT NULL,approved_by TEXT NOT NULL,risk_owner_principal_id TEXT NOT NULL,expires_at TEXT NOT NULL,closure_plan TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN('open','closed')),created_at TEXT NOT NULL,closed_at TEXT,PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,requirement_id) REFERENCES ops_case_requirements(tenant_id,id));
CREATE TABLE ops_asset_register_events(
    tenant_id TEXT NOT NULL,id TEXT NOT NULL,asset_id TEXT NOT NULL,asset_version INTEGER NOT NULL,
    event_json TEXT NOT NULL,event_hash TEXT NOT NULL,requested_by TEXT NOT NULL,approved_by TEXT,
    PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,asset_id,asset_version),
    FOREIGN KEY(tenant_id,asset_id,asset_version) REFERENCES ops_entity_versions(tenant_id,entity_id,version));
CREATE TABLE "ops_asset_events"(
    tenant_id TEXT NOT NULL,id TEXT NOT NULL,asset_id TEXT NOT NULL,allocation_id TEXT NOT NULL,
    allocation_version INTEGER NOT NULL,kind TEXT NOT NULL CHECK(kind IN('reserve','issue','return','release','expire')),
    requested_by TEXT NOT NULL,approved_by TEXT,performed_by TEXT,occurred_on TEXT NOT NULL,recorded_at TEXT NOT NULL,
    run_id TEXT NOT NULL,step_id TEXT NOT NULL,operation_key TEXT NOT NULL,snapshot_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,
    PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,allocation_id,allocation_version),UNIQUE(tenant_id,operation_key,asset_id),
    FOREIGN KEY(tenant_id,allocation_id) REFERENCES ops_allocations(tenant_id,id),
    FOREIGN KEY(tenant_id,asset_id) REFERENCES ops_entities(tenant_id,id));
CREATE TABLE ops_access_grants(
    tenant_id TEXT NOT NULL,id TEXT NOT NULL,application_id TEXT NOT NULL,person_id TEXT NOT NULL,
    employment_episode_id TEXT NOT NULL,case_id TEXT NOT NULL,role TEXT NOT NULL,account_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN('active','revoked')),version INTEGER NOT NULL CHECK(version>0),
    snapshot_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,last_event_id TEXT NOT NULL,
    PRIMARY KEY(tenant_id,id),
    FOREIGN KEY(tenant_id,application_id) REFERENCES ops_entities(tenant_id,id),
    FOREIGN KEY(tenant_id,person_id) REFERENCES ops_entities(tenant_id,id),
    FOREIGN KEY(tenant_id,employment_episode_id) REFERENCES ops_employment(tenant_id,id),
    FOREIGN KEY(tenant_id,case_id) REFERENCES ops_entities(tenant_id,id));
CREATE TABLE ops_access_events(
    tenant_id TEXT NOT NULL,id TEXT NOT NULL,grant_id TEXT NOT NULL,grant_version INTEGER NOT NULL,
    event_json TEXT NOT NULL,event_hash TEXT NOT NULL,operation_key TEXT NOT NULL,
    PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,grant_id,grant_version),UNIQUE(tenant_id,operation_key),
    FOREIGN KEY(tenant_id,grant_id) REFERENCES ops_access_grants(tenant_id,id));
CREATE INDEX ops_entity_module ON ops_entities(tenant_id,module,updated_at);
CREATE UNIQUE INDEX ops_one_active_allocation ON ops_allocations(tenant_id,asset_id) WHERE status IN ('reserved','issued');
CREATE INDEX ops_tasks_assignee ON ops_tasks(tenant_id,assignee_principal_id,status);
CREATE UNIQUE INDEX ops_one_open_engagement ON ops_employment(tenant_id,person_id,engagement_key) WHERE status!='ended' AND engagement_key IS NOT NULL;
CREATE UNIQUE INDEX ops_one_open_internal ON ops_employment(tenant_id,person_id) WHERE status!='ended' AND kind='internal';
CREATE UNIQUE INDEX ops_unique_episode_seat ON ops_license_seats(tenant_id,license_id,person_id,employment_episode_id) WHERE status='assigned' AND employment_episode_id IS NOT NULL;
CREATE UNIQUE INDEX ops_unique_legacy_seat ON ops_license_seats(tenant_id,license_id,person_id) WHERE status='assigned' AND employment_episode_id IS NULL;
CREATE INDEX ops_asset_register_history ON ops_asset_register_events(tenant_id,asset_id,asset_version);
CREATE INDEX ops_asset_event_history ON ops_asset_events(tenant_id,asset_id,recorded_at,id);
CREATE UNIQUE INDEX ops_access_active_role ON ops_access_grants(tenant_id,person_id,employment_episode_id,application_id,role) WHERE status='active';
CREATE UNIQUE INDEX ops_access_active_account ON ops_access_grants(tenant_id,application_id,account_ref,role) WHERE status='active';
CREATE INDEX ops_access_case ON ops_access_grants(tenant_id,case_id,id);
CREATE UNIQUE INDEX ops_application_key ON ops_entities(tenant_id,json_extract(data_json,'$.applicationKey')) WHERE module='it' AND json_extract(data_json,'$.kind')='application';
CREATE UNIQUE INDEX ops_access_bundle_key ON ops_entities(tenant_id,json_extract(data_json,'$.accessKey')) WHERE module='it' AND json_extract(data_json,'$.kind')='access_bundle';
INSERT INTO schema_versions_operations VALUES(1,'frozen-v8');
INSERT INTO schema_versions_operations VALUES(2,'frozen-v8');
INSERT INTO schema_versions_operations VALUES(3,'frozen-v8');
INSERT INTO schema_versions_operations VALUES(4,'frozen-v8');
INSERT INTO schema_versions_operations VALUES(5,'frozen-v8');
INSERT INTO schema_versions_operations VALUES(6,'frozen-v8');
INSERT INTO schema_versions_operations VALUES(7,'frozen-v8');
INSERT INTO schema_versions_operations VALUES(8,'frozen-v8');
