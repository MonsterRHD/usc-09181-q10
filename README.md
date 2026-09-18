# 企业出海合规清单

制造企业首次在多国设立销售实体时的**开业前置检查**系统：把国家、业务活动、所需材料、
责任角色和材料间的前置依赖关系建模为版本化规则；支持从合同、银行和外部顾问导入证据，
实时计算每个实体的**当前可签约状态**；材料过期、规则变更、例外豁免与重复导入均产出
可追溯的差异与审计时间线。未满足前置条件时，开业审查无法标记完成。

## 核心概念

| 概念 | 说明 |
| --- | --- |
| 国家 Country / 业务活动 Activity | 规则挂载维度，如「德国 · 直销」 |
| 责任角色 Role | 每项材料的负责方（TAX 税务 / LEGAL 法务 / DATA 数据合规…） |
| 所需材料 Requirement | 税号、当地许可、数据跨境备案等，带 `prerequisites` 前置链与续期信息 |
| 规则版本 RuleVersion | 每次发布保留完整快照、版本间结构化差异与生效时间 `effectiveFrom` |
| 销售实体 Entity | 属于某国家、开展若干业务活动，证据/豁免/核查均挂在实体上 |
| 证据 Evidence | 来源限 `CONTRACT` / `BANK` / `ADVISOR`，带有效期与内容哈希 |
| 豁免 Exemption | 可授予、可到期、可撤销；撤销后该材料立即回到阻断 |
| 阻断理由 Blocker | 缺证据 / 证据过期 / 豁免过期 / 前置未满足 / 法务质询未消 |

## 设计要点

- **事件溯源 + JSONL 只追加日志**（`data/compliance.jsonl`，可用 `COMPLIANCE_LOG` 覆盖）：
  所有变更都是不可变事件，进程重启后重放即可接续人工核查，状态与关停前一致。
- **纯函数规则引擎**（`src/domain/rules.mjs`）：给定规则版本快照与证据/豁免/核查投影，
  逐层求解前置链并输出每项材料状态与阻断理由；支持指定历史时刻重算。
- **幂等与差异**：证据导入必须带 `idempotencyKey`；同键回放、同内容哈希去重，
  内容变化则旧证据被 `SUPERSEDED` 并附字段级差异；证据历史可完整回溯。
- **规则版本化与定向通知**：发布保留版本快照与 added/removed/changed 差异，
  仅给适用要求真正变化的实体生成 `RULE_CHANGE` 通知；未来生效版本不提前改变状态。
- **跨时区并发审查**：写命令经互斥锁串行提交，事件 seq 严格有序；开业审查带
  `expectedVersion` 乐观并发，期间实体被其他时区更新则返回 409 并附当前阻断理由。
- **硬性门禁**：`canSign=false` 时开业审查返回 422，不能标记完成。

## 运行

```bash
npm start          # 启动 HTTP 服务，默认端口 3000
npm test           # 运行测试（node --test）
```

## API 摘要

写操作可用请求头 `X-Actor` 标注操作人（跨时区审计用）。

| 方法 & 路径 | 作用 |
| --- | --- |
| `POST /admin/countries` `/activities` `/roles` | 登记国家、业务活动、责任角色 |
| `POST /entities` | 建立销售实体 |
| `POST /countries/:id/rules` | 发布规则新版本（`{specs, effectiveFrom?}`） |
| `GET /countries/:id/rules` | 规则版本历史 |
| `POST /entities/:id/evidence/imports` | 导入证据（合同/银行/顾问，含幂等键） |
| `GET /entities/:id/evidence/:code/history` | 证据链与字段差异 |
| `POST /entities/:id/exemptions` | 授予豁免（可带 `expiresAt`） |
| `POST /entities/:id/exemptions/:code/revocations` | 撤销豁免 |
| `POST /entities/:id/reviews` | 法务逐项核查（`CHALLENGE` / `CLEAR`） |
| `POST /entities/:id/opening-review/completions` | 开业审查（可带 `expectedVersion`） |
| `GET /entities/:id/status` | 当前可签约状态与每项材料判定（`?at=` 可重算历史时刻） |
| `GET /entities/:id/blocking-reasons` | 可读的阻断理由清单 |
| `GET /entities/:id/audit` | 审计时间线（可按 `types/from/to` 过滤） |
| `GET /entities/:id/notifications` | 规则变更等定向通知 |

规则 `specs` 示例：

```json
{
  "activities": {
    "DIRECT_SALES": {
      "requirements": [
        { "code": "TAX_ID", "name": "当地税号登记", "ownerRole": "TAX", "prerequisites": [] },
        { "code": "LOCAL_LICENSE", "name": "当地经营许可", "ownerRole": "LEGAL", "prerequisites": ["TAX_ID"] },
        { "code": "DATA_CROSSBORDER", "name": "数据跨境备案", "ownerRole": "DATA", "prerequisites": ["LOCAL_LICENSE"] }
      ]
    }
  }
}
```

## 目录

```
src/core/      事件日志、互斥锁、时钟、哈希
src/domain/    事件、投影、规则引擎、应用服务、错误
src/http/      HTTP 路由
test/          领域场景测试（前置链、幂等、过期、豁免、并发、重放、版本生效）
```
