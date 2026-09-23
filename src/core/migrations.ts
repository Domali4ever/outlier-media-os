/**
 * Versioned schema migrations. Each migration runs once, inside a transaction,
 * and is recorded in schema_migrations. Never edit a released migration —
 * add a new one.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "init",
    sql: `
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,              -- sha256 of the session token
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
  market TEXT NOT NULL,
  language TEXT NOT NULL,
  currency TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}',
  origin_id TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE pillars (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE avatars (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  personality TEXT NOT NULL DEFAULT '',
  voice_tone TEXT NOT NULL DEFAULT '',
  ai_disclosure TEXT NOT NULL DEFAULT '',
  expertise_boundary TEXT NOT NULL DEFAULT '',
  restricted_claims_json TEXT NOT NULL DEFAULT '[]',
  visual_ref TEXT NOT NULL DEFAULT '',
  voice_ref TEXT NOT NULL DEFAULT '',
  lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('DRAFT','APPROVED','ACTIVE','RETIRED')),
  approval_id TEXT,
  origin_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE content_items (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  title TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'article',
  pillar_id TEXT REFERENCES pillars(id),
  stage TEXT NOT NULL CHECK (stage IN ('IDEA','RESEARCH','SCRIPT','QA','APPROVAL','READY','PUBLISHED','MEASURE')),
  buyer_intent TEXT CHECK (buyer_intent IN ('LOW','MEDIUM','HIGH')),
  risk TEXT NOT NULL CHECK (risk IN ('LOW','MEDIUM','HIGH','BLOCKED')),
  target_offer_id TEXT,
  commercial_decision TEXT NOT NULL DEFAULT 'UNDECIDED' CHECK (commercial_decision IN ('UNDECIDED','OFFER','NO_OFFER')),
  destination TEXT NOT NULL DEFAULT 'publish.primary',
  current_revision_id TEXT,
  research_status TEXT NOT NULL DEFAULT 'UNRESEARCHED' CHECK (research_status IN ('UNRESEARCHED','IN_PROGRESS','RESEARCHED')),
  legacy INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'VERIFIED' CHECK (verification_status IN ('VERIFIED','UNVERIFIED')),
  origin_id TEXT,
  retired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_content_brand ON content_items(brand_id, stage);

CREATE TABLE content_revisions (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content_items(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  research_notes TEXT NOT NULL DEFAULT '',
  change_note TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL,
  job_id TEXT,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (content_id, number)
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  content_id TEXT REFERENCES content_items(id),
  program_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('WEB_SOURCE','DOCUMENT','MANUAL_NOTE','PUBLICATION_PROOF','DRIVE_DOCUMENT')),
  url TEXT,
  title TEXT NOT NULL DEFAULT '',
  excerpt TEXT NOT NULL DEFAULT '',
  checked_at TEXT,
  file_path TEXT,
  sha256 TEXT,
  status TEXT NOT NULL DEFAULT 'UNVERIFIED' CHECK (status IN ('VERIFIED','UNVERIFIED','NOT_APPLICABLE','BLOCKED')),
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_evidence_content ON evidence(content_id);

CREATE TABLE claims (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content_items(id),
  text TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK (claim_type IN ('GENERAL','SAFETY','ELECTRICAL','COMPATIBILITY','AIRLINE','MANUFACTURER','MEDICAL','COMMERCIAL')),
  status TEXT NOT NULL CHECK (status IN ('VERIFIED','UNVERIFIED','NOT_APPLICABLE','BLOCKED')),
  evidence_id TEXT REFERENCES evidence(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE qa_reports (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content_items(id),
  revision_id TEXT NOT NULL REFERENCES content_revisions(id),
  kind TEXT NOT NULL CHECK (kind IN ('DETERMINISTIC','AI_EDITORIAL','HUMAN_REVIEW')),
  result TEXT NOT NULL CHECK (result IN ('PASS','FAIL','WARN')),
  findings_json TEXT NOT NULL DEFAULT '[]',
  job_id TEXT,
  reviewer TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  subject_type TEXT NOT NULL,          -- content | avatar | policy | program | recommendation
  subject_id TEXT NOT NULL,
  revision_id TEXT,
  destination TEXT,
  commercial_hash TEXT,
  decision TEXT NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','INVALIDATED','EXPIRED','SUPERSEDED')),
  level INTEGER NOT NULL,
  policy_version INTEGER,
  actor TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  legacy INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  invalidated_at TEXT,
  invalidated_reason TEXT
);
CREATE INDEX idx_approvals_subject ON approvals(subject_type, subject_id);

CREATE TABLE programs (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  network TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  program_status TEXT NOT NULL CHECK (program_status IN ('DISCOVERED','QUALIFIED','DISQUALIFIED','RETIRED')),
  account_status TEXT NOT NULL CHECK (account_status IN ('NOT_APPLIED','APPLIED','APPROVED','DECLINED','NOT_APPLICABLE')),
  notes TEXT NOT NULL DEFAULT '',
  legacy INTEGER NOT NULL DEFAULT 0,
  origin_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE commercial_facts (
  id TEXT PRIMARY KEY,
  program_id TEXT NOT NULL REFERENCES programs(id),
  criterion TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  checked_at TEXT,
  evidence TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('VERIFIED','UNVERIFIED','NOT_APPLICABLE','BLOCKED')),
  provenance_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  UNIQUE (program_id, criterion)
);

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL REFERENCES brands(id),
  program_id TEXT NOT NULL REFERENCES programs(id),
  name TEXT NOT NULL,
  product_url TEXT NOT NULL DEFAULT '',
  affiliate_url TEXT NOT NULL DEFAULT '',
  disclosure TEXT NOT NULL DEFAULT '',
  offer_status TEXT NOT NULL CHECK (offer_status IN ('DRAFT','VALID','EXPIRED','INVALID')),
  link_status TEXT NOT NULL CHECK (link_status IN ('INACTIVE','ACTIVE')),
  commission_text TEXT NOT NULL DEFAULT '',
  checked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,                 -- capability key, e.g. ai.structured_generation
  section TEXT NOT NULL,               -- AI | DATA | CONTENT | AFFILIATES | MEDIA | AUTOMATIONS
  capability TEXT NOT NULL,
  provider TEXT NOT NULL,
  auth_method TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('NOT_CONNECTED','CONFIGURING','TESTING','CONNECTED','DEGRADED','PAUSED','DISABLED','OUT_OF_SCOPE','LOCAL')),
  config_json TEXT NOT NULL DEFAULT '{}',
  secret_refs_json TEXT NOT NULL DEFAULT '[]',
  last_test_at TEXT,
  last_test_result TEXT,
  last_success_at TEXT,
  last_error_json TEXT,
  limits_text TEXT NOT NULL DEFAULT '',
  verified_capabilities_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('http','stdio')),
  url TEXT,
  command TEXT,
  args_json TEXT NOT NULL DEFAULT '[]',
  header_refs_json TEXT NOT NULL DEFAULT '{}',
  env_refs_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL CHECK (state IN ('NOT_CONNECTED','CONFIGURING','TESTING','CONNECTED','DEGRADED','PAUSED','DISABLED')),
  tools_json TEXT NOT NULL DEFAULT '[]',
  allowlist_json TEXT NOT NULL DEFAULT '{}',   -- { toolName: permissionLevel }
  last_error TEXT,
  last_test_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  brand_id TEXT,
  content_id TEXT,
  revision_id TEXT,
  input_json TEXT NOT NULL DEFAULT '{}',
  output_json TEXT,
  state TEXT NOT NULL CHECK (state IN ('QUEUED','BLOCKED','RUNNING','RETRYING','COMPLETE','FAILED','NEEDS_ATTENTION','CANCELLED')),
  actor TEXT NOT NULL,
  permission_level INTEGER NOT NULL,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  blocked_reason_json TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  approval_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  side_effect_state TEXT NOT NULL DEFAULT 'NONE' CHECK (side_effect_state IN ('NONE','REQUESTED','CONFIRMED','AMBIGUOUS')),
  usage_json TEXT,
  cost_estimate REAL,
  error_json TEXT,
  progress_text TEXT NOT NULL DEFAULT '',
  correlation_id TEXT NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX idx_jobs_state ON jobs(state, run_after);

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  at TEXT NOT NULL,
  state TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX idx_job_events_job ON job_events(job_id);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  brand_id TEXT,
  summary TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'INFO',
  data_json TEXT,
  correlation_id TEXT
);
CREATE INDEX idx_audit_at ON audit_events(at);

CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  content_id TEXT NOT NULL REFERENCES content_items(id),
  revision_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  remote_id TEXT,
  remote_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('CONFIRMED','MANUAL_CONFIRMED','AMBIGUOUS','FAILED','WITHDRAWN')),
  evidence_id TEXT,
  receipt_json TEXT NOT NULL DEFAULT '{}',
  job_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE performance_observations (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  content_id TEXT,
  publication_id TEXT,
  program_id TEXT,
  source TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('views','users','clicks','conversions','revenue')),
  value REAL NOT NULL,
  currency TEXT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  ingest_key TEXT NOT NULL UNIQUE,
  provenance_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE costs (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  is_estimate INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  job_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  incurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE recommendations (
  id TEXT PRIMARY KEY,
  brand_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('SCALE','MAINTAIN','MODIFY','KILL','INVESTIGATE')),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  title TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  upside TEXT NOT NULL DEFAULT '',
  risks TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL CHECK (confidence IN ('LOW','MEDIUM','HIGH')),
  data_sufficiency TEXT NOT NULL CHECK (data_sufficiency IN ('INSUFFICIENT','PARTIAL','SUFFICIENT')),
  status TEXT NOT NULL CHECK (status IN ('OPEN','APPROVED','REJECTED','DONE','SUPERSEDED')),
  rule_key TEXT NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  brand_id TEXT,
  kind TEXT NOT NULL,                  -- budget | recurring_publication | automation
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT','ACTIVE','REVOKED','SUPERSEDED')),
  approved_by TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL
);
`,
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
