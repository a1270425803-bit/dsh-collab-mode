---
name: orchestrate
description: 在有效 EXECUTING 的复杂任务中，把已批准方案投影成带版本、能力边界、轮次和候选契约的任务书；不创建第三个批准停点。
---

# 编排：批准方案 → 任务书

## 前提

重读 `CURRENT.md`。只有 schema 为 `collab-v4.3`、状态是有效 `EXECUTING`、需求/方案证据和 approval_cycle 均有效，才生成复杂任务书。否则返回对应停点，不实施。

## 编排步骤

1. 按依赖拆分紧耦合串行、松耦合并行的工作；并行必须有固定接口、互斥写域和最终集成任务。
2. 从已注册基础实例选择 `subagent_executor` 或 `subagent_executor_flash`；专项能力用 `required_skill: role-frontend | role-data-analyst | role-doc-writer | none`，合规只路由为 Fresh Reviewer + `role-compliance-reviewer`。
3. 复制而不是重算 `task_id/requirement_rev/plan_rev/approval_cycle`，分配 `execution_round/branch_id`，记录不可变 `base_ref`。
4. 任务书 capability_scope 必须是已批准方案和基础角色实际能力的子集；模型、外部写入、不可逆影响或风险不能在任务书中新增。
5. 使用同目录 `任务书模板.md`，按 `prompts/{task_id}_{cycle_hash}_{branch_id-or-main}_e{execution_round}.md` 落盘；`cycle_hash` 直接取 approval_cycle 去掉 `ac1:` 后的完整值。任务书是执行投影，不是新批准入口；生成后直接交 `dispatch`。

## 退出条件

任务书缺字段（含 permission_scope）、required Skill/模型不可用、base_ref 不可重建、现场事实要求改变批准路线或任务书扩大能力时停止并返回 Planner。批准路线内的普通实现细节不增加用户确认。
