import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import request from "supertest";
import { createApp } from "../src/server.js";
import { openDB } from "../src/db.js";

const HOUR = 3600 * 1000;
const SELF = { "x-actor-id": "person-1", "x-actor-role": "self" };
const DOC = { "x-actor-id": "doc-1", "x-actor-role": "clinician" };
const DOC2 = { "x-actor-id": "doc-2", "x-actor-role": "clinician" };
const PHARM1 = { "x-actor-id": "pharm-1", "x-actor-role": "dispenser" };
const PHARM2 = { "x-actor-id": "pharm-2", "x-actor-role": "dispenser" };
const COORD_A = { "x-actor-id": "coord-a", "x-actor-role": "coordinator" };
const COORD_B = { "x-actor-id": "coord-b", "x-actor-role": "coordinator" };
const COMMAND = { "x-actor-id": "command-1", "x-actor-role": "command" };
const AUDITOR = { "x-actor-id": "aud-1", "x-actor-role": "auditor" };

let clock;
let app;
let ids;

function medBody(overrides = {}) {
  return {
    medicationLabel: "胰岛素",
    remainingDoses: { amount: 3, unit: "剂" },
    latestSupplyBy: clock + 10 * HOUR,
    allergies: ["青霉素"],
    verificationSource: "package_label",
    requiresColdChain: true,
    deliveryRequired: true,
    ...overrides,
  };
}

// createApp 使用外部可注入时钟
function freshApp() {
  return createApp({ db: openDB(":memory:"), serviceOptions: { now: () => clock } });
}

async function boot() {
  clock = 1_000_000;
  app = freshApp();
  const siteA = await request(app).post("/sites").set(COORD_A).send({ name: "甲点" });
  const siteB = await request(app).post("/sites").set(COORD_B).send({ name: "乙点" });
  ids = { siteA: siteA.body.id, siteB: siteB.body.id };

  await request(app).post("/persons").set(COORD_A).send({ siteId: ids.siteA, personId: "person-1" });
  await request(app)
    .post("/persons/person-1/consents/clinicians")
    .set(SELF)
    .send({ clinicianId: "doc-1" });
  return ids;
}

async function register(actor = DOC, overrides = {}) {
  const res = await request(app)
    .post("/persons/person-1/medications")
    .set(actor)
    .send(medBody(overrides));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.registrationId;
}

async function reviewAndClaim(registrationId, pharm = PHARM1) {
  const review = await request(app).post(`/medications/${registrationId}/review`).set(DOC);
  assert.equal(review.status, 201, JSON.stringify(review.body));
  const claim = await request(app).post(`/requests/${review.body.requestId}/claim`).set(pharm).send({});
  assert.equal(claim.status, 201, JSON.stringify(claim.body));
  return { requestId: review.body.requestId, review: review.body, claim: claim.body };
}

beforeEach(async () => {
  await boot();
});
afterEach(() => {
  app = null;
});

// ---------- 鉴权 ----------

test("未携带身份头的请求被拒绝", async () => {
  const res = await request(app).get("/command/gaps");
  assert.equal(res.status, 401);
});

// ---------- 登记与分级可见性 ----------

test("本人或授权医护可登记；无授权医护不可登记", async () => {
  const ok = await request(app)
    .post("/persons/person-1/medications")
    .set(SELF)
    .send(medBody());
  assert.equal(ok.status, 201);
  assert.equal(ok.body.requiresColdChain, true);
  assert.equal(ok.body.latestSupplyBy, clock + 10 * HOUR);
  assert.equal("medicationLabel" in ok.body, false, "登记响应不含临床内容");

  const stranger = await request(app)
    .post("/persons/person-1/medications")
    .set(DOC2)
    .send(medBody());
  assert.equal(stranger.status, 403);

  const bad = await request(app)
    .post("/persons/person-1/medications")
    .set(SELF)
    .send(medBody({ latestSupplyBy: clock - 1 }));
  assert.equal(bad.status, 400);
});

