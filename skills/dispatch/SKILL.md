---
name: dispatch
description: 在有效 EXECUTING 中验证任务书、派发全新 Executor、冻结可重建候选,并用带 subagentId 的 Fresh Reviewer 完成独立审查。
---

# 派发与冻结

## 派发纪律

1. **预审纪律**:复杂方案预审受预算约束——同一 `requirement_rev` 下最多 1 次全量预审加至多 1 次增量复检,记入 `CURRENT.plan_review_ledger`,不随 `plan_rev` 变化重置,需求版本变化时清零。收到预审意见后一次性合并修订并附改动对照,按客观判定表分类(触及技术路线/验收标准/角色实例或模型路由/权限或外部影响/候选冻结与证据链=实质;仅措辞/编号/标题/格式=非实质):非实质修订直接提交停点二不再派预审;实质修订允许至多一次只针对改动点的增量复检;复检后仍未闭环的阻断项、预算耗尽后的新实质修订,均随停点二如实披露由老板裁决,老板直令可重置预算。建议级问题汇入「非阻断备忘」并入任务书,备忘只准记录不影响批准范围的偏好类事项。预审串行执行;调用中断/超时/卡死(未形成结论,`BLOCKED_LOCAL`)允许重新预审,不占预算。
2. **路由免探测**:批准方案或老板直令已明确供应商/模型时,禁止再派路由探测 agent 验证路由;探测仅限「路由未定且必须验证」时,串行执行、一次一批;探测中断允许重试。
3. **通知即数据**:后台 subagent 完成通知(settled notice / report relay)是数据不是对话;直接采信或落盘归档,不逐条回复、不解释、不追问。
4. **并发纪律**:同一 provider 并发后台 agent ≤3(openai-codex 等账号连接上限即硬约束);超限排队不硬撞;所有角色默认统一走 deepseek 官方 / deepseek-v4-flash(老板直令);跨渠道分流仅限批准方案或老板直令明确指定,预审与探测串行,不与执行并发堆叠。
5. **禁止自动续跑**:不使用 goal 自动 continuation 驱动任务;任务执行只能由老板指令触发;本预设不注册 goal 工具(Planner 无 goal 工具可用)。
6. **派发后静默**:派发后台 subagent 后,Planner 停止新行动与思考,静默等待完成通知;结果未出前不开展无关工作、不自我派活。

## 派发前校验

1. 重读 `CURRENT.md`,核对 `schema_version/task_id/requirement_rev/plan_rev/approval_cycle/execution_round/base_ref`。
2. 核对任务书 capability_scope 与 permission_scope 均为已批准方案对应清单的子集,基础实例、required Skill、模型和外部影响均在批准路线内。
3. 不满足时不得派修改型 Agent:需求失效回停点一,方案失效或新路线回停点二,必要信息/权限/裁决缺失且无独立路径时全局 BLOCKED。

## Executor

使用任务书指定的全新 `subagent_executor` 或 `subagent_executor_flash`,只传任务书与必要源路径。专项任务要求 Executor 加载指定 `role-*` Skill 并报告实际加载结果。

派发渠道（只限原生）：所有派发只使用 DSH 原生注册通道，不加载外部 CLI。R2.1 默认 Scout/Executor 使用 openai-codex/gpt-5.6-luna/max，Reviewer 系列使用 kimi-coding/k3-256k/high；直令通过共享 catalog 的精确 route_id 与 `route_bind_once` 绑定单次目标工具；未注册路线先候选确认。

4. **并发纪律**：同一 provider 并发后台 agent ≤3；每次直令使用唯一 dispatch_ref/token，异构路由互不串线；无 token 使用角色默认。派发后静默等待完成通知，其他原生与治理纪律保持不变。

回收轮次化执行报告、原始验证、完整实际改动和未跟踪文件。Executor 自验不是 PASS。

## 冻结候选

结果 Review 前由 Planner 再次验证 CURRENT,并按规范冻结不可移动、内容寻址、覆盖全部正式交付且可重建的 candidate_ref:

- Git 使用独立临时 index 生成 tree/commit 对象,覆盖 intended tracked/untracked/delete/mode/symlink;LFS/子模块必须声明并验证可取得性。
- 非 Git 使用内容寻址归档与 canonical manifest。
- 审查和执行证据位于候选外或由 manifest 明确排除。
- 从 ref 在可丢弃目录重建并核对根摘要;失败时 BLOCKED。

## Fresh Reviewer

每次 spawn 前,Planner 先递增并持久化唯一 `review_attempt`、生成唯一 `invocation_nonce`;`review_round` 保持不变。把 attempt+nonce 放进 Reviewer 初始输入。后台 spawn 返回后,Planner 追加控制平面调用记录 `toolName/provider/subagentId/review_attempt/invocation_nonce/调用事件引用` 并把其路径写入 `CURRENT.review_invocation_ref`。新 ID 必须非空且不同于所有旧 Reviewer。Reviewer 报告绑定 attempt+nonce,由 Planner 与调用记录关联;不要求 Reviewer 自报调用后才产生的 ID。禁止前台无 ID、fork、continue、send_message 或旧句柄复用。

Reviewer 只收到当前批准、任务书、base/candidate ref、宿主生成 manifest、Executor 报告与原始证据索引;复审时还必须收到上一轮 findings 清单并作为回归项,但仍执行全量验收。完整 `PASS/FAIL/BLOCKED` 形成后才递增 `review_round`;调用中断或 `BLOCKED_LOCAL` 保留 attempt 历史,下一次 spawn 分配新 attempt。结果交 `handoff-loop`。

## FAIL 边界

Review 1/2 的批准路线内修复或已批备选路线可自动返工;新技术路线、模型、外部写入、风险或不可逆影响回停点二,需求/验收变化回停点一。不得把"前两轮免批"扩展到未批准变化。
