import Database from "better-sqlite3";
import { ACTIVE_STATES } from "./contracts.js";

/**
 * 分级存储：
 * - persons / consents / audit_grants / access_log：身份与授权层（L0/L3）
 * - medication_registrations + supply_requests.med_snapshot/basis_snapshot：临床层（L2）
 * - supply_requests 的冷藏/配送/截止时间等列：运营层（L1），可直接投影给协调员
 * 流向（request_events / registration_events）只追加，不更新不删除。
 */
const ACTIVE_LIST = ACTIVE_STATES.map((s) => `'${s}'`).join(",");

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS persons (
  id TEXT PRIMARY KEY,
  anon_code TEXT NOT NULL UNIQUE,
  current_site_id TEXT NOT NULL REFERENCES sites(id),
  consent_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS consents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person_id TEXT NOT NULL REFERENCES persons(id),
  grantee TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(person_id, grantee)
);

CREATE TABLE IF NOT EXISTS medication_registrations (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES persons(id),
  site_id TEXT NOT NULL REFERENCES sites(id),
  medication_label TEXT NOT NULL,
  remaining_doses_amount REAL NOT NULL,
  remaining_doses_unit TEXT NOT NULL,
  latest_supply_by INTEGER NOT NULL,
  allergies_json TEXT NOT NULL DEFAULT '[]',
  verification_source TEXT NOT NULL,
  verification_detail TEXT,
  requires_cold_chain INTEGER NOT NULL DEFAULT 0,
  delivery_required INTEGER NOT NULL DEFAULT 0,
  registered_by TEXT NOT NULL,
  registered_by_role TEXT NOT NULL,
  blocked_allergy INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS supply_requests (
  id TEXT PRIMARY KEY,
  registration_id TEXT NOT NULL REFERENCES medication_registrations(id),
  person_id TEXT NOT NULL REFERENCES persons(id),
  version_no INTEGER NOT NULL,
  destination_site_id TEXT NOT NULL REFERENCES sites(id),
  status TEXT NOT NULL,
  -- 复核时写入，认领（接受）时被冻结快照覆盖，之后任何流程都不再修改
  med_snapshot TEXT,
  basis_snapshot TEXT,
  latest_supply_by INTEGER NOT NULL,
  requires_cold_chain INTEGER NOT NULL DEFAULT 0,
  delivery_required INTEGER NOT NULL DEFAULT 0,
  responsible_party TEXT,
  responsible_kind TEXT,
  package_code TEXT UNIQUE,
  escalation_level INTEGER NOT NULL DEFAULT 0,
  frozen_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(registration_id, version_no)
);

-- 同一登记（需求）任一时刻最多一个活跃版本：拒收/损坏/阻断后才能重新发出
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_request
  ON supply_requests(registration_id) WHERE status IN (${ACTIVE_LIST});

CREATE TABLE IF NOT EXISTS registration_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  registration_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS request_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES supply_requests(id),
  registration_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL,
  device_id TEXT,
  scan_seq TEXT
);

-- 离线扫描按设备流水去重（同设备同流水只能落一次）
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_scan_dedup
  ON request_events(device_id, scan_seq) WHERE device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scan_log (
  device_id TEXT NOT NULL,
  scan_seq TEXT NOT NULL,
  scan_type TEXT NOT NULL,
  result TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  at INTEGER NOT NULL,
  PRIMARY KEY (device_id, scan_seq)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS person_movements (
  id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL REFERENCES persons(id),
  from_site_id TEXT NOT NULL REFERENCES sites(id),
  to_site_id TEXT NOT NULL REFERENCES sites(id),
  status TEXT NOT NULL DEFAULT 'pending',
  departed_at INTEGER,
  arrived_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_movement
  ON person_movements(person_id) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS transfers (
  id TEXT PRIMARY KEY,
  movement_id TEXT NOT NULL REFERENCES person_movements(id),
  request_id TEXT NOT NULL REFERENCES supply_requests(id),
  registration_id TEXT NOT NULL,
  from_site_id TEXT NOT NULL REFERENCES sites(id),
  to_site_id TEXT NOT NULL REFERENCES sites(id),
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE(request_id)
);

CREATE TABLE IF NOT EXISTS audit_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grantee TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES persons(id),
  active INTEGER NOT NULL DEFAULT 1,
  granted_by TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE(grantee, person_id)
);

CREATE TABLE IF NOT EXISTS access_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  tier TEXT NOT NULL,
  person_id TEXT,
  registration_id TEXT,
  request_id TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_access_subject ON access_log(person_id, registration_id);
CREATE INDEX IF NOT EXISTS idx_request_events_request ON request_events(request_id, id);
CREATE INDEX IF NOT EXISTS idx_reg_events_reg ON registration_events(registration_id, id);
`;

export function openDB(filename = ":memory:") {
  const db = new Database(filename);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}
