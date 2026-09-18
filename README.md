# 企业出海合规清单

制造企业首次在多国设立销售实体时，税号、数据跨境备案、当地许可由不同角色分别跟进，缺一项开业后即可能被罚。本服务把**国家、业务活动、所需材料、责任角色、生效前置关系**建模为版本化规则，支持从合同系统、银行、外部顾问导入证据，自动计算每个实体的**当前可签约状态**，并为材料过期、规则变更、豁免、重复导入产出可追溯差异。未满足前置条件的开业审查**不能**被标记完成。

## 领域模型

| 概念 | 说明 |
|---|---|
| Country / Role | 国家与责任角色（税务/法务/数据合规/业务…），材料归属唯一责任角色 |
| Rulebook（规则手册） | **不可变版本快照**，含活动与材料、责任角色、材料间前置依赖（支持跨活动，拒绝成环） |
| Entity（实体） | 企业在某国设立的销售实体，带 `timeZone`；可登记多个业务活动 |
| Enrollment（登记） | 实体参与某活动时**绑定当时生效的规则版本**，评估口径冻结，迁移版本留痕 |
| Evidence（证据） | 材料的合规证明，来源 `contract` / `bank` / `advisor` / `manual`，带签发/到期日与内容指纹 |
| Exemption（豁免） | 可授予、可撤销、可设到期；撤销/到期后材料重新阻断 |
| Review（开业审查） | 法务逐条核对阻断理由、跨时区并行操作；**放行由服务端重算决定**，不满足返回 422 |
| Task（人工核查任务） | 未满足材料自动开任务给责任角色，满足后自动关闭；同步幂等 |
| Notification | 规则变更**只通知受影响实体**（按上一版差异 + 实体去重）；过期按证据去重 |
| Audit | 哈希链式追加日志（`GENESIS` 起），全部 UTC 记录，跨时区操作可在同一时间线核对 |

## 材料状态机（可签约引擎）

```
missing ──有效证据──▶ satisfied
   │                    │
   │                 证据过期
   │                    ▼
   │                 expired
   │
   └──── 有效豁免 ──▶ exempted
        撤销/到期 ──▶ 重新判定

任何状态下，前置材料未满足 => blocked（即使本材料证据齐全也不能完成）
```

可签约判定是材料依赖图上的递归判定：本材料要满足，先看前置是否全部满足；活动可签约 = 所有材料满足；实体可签约 = 所有活动满足。

## 运行

```bash
npm start                 # 默认 STATE_FILE=data/state.json, PORT=3000
STATE_FILE=/tmp/x.json npm start
npm test                  # 10 个测试：建模校验/完整剧本/版本通知/过期/持久化续跑/HTTP
```

持久化采用单文件 JSON，写时先写临时文件再原子 rename，变更后立即落盘——**程序再次运行后从同一文件接续**：开放审查、未结任务、阻断评估、版本绑定与审计哈希链均保留。

## HTTP 摘要

身份与时区由请求头带入：`x-actor`（操作者，如 `legal-berlin`）、`x-timezone`。

- `POST /admin/{countries,roles}`、`GET /countries`、`GET /roles`
- `POST /entities` · `POST /entities/:id/enrollments` · `GET /entities/:id/status`
- `POST /entities/:id/evidence/imports` — 多来源批量导入，返回 `{added, duplicated, superseded, rejected}`
- `GET /entities/:id/{evidence,imports}` — 证据与历次导入差异
- `POST /entities/:id/exemptions` · `POST /entities/:id/exemptions/:exId/revoke`
- `POST /entities/:id/tasks/sync` · `GET /entities/:id/tasks`
- `POST /entities/:id/reviews` · `POST /reviews/:rid/blocker-checks` · `POST /reviews/:id/complete`（不满足前置时 422）
- `POST /rulebooks`（发布即保留版本并给受影响实体发通知）· `GET /rulebooks` · `GET /rulebooks/:version`
- `GET /notifications` · `POST /notifications/:nid/delivered`
- `GET /entities/:id/audit` · `GET /audit/verify` · `POST /system/reevaluate`

## 关键不变量

1. **前置硬阻断**：依赖未满足的材料即使证据齐全也是 `blocked`，审查完成被服务端拒绝（422 `PRECONDITIONS_UNMET`）。
2. **版本保留 + 绑定评估**：每次发布新增不可变版本；已登记实体按绑定版本评估，人工核查后才可迁移，全部历史版本可查。
3. **通知最小化**：相对上一版无材料结构增量的发布不通知任何实体；同一实体同一版本只一条；过期按证据去重。
4. **导入差异可追溯**：内容指纹去重（`duplicated`），新指纹使旧证据置 `superseded`（保留前后单据号与证据 ID），异常项进 `rejected` 并注明理由，被拒数据不影响判定。
5. **接续人工核查**：任务同步幂等（同材料不重复开任务），理由随状态更新；`POST /system/reevaluate` 可在重启后批量重算并补过期通知。
6. **审计防篡改**：每条审计含 `prevHash` 与自身哈希，`GET /audit/verify` 可发现任何改动；时间一律 UTC，跨时区法务（柏林补许可、新加坡撤豁免、同步更新税务材料）落在同一条可排序时间线上。

## 目录

```
src/domain/  领域内核（无框架依赖）
  errors.mjs    错误码与 HTTP 状态映射
  util.mjs      时钟、ID、指纹、规范化 JSON
  store.mjs     JSON 文档存储（原子写、:memory: 测试库）
  audit.mjs     哈希链审计与时间线
  rules.mjs     国家/角色/规则手册版本、前置图校验、结构差异
  entities.mjs  实体、活动登记与版本绑定、受影响登记计算
  evidence.mjs  证据导入去重/替换、豁免授予/撤销
  status.mjs    可签约状态引擎、阻断理由、人工任务同步
  reviews.mjs   开业审查与强制放行校验
  notify.mjs    规则变更/过期通知（去重）
  service.mjs   应用服务（组合 + 每次变更后落盘）
src/http/    Web 标准 Request/Response 路由
src/server.mjs
test/       10 个 node:test 用例
```
