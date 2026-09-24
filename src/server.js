import express from "express";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  EventType,
} from "./contracts.js";
import { createMedicationService, ServiceError } from "./medication.js";
import { createStore, openDatabase } from "./store.js";

// 极简身份头：现场系统由前置网关完成强认证后，以下游头传递调用者属性。
// X-Actor-Id / X-Actor-Role 必填；X-Site-Code 为安置点；X-Person-Ref 为本人标识；
// X-Authorization-Id 仅审计重建需要。
function readActor(request) {
  const headers = request.headers;
  if (!headers["x-actor-id"] || !headers["x-actor-role"]) return null;
  return {
    id: headers["x-actor-id"],
    role: headers["x-actor-role"],
    site_code: headers["x-site-code"] ?? null,
    person_ref: headers["x-person-ref"] ?? null,
    authorization_id: headers["x-authorization-id"] ?? null,
  };
}

export function createApp({ store } = {}) {
  const dataStore = store ?? createStore(openDatabase(defaultDbFile()));
  const service = createMedicationService(dataStore);
  const app = express();
  app.use(express.json());

  app.get("/health", (_request, response) =>
    response.json({ status: "ok", service: "evacuation-muster" }),
  );

  const actorOr401 = (request, response, next) => {
    const actor = readActor(request);
    if (!actor) return response.status(401).json({ error: { code: "unauthorized", message: "缺少身份信息" } });
    request.actor = actor;
    next();
  };

  const run = (handler) => (request, response) => {
    try {
      const result = handler(request);
      response.status(result?.statusCode ?? 200).json(result?.body ?? result);
    } catch (error) {
      sendError(response, error);
    }
  };

  // ---- 登记 ----------------------------------------------------------------
  app.post(
    "/v1/registrations",
    actorOr401,
    run((request) => service.register(request.body ?? {}, request.actor)),
  );

  // ---- 医护复核 → 一次性需求 -----------------------------------------------
  app.post(
    "/v1/registrations/:id/review",
    actorOr401,
    run((request) => service.reviewAndCreateRequest(request.params.id, request.actor, request.body ?? {})),
  );

  // ---- 医疗侧受限视图 ------------------------------------------------------
  app.get(
    "/v1/registrations/:id",
    actorOr401,
    run((request) => service.medicalView(request.params.id, request.actor)),
  );

  // ---- 过敏/授权撤回阻断 ---------------------------------------------------
  app.post(
    "/v1/registrations/:id/block",
    actorOr401,
    run((request) => service.block(request.params.id, request.actor, request.body ?? {})),
  );

  // ---- 医护核实后解除阻断 ---------------------------------------------------
  app.post(
    "/v1/registrations/:id/unblock",
    actorOr401,
    run((request) => service.unblock(request.params.id, request.actor, request.body ?? {})),
  );

  // ---- 认领 + 冻结 ---------------------------------------------------------
  app.post(
    "/v1/requests/:id/claim",
    actorOr401,
    run((request) => service.claim(request.params.id, request.actor, request.body ?? {})),
  );

  // ---- 物流事件（发出/在途/签收/拒收/损坏，支持离线扫码字段） --------------
  const logisticsRoute = (eventType) =>
    run((request) =>
      service.reportLogisticsEvent(request.params.id, eventType, request.actor, request.body ?? {}),
    );
  app.post("/v1/requests/:id/events/dispatched", actorOr401, logisticsRoute(EventType.DISPATCHED));
  app.post("/v1/requests/:id/events/in-transit", actorOr401, logisticsRoute(EventType.IN_TRANSIT));
  app.post("/v1/requests/:id/events/delivered", actorOr401, logisticsRoute(EventType.DELIVERED));
  app.post("/v1/requests/:id/events/rejected", actorOr401, logisticsRoute(EventType.REJECTED));
  app.post("/v1/requests/:id/events/damaged", actorOr401, logisticsRoute(EventType.DAMAGED));

  // ---- 重新发出 / 关闭 / 转移 ----------------------------------------------
  app.post(
    "/v1/requests/:id/reissue",
    actorOr401,
    run((request) => service.reissue(request.params.id, request.actor, request.body ?? {})),
  );
  app.post(
    "/v1/requests/:id/close",
    actorOr401,
    run((request) => service.close(request.params.id, request.actor, request.body ?? {})),
  );
  app.post(
    "/v1/requests/:id/transfer",
    actorOr401,
    run((request) => service.transfer(request.params.id, request.actor, request.body ?? {})),
  );

  // ---- 现场协调员：本点公开物流视图 ----------------------------------------
  app.get(
    "/v1/sites/me/requests",
    actorOr401,
    run((request) => service.coordinatorList(request.actor, request.query)),
  );

  // ---- 恢复后待办：临期升级 + 交接 + 待签收 --------------------------------
  app.get(
    "/v1/tasks/pending",
    actorOr401,
    run((request) => service.pendingTasks(request.actor, request.query)),
  );

  // 手动重跑临期升级（服务恢复时由调度调用，幂等）。由调度密钥或授权医护触发。
  app.post(
    "/v1/system/escalations/run",
    run((request) => {
      const body = request.body ?? {};
      const secret = process.env.SCHEDULER_SECRET;
      const actor = readActor(request);
      const schedulerOk = secret && body.scheduler_secret === secret;
      if (!schedulerOk && (!actor || actor.role !== "clinician")) {
        throw new ServiceError("forbidden", "需要调度密钥或授权医护身份", { status: 403 });
      }
      return service.escalateDue(body);
    }),
  );

  // ---- 指挥席：匿名缺口汇总 ------------------------------------------------
  app.get(
    "/v1/command/gaps",
    actorOr401,
    run((request) => service.commanderSummary(request.actor, request.query)),
  );

  // ---- 审计员：重建访问者、流向与最终交付 ----------------------------------
  app.post(
    "/v1/audit/rebuild",
    actorOr401,
    run((request) =>
      service.auditRebuild(request.actor, {
        ...(request.body ?? {}),
        authorization_id: (request.body ?? {}).authorization_id ?? request.actor.authorization_id,
      })),
  );

  app.use((request, response) => response.status(404).json({ error: { code: "not_found", message: "未知路由" } }));
  // eslint-disable-next-line no-unused-vars
  app.use((error, _request, response, _next) => sendError(response, error));

  return app;
}

function sendError(response, error) {
  if (error instanceof ServiceError) {
    return response.status(error.status).json({
      error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
    });
  }
  if (error?.type === "entity.parse.failed") {
    return response.status(400).json({ error: { code: "invalid_json", message: "请求体不是合法 JSON" } });
  }
  response.status(500).json({ error: { code: "internal_error", message: "服务内部错误" } });
}

function defaultDbFile() {
  if (process.env.DB_FILE) {
    mkdirSync(dirname(process.env.DB_FILE), { recursive: true });
    return process.env.DB_FILE;
  }
  const dir = ".data";
  mkdirSync(dir, { recursive: true });
  return `${dir}/medication.sqlite`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createApp().listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
}
