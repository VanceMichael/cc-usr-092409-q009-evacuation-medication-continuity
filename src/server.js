import express from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { openDB } from "./db.js";
import { createService, HttpError } from "./service.js";
import { Role, EventType } from "./contracts.js";

const VALID_ROLES = new Set(Object.values(Role));

/**
 * 网关在完成现场身份核验后注入 actor 头：
 *   x-actor-id   操作者标识（本人ID / 医护工号 / 药房队伍ID / 设备协调员）
 *   x-actor-role self | clinician | coordinator | dispenser | command | auditor
 */
function actorFrom(request, response) {
  const id = String(request.header("x-actor-id") ?? "").trim();
  const role = String(request.header("x-actor-role") ?? "").trim();
  if (!id || !VALID_ROLES.has(role)) {
    response.status(401).json({ error: "unauthenticated", message: "缺少有效的操作者身份头" });
    return null;
  }
  return { id, role };
}

function requireActor(handler) {
  return (request, response, next) => {
    const actor = actorFrom(request, response);
    if (!actor) return;
    try {
      const result = handler(request, response, actor);
      if (result instanceof Promise) result.catch(next);
    } catch (error) {
      next(error);
    }
  };
}

const FLOW_EVENT_HANDLERS = Object.freeze({
  [EventType.DISPATCHED]: (svc, id, actor, payload) => svc.dispatch(id, actor, payload),
  [EventType.IN_TRANSIT]: (svc, id, actor, payload) => svc.markInTransit(id, actor, payload),
  [EventType.DELIVERED]: (svc, id, actor, payload) => svc.deliver(id, actor, payload),
  [EventType.REJECTED]: (svc, id, actor, payload) => svc.reject(id, actor, payload),
  [EventType.DAMAGED]: (svc, id, actor, payload) => svc.damage(id, actor, payload),
});

