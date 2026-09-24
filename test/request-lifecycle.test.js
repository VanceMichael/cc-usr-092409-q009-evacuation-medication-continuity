import assert from "node:assert/strict";
import { test } from "node:test";
import { actors, expectError, makeService, registrationInput, seedInTransit } from "./helpers.js";

test("医护复核生成一次性需求，重复复核被拒", () => {
  const { service, store } = makeService();
  const reg = service.register(registrationInput(), actors.self1);
  const v1 = service.reviewAndCreateRequest(reg.id, actors.clinicianA);
  assert.equal(v1.version_no, 1);
  assert.equal(v1.state, "open");
  assert.equal(v1.responsible_party, null);

  expectError(
    () => service.reviewAndCreateRequest(reg.id, actors.clinicianA),
    "active_request_exists",
  );

  const versions = store.listVersionsByRegistration(reg.id);
  assert.equal(versions.length, 1);
});

test("非医护不能复核", () => {
  const { service } = makeService();
  const reg = service.register(registrationInput(), actors.self1);
  expectError(() => service.reviewAndCreateRequest(reg.id, actors.coordinatorS1), "forbidden");
});

test("药房认领时冻结所见版本；第二个认领方并发落败", () => {
  const { service, store } = makeService();
  const reg = service.register(registrationInput(), actors.self1);
  const v1 = service.reviewAndCreateRequest(reg.id, actors.clinicianA);

  const result = service.claim(v1.id, actors.pharmacy1);
  assert.equal(result.version.state, "accepted");
  assert.equal(result.version.responsible_party, "pharm-1");
  assert.ok(result.snapshot.snapshot_hash.startsWith("sha256:"));
  assert.equal(result.snapshot.medication_code, "MED-A100");
  assert.ok(result.snapshot.allergies.includes("青霉素"));
  assert.equal(result.version.frozen_at, result.snapshot.frozen_at);

  // 并发认领：条件 UPDATE 只能一个成功。
  expectError(() => service.claim(v1.id, actors.team1), "claim_lost");
  expectError(() => service.claim(v1.id, actors.pharmacy1), "claim_lost");

  // 冻结快照内容不可变：直接读库比对哈希一致。
  const stored = store.getVersion(v1.id);
  assert.equal(stored.frozen_snapshot.snapshot_hash, result.snapshot.snapshot_hash);
});

test("转移后原安置点药房不能认领，新安置点药房可以", () => {
  const { service } = makeService();
  const reg = service.register(registrationInput(), actors.self1);
  const v1 = service.reviewAndCreateRequest(reg.id, actors.clinicianA);
  service.transfer(v1.id, actors.coordinatorS1, { to_site_code: "S2" });
  expectError(() => service.claim(v1.id, actors.pharmacy1), "forbidden");
  const claimed = service.claim(v1.id, actors.pharmacy2);
  assert.equal(claimed.version.current_site_code, "S2");
  assert.equal(claimed.version.responsible_party, "pharm-2");
});

test("发出→在途→签收全程只追加事件，签收固定当时依据", () => {
  const { service, store } = makeService();
  const seeded = seedInTransit(service);
  const { reg, open, claim } = seeded;

  const delivery = service.reportLogisticsEvent(open.id, "delivered", actors.coordinatorS1);
  assert.equal(delivery.version.state, "delivered");
  assert.equal(delivery.event.payload.basis.snapshot_hash, claim.snapshot.snapshot_hash);
  assert.equal(delivery.event.payload.delivered_to_person_ref, "P-001");

  const events = store.listEventsByRegistration(reg.id).map((e) => e.type);
  assert.deepEqual(events, [
    "registered",
    "reviewed",
    "request_created",
    "accepted",
    "dispatched",
    "in_transit",
    "delivered",
  ]);
});

test("事件表在 SQL 层禁止修改与删除", () => {
  const { service, store } = makeService();
  const seeded = seedInTransit(service);
  const delivery = service.reportLogisticsEvent(seeded.open.id, "delivered", actors.coordinatorS1);
  assert.throws(
    () => store.db.prepare(`UPDATE events SET type='x' WHERE event_id=?`).run(delivery.event.event_id),
    /append-only/,
  );
  assert.throws(
    () => store.db.prepare(`DELETE FROM events WHERE event_id=?`).run(delivery.event.event_id),
    /append-only/,
  );
});

test("不能跳过在途直接签收", () => {
  const { service } = makeService();
  const reg = service.register(registrationInput(), actors.self1);
  const v1 = service.reviewAndCreateRequest(reg.id, actors.clinicianA);
  service.claim(v1.id, actors.pharmacy1);
  expectError(
    () => service.reportLogisticsEvent(v1.id, "delivered", actors.pharmacy1),
    "illegal_transition",
  );
});

test("只有负责方能标记发出/在途", () => {
  const { service } = makeService();
  const reg = service.register(registrationInput(), actors.self1);
  const v1 = service.reviewAndCreateRequest(reg.id, actors.clinicianA);
  service.claim(v1.id, actors.pharmacy1);
  expectError(
    () => service.reportLogisticsEvent(v1.id, "dispatched", actors.team1),
    "forbidden",
  );
});

test("损坏后版本终结，医护重新发出 v2，迟到签收不能越过 v1", () => {
  const { service, store } = makeService();
  const seeded = seedInTransit(service);
  const damaged = service.reportLogisticsEvent(seeded.open.id, "damaged", actors.pharmacy1, {
    payload: { note: "运输中破碎" },
  });
  assert.equal(damaged.version.state, "damaged");

  // 迟到签收撞上损坏版本：拒绝。
  expectError(
    () => service.reportLogisticsEvent(seeded.open.id, "delivered", actors.coordinatorS1),
    "event_too_late",
  );

  // 只有医护能重新发出。
  expectError(() => service.reissue(seeded.open.id, actors.coordinatorS1), "forbidden");
  const v2 = service.reissue(seeded.open.id, actors.clinicianA);
  assert.equal(v2.version_no, 2);
  assert.equal(v2.state, "open");
  assert.equal(store.getVersion(seeded.open.id).state, "reissued");
  assert.equal(v2.supersedes_version_id, seeded.open.id);

  // 对 v1 的迟到签收仍被拒绝（已 reissued）。
  expectError(
    () => service.reportLogisticsEvent(seeded.open.id, "delivered", actors.coordinatorS1),
    "event_too_late",
  );
});

test("关闭后任何物流事件都不能回灌", () => {
  const { service } = makeService();
  const seeded = seedInTransit(service);
  service.close(seeded.open.id, actors.coordinatorS1, { reason: "人员已通过其他渠道获药" });
  expectError(
    () => service.reportLogisticsEvent(seeded.open.id, "delivered", actors.pharmacy1),
    "event_too_late",
  );
});

test("阻断后认领与流转立即停止", () => {
  const { service } = makeService();
  // 尚未认领：阻断导致 open 版本进入 blocked。
  const reg = service.register(registrationInput(), actors.self1);
  const v1 = service.reviewAndCreateRequest(reg.id, actors.clinicianA);
  const result = service.block(reg.id, actors.clinicianA, { reason: "allergy", note: "新增药物过敏" });
  assert.equal(result.blocked_versions.length, 1);
  assert.equal(result.blocked_versions[0].state, "blocked");
  expectError(() => service.claim(v1.id, actors.pharmacy1), "registration_blocked");
});
