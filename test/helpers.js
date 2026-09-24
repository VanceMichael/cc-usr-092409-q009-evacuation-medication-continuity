// 测试辅助：内存数据库 + 固定身份。
import { createMedicationService } from "../src/medication.js";
import { createStore, openDatabase } from "../src/store.js";

export function makeService() {
  const store = createStore(openDatabase(":memory:"));
  const service = createMedicationService(store);
  return { store, service };
}

export const HOUR = 60 * 60 * 1000;

export const actors = {
  self1: { id: "self-1", role: "self", person_ref: "P-001" },
  self2: { id: "self-2", role: "self", person_ref: "P-002" },
  clinicianA: { id: "clinician-a", role: "clinician", site_code: "S1" },
  coordinatorS1: { id: "coord-1", role: "coordinator", site_code: "S1" },
  coordinatorS2: { id: "coord-2", role: "coordinator", site_code: "S2" },
  pharmacy1: { id: "pharm-1", role: "pharmacy", site_code: "S1" },
  pharmacy2: { id: "pharm-2", role: "pharmacy", site_code: "S2" },
  team1: { id: "team-1", role: "medical_team", site_code: "S1" },
  commander: { id: "cmd-1", role: "commander" },
  auditor: { id: "aud-1", role: "auditor" },
};

export function registrationInput(overrides = {}) {
  return {
    medication_code: "MED-A100",
    medication_label: "示例降压药 10mg",
    remaining_doses: 6,
    dose_unit: "片",
    allergies: ["青霉素"],
    contraindications: ["严重肾功能不全"],
    needs_refrigeration: true,
    needs_delivery: true,
    latest_supply_at: new Date(Date.now() + 48 * HOUR).toISOString(),
    site_code: "S1",
    ...overrides,
  };
}

// 登记 → 医护复核 → 药房认领 → 发出 → 在途，返回各阶段 id。
export function seedInTransit(service, overrides = {}) {
  const reg = service.register(registrationInput(overrides.registration ?? {}), actors.self1);
  const open = service.reviewAndCreateRequest(reg.id, actors.clinicianA);
  const claim = service.claim(open.id, actors.pharmacy1);
  service.reportLogisticsEvent(open.id, "dispatched", actors.pharmacy1);
  const inTransit = service.reportLogisticsEvent(open.id, "in_transit", actors.pharmacy1);
  return { reg, open, claim, inTransit };
}

export const expectError = async (fn, code) => {
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  }
  if (!error) throw new Error(`预期抛出 ${code ?? "错误"}，但调用成功`);
  if (code && error.code !== code) {
    throw new Error(`预期错误码 ${code}，实际 ${error.code}：${error.message}`);
  }
  return error;
};
