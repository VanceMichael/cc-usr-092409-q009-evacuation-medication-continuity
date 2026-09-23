import assert from "node:assert/strict";
import { test } from "node:test";
import request from "supertest";
import { createApp } from "../src/server.js";

test("健康检查返回清点服务标识", async () => {
  const response = await request(createApp()).get("/health");
  assert.equal(response.status, 200);
  assert.equal(response.body.service, "evacuation-muster");
});
