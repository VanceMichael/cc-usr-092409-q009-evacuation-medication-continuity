# 撤离清点服务

服务接收撤离批次、人员名单和集合点到达事件，并在其后提供**随身药物续供连续性**流程：登记临期药品、医护复核生成一次性续供需求、药房/医疗队认领冻结、流向追踪、人员转移交接、离线扫描去重、临期升级与授权审计。

`src/contracts.js` 提供分类常量（角色、敏感分级、需求状态、事件、扫描处置、升级阈值）；`src/db.js` 建立分级存储的 SQLite 结构；`src/service.js` 是事务化领域服务；`src/server.js` 是 Express 入口。SQLite 文件默认保存在 `.data/evacuation.db`。

## 敏感内容分级

| 层级 | 内容 | 可见角色 |
| --- | --- | --- |
| L0 身份 | 人员标识、匿名码、医护/审计授权关系 | 本人、授权对象 |
| L1 运营 | 是否冷藏、是否配送、最晚补给时刻、包裹码、状态 | 现场协调员、药房 |
| L2 临床 | 药品标识、剩余剂量、过敏禁忌、验证来源、诊断/处方依据 | 本人、授权医护、负责药房 |
| L3 审计 | 访问日志、药物流向、最终交付依据 | 仅获授权审计员 |

协调员看板（`GET /sites/:siteId/board`）与指挥席缺口（`GET /command/gaps`）只输出 L1 或匿名聚合，任何响应中不含人员标识、药品名、剂量、过敏。所有 L2/L3 读取写 `access_log`。

## 关键流程与不变量

- **登记**：本人或授权医护提交药品标识、剩余剂量、最晚补给时刻、过敏禁忌与验证来源；运营字段与临床字段分表保存。
- **复核与一次性需求**：医护复核后生成 `pending` 版本；**同一登记任一时刻最多一个活跃版本**（数据库部分唯一索引保证）。
- **认领冻结**：药房/医疗队认领（接受）时以条件更新 CAS 竞争，并发只有一个成功；成功瞬间冻结药品快照与依据（`med_snapshot`/`basis_snapshot`/`frozen_at`），之后任何流程不再改写。
- **流向只追加**：发出 → 在途 → 签收，以及拒收、损坏，均追加不可变事件，状态迁移受白名单约束。
- **拒收/损坏**：版本关闭，医护可 `reissue` 生成版本号 +1 的新需求；迟到扫描落到旧包裹返回 `stale`，不能越过已关闭或已重新发出的版本。
- **离线扫描**：`POST /scans` 按 `(device_id, scan_seq)` 唯一去重，重复上报幂等返回首次处置；处置结果为 `accepted/duplicate/stale/unknown/rejected`。
- **即时阻断**：医护登记过敏禁忌或本人撤回授权时，所有未交付活跃版本立即转 `blocked` 并追加阻断事件；**已完成交付的版本保持终态，当时冻结依据原样保留**。
- **人员转移**：发起转移登记交接单，到达确认原子地把旧点活跃版本转 `transferred` 并在新点生成待认领版本；途中已签收/阻断的交接单作废；确认可幂等续跑。任一时刻同一需求只有一个负责方。
- **服务恢复**：进程启动与 `POST /internal/sweep`（指挥席）执行巡检——临期单调升级（24h 关注 / 6h 紧急 / 过期 critical，追加升级事件）、补完崩溃在中途的转移交接、列出待签收任务。
- **审计重建**：本人向审计员授权后，`GET /persons/:id/audit-trail` 可重建访问者链、每个版本的流向事件与最终交付时的冻结依据。

## 身份头

网关完成现场身份核验后注入：`x-actor-id`（操作者标识）与 `x-actor-role`（`self`/`clinician`/`coordinator`/`dispenser`/`command`/`auditor`）。缺头返回 401。

## 主要端点

```
POST   /sites                                  协调员建点
POST   /persons                                建人员（body: siteId, personId?）
POST   /persons/:id/consents/clinicians        本人授权医护
DELETE /persons/:id/consents/clinicians/:cid   本人解除医护授权
POST   /persons/:id/consent/withdraw           本人撤回服务授权（阻断未交付药物）
POST   /persons/:id/medications                本人/授权医护登记（L1+L2 分存）
GET    /persons/:id/medications                本人/授权医护查看登记与版本
POST   /medications/:rid/allergy-block         授权医护登记过敏禁忌
POST   /medications/:rid/review                医护复核 → 一次性需求 v1
POST   /medications/:rid/reissue               拒收/损坏后医护重新发出下一版
POST   /requests/:id/claim                     药房/医疗队认领并冻结
POST   /requests/:id/events                    type=dispatched|in_transit|delivered|rejected|damaged
GET    /requests/:id                           有权限方查看（含冻结快照与事件链）
POST   /scans                                  离线扫描上报（设备流水去重）
POST   /persons/:id/movements                  发起转移（body: toSiteId）
POST   /movements/:id/arrive                   到达确认（交接，幂等）
POST   /movements/:id/arrive-offline           离线补录到达并立即续跑巡检
GET    /sites/:id/board                        协调员 L1 看板
GET    /command/gaps                           指挥席匿名缺口汇总
POST   /persons/:id/audit-grants               本人授权审计员
GET    /persons/:id/audit-trail                授权审计员重建全链路
POST   /internal/sweep                         指挥席触发恢复巡检
```

## 运行

```bash
npm test                # node:test + supertest，端到端用例（分级可见性、并发认领、
                        # 版本冻结、扫描去重、阻断、转移交接、恢复升级、审计重建等）
npm run build           # 全部源文件语法检查
npm start               # 监听 $PORT（默认 8080），DB_FILE 默认 .data/evacuation.db
```

Docker：`docker build -t evacuation-muster .` 后 `docker run --rm -p 8080:8080 evacuation-muster`。进程状态由 `GET /health` 获取。