test("协调员看板只见运营字段：冷藏、配送、截止时间，不见诊断/药品/人员", async () => {
  const regId = await register();
  await reviewAndClaim(regId);

  const board = await request(app).get(`/sites/${ids.siteA}/board`).set(COORD_A);
  assert.equal(board.status, 200);
  assert.equal(board.body.requests.length, 1);
  const row = board.body.requests[0];
  assert.equal(row.requiresColdChain, true);
  assert.equal(row.deliveryRequired, true);
  assert.equal(row.latestSupplyBy, clock + 10 * HOUR);
  const blob = JSON.stringify(board.body);
  assert.ok(!blob.includes("胰岛素"), "看板泄露药品标识");
  assert.ok(!blob.includes("青霉素"), "看板泄露过敏信息");
  assert.ok(!blob.includes("person-1"), "看板泄露人员标识");

  // 协调员不能读临床内容
  const clinical = await request(app).get(`/requests/${row.requestId}`).set(COORD_A);
  assert.equal(clinical.status, 403);
});

test("授权医护可读临床视图，撤回授权后立即失去访问", async () => {
  const regId = await register();
  const { requestId } = await reviewAndClaim(regId);

  const seen = await request(app).get(`/requests/${requestId}`).set(DOC);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.medication.medicationLabel, "胰岛素");
  assert.deepEqual(seen.body.medication.allergies, ["青霉素"]);

  await request(app)
    .delete("/persons/person-1/consents/clinicians/doc-1")
    .set(SELF)
    .expect(200);
  const after = await request(app).get(`/requests/${requestId}`).set(DOC);
  assert.equal(after.status, 403);
});

// ---------- 复核、一次性需求、并发认领、冻结 ----------

test("复核生成待认领需求；并发认领只有一个成功且版本冻结", async () => {
  const regId = await register();
  const r1 = await request(app).post(`/medications/${regId}/review`).set(DOC);
  assert.equal(r1.status, 201);
  assert.equal(r1.body.versionNo, 1);
  assert.equal(r1.body.status, "pending");
  assert.equal(r1.body.frozenAt, null);

  // 重复复核被拒绝
  const dup = await request(app).post(`/medications/${regId}/review`).set(DOC);
  assert.equal(dup.status, 409);

  const [winner, loser] = await Promise.all([
    request(app).post(`/requests/${r1.body.requestId}/claim`).set(PHARM1).send({}),
    request(app).post(`/requests/${r1.body.requestId}/claim`).set(PHARM2).send({}),
  ]);
  const ok = winner.status === 201 ? winner : loser;
  const fail = winner.status === 201 ? loser : winner;
  assert.equal(ok.status, 201);
  assert.equal(fail.status, 409);
  assert.equal(fail.body.error, "already_claimed");
  assert.equal(ok.body.responsibleParty, ok === winner ? "pharm-1" : "pharm-2");
  assert.ok(ok.body.frozenAt, "认领时应冻结");
  assert.equal(ok.body.medication.frozenBy, ok.body.responsibleParty);
  assert.ok(ok.body.packageCode, "应生成包裹码");
});

// ---------- 流向事件只追加，非法迁移被拒 ----------

test("发出、在途、签收依次追加事件；非法状态迁移被拒", async () => {
  const regId = await register();
  const { requestId } = await reviewAndClaim(regId);

  // 未认领不能直接发出
  const regId2 = await register(DOC, { medicationLabel: "降压药", requiresColdChain: false });
  const pending = await request(app).post(`/medications/${regId2}/review`).set(DOC);
  const early = await request(app)
    .post(`/requests/${pending.body.requestId}/events`)
    .set(PHARM1)
    .send({ type: "dispatched" });
  assert.equal(early.status, 403, "非负责方不能操作");

  const d = await request(app)
    .post(`/requests/${requestId}/events`)
    .set(PHARM1)
    .send({ type: "dispatched", payload: { note: "出库" } });
  assert.equal(d.status, 201);
  assert.equal(d.body.status, "dispatched");

  const t = await request(app)
    .post(`/requests/${requestId}/events`)
    .set(PHARM1)
    .send({ type: "in_transit" });
  assert.equal(t.body.status, "in_transit");

  // 他队不能签收
  const stranger = await request(app)
    .post(`/requests/${requestId}/events`)
    .set(PHARM2)
    .send({ type: "delivered" });
  assert.equal(stranger.status, 403);

  const received = await request(app)
    .post(`/requests/${requestId}/events`)
    .set(SELF)
    .send({ type: "delivered", payload: { signature: "本人" } });
  assert.equal(received.status, 201);
  assert.equal(received.body.status, "delivered");

  const types = received.body.events.map((e) => e.type);
  assert.deepEqual(types, ["reviewed", "claimed", "dispatched", "in_transit", "delivered"]);

  // 终态后任何流向事件被拒
  const again = await request(app)
    .post(`/requests/${requestId}/events`)
    .set(PHARM1)
    .send({ type: "in_transit" });
  assert.equal(again.status, 409);
  assert.equal(again.body.error, "version_closed");
});

