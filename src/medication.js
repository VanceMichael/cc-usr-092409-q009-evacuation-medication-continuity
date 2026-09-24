// 用药连续性领域服务：登记、复核、一次性需求、认领冻结、物流事件、转移交接、
// 阻断、临期升级、分级视图与审计重建。
//
// 不变式：
//   - 同一登记任一时刻至多一个未终结版本（存储层部分唯一索引兜底）；
//   - 每个版本任一时刻至多一个负责方（单列 responsible_party + 条件 UPDATE）；
//   - 事件只追加；版本一旦终结，迟到事件不得回灌；
//   - 交付（delivered）永久保留认领时冻结的依据，阻断不触及已交付版本。
import { createHash } from "node:crypto";
import {
  AccessKind,
  BlockReason,
  EscalationLevel,
  ESCALATION_ORDER,
  ESCALATION_THRESHOLDS_MS,
  EventType,
  FULFILLMENT_PARTIES,
  LOGISTICS_EVENT_TARGET,
  MEDICAL_ROLES,
  REGISTRATION_FIELD_TIERS,
  RequestState,
  Role,
  SensitivityTier,
  STATE_TRANSITIONS,
  TaskKind,
  TERMINAL_STATES,
  TRANSFERABLE_STATES,
  VerificationSource,
} from "./contracts.js";
import { newId } from "./store.js";

