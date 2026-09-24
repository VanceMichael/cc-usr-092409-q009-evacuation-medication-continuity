// SQLite 存储层：表结构、只追加约束与并发原语。
//
// 并发安全依赖三点：
//   1. 关键状态推进全部使用「带当前状态/责任方条件的 UPDATE」，以 changes() 判定胜负；
//   2. 同一登记的活跃版本由部分唯一索引保证至多一个；
//   3. 每个用例在单个事务内完成，配合 busy_timeout 与 WAL 串行化写竞争。
import crypto from "node:crypto";
import Database from "better-sqlite3";

export const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;

const SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=5000;

CREATE TABLE IF NOT EXISTS registrations (
  id                    TEXT PRIMARY KEY,
  person_ref            TEXT NOT NULL,
  medication_code       TEXT NOT NULL,
  medication_label      TEXT NOT NULL,
  remaining_doses       REAL NOT NULL,
  dose_unit             TEXT NOT NULL,
  allergies             TEXT NOT NULL DEFAULT '[]',
  contraindications     TEXT NOT NULL DEFAULT '[]',
  verification_source   TEXT NOT NULL,
  verification_detail   TEXT,
  registered_by         TEXT NOT NULL,
  registerer_role       TEXT NOT NULL,
  needs_refrigeration   INTEGER NOT NULL DEFAULT 0,
  needs_delivery        INTEGER NOT NULL DEFAULT 0,
  latest_supply_at      TEXT NOT NULL,
  site_code             TEXT NOT NULL,
  blocked_allergy       INTEGER NOT NULL DEFAULT 0,
  auth_withdrawn        INTEGER NOT NULL DEFAULT 0,
  block_note            TEXT,
  blocked_at            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- 续供需求的每个版本一行。v1 来自医护首次复核；拒收/损坏后 reissue 递增版本号。
CREATE TABLE IF NOT EXISTS request_versions (
  id                        TEXT PRIMARY KEY,
  registration_id           TEXT NOT NULL REFERENCES registrations(id),
  version_no                INTEGER NOT NULL,
  state                     TEXT NOT NULL,
  origin_site_code          TEXT NOT NULL,
  current_site_code         TEXT NOT NULL,
  responsible_party         TEXT,
  responsible_party_kind    TEXT,
  frozen_snapshot           TEXT,
  frozen_at                 TEXT,
  supersedes_version_id     TEXT,
  created_by_clinician      TEXT NOT NULL,
  escalation_level          TEXT NOT NULL DEFAULT 'normal',
  created_at                TEXT NOT NULL,
  updated_at                TEXT NOT NULL,
  UNIQUE(registration_id, version_no)
);

-- 同一登记任一时刻至多一个未终结版本（一次性需求 / 唯一活跃链）。
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_version
  ON request_versions(registration_id)
  WHERE state NOT IN ('delivered','rejected','damaged','closed','reissued','blocked');
CREATE INDEX IF NOT EXISTS ix_versions_state_site
  ON request_versions(state, current_site_code);

-- 事件只追加；触发器在 SQL 层阻止修改与删除。
CREATE TABLE IF NOT EXISTS events (
  seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id            TEXT NOT NULL UNIQUE,
  request_version_id  TEXT,
  registration_id     TEXT NOT NULL,
  version_no          INTEGER,
  type                TEXT NOT NULL,
  payload             TEXT NOT NULL DEFAULT '{}',
  actor               TEXT NOT NULL,
  actor_role          TEXT NOT NULL,
  site_code           TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_events_registration ON events(registration_id, seq);
CREATE INDEX IF NOT EXISTS ix_events_version ON events(request_version_id, seq);
CREATE INDEX IF NOT EXISTS ix_events_type ON events(type, seq);

CREATE TRIGGER IF NOT EXISTS trg_events_no_update BEFORE UPDATE ON events
BEGIN SELECT raise(ABORT, 'events are append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_events_no_delete BEFORE DELETE ON events
BEGIN SELECT raise(ABORT, 'events are append-only'); END;

-- 离线扫描按「设备 + 设备本地流水号」全局去重；记录首次裁决，重放只回放裁决。
CREATE TABLE IF NOT EXISTS scan_dedup (
  device_id           TEXT NOT NULL,
  scan_serial         TEXT NOT NULL,
  request_version_id  TEXT,
  event_type          TEXT,
  status              TEXT NOT NULL, -- applied | rejected_late | rejected_conflict
  event_id            TEXT,
  first_seen_at       TEXT NOT NULL,
  last_replayed_at    TEXT NOT NULL,
  PRIMARY KEY (device_id, scan_serial)
);

-- 谁、以什么身份、因何访问了哪条记录——审计员重建访问轨迹的唯一来源。
CREATE TABLE IF NOT EXISTS access_log (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  actor             TEXT NOT NULL,
  actor_role        TEXT NOT NULL,
  kind              TEXT NOT NULL,
  target            TEXT,
  site_code         TEXT,
  authorization_id  TEXT,
  detail            TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_access_actor ON access_log(actor, seq);
CREATE INDEX IF NOT EXISTS ix_access_target ON access_log(target, seq);
`;

export function openDatabase(filename = ":memory:") {
  const db = new Database(filename);
  db.exec(SCHEMA);
  return db;
}

export const parseJson = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const parseEvent = (row) => ({ ...row, payload: parseJson(row.payload, {}) });

export function createStore(db) {
  const rowToVersion = (row) =>
    row && {
      ...row,
      frozen_snapshot: parseJson(row.frozen_snapshot, null),
    };

  const store = {
    db,
    tx: (fn) => db.transaction(fn)(),

    // ---- 登记 -------------------------------------------------------------
    insertRegistration(r) {
      db.prepare(
        `INSERT INTO registrations
          (id, person_ref, medication_code, medication_label, remaining_doses, dose_unit,
           allergies, contraindications, verification_source, verification_detail,
           registered_by, registerer_role, needs_refrigeration, needs_delivery,
           latest_supply_at, site_code, created_at, updated_at)
         VALUES
          (@id, @person_ref, @medication_code, @medication_label, @remaining_doses, @dose_unit,
           @allergies, @contraindications, @verification_source, @verification_detail,
           @registered_by, @registerer_role, @needs_refrigeration, @needs_delivery,
           @latest_supply_at, @site_code, @created_at, @updated_at)`,
      ).run(r);
      return store.getRegistration(r.id);
    },

    getRegistration(id) {
      return db.prepare(`SELECT * FROM registrations WHERE id = ?`).get(id);
    },

    setBlocked({ id, blockedAllergy, authWithdrawn, note, at }) {
      db.prepare(
        `UPDATE registrations
           SET blocked_allergy = ?, auth_withdrawn = ?, block_note = ?, blocked_at = ?, updated_at = ?
         WHERE id = ?`,
      ).run(blockedAllergy ? 1 : 0, authWithdrawn ? 1 : 0, note ?? null, at, at, id);
      return store.getRegistration(id);
    },

    clearBlock({ id, at }) {
      db.prepare(
        `UPDATE registrations
           SET blocked_allergy = 0, auth_withdrawn = 0, block_note = NULL,
               blocked_at = NULL, updated_at = ?
         WHERE id = ?`,
      ).run(at, id);
      return store.getRegistration(id);
    },

    // ---- 需求版本 ----------------------------------------------------------
    insertVersion(v) {
      db.prepare(
        `INSERT INTO request_versions
          (id, registration_id, version_no, state, origin_site_code, current_site_code,
           responsible_party, responsible_party_kind, frozen_snapshot, frozen_at,
           supersedes_version_id, created_by_clinician, escalation_level, created_at, updated_at)
         VALUES
          (@id, @registration_id, @version_no, @state, @origin_site_code, @current_site_code,
           @responsible_party, @responsible_party_kind, @frozen_snapshot, @frozen_at,
           @supersedes_version_id, @created_by_clinician, @escalation_level, @created_at, @updated_at)`,
      ).run(v);
      return store.getVersion(v.id);
    },

    getVersion(id) {
      const row = db
        .prepare(
          `SELECT v.*, r.latest_supply_at, r.needs_refrigeration, r.needs_delivery
             FROM request_versions v JOIN registrations r ON r.id = v.registration_id
            WHERE v.id = ?`,
        )
        .get(id);
      return rowToVersion(row);
    },

    getVersionForUpdate(id) {
      return db.prepare(`SELECT * FROM request_versions WHERE id = ?`).get(id);
    },

    listVersionsByRegistration(registrationId) {
      return db
        .prepare(`SELECT * FROM request_versions WHERE registration_id = ? ORDER BY version_no`)
        .all(registrationId)
        .map(rowToVersion);
    },

    latestVersion(registrationId) {
      const row = db
        .prepare(
          `SELECT * FROM request_versions WHERE registration_id = ?
           ORDER BY version_no DESC LIMIT 1`,
        )
        .get(registrationId);
      return rowToVersion(row);
    },

    activeVersion(registrationId) {
      const row = db
        .prepare(
          `SELECT * FROM request_versions WHERE registration_id = ?
            AND state NOT IN ('delivered','rejected','damaged','closed','reissued','blocked')
           ORDER BY version_no DESC LIMIT 1`,
        )
        .get(registrationId);
      return rowToVersion(row);
    },

    // 认领：条件更新——只有 open 且尚无负责方的版本能被认领，并发调用恰有一个 changes()=1。
    claimVersion({ id, party, partyKind, snapshotJson, at }) {
      const info = db
        .prepare(
          `UPDATE request_versions
              SET state = 'accepted', responsible_party = ?, responsible_party_kind = ?,
                  frozen_snapshot = ?, frozen_at = ?, updated_at = ?
            WHERE id = ? AND state = 'open' AND responsible_party IS NULL`,
        )
        .run(party, partyKind, snapshotJson, at, at, id);
      return info.changes === 1 ? store.getVersion(id) : null;
    },

    // 通用状态推进；expectedState 为空表示不检查，否则必须匹配（迟到/并发事件据此落败）。
    advanceVersion({ id, expectedState, nextState, at, patch = {} }) {
      const sets = ["state = ?", "updated_at = ?"];
      const values = [nextState, at];
      for (const [key, value] of Object.entries(patch)) {
        sets.push(`${key} = ?`);
        values.push(value);
      }
      let sql = `UPDATE request_versions SET ${sets.join(", ")} WHERE id = ?`;
      if (expectedState) {
        sql += ` AND state = ?`;
      }
      values.push(id);
      if (expectedState) values.push(expectedState);
      const info = db.prepare(sql).run(...values);
      return info.changes === 1 ? store.getVersion(id) : null;
    },

    // 转移交接：只有当前责任站点能发起，且需求仍处于可交接状态；并发二次交接受此条件阻挡。
    transferVersion({ id, fromSite, toSite, at }) {
      const info = db
        .prepare(
          `UPDATE request_versions SET current_site_code = ?, updated_at = ?
            WHERE id = ? AND current_site_code = ?
              AND state IN ('open','accepted','dispatched','in_transit')`,
        )
        .run(toSite, at, id, fromSite);
      return info.changes === 1 ? store.getVersion(id) : null;
    },

    listActiveVersions() {
      return db
        .prepare(
          `SELECT v.*, r.latest_supply_at, r.needs_refrigeration, r.needs_delivery
             FROM request_versions v JOIN registrations r ON r.id = v.registration_id
            WHERE v.state NOT IN ('delivered','rejected','damaged','closed','reissued','blocked')`,
        )
        .all()
        .map(rowToVersion);
    },

    setEscalation({ id, level, at }) {
      db.prepare(
        `UPDATE request_versions SET escalation_level = ?, updated_at = ? WHERE id = ?`,
      ).run(level, at, id);
    },

    // ---- 事件（只追加） ----------------------------------------------------
    insertEvent(e) {
      db.prepare(
        `INSERT INTO events
          (event_id, request_version_id, registration_id, version_no, type, payload,
           actor, actor_role, site_code, created_at)
         VALUES
          (@event_id, @request_version_id, @registration_id, @version_no, @type, @payload,
           @actor, @actor_role, @site_code, @created_at)`,
      ).run(e);
      return store.getEvent(e.event_id);
    },

    getEvent(eventId) {
      const row = db.prepare(`SELECT * FROM events WHERE event_id = ?`).get(eventId);
      return row ? parseEvent(row) : undefined;
    },

    listEventsByRegistration(registrationId) {
      return db
        .prepare(`SELECT * FROM events WHERE registration_id = ? ORDER BY seq`)
        .all(registrationId)
        .map(parseEvent);
    },

    listEventsByVersion(requestVersionId) {
      return db
        .prepare(`SELECT * FROM events WHERE request_version_id = ? ORDER BY seq`)
        .all(requestVersionId)
        .map(parseEvent);
    },

    latestEventOfType(requestVersionId, type) {
      const row = db
        .prepare(
          `SELECT * FROM events WHERE request_version_id = ? AND type = ? ORDER BY seq DESC LIMIT 1`,
        )
        .get(requestVersionId, type);
      return row ? parseEvent(row) : undefined;
    },

    // ---- 离线扫描去重 ------------------------------------------------------
    firstOrSeenScan({ device_id: deviceId, scan_serial: serial }) {
      const existing = db
        .prepare(`SELECT * FROM scan_dedup WHERE device_id = ? AND scan_serial = ?`)
        .get(deviceId, serial);
      return { existing };
    },

    recordScan(row) {
      db.prepare(
        `INSERT INTO scan_dedup
          (device_id, scan_serial, request_version_id, event_type, status, event_id,
           first_seen_at, last_replayed_at)
         VALUES
          (@device_id, @scan_serial, @request_version_id, @event_type, @status, @event_id,
           @first_seen_at, @last_replayed_at)
        ON CONFLICT(device_id, scan_serial)
        DO UPDATE SET last_replayed_at = excluded.last_replayed_at`,
      ).run(row);
      return db
        .prepare(`SELECT * FROM scan_dedup WHERE device_id = ? AND scan_serial = ?`)
        .get(row.device_id, row.scan_serial);
    },

    // ---- 访问日志 ----------------------------------------------------------
    recordAccess(a) {
      db.prepare(
        `INSERT INTO access_log
          (actor, actor_role, kind, target, site_code, authorization_id, detail, created_at)
         VALUES
          (@actor, @actor_role, @kind, @target, @site_code, @authorization_id, @detail, @created_at)`,
      ).run(a);
    },

    listAccess({ actor, target } = {}) {
      let sql = `SELECT * FROM access_log`;
      const where = [];
      const params = [];
      if (actor) {
        where.push(`actor = ?`);
        params.push(actor);
      }
      if (target) {
        where.push(`target = ? OR target IN (SELECT id FROM request_versions WHERE registration_id = ?)`);
        params.push(target, target);
      }
      if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
      sql += ` ORDER BY seq`;
      return db.prepare(sql).all(...params);
    },
  };

  return store;
}
