// 撤离随身药物续供交接——领域契约
//
// 所有状态、事件、角色与敏感分级集中在此，存储层与 HTTP 层只能引用这里的常量，
// 不允许在别处硬编码状态字符串。

// ---- 既有清点基线（保持向后兼容） ------------------------------------------
export const BatchState = Object.freeze({ OPEN: "open", CLOSED: "closed" });
export const ArrivalKind = Object.freeze({ ON_TIME: "on_time", LATE: "late", DUPLICATE: "duplicate" });

// ---- 角色 ------------------------------------------------------------------
// self         撤离人员本人
// clinician    授权医护（登记、复核、阻断、重新发出）
// coordinator  现场协调员（只见物流所需的最小公开信息）
// pharmacy     药房（可认领需求）
// medical_team 医疗队（可认领需求）
// commander    指挥席（只见匿名缺口汇总）
// auditor      获授权审计员（可重建访问、流向与交付）
export const Role = Object.freeze({
  SELF: "self",
  CLINICIAN: "clinician",
  COORDINATOR: "coordinator",
  PHARMACY: "pharmacy",
  MEDICAL_TEAM: "medical_team",
  COMMANDER: "commander",
  AUDITOR: "auditor",
});

export const FULFILLMENT_PARTIES = Object.freeze(new Set([Role.PHARMACY, Role.MEDICAL_TEAM]));
export const MEDICAL_ROLES = Object.freeze(new Set([Role.CLINICIAN, Role.PHARMACY, Role.MEDICAL_TEAM]));

// ---- 登记验证来源 ----------------------------------------------------------
export const VerificationSource = Object.freeze({
  SELF_REPORT: "self_report", // 本人登记
  AUTHORIZED_CLINICIAN: "authorized_clinician", // 授权医护核验登记
});

// ---- 敏感分级 --------------------------------------------------------------
// public     协调员可见：是否冷藏、是否需要配送、最晚补给时刻
// restricted 医疗侧可见：药品标识、剩余剂量、过敏禁忌、验证来源
// audit      仅审计员：访问者痕迹与跨点流向重建
export const SensitivityTier = Object.freeze({
  PUBLIC: "public",
  RESTRICTED: "restricted",
  AUDIT: "audit",
});

// 登记字段 -> 分级，投影层据此裁剪
export const REGISTRATION_FIELD_TIERS = Object.freeze({
  person_ref: SensitivityTier.RESTRICTED,
  medication_code: SensitivityTier.RESTRICTED,
  medication_label: SensitivityTier.RESTRICTED,
  remaining_doses: SensitivityTier.RESTRICTED,
  dose_unit: SensitivityTier.RESTRICTED,
  allergies: SensitivityTier.RESTRICTED,
  contraindications: SensitivityTier.RESTRICTED,
  verification_source: SensitivityTier.RESTRICTED,
  verification_detail: SensitivityTier.RESTRICTED,
  registered_by: SensitivityTier.AUDIT,
  registerer_role: SensitivityTier.AUDIT,
  needs_refrigeration: SensitivityTier.PUBLIC,
  needs_delivery: SensitivityTier.PUBLIC,
  latest_supply_at: SensitivityTier.PUBLIC,
  site_code: SensitivityTier.PUBLIC,
});

// ---- 续供需求版本状态 -------------------------------------------------------
// 每次医护复核生成一条一次性需求（版本 1）；拒收/损坏后可重新发出（版本号递增）。
// 负责方接受的一瞬间冻结所见版本（快照哈希），此后该版本内容不可变。
export const RequestState = Object.freeze({
  OPEN: "open", // 一次性需求已生成，等待药房/医疗队认领
  ACCEPTED: "accepted", // 已认领，版本已冻结
  DISPATCHED: "dispatched", // 已发出
  IN_TRANSIT: "in_transit", // 在途
  DELIVERED: "delivered", // 已签收（终态，保留当时依据）
  REJECTED: "rejected", // 拒收（版本终态，等待医护重新发出）
  DAMAGED: "damaged", // 损坏（版本终态，等待医护重新发出）
  CLOSED: "closed", // 已关闭（版本终态）
  REISSUED: "reissued", // 已被新版本取代（版本终态）
  BLOCKED: "blocked", // 过敏或授权撤回，立即阻断（版本终态）
});

export const TERMINAL_STATES = Object.freeze(
  new Set([
    RequestState.DELIVERED,
    RequestState.REJECTED,
    RequestState.DAMAGED,
    RequestState.CLOSED,
    RequestState.REISSUED,
    RequestState.BLOCKED,
  ]),
);