export class ServiceError extends Error {
  constructor(code, message, { status = 400, details } = {}) {
    super(message);
    this.name = "ServiceError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const badRequest = (message, details) =>
  new ServiceError("validation_error", message, { status: 422, details });
const unauthorized = (message = "缺少身份信息") =>
  new ServiceError("unauthorized", message, { status: 401 });
const forbidden = (message = "角色无权执行该操作") =>
  new ServiceError("forbidden", message, { status: 403 });
const notFound = (what) => new ServiceError("not_found", `${what}不存在`, { status: 404 });
const conflict = (code, message, details) =>
  new ServiceError(code, message, { status: 409, details });

const nowIso = (at) => at ?? new Date().toISOString();

function requireFields(input, fields) {
  for (const field of fields) {
    if (input[field] === undefined || input[field] === null || input[field] === "") {
      throw badRequest(`缺少必填字段：${field}`, { field });
    }
  }
}

const isStringArray = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const hashSnapshot = (snapshot) =>
  `sha256:${createHash("sha256").update(stableJson(snapshot)).digest("hex")}`;

// ---- 分级投影 --------------------------------------------------------------

// 协调员公开视图：只有物流必需的三项 + 状态，绝无诊断、处方、过敏与身份。
export function projectCoordinator(view) {
  return {
    request_id: view.request_id,
    version_no: view.version_no,
    state: view.state,
    site_code: view.site_code,
    origin_site_code: view.origin_site_code,
    transferred_from_elsewhere: view.site_code !== view.origin_site_code,
    needs_refrigeration: view.needs_refrigeration,
    needs_delivery: view.needs_delivery,
    latest_supply_at: view.latest_supply_at,
    escalation_level: view.escalation_level,
    has_responsible_party: view.has_responsible_party,
    responsible_party_kind: view.responsible_party_kind,
  };
}

export function tierOfField(field) {
  return REGISTRATION_FIELD_TIERS[field];
}

export function createMedicationService(store, { clock = () => new Date() } = {}) {
  const at = (override) => (override ? nowIso(override) : clock().toISOString());

  const requireActor = (actor) => {
    if (!actor || !actor.id || !actor.role) throw unauthorized();
    return actor;
  };

  const appendEvent = (entry) =>
    store.insertEvent({
      event_id: newId("evt"),
      request_version_id: entry.version_id ?? null,
      registration_id: entry.registration_id,
      version_no: entry.version_no ?? null,
      type: entry.type,
      payload: JSON.stringify(entry.payload ?? {}),
      actor: entry.actor.id,
      actor_role: entry.actor.role,
      site_code: entry.site_code ?? actorSite(entry.actor),
      created_at: entry.at,
    });

  const logAccess = (actor, kind, { target = null, detail = {}, authorizationId = null } = {}) => {
    store.recordAccess({
      actor: actor.id,
      actor_role: actor.role,
      kind,
      target,
      site_code: actorSite(actor),
      authorization_id: authorizationId,
      detail: JSON.stringify(detail),
      created_at: nowIso(),
    });
  };

  const getRegistrationOr404 = (id) => {
    const reg = store.getRegistration(id);
    if (!reg) throw notFound("用药登记");
    return reg;
  };

  const getVersionOr404 = (id) => {
    const version = store.getVersion(id);
    if (!version) throw notFound("续供需求");
    return version;
  };

  const isBlocked = (reg) => !!reg.blocked_allergy || !!reg.auth_withdrawn;

  // ---- 1. 登记：本人或授权医护 -------------------------------------------
  function register(input, actor) {
    requireActor(actor);
    if (actor.role !== Role.SELF && actor.role !== Role.CLINICIAN) {
      throw forbidden("只有本人或授权医护可以登记用药续供需求");
    }
    requireFields(input, [
      "medication_code",
      "medication_label",
      "remaining_doses",
      "dose_unit",
      "latest_supply_at",
      "site_code",
    ]);
    if (!Number.isFinite(Number(input.remaining_doses)) || Number(input.remaining_doses) <= 0) {
      throw badRequest("剩余剂量必须为正数", { field: "remaining_doses" });
    }
    if (Number.isNaN(Date.parse(input.latest_supply_at))) {
      throw badRequest("最晚补给时刻不是合法时间", { field: "latest_supply_at" });
    }
    if (input.allergies !== undefined && !isStringArray(input.allergies)) {
      throw badRequest("过敏项必须是字符串数组", { field: "allergies" });
    }
    if (input.contraindications !== undefined && !isStringArray(input.contraindications)) {
      throw badRequest("禁忌项必须是字符串数组", { field: "contraindications" });
    }

    const verification_source =
      actor.role === Role.CLINICIAN
        ? VerificationSource.AUTHORIZED_CLINICIAN
        : VerificationSource.SELF_REPORT;

    const person_ref = actor.role === Role.SELF ? actor.person_ref ?? input.person_ref : input.person_ref;
    if (!person_ref) throw badRequest("缺少人员标识", { field: "person_ref" });
    if (actor.role === Role.SELF && input.person_ref && input.person_ref !== actor.person_ref) {
      throw forbidden("本人只能登记自己的用药");
    }

    const ts = at(input.at);
    const id = newId("reg");
    const row = {
      id,
      person_ref,
      medication_code: String(input.medication_code),
      medication_label: String(input.medication_label),
      remaining_doses: Number(input.remaining_doses),
      dose_unit: String(input.dose_unit),
      allergies: JSON.stringify(input.allergies ?? []),
      contraindications: JSON.stringify(input.contraindications ?? []),
      verification_source,
      verification_detail: input.verification_detail ?? null,
      registered_by: actor.id,
      registerer_role: actor.role,
      needs_refrigeration: input.needs_refrigeration ? 1 : 0,
      needs_delivery: input.needs_delivery ? 1 : 0,
      latest_supply_at: new Date(input.latest_supply_at).toISOString(),
      site_code: String(input.site_code),
      created_at: ts,
      updated_at: ts,
    };

    return store.tx(() => {
      const registration = store.insertRegistration(row);
      appendEvent({
        registration_id: id,
        type: EventType.REGISTERED,
        payload: {
          verification_source,
          medication_code: row.medication_code,
          latest_supply_at: row.latest_supply_at,
          site_code: row.site_code,
        },
        actor,
        at: ts,
      });
      return registration;
    });
  }

  // ---- 2. 医护复核 → 生成一次性续供需求 -----------------------------------
  function reviewAndCreateRequest(registrationId, actor, input = {}) {
    requireActor(actor);
    if (actor.role !== Role.CLINICIAN) throw forbidden("只有授权医护可以复核并生成续供需求");
    const ts = at(input.at);

    return store.tx(() => {
      const reg = getRegistrationOr404(registrationId);
      if (isBlocked(reg)) {
        throw conflict("registration_blocked", "登记已被过敏或授权撤回阻断，不能生成需求");
      }
      const active = store.activeVersion(registrationId);
      if (active) {
        throw conflict("active_request_exists", "已有未完成的续供需求，一次性需求不得重复生成", {
          request_id: active.id,
          state: active.state,
        });
      }
      const latest = store.latestVersion(registrationId);
      if (latest && (latest.state === RequestState.REJECTED || latest.state === RequestState.DAMAGED)) {
        throw conflict("reissue_required", "上一版本被拒收或损坏，应由医护重新发出新版本", {
          request_id: latest.id,
        });
      }

      const siteCode = input.site_code ?? reg.site_code;
      const versionNo = latest ? latest.version_no + 1 : 1;
      const id = newId("req");
      const version = store.insertVersion({
        id,
        registration_id: reg.id,
        version_no: versionNo,
        state: RequestState.OPEN,
        origin_site_code: siteCode,
        current_site_code: siteCode,
        responsible_party: null,
        responsible_party_kind: null,
        frozen_snapshot: null,
        frozen_at: null,
        supersedes_version_id: latest?.id ?? null,
        created_by_clinician: actor.id,
        escalation_level: EscalationLevel.NORMAL,
        created_at: ts,
        updated_at: ts,
      });

      appendEvent({
        registration_id: reg.id,
        version_id: id,
        version_no: versionNo,
        type: EventType.REVIEWED,
        payload: { site_code: siteCode },
        actor,
        at: ts,
      });
      appendEvent({
        registration_id: reg.id,
        version_id: id,
        version_no: versionNo,
        type: EventType.REQUEST_CREATED,
        payload: { version_no: versionNo, site_code: siteCode },
        actor,
        at: ts,
      });
      return version;
    });
  }

  // ---- 3. 认领：药房/医疗队接受，冻结所见版本 ------------------------------
  function buildSnapshot(reg, version, frozenAt) {
    const snapshot = {
      frozen_at: frozenAt,
      version_no: version.version_no,
      request_id: version.id,
      person_ref: reg.person_ref,
      medication_code: reg.medication_code,
      medication_label: reg.medication_label,
      remaining_doses: reg.remaining_doses,
      dose_unit: reg.dose_unit,
      allergies: JSON.parse(reg.allergies ?? "[]"),
      contraindications: JSON.parse(reg.contraindications ?? "[]"),
      needs_refrigeration: !!reg.needs_refrigeration,
      needs_delivery: !!reg.needs_delivery,
      latest_supply_at: reg.latest_supply_at,
      site_code: version.current_site_code,
    };
    return { ...snapshot, snapshot_hash: hashSnapshot(snapshot) };
  }

  function claim(versionId, actor, input = {}) {
    requireActor(actor);
    if (!FULFILLMENT_PARTIES.has(actor.role)) {
      throw forbidden("只有药房或医疗队可以认领续供需求");
    }
    const ts = at(input.at);
    const device = readDevice(input);

    // 重放检查在业务事务之外：即使后续业务被拒，首次裁决也必须留存。
    if (device) {
      const replay = checkReplay(device, ts);
      if (replay) return replay;
    }

    try {
      return store.tx(() => {
        const rawVersion = store.getVersionForUpdate(versionId);
        if (!rawVersion) throw notFound("续供需求");
        const reg = store.getRegistration(rawVersion.registration_id);
        if (isBlocked(reg)) throw conflict("registration_blocked", "登记已被阻断，不能认领");
        if (rawVersion.state !== RequestState.OPEN || rawVersion.responsible_party) {
          throw conflict("claim_lost", "认领冲突：该需求已被其他负责方认领或已终结", {
            state: rawVersion.state,
          });
        }
        // 只有需求当前所在安置点的药房/医疗队可以认领——转移后由新安置点接手。
        if (actor.site_code !== rawVersion.current_site_code) {
          throw forbidden("只能认领当前由本安置点持有的需求");
        }
        const version = rawVersion;

        const snapshot = buildSnapshot(reg, version, ts);
        const claimed = store.claimVersion({
          id: versionId,
          party: actor.id,
          partyKind: actor.role,
          snapshotJson: JSON.stringify(snapshot),
          at: ts,
        });
        if (!claimed) {
          // 并发认领：条件更新落败。
          throw conflict("claim_lost", "认领冲突：该需求已被其他负责方认领");
        }

        const event = appendEvent({
          registration_id: reg.id,
          version_id: versionId,
          version_no: version.version_no,
          type: EventType.ACCEPTED,
          payload: {
            responsible_party: actor.id,
            responsible_party_kind: actor.role,
            snapshot_hash: snapshot.snapshot_hash,
          },
          actor,
          at: ts,
        });
        logAccess(actor, AccessKind.RESTRICTED_VIEW, {
          target: reg.id,
          detail: { reason: "claim", snapshot_hash: snapshot.snapshot_hash },
        });
        if (device) {
          store.recordScan({
            ...device,
            request_version_id: versionId,
            event_type: EventType.ACCEPTED,
            status: "applied",
            event_id: event.event_id,
            first_seen_at: ts,
            last_replayed_at: ts,
          });
        }
        return { version: store.getVersion(versionId), snapshot, event, deduplicated: false };
      });
    } catch (error) {
      // 业务事务已回滚；在独立短事务中留存本设备流水的首次裁决。
      recordRejectedScan({ device, versionId, eventType: EventType.ACCEPTED, error, at: ts });
      throw error;
    }
  }

  // ---- 4. 物流事件：发出/在途/签收/拒收/损坏（只追加） ---------------------
  function reportLogisticsEvent(versionId, eventType, actor, input = {}) {
    requireActor(actor);
    const targetState = LOGISTICS_EVENT_TARGET[eventType];
    if (!targetState) throw badRequest("不支持的物流事件类型", { event_type: eventType });
    const ts = at(input.at);
    const device = readDevice(input);

    if (device) {
      const replay = checkReplay(device, ts);
      if (replay) return replay;
    }

    try {
      return store.tx(() => {
        const version = store.getVersionForUpdate(versionId);
        if (!version) throw notFound("续供需求");
        const reg = store.getRegistration(version.registration_id);

        if (isBlocked(reg) && version.state !== RequestState.DELIVERED) {
          throw conflict("registration_blocked", "登记已被阻断，未交付药物停止流转");
        }

        if (!STATE_TRANSITIONS[version.state]?.has(targetState)) {
          // 迟到事件撞上已关闭/重新发出/已签收版本：拒绝且不回灌，
          // 裁决由外层 catch 在独立事务中落库（不随业务回滚丢失）。
          const late = TERMINAL_STATES.has(version.state);
          throw conflict(
            late ? "event_too_late" : "illegal_transition",
            late
              ? `版本已处于终态 ${version.state}，迟到事件不能越过该版本`
              : `不能从 ${version.state} 推进到 ${targetState}`,
            { state: version.state, attempted: targetState },
          );
        }

        assertLogisticsPermission(eventType, actor, version);

        const advanced = store.advanceVersion({
          id: versionId,
          expectedState: version.state,
          nextState: targetState,
          at: ts,
        });
        if (!advanced) {
          throw conflict("state_changed", "状态已被并发操作改变，事件未被接受");
        }

        const frozen = parseStoredJson(version.frozen_snapshot);
        const payload = {
          ...(input.payload ?? {}),
          responsible_party: version.responsible_party,
        };
        // 签收时固定交付依据：认领冻结快照的哈希与冻结时刻随交付事件永久留存。
        if (targetState === RequestState.DELIVERED) {
          payload.basis = frozen
            ? { snapshot_hash: frozen.snapshot_hash, frozen_at: frozen.frozen_at }
            : { snapshot_hash: null, frozen_at: null };
          payload.delivered_to_person_ref = reg.person_ref;
        }

        const event = appendEvent({
          registration_id: reg.id,
          version_id: versionId,
          version_no: version.version_no,
          type: eventType,
          payload,
          actor,
          site_code: input.site_code ?? actor.site_code ?? version.current_site_code,
          at: ts,
        });
        if (device) {
          store.recordScan({
            ...device,
            request_version_id: versionId,
            event_type: eventType,
            status: "applied",
            event_id: event.event_id,
            first_seen_at: ts,
            last_replayed_at: ts,
          });
        }
        return { version: store.getVersion(versionId), event, deduplicated: false };
      });
    } catch (error) {
      recordRejectedScan({
        device,
        versionId,
        eventType,
        error,
        at: ts,
        lateCode: "event_too_late",
      });
      throw error;
    }
  }

  function assertLogisticsPermission(eventType, actor, version) {
    const isResponsible = version.responsible_party === actor.id;
    switch (eventType) {
      case EventType.DISPATCHED:
      case EventType.IN_TRANSIT:
        if (!isResponsible) throw forbidden("只有认领负责方可以标记发出或在途");
        return;
      case EventType.DELIVERED:
        // 签收可由负责方或目的安置点协调员扫码确认。
        if (
          !isResponsible &&
          actor.role !== Role.COORDINATOR &&
          actor.role !== Role.CLINICIAN
        ) {
          throw forbidden("只有负责方或现场协调员可以确认签收");
        }
        if (
          !isResponsible &&
          actor.role === Role.COORDINATOR &&
          actor.site_code !== version.current_site_code
        ) {
          throw forbidden("协调员只能签收当前由本安置点持有的需求");
        }
        return;
      case EventType.REJECTED:
      case EventType.DAMAGED:
        if (!isResponsible && actor.role !== Role.CLINICIAN) {
          throw forbidden("只有负责方或医护可以登记拒收或损坏");
        }
        return;
      default:
        throw forbidden("未授权的物流事件");
    }
  }

  // ---- 5. 拒收/损坏后医护重新发出 ------------------------------------------
  function reissue(versionId, actor, input = {}) {
    requireActor(actor);
    if (actor.role !== Role.CLINICIAN) throw forbidden("只有医护可以重新发出需求");
    const ts = at(input.at);

    return store.tx(() => {
      const old = store.getVersionForUpdate(versionId);
      if (!old) throw notFound("续供需求");
      if (old.state !== RequestState.REJECTED && old.state !== RequestState.DAMAGED) {
        throw conflict("reissue_not_allowed", "只有被拒收或损坏的版本才能重新发出", {
          state: old.state,
        });
      }
      const reg = store.getRegistration(old.registration_id);
      if (isBlocked(reg)) throw conflict("registration_blocked", "登记已被阻断，不能重新发出");
      if (store.activeVersion(reg.id)) {
        throw conflict("active_request_exists", "已存在未完成版本");
      }

      const closed = store.advanceVersion({
        id: versionId,
        expectedState: old.state,
        nextState: RequestState.REISSUED,
        at: ts,
      });
      if (!closed) throw conflict("state_changed", "版本状态已被并发改变");

      const siteCode = input.site_code ?? old.current_site_code;
      const newId2 = newId("req");
      const version = store.insertVersion({
        id: newId2,
        registration_id: reg.id,
        version_no: old.version_no + 1,
        state: RequestState.OPEN,
        origin_site_code: siteCode,
        current_site_code: siteCode,
        responsible_party: null,
        responsible_party_kind: null,
        frozen_snapshot: null,
        frozen_at: null,
        supersedes_version_id: old.id,
        created_by_clinician: actor.id,
        escalation_level: old.escalation_level,
        created_at: ts,
        updated_at: ts,
      });

      appendEvent({
        registration_id: reg.id,
        version_id: old.id,
        version_no: old.version_no,
        type: EventType.REISSUED,
        payload: { new_request_id: newId2, new_version_no: old.version_no + 1 },
        actor,
        at: ts,
      });
      appendEvent({
        registration_id: reg.id,
        version_id: newId2,
        version_no: old.version_no + 1,
        type: EventType.REQUEST_CREATED,
        payload: { version_no: old.version_no + 1, reissued_from: old.id, site_code: siteCode },
        actor,
        at: ts,
      });
      return version;
    });
  }

  // ---- 6. 关闭未交付需求 ---------------------------------------------------
  function close(versionId, actor, input = {}) {
    requireActor(actor);
    if (actor.role !== Role.CLINICIAN && actor.role !== Role.COORDINATOR) {
      throw forbidden("只有医护或现场协调员可以关闭需求");
    }
    const ts = at(input.at);
    return store.tx(() => {
      const version = store.getVersionForUpdate(versionId);
      if (!version) throw notFound("续供需求");
      if (!STATE_TRANSITIONS[version.state]?.has(RequestState.CLOSED)) {
        throw conflict("cannot_close", `处于 ${version.state} 的版本不能关闭`);
      }
      const advanced = store.advanceVersion({
        id: versionId,
        expectedState: version.state,
        nextState: RequestState.CLOSED,
        at: ts,
      });
      if (!advanced) throw conflict("state_changed", "版本状态已被并发改变");
      const event = appendEvent({
        registration_id: version.registration_id,
        version_id: versionId,
        version_no: version.version_no,
        type: EventType.CLOSED,
        payload: { reason: input.reason ?? null },
        actor,
        at: ts,
      });
      return { version: store.getVersion(versionId), event };
    });
  }

  // ---- 7. 人员转移：未完成需求交给新安置点（单一负责方不变） ---------------
  function transfer(versionId, actor, input = {}) {
    requireActor(actor);
    if (actor.role !== Role.COORDINATOR && actor.role !== Role.CLINICIAN) {
      throw forbidden("只有现场协调员或医护可以交接需求");
    }
    requireFields(input, ["to_site_code"]);
    const toSite = String(input.to_site_code);
    const ts = at(input.at);

    return store.tx(() => {
      const version = store.getVersionForUpdate(versionId);
      if (!version) throw notFound("续供需求");
      if (!TRANSFERABLE_STATES.has(version.state)) {
        throw conflict("not_transferable", `处于 ${version.state} 的需求不能交接`);
      }
      if (toSite === version.current_site_code) {
        throw badRequest("目标安置点与当前安置点相同", { field: "to_site_code" });
      }
      if (actor.role === Role.COORDINATOR && actor.site_code !== version.current_site_code) {
        throw forbidden("协调员只能交接本安置点当前持有的需求");
      }

      // 条件更新：current_site 必须仍是本站点——并发/重放的第二次交接待此落败。
      const moved = store.transferVersion({
        id: versionId,
        fromSite: version.current_site_code,
        toSite,
        at: ts,
      });
      if (!moved) throw conflict("transfer_lost", "需求已被并发交接或状态改变");

      // open 需求无人负责，新站点药房/医疗队可认领；已认领或在途的需求，
      // 原负责方继续是唯一负责方，只是配送目的地改为新站点。
      const event = appendEvent({
        registration_id: version.registration_id,
        version_id: versionId,
        version_no: version.version_no,
        type: EventType.TRANSFERRED,
        payload: {
          from_site_code: version.current_site_code,
          to_site_code: toSite,
          state: version.state,
          responsible_party_continues: version.responsible_party ?? null,
        },
        actor,
        site_code: toSite,
        at: ts,
      });
      return { version: store.getVersion(versionId), event };
    });
  }

  // ---- 8. 过敏/授权撤回：立即阻断未交付药物，已交付保留依据 ---------------
  function block(registrationId, actor, input = {}) {
    requireActor(actor);
    requireFields(input, ["reason"]);
    const { reason } = input;
    if (reason !== BlockReason.ALLERGY && reason !== BlockReason.AUTHORIZATION_WITHDRAWN) {
      throw badRequest("阻断原因必须是 allergy 或 authorization_withdrawn", { field: "reason" });
    }
    const ts = at(input.at);

    return store.tx(() => {
      const reg = getRegistrationOr404(registrationId);
      if (actor.role === Role.SELF && actor.person_ref !== reg.person_ref) {
        throw forbidden("本人只能处理自己的用药登记");
      }
      if (
        actor.role !== Role.CLINICIAN &&
        actor.role !== Role.SELF
      ) {
        throw forbidden("只有本人或授权医护可以触发过敏阻断或撤回授权");
      }

      const updated = store.setBlocked({
        id: reg.id,
        blockedAllergy: !!reg.blocked_allergy || reason === BlockReason.ALLERGY,
        authWithdrawn: !!reg.auth_withdrawn || reason === BlockReason.AUTHORIZATION_WITHDRAWN,
        note: input.note ?? reg.block_note ?? null,
        at: ts,
      });

      appendEvent({
        registration_id: reg.id,
        type: EventType.BLOCKED,
        payload: { reason, note: input.note ?? null, scope: "registration" },
        actor,
        at: ts,
      });

      // 只阻断未交付（未终结）版本；delivered/closed/rejected/... 一律不动，
      // 交付版本的冻结依据原样保留。
      const blockedVersions = [];
      for (const version of store.listVersionsByRegistration(reg.id)) {
        if (TERMINAL_STATES.has(version.state)) continue;
        const advanced = store.advanceVersion({
          id: version.id,
          expectedState: version.state,
          nextState: RequestState.BLOCKED,
          at: ts,
        });
        if (advanced) {
          appendEvent({
            registration_id: reg.id,
            version_id: version.id,
            version_no: version.version_no,
            type: EventType.BLOCKED,
            payload: { reason, note: input.note ?? null, scope: "request" },
            actor,
            at: ts,
          });
          blockedVersions.push(advanced);
        }
      }
      return { registration: updated, blocked_versions: blockedVersions };
    });
  }

  // 解除阻断：误报过敏经医护核实更正、或授权重新建立后，由医护解除。
  // 已 blocked 的版本保持终态（历史可审计），解除后医护重新复核生成新版本。
  function unblock(registrationId, actor, input = {}) {
    requireActor(actor);
    if (actor.role !== Role.CLINICIAN) {
      throw forbidden("只有授权医护在核实后可以解除阻断");
    }
    const ts = at(input.at);
    return store.tx(() => {
      const reg = getRegistrationOr404(registrationId);
      if (!isBlocked(reg)) {
        throw conflict("not_blocked", "该登记当前不处于阻断状态");
      }
      const updated = store.clearBlock({ id: reg.id, at: ts });
      appendEvent({
        registration_id: reg.id,
        type: EventType.UNBLOCKED,
        payload: { note: input.note ?? null },
        actor,
        at: ts,
      });
      return { registration: updated };
    });
  }

  // ---- 9. 临期升级（服务恢复后重跑同一逻辑即可继续） -----------------------
  function levelFor(version, nowMs) {
    const deadline = Date.parse(version.latest_supply_at);
    const remaining = deadline - nowMs;
    if (remaining <= ESCALATION_THRESHOLDS_MS[EscalationLevel.CRITICAL]) return EscalationLevel.CRITICAL;
    if (remaining <= ESCALATION_THRESHOLDS_MS[EscalationLevel.URGENT]) return EscalationLevel.URGENT;
    return EscalationLevel.NORMAL;
  }

  function escalateDue(input = {}) {
    const ts = at(input.at);
    const nowMs = Date.parse(ts);
    const escalations = [];
    store.tx(() => {
      for (const version of store.listActiveVersions()) {
        const level = levelFor(version, nowMs);
        const current = ESCALATION_ORDER.indexOf(version.escalation_level);
        const next = ESCALATION_ORDER.indexOf(level);
        if (next > current) {
          store.setEscalation({ id: version.id, level, at: ts });
          appendEvent({
            registration_id: version.registration_id,
            version_id: version.id,
            version_no: version.version_no,
            type: EventType.ESCALATED,
            payload: {
              from_level: version.escalation_level,
              to_level: level,
              latest_supply_at: version.latest_supply_at,
            },
            actor: { id: "system", role: "system" },
            at: ts,
          });
          escalations.push({ request_id: version.id, level });
        }
      }
    });
    return { ran_at: ts, escalations };
  }

  // ---- 10. 恢复后待办：临期升级 + 转移交接 + 待签收 ------------------------
  function pendingTasks(actor, input = {}) {
    requireActor(actor);
    if (actor.role !== Role.COORDINATOR && actor.role !== Role.CLINICIAN) {
      throw forbidden("只有现场协调员或医护可以查看任务清单");
    }
    const ts = at(input.at);
    // 恢复时先把临期级别追平，再列任务——离线期间到期的需求不会漏升级。
    const { escalations } = escalateDue({ at: ts });
    const tasks = store.listActiveVersions()
      .filter((version) => version.current_site_code === actor.site_code)
      .map((version) => {
        const base = {
          request_id: version.id,
          version_no: version.version_no,
          state: version.state,
          site_code: version.current_site_code,
          latest_supply_at: version.latest_supply_at,
          needs_refrigeration: !!version.needs_refrigeration,
          needs_delivery: !!version.needs_delivery,
          escalation_level: version.escalation_level,
        };
        if (version.state === RequestState.OPEN) {
          return {
            ...base,
            kind:
              version.origin_site_code !== version.current_site_code
                ? TaskKind.PENDING_TRANSFER
                : TaskKind.PENDING_CLAIM,
          };
        }
        return { ...base, kind: TaskKind.PENDING_DELIVERY };
      });
    return { ran_at: ts, escalations, tasks };
  }

  // ---- 11. 协调员视图：仅冷藏/配送/截止时间 -------------------------------
  function coordinatorList(actor, input = {}) {
    requireActor(actor);
    if (actor.role !== Role.COORDINATOR) throw forbidden("该视图仅面向现场协调员");
    requireActorSite(actor);
    const siteCode = input.site_code ?? actor.site_code;
    if (siteCode !== actor.site_code) throw forbidden("协调员只能查看本安置点");
    const rows = store
      .listActiveVersions()
      .filter((version) => version.current_site_code === siteCode)
      .map((version) =>
        projectCoordinator({
          request_id: version.id,
          version_no: version.version_no,
          state: version.state,
          site_code: version.current_site_code,
          origin_site_code: version.origin_site_code,
          needs_refrigeration: !!version.needs_refrigeration,
          needs_delivery: !!version.needs_delivery,
          latest_supply_at: version.latest_supply_at,
          escalation_level: version.escalation_level,
          has_responsible_party: !!version.responsible_party,
          responsible_party_kind: version.responsible_party_kind,
        }),
      );
    logAccess(actor, AccessKind.COORDINATOR_VIEW, {
      target: `site:${siteCode}`,
      detail: { count: rows.length },
    });
    return { site_code: siteCode, generated_at: nowIso(), requests: rows };
  }

  // ---- 12. 医疗侧受限视图：药品/剂量/过敏（物流与发药所需） ---------------
  function medicalView(registrationId, actor) {
    requireActor(actor);
    if (!MEDICAL_ROLES.has(actor.role)) throw forbidden("该视图仅面向授权医疗侧");
    const reg = getRegistrationOr404(registrationId);
    const versions = store.listVersionsByRegistration(reg.id);
    // 药房/医疗队只能查看自己负责的登记；医护不受此限。
    if (actor.role !== Role.CLINICIAN) {
      const owns = versions.some((version) => version.responsible_party === actor.id);
      if (!owns) throw forbidden("只能查看本负责方认领的需求详情");
    }
    logAccess(actor, AccessKind.RESTRICTED_VIEW, { target: reg.id, detail: { reason: "view" } });
    return {
      registration: {
        id: reg.id,
        person_ref: reg.person_ref,
        medication_code: reg.medication_code,
        medication_label: reg.medication_label,
        remaining_doses: reg.remaining_doses,
        dose_unit: reg.dose_unit,
        allergies: JSON.parse(reg.allergies ?? "[]"),
        contraindications: JSON.parse(reg.contraindications ?? "[]"),
        verification_source: reg.verification_source,
        verification_detail: reg.verification_detail,
        needs_refrigeration: !!reg.needs_refrigeration,
        needs_delivery: !!reg.needs_delivery,
        latest_supply_at: reg.latest_supply_at,
        site_code: reg.site_code,
        blocked: isBlocked(reg),
      },
      versions: versions.map((version) => ({
        id: version.id,
        version_no: version.version_no,
        state: version.state,
        origin_site_code: version.origin_site_code,
        current_site_code: version.current_site_code,
        responsible_party_kind: version.responsible_party_kind,
        frozen_at: version.frozen_at,
      })),
    };
  }

  // ---- 13. 指挥席：匿名缺口汇总 -------------------------------------------
  function commanderSummary(actor, input = {}) {
    requireActor(actor);
    if (actor.role !== Role.COMMANDER && actor.role !== Role.COORDINATOR) {
      throw forbidden("该汇总仅面向指挥席");
    }
    const ts = at(input.at);
    const nowMs = Date.parse(ts);
    const bySite = new Map();
    for (const version of store.listActiveVersions()) {
      const site = version.current_site_code;
      if (!bySite.has(site)) {
        bySite.set(site, {
          site_code: site,
          open: 0,
          accepted: 0,
          dispatched: 0,
          in_transit: 0,
          urgent: 0,
          critical: 0,
          overdue: 0,
          unfulfilled_total: 0,
        });
      }
      const bucket = bySite.get(site);
      if (version.state in bucket) bucket[version.state] += 1;
      bucket.unfulfilled_total += 1;
      // 临期级别按截止时刻实时计算，服务恢复后无需先跑升级即可反映缺口。
      const effectiveLevel = levelFor(version, nowMs);
      if (effectiveLevel === EscalationLevel.URGENT) bucket.urgent += 1;
      if (effectiveLevel === EscalationLevel.CRITICAL) bucket.critical += 1;
      if (nowMs > Date.parse(version.latest_supply_at)) bucket.overdue += 1;
    }
    logAccess(actor, AccessKind.COMMANDER_SUMMARY, {
      target: "all_sites",
      detail: { sites: bySite.size },
    });
    return { generated_at: ts, sites: [...bySite.values()].sort((a, b) => a.site_code.localeCompare(b.site_code)) };
  }

  // ---- 14. 审计员重建：访问者、药物流向、最终交付 --------------------------
  function auditRebuild(actor, input = {}) {
    requireActor(actor);
    if (actor.role !== Role.AUDITOR) throw forbidden("只有获授权审计员可以重建轨迹");
    if (!input.authorization_id) {
      throw forbidden("审计重建必须提供有效授权标识");
    }
    const ts = at(input.at);

    logAccess(actor, AccessKind.AUDIT_REBUILD, {
      target: "all",
      authorizationId: input.authorization_id,
      detail: { scope: "full_rebuild" },
    });

    const registrations = store.db.prepare(`SELECT * FROM registrations ORDER BY created_at`).all();
    const rebuilt = registrations.map((reg) => {
      const versions = store.listVersionsByRegistration(reg.id).map((version) => {
        const events = store.db
          .prepare(`SELECT * FROM events WHERE request_version_id = ? ORDER BY seq`)
          .all(version.id)
          .map(decodeEvent);
        // 流向重建：交接与责任方变更按时间排列。
        const flow = events
          .filter((event) =>
          [
            EventType.ACCEPTED,
            EventType.TRANSFERRED,
            EventType.DISPATCHED,
            EventType.IN_TRANSIT,
            EventType.DELIVERED,
            EventType.REJECTED,
            EventType.DAMAGED,
          ].includes(event.type))
          .map((event) => ({
            type: event.type,
            at: event.created_at,
            actor: event.actor,
            actor_role: event.actor_role,
            site_code: event.site_code,
            payload: event.payload,
          }));
        return {
          id: version.id,
          version_no: version.version_no,
          state: version.state,
          origin_site_code: version.origin_site_code,
          current_site_code: version.current_site_code,
          responsible_party: version.responsible_party,
          responsible_party_kind: version.responsible_party_kind,
          frozen_snapshot: version.frozen_snapshot,
          frozen_at: version.frozen_at,
          supersedes_version_id: version.supersedes_version_id,
          events,
          flow,
        };
      });

      const deliveryVersion = versions.find((version) => version.state === RequestState.DELIVERED);
      const deliveryEvents = versions
        .map((version) => version.events.find((event) => event.type === EventType.DELIVERED))
        .filter(Boolean);

      return {
        registration: {
          ...reg,
          allergies: JSON.parse(reg.allergies ?? "[]"),
          contraindications: JSON.parse(reg.contraindications ?? "[]"),
        },
        versions,
        final_delivery: deliveryVersion
          ? {
              request_id: deliveryVersion.id,
              version_no: deliveryVersion.version_no,
              at: deliveryEvents[0]?.created_at,
              to_person_ref: deliveryEvents[0]?.payload?.delivered_to_person_ref,
              // 当时依据：认领时冻结的完整快照与哈希，交付后不可变。
              basis: deliveryEvents[0]?.payload?.basis ?? null,
              frozen_snapshot: deliveryVersion.frozen_snapshot,
            }
          : null,
        accesses: store.listAccess({ target: reg.id }),
      };
    });

    return {
      generated_at: ts,
      authorization_id: input.authorization_id,
      auditor: actor.id,
      registrations: rebuilt,
      access_log: store.db.prepare(`SELECT * FROM access_log ORDER BY seq`).all(),
    };
  }

  // ---- 离线扫描重放 --------------------------------------------------------
  function checkReplay(device, ts) {
    const { existing } = store.firstOrSeenScan(device);
    if (!existing) return null;
    store.recordScan({ ...existing, last_replayed_at: ts });
    const event = existing.event_id ? store.getEvent(existing.event_id) : null;
    const version = existing.request_version_id ? store.getVersion(existing.request_version_id) : null;
    return {
      deduplicated: true,
      status: existing.status,
      version,
      event: event ?? null,
      first_seen_at: existing.first_seen_at,
    };
  }

  // 业务事务回滚后，在独立短事务中留存扫描裁决；仅记录 409 类业务拒绝，
  // 鉴权/参数错误不落裁决（调用方修正后可重试）。
  function recordRejectedScan({ device, versionId, eventType, error, at: ts, lateCode }) {
    if (!device) return;
    if (!(error instanceof ServiceError) || error.status !== 409) return;
    const status =
      error.code === lateCode || error.code === "event_too_late"
        ? "rejected_late"
        : "rejected_conflict";
    store.tx(() => {
      // 并发下可能已由另一方落库；已存在则不覆盖首次裁决。
      const { existing } = store.firstOrSeenScan(device);
      if (existing) return;
      store.recordScan({
        ...device,
        request_version_id: versionId,
        event_type: eventType,
        status,
        event_id: null,
        first_seen_at: ts,
        last_replayed_at: ts,
      });
    });
  }

  return {
    register,
    reviewAndCreateRequest,
    claim,
    reportLogisticsEvent,
    reissue,
    close,
    transfer,
    block,
    unblock,
    escalateDue,
    pendingTasks,
    coordinatorList,
    medicalView,
    commanderSummary,
    auditRebuild,
  };
}

// ---- 辅助 ------------------------------------------------------------------

function actorSite(actor) {
  return actor?.site_code ?? null;
}

function requireActorSite(actor) {
  if (!actor.site_code) throw badRequest("协调员身份必须携带安置点编号", { field: "site_code" });
}

function readDevice(input) {
  if (!input.device_id || !input.scan_serial) return null;
  return { device_id: String(input.device_id), scan_serial: String(input.scan_serial) };
}

function decodeEvent(row) {
  return { ...row, payload: JSON.parse(row.payload ?? "{}") };
}

// getVersionForUpdate 返回原始行（frozen_snapshot 为 JSON 文本或 null）。
function parseStoredJson(value) {
  return value ? JSON.parse(value) : null;
}

export { SensitivityTier };