export function createApp(options = {}) {
  const db = options.db ?? openDB(process.env.DB_FILE ?? ":memory:");
  const svc = createService(db, options.serviceOptions ?? {});
  const app = express();
  app.use(express.json());
  app.locals.svc = svc;

  app.get("/health", (_request, response) =>
    response.json({ status: "ok", service: "evacuation-muster" })
  );

  // ---------- 站点与人员（身份层） ----------

  app.post(
    "/sites",
    requireActor((req, res, actor) => {
      if (actor.role !== Role.COORDINATOR) throw new HttpError(403, "forbidden", "仅协调员可建立安置点");
      res.status(201).json(svc.createSite(String(req.body?.name ?? "").trim() || "未命名安置点"));
    })
  );

  app.post(
    "/persons",
    requireActor((req, res, actor) => {
      const siteId = String(req.body?.siteId ?? "").trim();
      if (!siteId) throw new HttpError(400, "invalid_input", "缺少 siteId");
      const personId = req.body?.personId ? String(req.body.personId) : undefined;
      res.status(201).json(svc.createPerson(siteId, actor, personId));
    })
  );

  app.post(
    "/persons/:personId/consents/clinicians",
    requireActor((req, res, actor) => {
      const clinicianId = String(req.body?.clinicianId ?? "").trim();
      if (!clinicianId) throw new HttpError(400, "invalid_input", "缺少 clinicianId");
      res.status(201).json(svc.grantClinician(req.params.personId, clinicianId, actor));
    })
  );

  app.delete(
    "/persons/:personId/consents/clinicians/:clinicianId",
    requireActor((req, res, actor) => {
      res.json(svc.revokeClinician(req.params.personId, req.params.clinicianId, actor));
    })
  );

  app.post(
    "/persons/:personId/consent/withdraw",
    requireActor((req, res, actor) => res.json(svc.withdrawConsent(req.params.personId, actor)))
  );

  // ---------- 用药登记（临床层写入） ----------

  app.post(
    "/persons/:personId/medications",
    requireActor((req, res, actor) => {
      const body = req.body ?? {};
      res.status(201).json(
        svc.registerMedication(req.params.personId, actor, {
          medicationLabel: body.medicationLabel,
          remainingDoses: body.remainingDoses,
          latestSupplyBy: body.latestSupplyBy,
          allergies: body.allergies,
          verificationSource: body.verificationSource,
          verificationDetail: body.verificationDetail,
          requiresColdChain: body.requiresColdChain,
          deliveryRequired: body.deliveryRequired,
        })
      );
    })
  );

  app.get(
    "/persons/:personId/medications",
    requireActor((req, res, actor) => res.json(svc.listMyRegistrations(req.params.personId, actor)))
  );

  app.post(
    "/medications/:registrationId/allergy-block",
    requireActor((req, res, actor) =>
      res.json(svc.flagAllergy(req.params.registrationId, actor, String(req.body?.reason ?? "")))
    )
  );

  // ---------- 复核 → 一次性需求；拒收/损坏后重发 ----------

  app.post(
    "/medications/:registrationId/review",
    requireActor((req, res, actor) => res.status(201).json(svc.review(req.params.registrationId, actor)))
  );

  app.post(
    "/medications/:registrationId/reissue",
    requireActor((req, res, actor) => res.status(201).json(svc.reissue(req.params.registrationId, actor)))
  );

  // ---------- 认领冻结与流向事件 ----------

  app.post(
    "/requests/:requestId/claim",
    requireActor((req, res, actor) => {
      if (actor.role !== Role.DISPENSER) throw new HttpError(403, "forbidden", "仅药房或医疗队可认领");
      res.status(201).json(svc.claim(req.params.requestId, actor, String(req.body?.partyKind ?? "dispenser")));
    })
  );

  app.post(
    "/requests/:requestId/events",
    requireActor((req, res, actor) => {
      const type = String(req.body?.type ?? "");
      const handler = FLOW_EVENT_HANDLERS[type];
      if (!handler) throw new HttpError(400, "invalid_event", "不支持的事件类型");
      res.status(201).json(handler(svc, req.params.requestId, actor, req.body?.payload ?? {}));
    })
  );

  app.get(
    "/requests/:requestId",
    requireActor((req, res, actor) => res.json(svc.getClinicalRequest(req.params.requestId, actor)))
  );

  // ---------- 离线扫描（设备流水去重、迟到拦截） ----------

  app.post(
    "/scans",
    requireActor((req, res) => {
      // 扫描由设备身份承载，x-actor-id 即设备号，流水在请求体内
      const body = req.body ?? {};
      const result = svc.reportScan({
        deviceId: body.deviceId ?? req.header("x-actor-id"),
        scanSeq: body.scanSeq,
        scanType: body.scanType,
        packageCode: body.packageCode,
        occurredAt: body.occurredAt,
        actorId: body.actorId,
        actorRole: body.actorRole,
        payload: body.payload,
      });
      // duplicate/stale/unknown/rejected 是幂等或拒绝处置，HTTP 仍为 200 便于离线设备重试
      res.status(201).json(result);
    })
  );

  // ---------- 人员转移与交接 ----------

  app.post(
    "/persons/:personId/movements",
    requireActor((req, res, actor) => {
      const toSiteId = String(req.body?.toSiteId ?? "").trim();
      if (!toSiteId) throw new HttpError(400, "invalid_input", "缺少 toSiteId");
      res.status(201).json(svc.reportMovement(req.params.personId, toSiteId, actor));
    })
  );

  app.post(
    "/movements/:movementId/arrive",
    requireActor((req, res, actor) =>
      res.status(201).json(svc.confirmArrival(req.params.movementId, actor))
    )
  );

  app.post(
    "/movements/:movementId/arrive-offline",
    requireActor((req, res, actor) => {
      const arrivedAt = Number(req.body?.arrivedAt);
      if (!Number.isFinite(arrivedAt)) throw new HttpError(400, "invalid_input", "缺少 arrivedAt");
      res.status(201).json(svc.recordArrivalOffline(req.params.movementId, arrivedAt, actor));
    })
  );

  // ---------- 协调员看板（仅 L1 运营字段） ----------

  app.get(
    "/sites/:siteId/board",
    requireActor((req, res, actor) => res.json(svc.coordinationBoard(req.params.siteId, actor)))
  );

  // ---------- 指挥席匿名缺口 ----------

  app.get("/command/gaps", requireActor((req, res, actor) => res.json(svc.gapSummary(actor))));

  // ---------- 授权审计 ----------

  app.post(
    "/persons/:personId/audit-grants",
    requireActor((req, res, actor) => {
      const auditorId = String(req.body?.auditorId ?? "").trim();
      if (!auditorId) throw new HttpError(400, "invalid_input", "缺少 auditorId");
      res.status(201).json(svc.grantAudit(req.params.personId, auditorId, actor));
    })
  );

  app.get(
    "/persons/:personId/audit-trail",
    requireActor((req, res, actor) => res.json(svc.rebuildTrail(req.params.personId, actor)))
  );

  // ---------- 运维：恢复扫描（也会在进程启动时执行一次） ----------

  app.post(
    "/internal/sweep",
    requireActor((_req, res, actor) => {
      if (actor.role !== Role.COMMAND) throw new HttpError(403, "forbidden", "仅指挥席可触发巡检");
      res.json(svc.runSweep());
    })
  );

  // ---------- 错误处理 ----------

  // JSON 解析错误
  app.use((error, _request, response, next) => {
    if (error instanceof SyntaxError && "body" in error) {
      return response.status(400).json({ error: "invalid_json", message: "请求体不是合法 JSON" });
    }
    next(error);
  });

  app.use((error, _request, response, _next) => {
    if (error instanceof HttpError) {
      return response.status(error.status).json({ error: error.code, message: error.message });
    }
    requestLog(error);
    response.status(500).json({ error: "internal_error", message: "服务内部错误" });
  });

  return app;
}

function requestLog(error) {
  // 保留堆栈到服务端日志，不外泄
  console.error(error);
}

function defaultDbFile() {
  const file = process.env.DB_FILE ?? ".data/evacuation.db";
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = createApp({ db: openDB(defaultDbFile()) });
  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, "0.0.0.0", () => {
    // 服务恢复：立即续跑临期升级、转移交接与待签收任务，之后按间隔巡检
    const svc = app.locals.svc;
    try {
      const sweep = svc.runSweep();
      console.log(
        `[startup] sweep: 升级 ${sweep.escalated.length}，交接 ${sweep.completedTransfers.length}，待签收 ${sweep.pendingReceipt.length}`
      );
    } catch (error) {
      console.error("[startup] sweep 失败：", error);
    }
    const intervalMs = Number(process.env.SWEEP_INTERVAL_MS ?? 15 * 60 * 1000);
    if (Number.isFinite(intervalMs) && intervalMs > 0) setInterval(() => svc.runSweep(), intervalMs);
    console.log(`evacuation-muster 监听 0.0.0.0:${port}`);
  });
}
