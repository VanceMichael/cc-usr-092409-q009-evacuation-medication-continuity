# 撤离清点与随身药物续供服务

服务在撤离清点基线之上提供**最小化用药连续性流程**：撤离人员或授权医护登记随身药物，医护复核后生成一次性续供需求，药房/医疗队认领并发药，跨安置点转移时交接未完成需求；现场协调员只见物流所需信息，指挥席只见匿名缺口，审计员凭授权重建完整流向。

`src/contracts.js` 集中定义角色、状态机、事件与敏感分级；`src/store.js` 是 SQLite 存储与并发原语；`src/medication.js` 是领域服务；`src/server.js` 为 Express 入口。SQLite 文件默认保存在 `.data/`（可用 `DB_FILE` 覆盖）。

## 流程与不变式

1. **登记**（`POST /v1/registrations`）：本人或授权医护提交药品标识、剩余剂量、最晚补给时刻、过敏禁忌与验证来源。本人登记来源为 `self_report`，医护登记为 `authorized_clinician`。
2. **医护复核**（`POST /v1/registrations/:id/review`）：生成**一次性**续供需求（v1）。同一登记任一时刻至多一个未终结版本（部分唯一索引兜底），重复复核返回 `active_request_exists`。
3. **认领冻结**（`POST /v1/requests/:id/claim`）：药房或医疗队接受时冻结所见版本快照（含 SHA-256 哈希）。并发认领用条件 UPDATE 裁决，恰有一个成功，落败方得到 `409 claim_lost`。只有需求当前所在安置点的负责方可以认领。
4. **物流事件**（只追加）：`events/dispatched` 发出、`events/in-transit` 在途、`events/delivered` 签收、`events/rejected` 拒收、`events/damaged` 损坏。事件表由 SQL 触发器禁止 UPDATE/DELETE。状态必须沿 `STATE_TRANSITIONS` 迁移；**迟到事件不能越过已关闭或重新发出的版本**（`409 event_too_late`）。签收事件永久携带认领时的快照哈希与冻结时刻作为交付依据。
5. **拒收/损坏后重新发出**（`POST /v1/requests/:id/reissue`）：仅医护可操作，旧版本置 `reissued`，新版本号递增。
6. **人员转移**（`POST /v1/requests/:id/transfer`）：协调员或医护把未完成需求交给新安置点。条件 UPDATE（当前站点必须匹配）保证并发/重放的二次交接失败；任一时刻只有一个当前站点、一个负责方——在途需求的原负责方继续负责，仅目的地变更。
7. **过敏/授权撤回阻断**（`POST /v1/registrations/:id/block`）：本人或医护可立即阻断，所有未交付版本进入终态 `blocked`，认领与物流事件全部停止；**已交付版本及其依据原样保留**。医护核实后可 `POST /v1/registrations/:id/unblock`，再重新复核生成新版本。
8. **离线扫描**：所有写事件接口接受 `device_id` + `scan_serial`，按设备流水全局去重，重放只回放首次裁决（`applied` / `rejected_late` / `rejected_conflict`），不产生第二个事件。被拒裁决在独立事务落库，不随业务回滚丢失。
9. **服务恢复**：`GET /v1/tasks/pending` 先幂等追平临期升级（24h→urgent，6h→critical），再列出本站点待认领、转移待接、待签收任务；`POST /v1/system/escalations/run`（需医护身份或 `SCHEDULER_SECRET`）可单独触发。

## 角色与可见性

| 角色 | 可见范围 |
|---|---|
| `self` 本人 | 登记、撤回本人授权 |
| `clinician` 医护 | 受限医疗信息、复核、阻断/解除、重新发出、任务清单 |
| `coordinator` 协调员 | **仅**是否冷藏、是否需要配送、最晚补给时刻、状态与负责方类型（`GET /v1/sites/me/requests`）；可交接、确认本站点签收 |
| `pharmacy` / `medical_team` | 仅自己认领需求的药品/过敏详情 |
| `commander` 指挥席 | `GET /v1/command/gaps`：按站点的匿名缺口计数（状态、临期、逾期），不含任何人员或药品标识 |
| `auditor` 审计员 | `POST /v1/audit/rebuild`（必须携带授权标识）重建访问者、药物流向与最终交付依据 |

字段级分级定义见 `REGISTRATION_FIELD_TIERS`（`public` / `restricted` / `audit`）。每次受限访问、指挥汇总与审计重建都写入 `access_log`，是访问轨迹重建的唯一来源。

## 身份头

服务假定位于已完成强认证的网关之后，从请求头读取调用者：`X-Actor-Id`、`X-Actor-Role`（必填），`X-Site-Code`（安置点）、`X-Person-Ref`（本人标识）、`X-Authorization-Id`（审计授权）。

## 运行

```bash
npm ci
npm test          # node --test，40 项端到端/并发/权限测试
npm run build     # 语法检查
npm start         # 监听 PORT（默认 8080）
docker build -t evacuation-muster .
docker run --rm -p 8080:8080 evacuation-muster
```

进程状态由 `GET /health` 获取。
