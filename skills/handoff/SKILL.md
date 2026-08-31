---
name: handoff
description: v4.3 跨 session 交接：由当前 Planner 保存 CURRENT 引用和 handoffs 事实摘要，或在新 session 中先验证 schema、所有权与批准绑定再恢复；不会因读到 EXECUTING 自动续跑。
---

# Handoff — 跨 Session 上下文交接

当用户需要将当前工作交接给新的 session，或从之前的 session 恢复上下文时使用。

> 落盘遵循 v4.3 文件纪律：`handoffs/{task_id}_g{state_generation}_{YYYYMMDDTHHMMSSZ}.md` + `CURRENT.md`。本技能只用于跨 session 续接，不是日常状态机。

## 保存上下文（当前 Session → 交接文件）

### 第一步：收集状态
回顾当前对话，提取以下信息：

1. **现在做到哪**：正在做什么？（一句话概括）+ 已完成清单（含具体文件路径）
2. **关键决策**：做过的技术决策及原因
3. **卡住待裁决**：阻塞中、需要用户裁决的事项（BLOCKED 式）
4. **待办事项**：下一步要做的具体任务
5. **已知陷阱**：遇到的坑、注意事项、避免重复的错误
6. **证据位置**：验收 log / 关键命令输出存在哪个文件
7. **关键文件**：涉及的核心文件路径列表
8. **环境信息**：当前分支、依赖版本、运行命令

### 第二步：写入交接并释放所有权

文件名使用 `handoffs/{task_id}_g{state_generation}_{YYYYMMDDTHHMMSSZ}.md`，精确到秒并包含 generation，同日多次不得覆盖。当前 owner 写完 handoff 后，在同一次治理更新中把 `planner_session_id` 置空并递增 generation；旧 session 此后不得再写。

格式要求：
- 简洁、可操作，新 session 读完就能直接开始工作
- 每个待办事项必须具体到文件路径 + 操作描述
- 标注「下一步」作为新 session 的起点

### 第三步：输出摘要
告知用户交接文件已保存的位置和文件大小。

> 三端当前都依靠用户交接触发词或长任务主动建议；不宣称有未实测的 PreCompact 自动检查点。

## 恢复上下文（交接文件 → 新 Session）

当用户说 "恢复上下文"、"继续上次的工作"、"resume" 时：

1. 首先读 CURRENT.md，验证 `schema_version: collab-v4.3`、planner 所有权、state_generation 和批准绑定，再读其明确引用的 handoff
2. 缺失/未知 schema 禁止恢复 EXECUTING；按迁移规则回对应停点
3. 快速验证关键文件、base/candidate ref 和证据仍可取得，handoff 不能覆盖 CURRENT
4. owner 为空时，新 session 以“重读 generation → 写入自身稳定 session ID → generation+1”接管；owner 非空且原 session 不可用时需老板明确授权接管，不能静默抢占
5. 只有老板要求继续或当前消息属于该任务时，从 CURRENT.next_action 继续；否则只汇报
6. 如果交接、CURRENT 与当前工作区冲突，不覆盖新状态；记录证据并按冲突影响回停点或 BLOCKED

## 交接文件模板

```markdown
# 交接 — {task_id} · generation {state_generation} · YYYY-MM-DDTHH:MM:SSZ

## 现在做到哪
（1-2 句话 + 已完成清单，含文件路径）

## 下一步
1. **Next**: （最优先的下一步，具体到文件和操作）

## 最近 handoff
- [最近 handoff](handoffs/{task_id}_g{state_generation}_{YYYYMMDDTHHMMSSZ}.md)

## 卡住待裁决
- （BLOCKED 式：事项 + 待裁决点 + 建议方向）

## 证据位置
- 验收 log：（路径）
- 关键命令输出：（路径）

## 关键决策（按需）
1. （决策） — 原因：（why）

## 已知陷阱（按需）
- （注意事项）

## 关键文件（按需）
- `path/to/file` — （用途）

## 环境信息（按需）
- 分支 / 依赖版本 / 运行命令
```
