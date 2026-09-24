import assert from "node:assert/strict";
import { test } from "node:test";
import { actors, expectError, makeService, registrationInput } from "./helpers.js";

test("离线扫描按设备+流水号去重：重放回放首次裁决，不产生第二个事件", () => {
  const { service, store } = makeService();
  const reg = service.register(registrationInput(), actors.self1);
  const v1 = service.reviewAndCreateRequest(reg.id, actors.clinicianA);

  const device = { device_id: "scanner-7", scan_serial: "S-0001" };

  const first = service.claim(v1.id, actors.pharmacy1, device);
  assert.equal(first.deduplicated, false);
  assert.equal(first.event.event_id, first.event.event_id);

  // 同一设备流水再次上传（甚至来自不同 actor）：回放，不新建事件。
  const replay = service.claim(v1.id, actors.pharmacy1, device);
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.status, "applied");
  assert.equal(replay.event.event_id, first.event.event_id);

  const acceptedEvents = store.db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE type='accepted'`)
    .get().n;
  assert.equal(acceptedEvents, 1);
});

test("迟到签收被裁决为 rejected_late 并重放同一裁决", () => {
  const { service } = makeService();
  const reg = service.register(registrationInput(), actors.self1);
  const v1 = service.reviewAndCreateRequest(reg.id, actors.clinicianA);
  service.claim(v1.id, actors.pharmacy1);
  service.reportLogisticsEvent(v1.id, "dispatched", actors.pharmacy1);
  service.reportLogisticsEvent(v1.id, "in_transit", actors.pharmacy1);
  // 医护关闭版本（现场已不需要）。
  service.close(v1.id, actors.clinicianA, { reason: "已由医疗队直接给药" });

  const device = { device_id: "scanner-9", scan_serial: "LATE-42" };
  // 离线设备迟到上传签收：拒绝且裁决落库。
  expectError(
    () =>
      service.reportLogisticsEvent(v1.id, "delivered", actors.coordinatorS1, {
        ...device,
        at: new Date().toISOString(),
      }),
    "event_too_late",
  );

  // 重放同一流水：不再抛业务错误，直接回放 rejected_late。
  const replay = service.reportLogisticsEvent(
    v1.id,
    "delivered",
    actors.coordinatorS1,
    device,
  );
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.status, "rejected_late");
  assert.equal(replay.event, null);
});

test("并发认领落败方的扫描流水记录 rejected_conflict", () => {
  const { service, store } = makeService();
  const reg = service.register(registrationInput(), actors.self1);
  const v1 = service.reviewAndCreateRequest(reg.id, actors.clinicianA);

  service.claim(v1.id, actors.pharmacy1, {
    device_id: "scanner-1",
    scan_serial: "A-1",
  });

  // 另一设备几乎同时扫到同一需求：落败。
  expectError(
    () => service.claim(v1.id, actors.team1, { device_id: "scanner-2", scan_serial: "B-1" }),
    "claim_lost",
  );
  const row = store.db
    .prepare(`SELECT * FROM scan_dedup WHERE device_id='scanner-2' AND scan_serial='B-1'`)
    .get();
  assert.equal(row.status, "rejected_conflict");

  // 落败方重放自己的流水：永远是冲突裁决，不会翻案。
  const replay = service.claim(v1.id, actors.team1, {
    device_id: "scanner-2",
    scan_serial: "B-1",
  });
  assert.equal(replay.deduplicated, true);
  assert.equal(replay.status, "rejected_conflict");
});