// ---------- 离线扫描：去重 / 迟到 / 未知 ----------

test("离线扫描按设备流水去重，迟到签收不能越过关闭版本，未知包裹被识别", async () => {
  const regId = await register();
  const { requestId, claim } = await reviewAndClaim(regId);
  const pkg = claim.packageCode;

  const s1 = await request(app)
    .post("/scans")
    .set(PHARM1)
    .send({ deviceId: "dev-7", scanSeq: "0001", scanType: "dispatch", packageCode: pkg });
  assert.equal(s1.body.result, "accepted");

  const s2 = await request(app)
    .post("/scans")
    .set(PHARM1)
    .send({ deviceId: "dev-7", scanSeq: "0001", scanType: "dispatch", packageCode: pkg });
  assert.equal(s2.body.result, "duplicate");
  assert.equal(s2.body.original.result, "accepted");

  // 另一设备同流水号互不影响（去重键含设备）
  const s3 = await request(app)
    .post("/scans")
    .set(PHARM1)
    .send({ deviceId: "dev-8", scanSeq: "0001", scanType: "in_transit", packageCode: pkg });
  assert.equal(s3.body.result, "accepted");

  // 状态非法：已在途再扫发出 → rejected
  const bad = await request(app)
    .post("/scans")
    .set(PHARM1)
    .send({ deviceId: "dev-7", scanSeq: "0002", scanType: "dispatch", packageCode: pkg });
  assert.equal(bad.body.result, "rejected");

  // 未知包裹
  const unknown = await request(app)
    .post("/scans")
    .set(PHARM1)
    .send({ deviceId: "dev-7", scanSeq: "0003", scanType: "deliver", packageCode: "nope" });
  assert.equal(unknown.body.result, "unknown");

  // 签收关闭版本
  const done = await request(app)
    .post("/scans")
    .set(PHARM1)
    .send({ deviceId: "dev-7", scanSeq: "0004", scanType: "deliver", packageCode: pkg });
  assert.equal(done.body.result, "accepted");

  // 迟到事件落在已关闭版本 → stale，不会重开
  const late = await request(app)
    .post("/scans")
    .set(PHARM1)
    .send({ deviceId: "dev-9", scanSeq: "9001", scanType: "in_transit", packageCode: pkg });
  assert.equal(late.body.result, "stale");
  const row = await request(app).get(`/requests/${requestId}`).set(PHARM1);
  assert.equal(row.body.status, "delivered");
});

