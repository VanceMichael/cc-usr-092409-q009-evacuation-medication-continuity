export const BatchState = Object.freeze({ OPEN: "open", CLOSED: "closed" });
export const ArrivalKind = Object.freeze({ ON_TIME: "on_time", LATE: "late", DUPLICATE: "duplicate" });

/**
 * 角色分级：现场协调员只接触运营级信息；临床/身份级信息仅本人与授权医护、
 * 药房/医疗队可见；指挥席只见匿名聚合；审计员可在授权范围内重建全链路。
 */
export const Role = Object.freeze({
  SELF: "self", // 本人
  CLINICIAN: "clinician", // 授权医护
  COORDINATOR: "coordinator", // 现场协调员（仅运营级）
  DISPENSER: "dispenser", // 药房或医疗队
  COMMAND: "command", // 指挥席（匿名缺口）
  AUDITOR: "auditor", // 获授权审计员
});

/** 敏感内容分级存储标签。 */
export const Tier = Object.freeze({
  IDENTITY: "identity", // L0：人员标识、授权关系
  CLINICAL: "clinical", // L2：药品标识、剂量、过敏禁忌、诊断/处方依据
  OPERATIONAL: "operational", // L1：冷藏、配送、截止时间
  AUDIT: "audit", // L3：访问日志与流向重建
});

/** 续供需求版本的生命周期（每个版本为一次性发出尝试）。 */
export const RequestState = Object.freeze({
  PENDING: "pending", // 已复核，等待药房/医疗队认领
  CLAIMED: "claimed", // 已认领，所见版本已冻结
  DISPATCHED: "dispatched", // 已发出
  IN_TRANSIT: "in_transit", // 在途
  DELIVERED: "delivered", // 签收（终态）
  REJECTED: "rejected", // 拒收（终态，需重新发出新版本）
  DAMAGED: "damaged", // 损坏（终态，需重新发出新版本）
  BLOCKED: "blocked", // 过敏或授权撤回阻断（终态）
  TRANSFERRED: "transferred", // 已随人员转移交接（旧点终态）
});

/** 活跃状态集合：同一需求任一时刻只允许一个版本处于其中（部分唯一索引保证）。 */
export const ACTIVE_STATES = Object.freeze([
  RequestState.PENDING,
  RequestState.CLAIMED,
  RequestState.DISPATCHED,
  RequestState.IN_TRANSIT,
]);

export const CLOSED_STATES = Object.freeze([
  RequestState.DELIVERED,
  RequestState.REJECTED,
  RequestState.DAMAGED,
  RequestState.BLOCKED,
  RequestState.TRANSFERRED,
]);

/** 追加事件类型：流向只增不改。 */
export const EventType = Object.freeze({
  REGISTERED: "registered",
  REVIEWED: "reviewed",
  CLAIMED: "claimed",
  DISPATCHED: "dispatched",
  IN_TRANSIT: "in_transit",
  DELIVERED: "delivered",
  REJECTED: "rejected",
  DAMAGED: "damaged",
  REISSUED: "reissued",
  BLOCKED_ALLERGY: "blocked_allergy",
  BLOCKED_CONSENT: "blocked_consent",
  TRANSFERRED_OUT: "transferred_out",
  TRANSFERRED_IN: "transferred_in",
  ESCALATED: "escalated",
});

/** 续供事件允许的状态迁移。 */
export const ALLOWED_TRANSITIONS = Object.freeze({
  [EventType.DISPATCHED]: Object.freeze([RequestState.CLAIMED]),
  [EventType.IN_TRANSIT]: Object.freeze([RequestState.DISPATCHED]),
  [EventType.DELIVERED]: Object.freeze([RequestState.DISPATCHED, RequestState.IN_TRANSIT]),
  [EventType.REJECTED]: Object.freeze([RequestState.CLAIMED, RequestState.DISPATCHED, RequestState.IN_TRANSIT]),
  [EventType.DAMAGED]: Object.freeze([RequestState.CLAIMED, RequestState.DISPATCHED, RequestState.IN_TRANSIT]),
});

/** 登记依据的验证来源。 */
export const VerificationSource = Object.freeze({
  SELF_REPORT: "self_report",
  PRESCRIPTION_SEEN: "prescription_seen",
  PACKAGE_LABEL: "package_label",
  PHARMACY_RECORD: "pharmacy_record",
  CLINICIAN_VERIFIED: "clinician_verified",
});

/** 临期升级阈值（毫秒）与级别，单调只升。 */
export const Escalation = Object.freeze({
  WATCH_MS: 24 * 60 * 60 * 1000, // 24 小时内：关注
  URGENT_MS: 6 * 60 * 60 * 1000, // 6 小时内：紧急
  LEVELS: Object.freeze({ NORMAL: 0, WATCH: 1, URGENT: 2, CRITICAL: 3 }),
});

/** 离线扫描上报后的处置结果。 */
export const ScanStatus = Object.freeze({
  ACCEPTED: "accepted",
  DUPLICATE: "duplicate", // 同设备流水重复
  STALE: "stale", // 版本已关闭或已被重新发出
  UNKNOWN: "unknown", // 包裹码无法识别
  REJECTED: "rejected", // 状态迁移非法
});

/** 转移交接单状态。 */
export const TransferState = Object.freeze({
  PENDING: "pending",
  DONE: "done",
  OBSOLETE: "obsolete",
});
