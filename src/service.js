import { randomUUID } from "node:crypto";
import {
  Role,
  Tier,
  RequestState,
  ACTIVE_STATES,
  EventType,
  ALLOWED_TRANSITIONS,
  VerificationSource,
  Escalation,
  ScanStatus,
  TransferState,
} from "./contracts.js";

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TERMINAL_FLOW = new Set([RequestState.DELIVERED, RequestState.BLOCKED]);

export function createService(db, options = {}) {
  const now = options.now ?? (() => Date.now());
  const id = options.id ?? (() => randomUUID());

  // ---------- 基础工具 ----------

  function logAccess(actor, action, tier, subject = {}) {
    db.prepare(
      `INSERT INTO access_log (actor, actor_role, action, tier, person_id, registration_id, request_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      actor.id,
      actor.role,
      action,
      tier,
      subject.personId ?? null,
      subject.registrationId ?? null,
      subject.requestId ?? null,
      now()
    );
  }

  function appendRegEvent(tx, registrationId, type, actor, payload = {}, at = now()) {
    tx.prepare(
      `INSERT INTO registration_events (registration_id, event_type, actor, actor_role, payload_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(registrationId, type, actor.id, actor.role, JSON.stringify(payload ?? {}), at);
  }

  function appendReqEvent(tx, requestRow, type, actor, payload = {}, meta = {}, at = now()) {
    tx.prepare(
      `INSERT INTO request_events
         (request_id, registration_id, event_type, actor, actor_role, payload_json, occurred_at, device_id, scan_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      requestRow.id,
      requestRow.registration_id,
      type,
      actor.id,
      actor.role,
      JSON.stringify(payload ?? {}),
      at,
      meta.deviceId ?? null,
      meta.scanSeq ?? null
    );
  }

  function getPerson(personId) {
    const person = db.prepare(`SELECT * FROM persons WHERE id = ?`).get(personId);
    if (!person) throw new HttpError(404, "person_not_found", "人员不存在");
    return person;
  }

  function activeGrant(personId, grantee) {
    return db
      .prepare(`SELECT 1 FROM consents WHERE person_id = ? AND grantee = ? AND active = 1`)
      .get(personId, grantee);
  }

  /** 本人，或持有该人员有效授权的医护。 */
  function requireSelfOrClinician(actor, person) {
    if (actor.role === Role.SELF && actor.id === person.id) return;
    if (actor.role === Role.CLINICIAN && activeGrant(person.id, actor.id)) return;
    throw new HttpError(403, "forbidden", "仅本人或获授权医护可执行该操作");
  }

  function requireClinician(actor, person) {
    if (actor.role !== Role.CLINICIAN || !activeGrant(person.id, actor.id)) {
      throw new HttpError(403, "forbidden", "需要该人员的有效医护授权");
    }
  }

  function getRegistration(registrationId) {
    const row = db.prepare(`SELECT * FROM medication_registrations WHERE id = ?`).get(registrationId);
    if (!row) throw new HttpError(404, "registration_not_found", "用药登记不存在");
    return row;
  }

  function latestVersion(tx, registrationId) {
    return tx
      .prepare(`SELECT * FROM supply_requests WHERE registration_id = ? ORDER BY version_no DESC LIMIT 1`)
      .get(registrationId);
  }

  function activeVersion(tx, registrationId) {
    return tx
      .prepare(
        `SELECT * FROM supply_requests WHERE registration_id = ? AND status IN (${ACTIVE_STATES.map(() => "?").join(",")})
         ORDER BY version_no DESC LIMIT 1`
      )
      .get(registrationId, ...ACTIVE_STATES);
  }

  function medSnapshot(reg) {
    return {
      medicationLabel: reg.medication_label,
      remainingDoses: { amount: reg.remaining_doses_amount, unit: reg.remaining_doses_unit },
      allergies: JSON.parse(reg.allergies_json),
      verificationSource: reg.verification_source,
      verificationDetail: reg.verification_detail ?? null,
    };
  }

  // ---------- 站点与人员 ----------

  function createSite(name, siteId = id()) {
    db.prepare(`INSERT INTO sites (id, name, created_at) VALUES (?, ?, ?)`).run(siteId, name, now());
    return { id: siteId, name };
  }

  function createPerson(siteId, actor, personId = id()) {
    if (!db.prepare(`SELECT 1 FROM sites WHERE id = ?`).get(siteId)) {
      throw new HttpError(404, "site_not_found", "安置点不存在");
    }
    const anonCode = `P-${personId.slice(0, 8)}`;
    db.prepare(
      `INSERT INTO persons (id, anon_code, current_site_id, consent_active, created_at)
       VALUES (?, ?, ?, 1, ?)`
    ).run(personId, anonCode, siteId, now());
    logAccess(actor, "person.create", Tier.IDENTITY, { personId });
    return { id: personId, anonCode, currentSiteId: siteId };
  }

  function grantClinician(personId, clinicianId, actor) {
    const person = getPerson(personId);
    if (actor.role !== Role.SELF || actor.id !== person.id) {
      throw new HttpError(403, "forbidden", "仅本人可授权医护");
    }
    db.prepare(
      `INSERT INTO consents (person_id, grantee, active, granted_at) VALUES (?, ?, 1, ?)
       ON CONFLICT(person_id, grantee) DO UPDATE SET active = 1, revoked_at = NULL`
    ).run(personId, clinicianId, now());
    logAccess(actor, "consent.grant", Tier.IDENTITY, { personId });
    return { personId, clinicianId, active: true };
  }

  /** 解除某位医护的授权：该医护立即失去该人员临床数据的访问与操作权。 */
  function revokeClinician(personId, clinicianId, actor) {
    const person = getPerson(personId);
    if (actor.role !== Role.SELF || actor.id !== person.id) {
      throw new HttpError(403, "forbidden", "仅本人可撤回医护授权");
    }
    db.prepare(
      `UPDATE consents SET active = 0, revoked_at = ? WHERE person_id = ? AND grantee = ? AND active = 1`
    ).run(now(), personId, clinicianId);
    logAccess(actor, "consent.revoke_clinician", Tier.IDENTITY, { personId });
    return { personId, clinicianId, active: false };
  }

  // ---------- 登记（分级保存） ----------

  function registerMedication(personId, actor, input) {
    const person = getPerson(personId);
    requireSelfOrClinician(actor, person);
    if (!person.consent_active) throw new HttpError(409, "consent_withdrawn", "授权已撤回，不能登记续供");

    const label = String(input.medicationLabel ?? "").trim();
    if (!label) throw new HttpError(400, "invalid_input", "缺少药品标识");
    const amount = Number(input.remainingDoses?.amount);
    const unit = String(input.remainingDoses?.unit ?? "").trim();
    if (!Number.isFinite(amount) || amount < 0 || !unit) {
      throw new HttpError(400, "invalid_input", "剩余剂量无效");
    }
    const latestSupplyBy = Number(input.latestSupplyBy);
    if (!Number.isFinite(latestSupplyBy) || latestSupplyBy <= now()) {
      throw new HttpError(400, "invalid_input", "最晚补给时刻无效（必须晚于当前时刻）");
    }
    if (!Object.values(VerificationSource).includes(input.verificationSource)) {
      throw new HttpError(400, "invalid_input", "验证来源无效");
    }
    const allergies = Array.isArray(input.allergies) ? input.allergies.map(String) : [];

    const registrationId = id();
    const ts = now();
    db.prepare(
      `INSERT INTO medication_registrations
        (id, person_id, site_id, medication_label, remaining_doses_amount, remaining_doses_unit,
         latest_supply_by, allergies_json, verification_source, verification_detail,
         requires_cold_chain, delivery_required, registered_by, registered_by_role,
         blocked_allergy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    ).run(
      registrationId,
      personId,
      person.current_site_id,
      label,
      amount,
      unit,
      latestSupplyBy,
      JSON.stringify(allergies),
      input.verificationSource,
      input.verificationDetail ?? null,
      input.requiresColdChain ? 1 : 0,
      input.deliveryRequired ? 1 : 0,
      actor.id,
      actor.role,
      ts,
      ts
    );
    appendRegEvent(
      db,
      registrationId,
      EventType.REGISTERED,
      actor,
      { allergies, verificationSource: input.verificationSource, latestSupplyBy },
      ts
    );
    logAccess(actor, "medication.register", Tier.CLINICAL, { personId, registrationId });
    return { registrationId, ...operationalRegistration(getRegistration(registrationId)) };
  }

  // ---------- 阻断：过敏禁忌 / 授权撤回 ----------

  /**
   * 立即阻断未交付药物。已完成交付（delivered）的版本保持终态，
   * 其冻结依据原样保留，不被追溯修改。
   */
  const blockUndelivered = db.transaction((registration, actor, reason, eventType) => {
    const ts = now();
    db.prepare(
      `UPDATE medication_registrations
         SET blocked_allergy = CASE WHEN ? = '${EventType.BLOCKED_ALLERGY}' THEN 1 ELSE blocked_allergy END,
             blocked_reason = ?, updated_at = ?
       WHERE id = ?`
    ).run(eventType, reason, ts, registration.id);

    const active = activeVersion(db, registration.id);
    if (active) {
      db.prepare(`UPDATE supply_requests SET status = ?, updated_at = ? WHERE id = ?`).run(
        RequestState.BLOCKED,
        ts,
        active.id
      );
      appendReqEvent(db, active, eventType, actor, { reason }, {}, ts);
    }
    appendRegEvent(db, registration.id, eventType, actor, { reason }, ts);
    return { blocked: Boolean(active), requestId: active?.id ?? null };
  });

  function flagAllergy(registrationId, actor, reason) {
    const reg = getRegistration(registrationId);
    requireClinician(actor, getPerson(reg.person_id));
    logAccess(actor, "medication.flag_allergy", Tier.CLINICAL, {
      personId: reg.person_id,
      registrationId,
    });
    return blockUndelivered(reg, actor, reason || "过敏禁忌", EventType.BLOCKED_ALLERGY);
  }

  /** 本人撤回服务授权：该人员所有未交付需求立即阻断。 */
  const withdrawConsent = db.transaction((personId, actor) => {
    const person = getPerson(personId);
    if (actor.role !== Role.SELF || actor.id !== person.id) {
      throw new HttpError(403, "forbidden", "仅本人可撤回授权");
    }
    const ts = now();
    db.prepare(`UPDATE persons SET consent_active = 0 WHERE id = ?`).run(personId);
    db.prepare(
      `UPDATE consents SET active = 0, revoked_at = ? WHERE person_id = ? AND active = 1`
    ).run(ts, personId);

    const results = [];
    const regs = db.prepare(`SELECT * FROM medication_registrations WHERE person_id = ?`).all(personId);
    for (const reg of regs) {
      results.push(blockUndelivered(reg, actor, "本人撤回授权", EventType.BLOCKED_CONSENT));
    }
    logAccess(actor, "consent.withdraw", Tier.IDENTITY, { personId });
    return { personId, consentActive: false, blocked: results };
  });

  // ---------- 医护复核 → 一次性续供需求 ----------

  const createVersion = db.transaction((reg, actor, versionNo, triggerEvent, destinationSiteId, appendEvent = true) => {
    const ts = now();
    const requestId = id();
    const candidate = medSnapshot(reg);
    // 同一需求的临期级别跨版本延续（转移/重发不清零），sweep 只做单调上调
    const prev = latestVersion(db, reg.id);
    const initialLevel = Math.max(prev?.escalation_level ?? 0, levelForDeadline(reg.latest_supply_by, ts));
    db.prepare(
      `INSERT INTO supply_requests
        (id, registration_id, person_id, version_no, destination_site_id, status,
         med_snapshot, latest_supply_by, requires_cold_chain, delivery_required,
         responsible_party, responsible_kind, package_code, escalation_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`
    ).run(
      requestId,
      reg.id,
      reg.person_id,
      versionNo,
      destinationSiteId,
      RequestState.PENDING,
      JSON.stringify(candidate),
      reg.latest_supply_by,
      reg.requires_cold_chain,
      reg.delivery_required,
      initialLevel,
      ts,
      ts
    );
    const row = db.prepare(`SELECT * FROM supply_requests WHERE id = ?`).get(requestId);
    if (appendEvent) {
      appendReqEvent(db, row, triggerEvent, actor, { versionNo, destinationSiteId }, {}, ts);
    }
    return row;
  });

  function guardIssuable(reg) {
    if (reg.blocked_reason) {
      throw new HttpError(409, "registration_blocked", `登记已阻断：${reg.blocked_reason}`);
    }
    const person = getPerson(reg.person_id);
    if (!person.consent_active) throw new HttpError(409, "consent_withdrawn", "授权已撤回");
    if (activeVersion(db, reg.id)) {
      throw new HttpError(409, "request_active", "已有进行中的续供需求");
    }
    const last = latestVersion(db, reg.id);
    if (last && TERMINAL_FLOW.has(last.status)) {
      throw new HttpError(409, `request_${last.status}`, "该需求已终结，不能再生成新版本");
    }
    return person;
  }

  function review(registrationId, actor) {
    const reg = getRegistration(registrationId);
    requireClinician(actor, getPerson(reg.person_id));
    if (latestVersion(db, reg.id)) {
      throw new HttpError(409, "request_exists", "已有续供需求；拒收或损坏后请使用重新发出");
    }
    guardIssuable(reg);
    const row = createVersion(reg, actor, 1, EventType.REVIEWED, reg.site_id);
    appendRegEvent(db, registrationId, EventType.REVIEWED, actor, { requestId: row.id });
    logAccess(actor, "request.review", Tier.CLINICAL, {
      personId: reg.person_id,
      registrationId,
      requestId: row.id,
    });
    return requestView(row);
  }

  /** 拒收或损坏后，医护复核重新发出下一版本（一次性，版本号递增）。 */
  function reissue(registrationId, actor) {
    const reg = getRegistration(registrationId);
    requireClinician(actor, getPerson(reg.person_id));
    guardIssuable(reg);
    const last = latestVersion(db, reg.id);
    if (!last) throw new HttpError(409, "no_prior_version", "尚未复核生成过需求");
    // 沿用最近版本的目的站点：人员转移后重发应面向当前安置点
    const row = createVersion(reg, actor, last.version_no + 1, EventType.REISSUED, last.destination_site_id);
    logAccess(actor, "request.reissue", Tier.CLINICAL, {
      personId: reg.person_id,
      registrationId,
      requestId: row.id,
    });
    return requestView(row);
  }

  // ---------- 认领（接受）：并发只有一个成功，并冻结所见版本 ----------

  const claim = db.transaction((requestId, actor, partyKind) => {
    const req = db.prepare(`SELECT * FROM supply_requests WHERE id = ?`).get(requestId);
    if (!req) throw new HttpError(404, "request_not_found", "续供需求不存在");
    const reg = getRegistration(req.registration_id);
    // 认领瞬间仍校验阻断条件，避免冻结已禁忌/已撤权的需求
    if (reg.blocked_reason || !getPerson(reg.person_id).consent_active) {
      throw new HttpError(409, "registration_blocked", "需求已被阻断，不能认领");
    }
    const ts = now();
    // 条件更新：CAS。并发认领只有一个事务能把 pending 改成 claimed。
    const result = db.prepare(
      `UPDATE supply_requests
         SET status = ?, responsible_party = ?, responsible_kind = ?,
             package_code = ?, frozen_at = ?, updated_at = ?
       WHERE id = ? AND status = ?`
    ).run(
      RequestState.CLAIMED,
      actor.id,
      partyKind || "dispenser",
      `${requestId}-v${req.version_no}`,
      ts,
      ts,
      requestId,
      RequestState.PENDING
    );
    if (result.changes !== 1) {
      const current = db.prepare(`SELECT status FROM supply_requests WHERE id = ?`).get(requestId);
      throw new HttpError(409, "already_claimed", `需求当前状态为 ${current?.status}，认领失败`);
    }
    // 冻结：以认领时刻的登记内容重拍快照，之后任何流程不再改写
    const frozen = {
      ...medSnapshot(reg),
      frozenAt: ts,
      frozenBy: actor.id,
      consentActiveAtFreeze: true,
      blockedAtFreeze: false,
    };
    const basis = {
      reviewVersion: req.version_no,
      registeredBy: reg.registered_by,
      registeredByRole: reg.registered_by_role,
      destinationSiteId: req.destination_site_id,
      latestSupplyBy: req.latest_supply_by,
    };
    db.prepare(`UPDATE supply_requests SET med_snapshot = ?, basis_snapshot = ? WHERE id = ?`).run(
      JSON.stringify(frozen),
      JSON.stringify(basis),
      requestId
    );
    const row = db.prepare(`SELECT * FROM supply_requests WHERE id = ?`).get(requestId);
    appendReqEvent(db, row, EventType.CLAIMED, actor, {
      party: actor.id,
      partyKind: partyKind || "dispenser",
      packageCode: row.package_code,
      frozen,
    }, {}, ts);
    logAccess(actor, "request.claim", Tier.CLINICAL, {
      personId: req.person_id,
      registrationId: req.registration_id,
      requestId,
    });
    return requestView(row);
  });

  // ---------- 流向事件：发出 / 在途 / 签收 / 拒收 / 损坏（只追加） ----------

  const applyFlowEvent = db.transaction((requestId, eventType, actor, payload, meta = {}, at = now()) => {
    const req = db.prepare(`SELECT * FROM supply_requests WHERE id = ?`).get(requestId);
    if (!req) throw new HttpError(404, "request_not_found", "续供需求不存在");

    // 迟到事件不能越过已关闭版本，也不能落到被重新发出的旧版本上
    if (!ACTIVE_STATES.includes(req.status)) {
      throw new HttpError(409, "version_closed", `版本已关闭（${req.status}），事件被拒绝`);
    }
    // 过敏/撤权即时阻断优先于一切流向事件
    const reg = getRegistration(req.registration_id);
    if (reg.blocked_reason || !getPerson(reg.person_id).consent_active) {
      throw new HttpError(409, "registration_blocked", "需求已被阻断，事件被拒绝");
    }
    // 只有负责药房/医疗队本人、现场协调员，或本人签收可推进流向
    const selfOk = eventType === EventType.DELIVERED && actor.role === Role.SELF && actor.id === req.person_id;
    if (!selfOk && actor.role !== Role.COORDINATOR && actor.id !== req.responsible_party) {
      throw new HttpError(403, "forbidden", "仅该需求的负责方、现场协调员或本人可记录此事件");
    }
    const allowed = ALLOWED_TRANSITIONS[eventType];
    if (!allowed || !allowed.includes(req.status)) {
      throw new HttpError(409, "illegal_transition", `不能从 ${req.status} 迁移到 ${eventType}`);
    }

    const nextStatus = {
      [EventType.DISPATCHED]: RequestState.DISPATCHED,
      [EventType.IN_TRANSIT]: RequestState.IN_TRANSIT,
      [EventType.DELIVERED]: RequestState.DELIVERED,
      [EventType.REJECTED]: RequestState.REJECTED,
      [EventType.DAMAGED]: RequestState.DAMAGED,
    }[eventType];

    db.prepare(`UPDATE supply_requests SET status = ?, updated_at = ? WHERE id = ?`).run(nextStatus, at, requestId);
    const row = db.prepare(`SELECT * FROM supply_requests WHERE id = ?`).get(requestId);
    appendReqEvent(db, row, eventType, actor, payload ?? {}, meta, at);
    return requestView(row);
  });

  function dispatch(requestId, actor, payload = {}) {
    if (actor.role !== Role.DISPENSER) throw new HttpError(403, "forbidden", "仅药房或医疗队可标记发出");
    return applyFlowEvent(requestId, EventType.DISPATCHED, actor, payload);
  }
  function markInTransit(requestId, actor, payload = {}) {
    if (actor.role !== Role.DISPENSER && actor.role !== Role.COORDINATOR) {
      throw new HttpError(403, "forbidden", "仅配送相关方可标记在途");
    }
    return applyFlowEvent(requestId, EventType.IN_TRANSIT, actor, payload);
  }
  function deliver(requestId, actor, payload = {}) {
    return applyFlowEvent(requestId, EventType.DELIVERED, actor, payload);
  }
  function reject(requestId, actor, payload = {}) {
    return applyFlowEvent(requestId, EventType.REJECTED, actor, payload);
  }
  function damage(requestId, actor, payload = {}) {
    return applyFlowEvent(requestId, EventType.DAMAGED, actor, payload);
  }

  // ---------- 离线扫描：设备流水去重、迟到签收拦截 ----------

  const SCAN_EVENT = Object.freeze({
    dispatch: EventType.DISPATCHED,
    in_transit: EventType.IN_TRANSIT,
    deliver: EventType.DELIVERED,
    reject: EventType.REJECTED,
    damage: EventType.DAMAGED,
  });

  const reportScan = db.transaction((scan) => {
    const deviceId = String(scan.deviceId ?? "");
    const scanSeq = String(scan.scanSeq ?? "");
    if (!deviceId || !scanSeq) throw new HttpError(400, "invalid_scan", "缺少设备标识或流水号");
    const eventType = SCAN_EVENT[scan.scanType];
    if (!eventType) throw new HttpError(400, "invalid_scan", "扫描类型无效");
    const at = Number(scan.occurredAt ?? now());

    // 同设备同流水：幂等返回首次处置结果，绝不重复落事件
    const prior = db.prepare(`SELECT * FROM scan_log WHERE device_id = ? AND scan_seq = ?`).get(deviceId, scanSeq);
    if (prior) {
      return { result: ScanStatus.DUPLICATE, original: JSON.parse(prior.payload_json) };
    }

    const finish = (result, extra = {}) => {
      db.prepare(
        `INSERT INTO scan_log (device_id, scan_seq, scan_type, result, payload_json, at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(deviceId, scanSeq, scan.scanType, result, JSON.stringify({ result, ...extra }), at);
      return { result, ...extra };
    };

    const packageCode = String(scan.packageCode ?? "");
    const req = packageCode
      ? db.prepare(`SELECT * FROM supply_requests WHERE package_code = ?`).get(packageCode)
      : undefined;
    if (!req) return finish(ScanStatus.UNKNOWN, { packageCode });

    if (!ACTIVE_STATES.includes(req.status)) {
      return finish(ScanStatus.STALE, { requestId: req.id, status: req.status, packageCode });
    }
    const allowed = ALLOWED_TRANSITIONS[eventType];
    if (!allowed.includes(req.status)) {
      return finish(ScanStatus.REJECTED, {
        requestId: req.id,
        status: req.status,
        packageCode,
        reason: "illegal_transition",
      });
    }

    // 手持设备由负责药房/医疗队操作：未显式给 actorId 时以该包裹负责方身份落事件
    const actor = {
      id: scan.actorId || (scan.actorRole === Role.COORDINATOR ? deviceId : req.responsible_party || deviceId),
      role: scan.actorRole || Role.DISPENSER,
    };
    try {
      const view = applyFlowEvent(req.id, eventType, actor, scan.payload ?? {}, { deviceId, scanSeq }, at);
      return finish(ScanStatus.ACCEPTED, { requestId: req.id, status: view.status, packageCode });
    } catch (error) {
      if (error instanceof HttpError && error.code === "registration_blocked") {
        return finish(ScanStatus.REJECTED, { requestId: req.id, reason: error.code, packageCode });
      }
      throw error;
    }
  });

  // ---------- 人员转移：未完成需求交接给新安置点 ----------

  const reportMovement = db.transaction((personId, toSiteId, actor, movementId = id()) => {
    const person = getPerson(personId);
    if (!db.prepare(`SELECT 1 FROM sites WHERE id = ?`).get(toSiteId)) {
      throw new HttpError(404, "site_not_found", "目标安置点不存在");
    }
    const pending = db
      .prepare(`SELECT 1 FROM person_movements WHERE person_id = ? AND status = 'pending'`)
      .get(personId);
    if (pending) throw new HttpError(409, "movement_pending", "该人员已有进行中的转移");
    if (toSiteId === person.current_site_id) {
      throw new HttpError(400, "same_site", "人员已在该安置点");
    }

    const ts = now();
    db.prepare(
      `INSERT INTO person_movements (id, person_id, from_site_id, to_site_id, status, departed_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    ).run(movementId, personId, person.current_site_id, toSiteId, ts);

    // 未完成 = 有活跃版本，或最后版本拒收/损坏待重发；已交付与已阻断不交接
    const handovers = [];
    const regs = db.prepare(`SELECT * FROM medication_registrations WHERE person_id = ?`).all(personId);
    for (const reg of regs) {
      if (reg.blocked_reason || !person.consent_active) continue;
      const active = activeVersion(db, reg.id);
      const last = latestVersion(db, reg.id);
      const source = active ?? (last && [RequestState.REJECTED, RequestState.DAMAGED].includes(last.status) ? last : null);
      if (!source) continue;
      const transferId = id();
      db.prepare(
        `INSERT INTO transfers
          (id, movement_id, request_id, registration_id, from_site_id, to_site_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(request_id) DO NOTHING`
      ).run(transferId, movementId, source.id, reg.id, person.current_site_id, toSiteId, ts);
      handovers.push({ transferId, registrationId: reg.id, fromRequestId: source.id });
    }
    logAccess(actor, "movement.report", Tier.IDENTITY, { personId });
    return { movementId, personId, fromSiteId: person.current_site_id, toSiteId, handovers };
  });

  /**
   * 到达确认：原子地关闭旧点版本（transferred 终态）并在新点生成待认领版本。
   * 若途中药物已签收/被阻断，则对应交接单作废——任一时刻同一需求只有一个负责方。
   * 可重复调用：已完成的交接单跳过（崩溃/服务恢复后续跑）。
   */
  const confirmArrival = db.transaction((movementId, actor) => {
    const movement = db.prepare(`SELECT * FROM person_movements WHERE id = ?`).get(movementId);
    if (!movement) throw new HttpError(404, "movement_not_found", "转移记录不存在");
    const ts = now();
    const arrivalTs = movement.arrived_at ?? ts;
    db.prepare(
      `UPDATE person_movements SET status = 'done', arrived_at = ? WHERE id = ? AND status = 'pending'`
    ).run(arrivalTs, movementId);
    // 仅当人员尚未被后续转移移动过时更新归属，避免覆盖更新状态
    db.prepare(
      `UPDATE persons SET current_site_id = ? WHERE id = ? AND current_site_id = ?`
    ).run(movement.to_site_id, movement.person_id, movement.from_site_id);

    const transfers = db
      .prepare(`SELECT * FROM transfers WHERE movement_id = ? ORDER BY created_at`)
      .all(movementId);
    const completed = [];
    const obsolete = [];

    for (const tr of transfers) {
      if (tr.status !== TransferState.PENDING) {
        // 幂等续跑：已处理的交接单不再重复生成版本
        (tr.status === TransferState.DONE ? completed : obsolete).push({
          transferId: tr.id,
          status: "already_done",
        });
        continue;
      }
      const source = db.prepare(`SELECT * FROM supply_requests WHERE id = ?`).get(tr.request_id);
      const reg = getRegistration(tr.registration_id);

      // 阻断优先：药物不得交付，交接单作废
      if (reg.blocked_reason || !getPerson(reg.person_id).consent_active) {
        db.prepare(
          `UPDATE transfers SET status = 'obsolete', completed_at = ? WHERE id = ? AND status = 'pending'`
        ).run(ts, tr.id);
        obsolete.push({ transferId: tr.id, reason: "blocked" });
        continue;
      }
      // 途中已签收：旧点交付已完成，无需交接
      if (source && source.status === RequestState.DELIVERED) {
        db.prepare(
          `UPDATE transfers SET status = 'obsolete', completed_at = ? WHERE id = ? AND status = 'pending'`
        ).run(ts, tr.id);
        obsolete.push({ transferId: tr.id, reason: RequestState.DELIVERED });
        continue;
      }

      // 交接以当前活跃版本为准（转移单可能建在拒收版本上，途中已被重发）
      const currentActive = activeVersion(db, tr.registration_id);
      if (currentActive) {
        db.prepare(`UPDATE supply_requests SET status = ?, updated_at = ? WHERE id = ?`).run(
          RequestState.TRANSFERRED,
          ts,
          currentActive.id
        );
        appendReqEvent(db, currentActive, EventType.TRANSFERRED_OUT, actor, { toSiteId: tr.to_site_id }, {}, ts);
      }

      const last = latestVersion(db, tr.registration_id);
      const nextNo = (last?.version_no ?? 0) + 1;
      // 无活跃版本时（来源版本拒收/损坏）同样在新点生成待认领版本
      const row = createVersion(reg, actor, nextNo, EventType.TRANSFERRED_IN, tr.to_site_id, false);
      appendReqEvent(
        db,
        row,
        EventType.TRANSFERRED_IN,
        actor,
        { versionNo: nextNo, fromSiteId: tr.from_site_id, fromRequestId: currentActive?.id ?? tr.request_id, movementId },
        {},
        ts
      );

      db.prepare(
        `UPDATE transfers SET status = 'done', completed_at = ? WHERE id = ? AND status = 'pending'`
      ).run(ts, tr.id);
      completed.push({ transferId: tr.id, newRequestId: row.id, toSiteId: tr.to_site_id });
    }

    logAccess(actor, "movement.arrive", Tier.IDENTITY, { personId: movement.person_id });
    return { movementId, completed, obsolete };
  });

  // ---------- 服务恢复扫描：临期升级 / 转移交接 / 待签收 ----------

  function levelForDeadline(latestSupplyBy, ts) {
    const remain = latestSupplyBy - ts;
    if (remain <= 0) return Escalation.LEVELS.CRITICAL;
    if (remain <= Escalation.URGENT_MS) return Escalation.LEVELS.URGENT;
    if (remain <= Escalation.WATCH_MS) return Escalation.LEVELS.WATCH;
    return Escalation.LEVELS.NORMAL;
  }

  const runSweep = db.transaction((at = now()) => {
    // 1) 临期升级：单调只升，跨越阈值才追加事件
    const escalated = [];
    const actives = db
      .prepare(
        `SELECT * FROM supply_requests WHERE status IN (${ACTIVE_STATES.map(() => "?").join(",")})`
      )
      .all(...ACTIVE_STATES);
    for (const req of actives) {
      const target = levelForDeadline(req.latest_supply_by, at);
      if (target > req.escalation_level) {
        db.prepare(`UPDATE supply_requests SET escalation_level = ? WHERE id = ?`).run(target, req.id);
        appendReqEvent(
          db,
          req,
          EventType.ESCALATED,
          { id: "system", role: "system" },
          { from: req.escalation_level, to: target, at },
          {},
          at
        );
        escalated.push({ requestId: req.id, from: req.escalation_level, to: target });
      }
    }

    // 2) 转移交接：已到达但崩溃在中途的转移继续完成
    const completedTransfers = [];
    const arrivedOpen = db
      .prepare(
        `SELECT m.id FROM person_movements m
         WHERE m.status = 'pending' AND m.arrived_at IS NOT NULL
         AND EXISTS (SELECT 1 FROM transfers t WHERE t.movement_id = m.id AND t.status = 'pending')`
      )
      .all();
    for (const m of arrivedOpen) {
      completedTransfers.push(confirmArrival(m.id, { id: "system", role: "system" }));
    }

    // 3) 待签收：已发出/在途任务清单（供协调员继续催办）
    const pendingReceipt = db
      .prepare(
        `SELECT id, package_code, destination_site_id, status, requires_cold_chain,
                delivery_required, latest_supply_by, escalation_level
         FROM supply_requests WHERE status IN (?, ?) ORDER BY latest_supply_by`
      )
      .all(RequestState.DISPATCHED, RequestState.IN_TRANSIT)
      .map((r) => operationalRequest(r));

    return { at, escalated, completedTransfers, pendingReceipt };
  });

  /** 离线到达补录：设备在途中记录了到达事实，恢复时补盖 arrived_at 后让 sweep 续跑。 */
  function recordArrivalOffline(movementId, arrivedAt, actor) {
    const result = db
      .prepare(
        `UPDATE person_movements SET arrived_at = ? WHERE id = ? AND status = 'pending' AND arrived_at IS NULL`
      )
      .run(arrivedAt, movementId);
    if (result.changes !== 1) throw new HttpError(409, "arrival_recorded", "到达时间已存在或转移不存在");
    logAccess(actor, "movement.arrive_offline", Tier.IDENTITY, {});
    return runSweep();
  }

  // ---------- 视图投影（分级） ----------

  function operationalRegistration(reg) {
    return {
      registrationId: reg.id,
      requiresColdChain: Boolean(reg.requires_cold_chain),
      deliveryRequired: Boolean(reg.delivery_required),
      latestSupplyBy: reg.latest_supply_by,
      blocked: Boolean(reg.blocked_reason),
    };
  }

  function operationalRequest(req) {
    return {
      // 仅运营字段：不含人员、药品标识、剂量、过敏
      requestId: req.id,
      packageCode: req.package_code ?? null,
      destinationSiteId: req.destination_site_id,
      status: req.status,
      requiresColdChain: Boolean(req.requires_cold_chain),
      deliveryRequired: Boolean(req.delivery_required),
      latestSupplyBy: req.latest_supply_by,
      escalationLevel: req.escalation_level,
    };
  }

  function requestView(row) {
    const snapshot = row.med_snapshot ? JSON.parse(row.med_snapshot) : null;
    const events = db
      .prepare(
        `SELECT event_type, actor, actor_role, occurred_at, device_id, scan_seq
         FROM request_events WHERE request_id = ? ORDER BY id`
      )
      .all(row.id)
      .map((e) => ({
        type: e.event_type,
        actor: e.actor,
        actorRole: e.actor_role,
        at: e.occurred_at,
        deviceId: e.device_id ?? null,
        scanSeq: e.scan_seq ?? null,
      }));
    return {
      ...operationalRequest(row),
      versionNo: row.version_no,
      responsibleParty: row.responsible_party ?? null,
      responsibleKind: row.responsible_kind ?? null,
      frozenAt: row.frozen_at ?? null,
      medication: snapshot, // L2：仅临床/药房角色读取时才有意义
      basis: row.basis_snapshot ? JSON.parse(row.basis_snapshot) : null,
      events,
    };
  }

  /** 协调员看板：纯 L1 投影。 */
  function coordinationBoard(siteId, actor) {
    if (actor.role !== Role.COORDINATOR) throw new HttpError(403, "forbidden", "仅现场协调员可查看");
    const rows = db
      .prepare(
        `SELECT * FROM supply_requests
         WHERE destination_site_id = ? AND status IN (${ACTIVE_STATES.map(() => "?").join(",")})
         ORDER BY escalation_level DESC, latest_supply_by`
      )
      .all(siteId, ...ACTIVE_STATES);
    const incoming = db
      .prepare(`SELECT COUNT(*) AS n FROM transfers WHERE to_site_id = ? AND status = 'pending'`)
      .get(siteId).n;
    return { siteId, incomingTransfers: incoming, requests: rows.map(operationalRequest) };
  }

  /** 临床视图：本人/授权医护/责任药房，读取落审计。 */
  function getClinicalRequest(requestId, actor) {
    const req = db.prepare(`SELECT * FROM supply_requests WHERE id = ?`).get(requestId);
    if (!req) throw new HttpError(404, "request_not_found", "续供需求不存在");
    const person = getPerson(req.person_id);
    const allowed =
      (actor.role === Role.SELF && actor.id === person.id) ||
      (actor.role === Role.CLINICIAN && activeGrant(person.id, actor.id)) ||
      (actor.role === Role.DISPENSER &&
        (req.responsible_party === actor.id || req.status === RequestState.PENDING));
    if (!allowed) throw new HttpError(403, "forbidden", "无权查看临床内容");
    logAccess(actor, "request.read_clinical", Tier.CLINICAL, {
      personId: person.id,
      registrationId: req.registration_id,
      requestId,
    });
    return requestView(req);
  }

  function listMyRegistrations(personId, actor) {
    const person = getPerson(personId);
    if (
      !(actor.role === Role.SELF && actor.id === person.id) &&
      !(actor.role === Role.CLINICIAN && activeGrant(personId, actor.id))
    ) {
      throw new HttpError(403, "forbidden", "无权查看");
    }
    logAccess(actor, "medication.list", Tier.CLINICAL, { personId });
    const regs = db.prepare(`SELECT * FROM medication_registrations WHERE person_id = ?`).all(personId);
    return regs.map((reg) => {
      const versions = db
        .prepare(`SELECT * FROM supply_requests WHERE registration_id = ? ORDER BY version_no`)
        .all(reg.id)
        .map(requestView);
      return {
        ...medSnapshot(reg),
        ...operationalRegistration(reg),
        personId: reg.person_id,
        blockedReason: reg.blocked_reason ?? null,
        versions,
      };
    });
  }

  // ---------- 指挥席：匿名缺口汇总 ----------

  function gapSummary(actor) {
    if (actor.role !== Role.COMMAND) throw new HttpError(403, "forbidden", "仅指挥席可查看");
    const sites = db.prepare(`SELECT id, name FROM sites`).all();
    const perSite = sites.map((site) => {
      const row = db
        .prepare(
          `SELECT
              COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN escalation_level >= 3 THEN 1 ELSE 0 END), 0) AS critical,
              COALESCE(SUM(CASE WHEN escalation_level = 2 THEN 1 ELSE 0 END), 0) AS urgent,
              COALESCE(SUM(CASE WHEN escalation_level = 1 THEN 1 ELSE 0 END), 0) AS watch,
              COALESCE(SUM(CASE WHEN requires_cold_chain = 1 THEN 1 ELSE 0 END), 0) AS cold_chain,
              COALESCE(SUM(CASE WHEN delivery_required = 1 THEN 1 ELSE 0 END), 0) AS delivery,
              COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS unclaimed,
              COALESCE(SUM(CASE WHEN status IN ('dispatched','in_transit') THEN 1 ELSE 0 END), 0) AS in_delivery
           FROM supply_requests WHERE destination_site_id = ? AND status IN (${ACTIVE_STATES.map(() => "?").join(",")})`
        )
        .get(site.id, ...ACTIVE_STATES);
      return {
        siteId: site.id,
        siteName: site.name,
        total: row.total,
        critical: row.critical,
        urgent: row.urgent,
        watch: row.watch,
        coldChain: row.cold_chain,
        deliveryRequired: row.delivery,
        unclaimed: row.unclaimed,
        inDelivery: row.in_delivery,
      };
    });
    return { generatedAt: now(), sites: perSite };
  }

  // ---------- 授权审计：重建访问者、药物流向与最终交付 ----------

  function grantAudit(personId, auditorId, actor) {
    getPerson(personId);
    if (actor.role !== Role.SELF || actor.id !== personId) {
      throw new HttpError(403, "forbidden", "仅本人可授权审计");
    }
    db.prepare(
      `INSERT INTO audit_grants (grantee, person_id, active, granted_by, granted_at)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(grantee, person_id) DO UPDATE SET active = 1, revoked_at = NULL`
    ).run(auditorId, personId, actor.id, now());
    logAccess(actor, "audit.grant", Tier.AUDIT, { personId });
    return { personId, auditorId, active: true };
  }

  function rebuildTrail(personId, actor) {
    if (actor.role !== Role.AUDITOR) throw new HttpError(403, "forbidden", "仅审计员可重建");
    const grant = db
      .prepare(`SELECT 1 FROM audit_grants WHERE grantee = ? AND person_id = ? AND active = 1`)
      .get(actor.id, personId);
    if (!grant) throw new HttpError(403, "audit_not_authorized", "缺少该人员的审计授权");
    const person = getPerson(personId);
    logAccess(actor, "audit.rebuild", Tier.AUDIT, { personId });

    const visitors = db
      .prepare(
        `SELECT actor, actor_role, action, tier, registration_id, request_id, at
         FROM access_log WHERE person_id = ? ORDER BY at, id`
      )
      .all(personId);

    const registrations = db
      .prepare(`SELECT * FROM medication_registrations WHERE person_id = ? ORDER BY created_at`)
      .all(personId)
      .map((reg) => {
        const regEvents = db
          .prepare(`SELECT event_type, actor, actor_role, payload_json, occurred_at FROM registration_events WHERE registration_id = ? ORDER BY id`)
          .all(reg.id)
          .map((e) => ({ ...e, payload: JSON.parse(e.payload_json) }));
        const versions = db
          .prepare(`SELECT * FROM supply_requests WHERE registration_id = ? ORDER BY version_no`)
          .all(reg.id)
          .map((req) => {
            const events = db
              .prepare(
                `SELECT event_type, actor, actor_role, payload_json, occurred_at, device_id, scan_seq
                 FROM request_events WHERE request_id = ? ORDER BY id`
              )
              .all(req.id)
              .map((e) => ({ ...e, payload: JSON.parse(e.payload_json) }));
            return {
              versionNo: req.version_no,
              requestId: req.id,
              status: req.status,
              destinationSiteId: req.destination_site_id,
              packageCode: req.package_code,
              responsibleParty: req.responsible_party,
              responsibleKind: req.responsible_kind,
              frozenAt: req.frozen_at,
              frozenSnapshot: req.med_snapshot ? JSON.parse(req.med_snapshot) : null,
              basis: req.basis_snapshot ? JSON.parse(req.basis_snapshot) : null,
              events,
            };
          });
        const finalDelivery = versions
          .filter((v) => v.status === RequestState.DELIVERED)
          .map((v) => ({
            versionNo: v.version_no,
            requestId: v.requestId,
            deliveredAt: v.events.find((e) => e.event_type === EventType.DELIVERED)?.occurred_at ?? null,
            acceptedBy: v.events.find((e) => e.event_type === EventType.CLAIMED)?.actor ?? null,
            signedOffBy: v.events.find((e) => e.event_type === EventType.DELIVERED)?.actor ?? null,
            // 已完成交付保留当时依据：冻结快照不随后续过敏/撤权变化
            basisAtDelivery: { frozen: v.frozenSnapshot, basis: v.basis },
          }));
        return {
          registrationId: reg.id,
          medication: medSnapshot(reg),
          blocked: Boolean(reg.blocked_reason),
          blockedReason: reg.blocked_reason ?? null,
          events: regEvents,
          versions,
          finalDelivery,
        };
      });

    return {
      person: { id: person.id, anonCode: person.anon_code, consentActive: Boolean(person.consent_active) },
      rebuiltAt: now(),
      visitors,
      medicationFlow: registrations,
    };
  }

  return {
    db,
    createSite,
    createPerson,
    grantClinician,
    revokeClinician,
    registerMedication,
    flagAllergy,
    withdrawConsent,
    review,
    reissue,
    claim,
    dispatch,
    markInTransit,
    deliver,
    reject,
    damage,
    reportScan,
    reportMovement,
    confirmArrival,
    recordArrivalOffline,
    runSweep,
    coordinationBoard,
    getClinicalRequest,
    listMyRegistrations,
    gapSummary,
    grantAudit,
    rebuildTrail,
  };
}
