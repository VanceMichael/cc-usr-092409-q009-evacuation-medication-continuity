import assert from "node:assert/strict";
import { test } from "node:test";
import { actors, expectError, makeService, registrationInput } from "./helpers.js";

test("本人或授权医护可以登记，验证来源按身份分级", () => {
  const { service, store } = makeService();
  const reg = service.register(registrationInput(), actors.self1);
  assert.equal(reg.verification_source, "self_report");
  assert.equal(reg.registered_by, "self-1");

  const reg2 = service.register(
    registrationInput({
      person_ref: "P-003",
      site_code: "S2",
      latest_supply_at: new Date(Date.now() + 10e8).toISOString(),
    }),
    actors.clinicianA,
  );
  assert.equal(reg2.verification_source, "authorized_clinician");

  const events = store.listEventsByRegistration(reg.id);
  assert.equal(events[0].type, "registered");
});

test("无关角色不能登记", async () => {
  const { service } = makeService();
  await expectError(
    () => service.register(registrationInput(), actors.coordinatorS1),
    "forbidden",
  );
});

test("本人只能登记自己的用药", async () => {
  const { service } = makeService();
  await expectError(
    () =>
      service.register(
        registrationInput({ person_ref: "P-999" }),
        actors.self1,
      ),
    "forbidden",
  );
});

test("登记校验：剂量、截止时间、过敏数组", async () => {
  const { service } = makeService();
  await expectError(
    () => service.register(registrationInput({ remaining_doses: 0 }), actors.self1),
    "validation_error",
  );
  await expectError(
    () => service.register(registrationInput({ latest_supply_at: "不是时间" }), actors.self1),
    "validation_error",
  );
  await expectError(
    () => service.register(registrationInput({ allergies: ["x", 3] }), actors.self1),
    "validation_error",
  );
});

test("敏感字段与物流字段在同一条登记上分级保存", () => {
  const { store, service } = makeService();
  const reg = service.register(registrationInput({ person_ref: "P-001" }), actors.clinicianA);
  const row = store.getRegistration(reg.id);
  assert.equal(row.needs_refrigeration, 1);
  assert.equal(row.needs_delivery, 1);
  assert.ok(row.allergies.includes("青霉素"));
  assert.ok(row.medication_code);
});
