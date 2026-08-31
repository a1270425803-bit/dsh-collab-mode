---
name: handoff-loop
description: 处理复杂任务的 PASS、批准边界内 FAIL、BLOCKED_LOCAL、局部/全局 BLOCKED 与三轮停机，并把完成证据绑定到当前候选和批准周期。
---

# Review 回环

Reviewer 只给 `PASS / FAIL / BLOCKED`，不得修改候选。`BLOCKED_LOCAL` 是调用未形成结论的本地状态，不是第四种 Reviewer 结论。

## PASS

Planner 重读 CURRENT，核对报告的 `task_id/approval_cycle/candidate_ref/review_attempt/invocation_nonce`，并用 `review_invocation_ref` 关联非空且全新的 subagentId 控制平面记录，再核对全部强制验收和根摘要。随后写入：

- `verification_result: PASS`
- `verification_evidence_ref`
- `verified_candidate_ref`
- `verified_approval_cycle`

四项与当前 candidate/cycle 一致才进入 `DONE`。任务书、执行与审查文件名都包含完整 cycle_hash，证据按轮次追加，不覆盖历史。

## FAIL

- Review 1/2 且问题是批准路线内实现缺陷：保持 `EXECUTING`，递增 execution round，生成下一轮任务书并派全新 Executor。
- 已批准的备选路线可以直接使用；未批准的新路线、模型、外部影响、风险或不可逆性回 `PLAN_PENDING`。
- 需求目标、范围、红线或验收变化回 `REQUIREMENT_PENDING`。
- 同一路线同根因最多两次，不因换 Agent 或改名重置。
- 同一 approval cycle 的 Review 3 FAIL 无条件全局 `BLOCKED`，禁止第 4 轮。

Review 3 后如形成实质不同的新需求/方案，老板对该新版本的有效批准本身解除阻塞并生成新 cycle；不另设“解除确认”。“继续”或只换 Agent 无效。

## BLOCKED 与 BLOCKED_LOCAL

- 临时工具故障、单一路径暂不可用且未形成完整审查：记录 `BLOCKED_LOCAL`，不增加 review round；有独立路径时保持 EXECUTING。
- 局部路径受阻但仍有批准且不依赖的路径：记录到 `BLOCKED.md`，保持 EXECUTING。
- 缺必要信息/权限/业务裁决、约束矛盾、候选不可重建或无独立可继续路径：全局 BLOCKED。
- 能明确形成新方案/需求版本时直接回对应停点，不先制造额外阻塞状态。

## 交接

仅在跨 session 续接时使用 `handoffs/` 保存当前事实和证据引用；不创建 `PROGRESS.md` 平行状态真源。