test("拒收后重新发出新版本，迟到扫描不能越过新版本", async () => {
  const regId = await register(DOC, { medicationLabel: "抗凝药", requiresColdChain: false });
  const { requestId, claim } = await reviewAndClaim(regId);
  const oldPkg = claim.packageCode;

  await request(app).post(`/requests/${requestId}/events`).set(PHARM1).send({ type: "dispatched" });
  const rej = await request(app)
    .post(`/requests/${requestId}/events`)
    .set(PHARM1)
    .send({ type: "rejected", payload: { reason: "缺货" } });
  assert.equal(rej.body.status, "rejected");

  // 活跃版本存在时不能重发
  const regIdB = await register(DOC, { medicationLabel: "哮喘喷雾", requiresColdChain: false });
  const flowB = await reviewAndClaim(regIdB);
  await request(app).post(`/requests/${flowB.requestId}/events`).set(PHARM1).send({ type: "dispatched" });
  const noReissue = await request(app).post(`/medications/${regIdB}/reissue`).set(DOC);
  assert.equal(noReissue.status, 409);
  assert.equal(noReissue.body.error, "request_active");

  const v2 = await request(app).post(`/medications/${regId}/reissue`).set(DOC);
  assert.equal(v2.status, 201);
  assert.equal(v2.body.versionNo, 2);
  assert.equal(v2.body.status, "pending");

  // 旧包裹的迟到签收：旧版本已关闭 → stale
  const late = await request(app)
    .post("/scans")
    .set(PHARM1)
    .send({ deviceId: "dev-1", scanSeq: "5001", scanType: "deliver", packageCode: oldPkg });
  assert.equal(late.body.result, "stale");

  const c2 = await request(app).post(`/requests/${v2.body.requestId}/claim`).set(PHARM2).send({});
  assert.equal(c2.status, 201);
  assert.equal(c2.body.responsibleParty, "pharm-2");
});

// ---------- 过敏 / 授权撤回即时阻断 ----------

test("过敏禁忌立即阻断未交付药物；已完成交付保留当时依据", async () => {
  const regId = await register();
  const { requestId, claim } = await reviewAndClaim(regId);
  await request(app).post(`/requests/${requestId}/events`).set(PHARM1).send({ type: "dispatched" });

  const block = await request(app)
    .post(`/medications/${regId}/allergy-block`)
    .set(DOC)
    .send({ reason: "新发现交叉过敏" });
  assert.equal(block.status, 200);
  assert.equal(block.body.blocked, true);

  const row = await request(app).get(`/requests/${requestId}`).set(PHARM1);
  assert.equal(row.body.status, "blocked");
  assert.ok(row.body.events.some((e) => e.type === "blocked_allergy"));
  // 冻结快照保留认领时依据，不被追溯改写
  assert.deepEqual(row.body.medication.allergies, ["青霉素"]);

  const stopped = await request(app)
    .post(`/requests/${requestId}/events`)
    .set(PHARM1)
    .send({ type: "in_transit" });
  assert.equal(stopped.status, 409);

  // 阻断后不能再重发（终局）
  const reissue = await request(app).post(`/medications/${regId}/reissue`).set(DOC);
  assert.equal(reissue.status, 409);

  // 另一个登记：完成交付后再标记过敏，已交付版本不动
  const regId2 = await register(DOC, { medicationLabel: "降压药", allergies: [], requiresColdChain: false });
  const flow = await reviewAndClaim(regId2, PHARM2);
  await request(app).post(`/requests/${flow.requestId}/events`).set(PHARM2).send({ type: "dispatched" });
  await request(app).post(`/requests/${flow.requestId}/events`).set(PHARM2).send({ type: "in_transit" });
  const delivered = await request(app)
    .post(`/requests/${flow.requestId}/events`)
    .set(SELF)
    .send({ type: "delivered" });
  assert.equal(delivered.body.status, "delivered");
  const frozenBasis = delivered.body.medication;

  await request(app).post(`/medications/${regId2}/allergy-block`).set(DOC).send({ reason: "迟报" });
  const kept = await request(app).get(`/requests/${flow.requestId}`).set(PHARM2);
  assert.equal(kept.body.status, "delivered");
  assert.deepEqual(kept.body.medication, frozenBasis);
});

