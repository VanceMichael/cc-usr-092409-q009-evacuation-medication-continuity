import assert from "node:assert/strict";
import { test } from "node:test";
import { actors, expectError, HOUR, makeService, registrationInput, seedInTransit } from "./helpers.js";

test("人员转移把在途需求交给新安置点，负责方保持唯一", () => {
  const { service, store } = makeService();
  const seeded = seedInTransit(service);

  const result = service.transfer(seeded.open.id, actors.coordinatorS1, { to_site_code: "S2" });
  assert.equal(result.version.current_site_code, "S2");
  assert.equal(result.version.responsible_party, "pharm-1"); // 原负责方继续负责
  assert.equal(result.version.state, "in_transit");

  const event = store.latestEventOfType(seeded.open.id, "transferred");
  assert.equal(event.payload.from_site_code, "S1");
  assert.equal(event.payload.to_site_code, "S2");

  // 并发/重放的第二次交接：版本已离开 S1，原站点协调员不再持有，交接落败。
  expectError(
    () => service.transfer(seeded.open.id, actors.coordinatorS1, { to_site_code: "S3" }),
    "forbidden", // coord-1 不再持有该需求
  );
  // 新站点二次交接给同样在 S2 的请求也被拒（同站）。
  expectError(
    () => service.transfer(seeded.open.id, actors.coordinatorS2, { to_site_code: "S2" }),
    "validation_error",
  );
});

test("外站点协调员不能交接不属于本站点的需求", () => {
  const { service } = makeService();
  const seeded = seedInTransit(service);
  expectError(
    () => service.transfer(seeded.open.id, actors.coordinatorS2, { to_site_code: "S2" }),
    "forbidden",
  );
});

test("已交付版本转移被拒", () => {
  const { service } = makeService();
  const seeded = seedInTransit(service);
  service.reportLogisticsEvent(seeded.open.id, "delivered", actors.coordinatorS1);
  expectError(
    () => service.transfer(seeded.open.id, actors.coordinatorS1, { to_site_code: "S2" }),
    "not_transferable",
  );
});

test("阻断未交付在途药物，已完成交付保留当时依据", () => {
  const { service, store } = makeService();
  const seeded = seedInTransit(service);
  const delivery = service.reportLogisticsEvent(seeded.open.id, "delivered", actors.coordinatorS1);
  const basisHash = delivery.event.payload.basis.snapshot_hash;

  // 交付后才上报过敏：delivered 版本保持不动。
  const result = service.block(seeded.reg.id, actors.clinicianA, { reason: "allergy" });
  assert.deepEqual(result.blocked_versions, []);
  const delivered = store.getVersion(seeded.open.id);
  assert.equal(delivered.state, "delivered");
  const events = store
    .listEventsByRegistration(seeded.reg.id)
    .filter((e) => e.type === "delivered");
  assert.equal(events[0].payload.basis.snapshot_hash, basisHash);
  assert.ok(delivered.frozen_snapshot);
});

test("授权撤回立即阻断在途版本", () => {
  const { service } = makeService();
  const seeded = seedInTransit(service);
  const result = service.block(seeded.reg.id, actors.self1, { reason: "authorization_withdrawn" });
  assert.equal(result.registration.auth_withdrawn, 1);
  assert.equal(result.blocked_versions[0].state, "blocked");
  // 阻断后不能再报在途/签收。
  expectError(
    () => service.reportLogisticsEvent(seeded.open.id, "delivered", actors.coordinatorS2),
    "registration_blocked",
  );
});

test("本人不能撤回他人授权", () => {
  const { service } = makeService();
  const seeded = seedInTransit(service);
  expectError(
    () => service.block(seeded.reg.id, actors.self2, { reason: "authorization_withdrawn" }),
    "forbidden",
  );
});

test("医护解除阻断后可重新复核生成新版本，blocked 版本保留为终态", () => {
  const { service, store } = makeService();
  const seeded = seedInTransit(service);
  service.block(seeded.reg.id, actors.clinicianA, { reason: "allergy", note: "疑似过敏待核" });
  assert.equal(store.getVersion(seeded.open.id).state, "blocked");

  // 阻断期间不能重新复核。
  expectError(
    () => service.reviewAndCreateRequest(seeded.reg.id, actors.clinicianA),
    "registration_blocked",
  );
  // 非医护不能解除。
  expectError(() => service.unblock(seeded.reg.id, actors.coordinatorS1), "forbidden");

  const { registration } = service.unblock(seeded.reg.id, actors.clinicianA, {
    note: "核实为药物相互作用而非过敏",
  });
  assert.equal(registration.blocked_allergy, 0);

  const v2 = service.reviewAndCreateRequest(seeded.reg.id, actors.clinicianA);
  assert.equal(v2.version_no, 2);
  assert.equal(v2.state, "open");
  // 历史版本仍为 blocked，可审计。
  assert.equal(store.getVersion(seeded.open.id).state, "blocked");
  const types = store.listEventsByRegistration(seeded.reg.id).map((e) => e.type);
  assert.ok(types.includes("unblocked"));
});
