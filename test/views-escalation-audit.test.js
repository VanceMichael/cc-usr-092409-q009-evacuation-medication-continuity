import assert from "node:assert/strict";
import { test } from "node:test";
import { actors, expectError, HOUR, makeService, registrationInput, seedInTransit } from "./helpers.js";

const iso = (ms) => new Date(ms).toISOString();

test("协调员视图只有冷藏/配送/截止时间，没有诊断、处方、过敏或人员标识", () => {
  const { service } = makeService();
  const seeded = seedInTransit(service);
  const view = service.coordinatorList(actors.coordinatorS1);
  assert.equal(view.requests.length, 1);
  const row = view.requests[0];
  assert.equal(row.needs_refrigeration, true);
  assert.equal(row.needs_delivery, true);
  assert.ok(row.latest_supply_at);
  assert.equal(row.state, "in_transit");
  for (const secret of [
    "medication_code",
    "medication_label",
    "remaining_doses",
    "allergies",
    "contraindications",
    "person_ref",
    "verification_source",
  ]) {
    assert.equal(secret in row, false, `协调员视图不得包含 ${secret}`);
  }
  void seeded;
});

test("协调员只能查看本安置点", () => {
  const { service } = makeService();
  seedInTransit(service);
  expectError(() => service.coordinatorList(actors.coordinatorS2, { site_code: "S1" }), "forbidden");
});

test("非协调员不能访问协调员视图，药房看不到药品以外的登记管理字段", () => {
  const { service } = makeService();
  const seeded = seedInTransit(service);
  expectError(() => service.coordinatorList(actors.pharmacy1), "forbidden");
  const view = service.medicalView(seeded.reg.id, actors.pharmacy1);
  assert.equal(view.registration.allergies[0], "青霉素");
  assert.equal(view.registration.medication_code, "MED-A100");
});

test("药房不能查看未认领需求的受限详情", () => {
  const { service } = makeService();
  const reg = service.register(registrationInput(), actors.self1);
  const v1 = service.reviewAndCreateRequest(reg.id, actors.clinicianA);
  void v1;
  expectError(() => service.medicalView(reg.id, actors.pharmacy1), "forbidden");
});

test("指挥席只看匿名缺口汇总：按站点统计，不含任何标识", () => {
  const { service } = makeService();
  const seeded = seedInTransit(service, {
    registration: { latest_supply_at: iso(Date.now() + 2 * HOUR) },
  });
  // 再来一条 open 需求。
  const reg2 = service.register(
    registrationInput({ latest_supply_at: iso(Date.now() + 72 * HOUR) }),
    { ...actors.self2 },
  );
  service.reviewAndCreateRequest(reg2.id, actors.clinicianA);
  void seeded;

  const summary = service.commanderSummary(actors.commander, { at: iso(Date.now()) });
  assert.equal(summary.sites.length, 1);
  const s1 = summary.sites[0];
  assert.equal(s1.site_code, "S1");
  assert.equal(s1.unfulfilled_total, 2);
  assert.equal(s1.in_transit, 1);
  assert.equal(s1.open, 1);
  assert.equal(s1.critical, 1); // 2 小时内到期
  assert.ok(!JSON.stringify(summary).includes("P-001"));
  assert.ok(!JSON.stringify(summary).includes("MED-A100"));
});

test("临期升级幂等：重复运行不重复升级、不产生重复事件", () => {
  const { service, store } = makeService();
  const seeded = seedInTransit(service, {
    registration: { latest_supply_at: iso(Date.now() + 2 * HOUR) },
  });
  const runAt = iso(Date.now());
  const r1 = service.escalateDue({ at: runAt });
  assert.deepEqual(r1.escalations.map((e) => e.level), ["critical"]);
  const r2 = service.escalateDue({ at: runAt });
  assert.equal(r2.escalations.length, 0);
  const escalated = store.db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE type='escalated'`)
    .get().n;
  assert.equal(escalated, 1);
  assert.equal(store.getVersion(seeded.open.id).escalation_level, "critical");
});

test("服务恢复后 pendingTasks 追平临期升级并列出待签收/待认领/已交接任务", () => {
  const { service } = makeService();
  const seeded = seedInTransit(service, {
    registration: { latest_supply_at: iso(Date.now() + 2 * HOUR) },
  });
  // 一条转移到达 S2 的 open 需求。
  const reg2 = service.register(
    registrationInput({ latest_supply_at: iso(Date.now() + 48 * HOUR) }),
    actors.self2,
  );
  const v2 = service.reviewAndCreateRequest(reg2.id, actors.clinicianA);
  service.transfer(v2.id, actors.coordinatorS1, { to_site_code: "S2" });

  const tasks = service.pendingTasks(actors.coordinatorS2, { at: iso(Date.now()) });
  // 升级是全局恢复动作：S2 恢复时也会把 S1 的临期需求追平。
  assert.equal(tasks.escalations.length, 1);
  assert.equal(tasks.escalations[0].level, "critical");
  // S2 只持有转入的 open 需求；在途那条仍由 S1 持有。
  const kinds = tasks.tasks.map((t) => t.kind);
  assert.deepEqual(kinds, ["pending_transfer"]);
  // S1 协调员看到的：在途待签收（临期已被 S2 的恢复调用追平为 critical）。
  const s1 = service.pendingTasks(actors.coordinatorS1, { at: iso(Date.now()) });
  const delivery = s1.tasks.find((t) => t.kind === "pending_delivery");
  assert.equal(delivery.request_id, seeded.open.id);
  assert.equal(delivery.escalation_level, "critical");
});

test("审计员必须提供授权标识，重建访问者、流向与最终交付依据", () => {
  const { service } = makeService();
  const seeded = seedInTransit(service);
  service.coordinatorList(actors.coordinatorS1);
  service.reportLogisticsEvent(seeded.open.id, "delivered", actors.coordinatorS1);

  expectError(() => service.auditRebuild(actors.auditor, {}), "forbidden");

  const report = service.auditRebuild(actors.auditor, { authorization_id: "AUTH-2026-001" });
  const entry = report.registrations.find((r) => r.registration.id === seeded.reg.id);
  // 最终交付与当时依据。
  assert.equal(entry.final_delivery.request_id, seeded.open.id);
  assert.equal(entry.final_delivery.basis.snapshot_hash, seeded.claim.snapshot.snapshot_hash);
  assert.ok(entry.final_delivery.frozen_snapshot.allergies.includes("青霉素"));
  // 流向按时间排列。
  const flowTypes = entry.versions[0].flow.map((f) => f.type);
  assert.deepEqual(flowTypes, ["accepted", "dispatched", "in_transit", "delivered"]);
  // 访问者重建包含协调员视图访问与本次审计访问。
  const kinds = report.access_log.map((a) => a.kind);
  assert.ok(kinds.includes("coordinator_view"));
  assert.ok(kinds.includes("audit_rebuild"));
  assert.equal(report.authorization_id, "AUTH-2026-001");
});

test("非审计员不能重建审计轨迹", () => {
  const { service } = makeService();
  seedInTransit(service);
  expectError(
    () => service.auditRebuild(actors.commander, { authorization_id: "x" }),
    "forbidden",
  );
});