test("本人撤回授权立即阻断全部未交付需求，交付历史保留", async () => {
  const undelivered = await register();
  const flow1 = await reviewAndClaim(undelivered);
  const done = await register(DOC, { medicationLabel: "甲状腺素", allergies: [], requiresColdChain: false });
  const flow2 = await reviewAndClaim(done, PHARM2);
  await request(app).post(`/requests/${flow2.requestId}/events`).set(PHARM2).send({ type: "dispatched" });
  await request(app).post(`/requests/${flow2.requestId}/events`).set(SELF).send({ type: "delivered" });

  const wd = await request(app).post("/persons/person-1/consent/withdraw").set(SELF);
  assert.equal(wd.status, 200);
  assert.equal(wd.body.consentActive, false);

  const blocked = await request(app).get(`/requests/${flow1.requestId}`).set(PHARM1);
  assert.equal(blocked.body.status, "blocked");
  const kept = await request(app).get(`/requests/${flow2.requestId}`).set(PHARM2);
  assert.equal(kept.body.status, "delivered");

  // 撤权后不能新登记
  const more = await request(app).post("/persons/person-1/medications").set(SELF).send(medBody());
  assert.equal(more.status, 409);
});

// ---------- 转移交接：单负责方、途中签收作废、幂等 ----------

test("人员转移把未完成需求交给新安置点，旧点版本终结，全程只有一个活跃版本", async () => {
  const regId = await register(DOC, { medicationLabel: "降压药", requiresColdChain: false });
  const { requestId } = await reviewAndClaim(regId);
  await request(app).post(`/requests/${requestId}/events`).set(PHARM1).send({ type: "dispatched" });

  const mv = await request(app)
    .post("/persons/person-1/movements")
    .set(COORD_A)
    .send({ toSiteId: ids.siteB });
  assert.equal(mv.status, 201);
  assert.equal(mv.body.handovers.length, 1);

  // 转移进行中不能重复发起
  const again = await request(app)
    .post("/persons/person-1/movements")
    .set(COORD_A)
    .send({ toSiteId: ids.siteA });
  assert.equal(again.status, 409);

  const arrival = await request(app)
    .post(`/movements/${mv.body.movementId}/arrive`)
    .set(COORD_B);
  assert.equal(arrival.status, 201);
  assert.equal(arrival.body.completed.length, 1);
  const newRequestId = arrival.body.completed[0].newRequestId;

  const oldRow = await request(app).get(`/requests/${requestId}`).set(PHARM1);
  assert.equal(oldRow.body.status, "transferred");
  assert.ok(oldRow.body.events.some((e) => e.type === "transferred_out"));

  const newRow = await request(app).get(`/requests/${newRequestId}`).set(PHARM1);
  assert.equal(newRow.body.status, "pending");
  assert.equal(newRow.body.destinationSiteId, ids.siteB);
  assert.equal(newRow.body.versionNo, 2);
  assert.equal(newRow.body.events[0].type, "transferred_in");

  // 新点协调员看板出现该需求，旧点看板清空
  const boardB = await request(app).get(`/sites/${ids.siteB}/board`).set(COORD_B);
  assert.equal(boardB.body.requests.length, 1);
  const boardA = await request(app).get(`/sites/${ids.siteA}/board`).set(COORD_A);
  assert.equal(boardA.body.requests.length, 0);

  // 幂等：重复确认不产生第二个新版本
  const repeat = await request(app)
    .post(`/movements/${mv.body.movementId}/arrive`)
    .set(COORD_B);
  assert.equal(repeat.body.completed.filter((c) => c.newRequestId).length, 0);

  // 新版本可被新药房认领并走完全程
  await request(app).post(`/requests/${newRequestId}/claim`).set(PHARM2).send({}).expect(201);
});

test("转移途中已签收的需求交接单作废，不产生重复版本", async () => {
  const regId = await register(DOC, { medicationLabel: "平喘药", requiresColdChain: false });
  const { requestId } = await reviewAndClaim(regId);
  await request(app).post(`/requests/${requestId}/events`).set(PHARM1).send({ type: "dispatched" });

  const mv = await request(app)
    .post("/persons/person-1/movements")
    .set(COORD_A)
    .send({ toSiteId: ids.siteB });
  // 途中在旧点完成签收
  await request(app).post(`/requests/${requestId}/events`).set(SELF).send({ type: "delivered" });

  const arrival = await request(app).post(`/movements/${mv.body.movementId}/arrive`).set(COORD_B);
  assert.equal(arrival.body.completed.length, 0);
  assert.equal(arrival.body.obsolete.length, 1);
  assert.equal(arrival.body.obsolete[0].reason, "delivered");
});