// 允许的状态迁移；签收等事件只能沿迁移图推进，迟到事件不能回灌终态版本。
export const STATE_TRANSITIONS = Object.freeze({
  [RequestState.OPEN]: new Set([RequestState.ACCEPTED, RequestState.CLOSED, RequestState.BLOCKED]),
  [RequestState.ACCEPTED]: new Set([
    RequestState.DISPATCHED,
    RequestState.CLOSED,
    RequestState.BLOCKED,
  ]),
  [RequestState.DISPATCHED]: new Set([
    RequestState.IN_TRANSIT,
    RequestState.CLOSED,
    RequestState.BLOCKED,
  ]),
  [RequestState.IN_TRANSIT]: new Set([
    RequestState.DELIVERED,
    RequestState.REJECTED,
    RequestState.DAMAGED,
    RequestState.CLOSED,
    RequestState.BLOCKED,
  ]),
  [RequestState.DELIVERED]: new Set(),
  [RequestState.REJECTED]: new Set([RequestState.REISSUED]),
  [RequestState.DAMAGED]: new Set([RequestState.REISSUED]),
  [RequestState.CLOSED]: new Set(),
  [RequestState.REISSUED]: new Set(),
  [RequestState.BLOCKED]: new Set(),
});

// 可交接给新安置点的状态（未完成需求）。
export const TRANSFERABLE_STATES = Object.freeze(
  new Set([
    RequestState.OPEN,
    RequestState.ACCEPTED,
    RequestState.DISPATCHED,
    RequestState.IN_TRANSIT,
  ]),
);

// ---- 事件类型（只追加，不修改不删除） ---------------------------------------
export const EventType = Object.freeze({
  REGISTERED: "registered",
  REVIEWED: "reviewed",
  REQUEST_CREATED: "request_created",
  ACCEPTED: "accepted", // 认领 + 版本冻结
  DISPATCHED: "dispatched", // 发出
  IN_TRANSIT: "in_transit", // 在途
  DELIVERED: "delivered", // 签收
  REJECTED: "rejected", // 拒收
  DAMAGED: "damaged", // 损坏
  CLOSED: "closed", // 关闭
  REISSUED: "reissued", // 重新发出（旧版本关闭指针）
  TRANSFERRED: "transferred", // 跨安置点交接
  BLOCKED: "blocked", // 过敏/授权撤回阻断
  UNBLOCKED: "unblocked", // 医护解除阻断（误报更正或重新授权）
  ESCALATED: "escalated", // 临期升级
});

// 物流事件 -> 目标状态
export const LOGISTICS_EVENT_TARGET = Object.freeze({
  [EventType.DISPATCHED]: RequestState.DISPATCHED,
  [EventType.IN_TRANSIT]: RequestState.IN_TRANSIT,
  [EventType.DELIVERED]: RequestState.DELIVERED,
  [EventType.REJECTED]: RequestState.REJECTED,
  [EventType.DAMAGED]: RequestState.DAMAGED,
});

// ---- 临期升级 --------------------------------------------------------------
export const EscalationLevel = Object.freeze({
  NORMAL: "normal",
  URGENT: "urgent",
  CRITICAL: "critical",
});

export const ESCALATION_ORDER = Object.freeze([
  EscalationLevel.NORMAL,
  EscalationLevel.URGENT,
  EscalationLevel.CRITICAL,
]);

// 距最晚补给时刻剩余时间阈值
export const ESCALATION_THRESHOLDS_MS = Object.freeze({
  [EscalationLevel.URGENT]: 24 * 60 * 60 * 1000,
  [EscalationLevel.CRITICAL]: 6 * 60 * 60 * 1000,
});

// ---- 恢复后待办 ------------------------------------------------------------
export const TaskKind = Object.freeze({
  PENDING_CLAIM: "pending_claim", // 等待认领（含转移到达）
  PENDING_TRANSFER: "pending_transfer", // 已交接、新安置点尚未认领
  PENDING_DELIVERY: "pending_delivery", // 在途待签收
  ESCALATION_DUE: "escalation_due", // 临期需升级
});

// ---- 访问日志种类（审计重建用） ---------------------------------------------
export const AccessKind = Object.freeze({
  COORDINATOR_VIEW: "coordinator_view",
  RESTRICTED_VIEW: "restricted_view",
  COMMANDER_SUMMARY: "commander_summary",
  AUDIT_REBUILD: "audit_rebuild",
});

// ---- 阻断原因 --------------------------------------------------------------
export const BlockReason = Object.freeze({
  ALLERGY: "allergy",
  AUTHORIZATION_WITHDRAWN: "authorization_withdrawn",
});
