import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/server.js";
import { createStore, openDatabase } from "../src/store.js";

function app() {
  const store = createStore(openDatabase(":memory:"));
  return createApp({ store });
}

const headers = (actor, extra = {}) => ({
  "x-actor-id": actor.id,
  "x-actor-role": actor.role,
  ...(actor.site_code ? { "x-site-code": actor.site_code } : {}),
  ...(actor.person_ref ? { "x-person-ref": actor.person_ref } : {}),
  ...extra,
});

const self1 = { id: "self-1", role: "self", person_ref: "P-001" };
const clinician = { id: "clinician-a", role: "clinician", site_code: "S1" };
const coordinator = { id: "coord-1", role: "coordinator", site_code: "S1" };
const pharmacy = { id: "pharm-1", role: "pharmacy", site_code: "S1" };
const commander = { id: "cmd-1", role: "commander" };
const auditor = { id: "aud-1", role: "auditor" };

const registrationBody = () => ({
  medication_code: "MED-A100",
  medication_label: "示例降压药 10mg",
  remaining_doses: 6,
  dose_unit: "片",
  allergies: ["青霉素"],
  needs_refrigeration: true,
  needs_delivery: true,
  latest_supply_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
  site_code: "S1",
});

test("HTTP：无身份头 401", async () => {
  const res = await request(app()).get("/v1/sites/me/requests");
  assert.equal(res.status, 401);
});

test("HTTP：完整续供链路与分级视图", async () => {
  const application = app();

  const regRes = await request(application)
    .post("/v1/registrations")
    .set(headers(self1))
    .send(registrationBody());
  assert.equal(regRes.status, 200);
  const regId = regRes.body.id;

  const reviewRes = await request(application)
    .post(`/v1/registrations/${regId}/review`)
    .set(headers(clinician))
    .send({});
  assert.equal(reviewRes.status, 200);
  const reqId = reviewRes.body.id;

  const claimRes = await request(application)
    .post(`/v1/requests/${reqId}/claim`)
    .set(headers(pharmacy))
    .send({ device_id: "scanner-1", scan_serial: "001" });
  assert.equal(claimRes.status, 200);
  assert.equal(claimRes.body.version.state, "accepted");
  assert.ok(claimRes.body.snapshot.snapshot_hash);

  for (const step of ["dispatched", "in-transit"]) {
    const res = await request(application)
      .post(`/v1/requests/${reqId}/events/${step}`)
      .set(headers(pharmacy))
      .send({ device_id: "scanner-1", scan_serial: step });
    assert.equal(res.status, 200, step);
  }

  const deliveryRes = await request(application)
    .post(`/v1/requests/${reqId}/events/delivered`)
    .set(headers(coordinator))
    .send({ device_id: "scanner-1", scan_serial: "deliv" });
  assert.equal(deliveryRes.status, 200);
  assert.equal(deliveryRes.body.version.state, "delivered");

  // 协调员视图不含敏感字段。
  const coordRes = await request(application)
    .get("/v1/sites/me/requests")
    .set(headers(coordinator));
  assert.equal(coordRes.status, 200);
  // 已交付的版本不出现在待处理列表。
  assert.deepEqual(coordRes.body.requests, []);

  // 指挥席匿名汇总（已交付不计缺口）。
  const gaps = await request(application).get("/v1/command/gaps").set(headers(commander));
  assert.equal(gaps.status, 200);
  assert.deepEqual(gaps.body.sites, []);
  assert.ok(!JSON.stringify(gaps.body).includes("P-001"));

  // 审计重建需要授权头。
  const noAuth = await request(application).post("/v1/audit/rebuild").set(headers(auditor)).send({});
  assert.equal(noAuth.status, 403);
  const audit = await request(application)
    .post("/v1/audit/rebuild")
    .set(headers(auditor, { "x-authorization-id": "AUTH-1" }))
    .send({});
  assert.equal(audit.status, 200);
  assert.equal(audit.body.registrations[0].final_delivery.request_id, reqId);
});

test("HTTP：并发认领只有一个 200，另一个 409", async () => {
  const application = app();
  const reg = await request(application).post("/v1/registrations").set(headers(self1)).send(registrationBody());
  const review = await request(application)
    .post(`/v1/registrations/${reg.body.id}/review`)
    .set(headers(clinician))
    .send({});
  const reqId = review.body.id;
  const team = { id: "team-1", role: "medical_team", site_code: "S1" };
  const [a, b] = await Promise.all([
    request(application).post(`/v1/requests/${reqId}/claim`).set(headers(pharmacy)).send({}),
    request(application).post(`/v1/requests/${reqId}/claim`).set(headers(team)).send({}),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
});