test("服务恢复：离线补录到达后 sweep 续跑交接与临期升级", async () => {
  const urgent = await register(DOC, {
    medicationLabel: "急救药",
    requiresColdChain: false,
    latestSupplyBy: clock + 2 * HOUR,
  });
  const { requestId } = await reviewAndClaim(urgent);
  await request(app).post(`/requests/${requestId}/events`).set(PHARM1).send({ type: "dispatched" });

  const mv = await request(app)
    .post("/persons/person-1/movements")
    .set(COORD_A)
    .send({ toSiteId: ids.siteB });

  // 时钟跳到服务恢复之后：先补录离线到达，再巡检
  clock += 5 * HOUR;
  const offline = await request(app)
    .post(`/movements/${mv.body.movementId}/arrive-offline`)
    .set(COORD_B)
    .send({ arrivedAt: clock - 3 * HOUR });
  assert.equal(offline.status, 201);
  // sweep 完成了交接
  assert.equal(offline.body.completedTransfers.length, 1);
  // 截止时间已过 → 升级到 critical
  assert.ok(offline.body.escalated.some((e) => e.to === 3), JSON.stringify(offline.body.escalated));

  const sweep2 = await request(app).post("/internal/sweep").set(COMMAND);
  assert.equal(sweep2.status, 200);
  // 升级单调：再次 sweep 不重复追加升级事件
  assert.equal(sweep2.body.escalated.length, 0);
});

// ---------- 指挥席匿名缺口 ----------

test("指挥席只见匿名缺口汇总，按站点与升级级别聚合", async () => {
  const regId = await register();
  await reviewAndClaim(regId);
  const gaps = await request(app).get("/command/gaps").set(COMMAND);
  assert.equal(gaps.status, 200);
  const siteA = gaps.body.sites.find((s) => s.siteId === ids.siteA);
  assert.equal(siteA.total, 1);
  assert.equal(siteA.coldChain, 1);
  assert.equal(siteA.deliveryRequired, 1);
  assert.equal(siteA.unclaimed, 0);
  const blob = JSON.stringify(gaps.body);
  assert.ok(!blob.includes("person-1"));
  assert.ok(!blob.includes("胰岛素"));

  // 非指挥席被拒
  const denied = await request(app).get("/command/gaps").set(COORD_A);
  assert.equal(denied.status, 403);
});

// ---------- 授权审计 ----------

test("仅获授权审计员可重建访问者、药物流向与最终交付依据", async () => {
  const regId = await register();
  const { requestId } = await reviewAndClaim(regId);
  await request(app).post(`/requests/${requestId}/events`).set(PHARM1).send({ type: "dispatched" });
  await request(app).post(`/requests/${requestId}/events`).set(SELF).send({ type: "delivered" });
  // 产生若干访问记录
  await request(app).get(`/requests/${requestId}`).set(DOC);

  const noGrant = await request(app).get("/persons/person-1/audit-trail").set(AUDITOR);
  assert.equal(noGrant.status, 403);

  await request(app)
    .post("/persons/person-1/audit-grants")
    .set(SELF)
    .send({ auditorId: "aud-1" })
    .expect(201);

  const trail = await request(app).get("/persons/person-1/audit-trail").set(AUDITOR);
  assert.equal(trail.status, 200);
  assert.equal(trail.body.person.anonCode.startsWith("P-"), true);
  assert.equal(trail.body.person.id, "person-1", "授权范围内审计可见标识");

  const med = trail.body.medicationFlow[0];
  assert.equal(med.medication.medicationLabel, "胰岛素");
  assert.equal(med.finalDelivery.length, 1);
  const delivery = med.finalDelivery[0];
  assert.ok(delivery.basisAtDelivery.frozen.frozenAt, "最终交付保留当时冻结依据");
  assert.equal(delivery.signedOffBy, "person-1");
  assert.equal(delivery.acceptedBy, "pharm-1");
  // 访问者链：含医护读取、药房操作
  const actions = trail.body.visitors.map((v) => v.action);
  assert.ok(actions.includes("request.read_clinical"));
});
