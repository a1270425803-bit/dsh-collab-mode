# CURRENT.md v4.3 模板

> 复制到项目根后才成为该工作区的当前状态真源。本模板自身不是任务状态。批准 evidence 的结构化详情可引用追加式证据文件，但以下绑定字段必须保留。

```yaml
---
schema_version: collab-v4.3
task_id: null
state: REQUIREMENT_PENDING
requirement_rev: R1
requirement_digest: null
requirement_approved_rev: null
requirement_approval_event_id: null
requirement_approval_evidence: null
plan_rev: null
plan_digest: null
plan_approved_rev: null
plan_approval_event_id: null
plan_approval_evidence: null
approval_mode: normal
state_generation: 1
planner_session_id: null
approval_cycle: null
verification_mode: null
execution_round: 0
review_attempt: 0
review_invocation_ref: null
review_round: 0
base_ref: null
candidate_ref: null
verification_result: null
verification_evidence_ref: null
verified_candidate_ref: null
verified_approval_cycle: null
plan_review_ledger:
  full_review_used: false
  recheck_used: false
  findings_ref: null
route_binding_ref: null
next_action: 等待确认需求 R1
updated_at: null
---
```

## 迁移规则

- 缺失或未知 `schema_version`：先只读留存旧文件，不得恢复 `EXECUTING` 或继续修改 `DONE`。
- `plan_review_ledger` 与 `route_binding_ref` 是附加字段：旧文件缺失时按默认值读取（各项 false/null），写入补齐，不构成 schema 变化；ledger 绑定当前 requirement_rev，新需求版本清零。
- 只迁移能够确定映射的字段，并按 v4.3 重验批准证据。
- 需求证据有效、方案证据无效：`PLAN_PENDING`。
- 两份证据无法可靠验证：`REQUIREMENT_PENDING`。
- 新需求版本清空方案批准、approval_cycle、candidate_ref、review_invocation_ref 和四项完成证据。
- 新方案版本清空 approval_cycle、candidate_ref、review_invocation_ref 和四项完成证据。
- candidate 变化清空 review_invocation_ref 和四项完成证据；四项与当前 candidate/cycle 不一致时不得进入或恢复 `DONE`。

## approval_cycle

`requirement_digest` 和 `plan_digest` 分别使用 `req1:<sha256>` 与 `plan1:<sha256>`。哈希该版本向老板展示、但不包含 digest 展示行本身的完整正文；先做 Unicode NFC、统一 LF、移除每行末尾空白并保证恰好一个结尾换行，再对 UTF-8 字节计算 SHA-256。正文变化必须产生新版本和新摘要。

输入为 `schema_version/task_id/requirement_rev/requirement_digest/requirement_approval_event_id/plan_rev/plan_digest/plan_approval_event_id`。使用 canonical JSON v1：字段名按 Unicode 码点排序、UTF-8、无额外空白；计算 SHA-256，格式为 `ac1:<64位小写十六进制>`。任务书与子 Agent 只复制 CURRENT 中的值，不自行重算。
