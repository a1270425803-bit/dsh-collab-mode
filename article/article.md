# 我给 AI 立了套规矩，开源了

你有没有见过这种场面：AI 说“我已经处理好了”，结果它顺手改了三处文件；你追问为什么，它只回一句“这是更好的方案”。

更糟的是，审查也常常只剩一句“看过了”。

问题不一定是 AI 不够聪明，而是协作没有停点、没有版本，也没有一个真正独立的复核者。

所以我给自己的 Agent 协作立了套规矩，做成一个可以装进 DSH 的 preset，开源成 `dsh-collab-mode`。你也可以把这套方法迁移到自己的 Agent 上。

[图：article/images/cover.png]

## 第 1 步｜先把“收到”变成停点

这套模式的第一条规矩很反直觉：收到任务，不等于可以动手。

停点一是需求批准。Planner 先把目标、交付物、范围、禁止项和验收标准写成版本化需求，等你明确确认。没有这次确认，不能创建交付候选。

停点二是方案批准。需求确认后，Planner 再把实现路线、模型路由、权限、风险、并行关系和停止条件固定下来，等你做第二次确认。两次批准都完成，才进入执行。

你会发现，这不是给对话增加仪式感，而是把“做什么”和“怎么做”拆开。很多失控，恰恰发生在这两件事被一句“继续吧”混在一起的时候。

[图：article/images/inline-1.png]

可以把这段提示词放进自己的工作约定里：

> 你是 Planner。先把目标、交付物、范围、禁止项和验收标准写成版本化需求；我确认后，再提交实现路线、模型路由、权限、风险、并行关系和停止条件。两次确认前，不创建候选。

得到什么：AI 不会因为“已经理解”就自动进入执行；你可以在需求层和方案层分别刹一次车。

## 第 2 步｜安装：把一组文件放到 DSH 能加载的位置

安装不是把一段 prompt 粘进去，而是把一组彼此绑定的文件放到 DSH 能加载的位置。

发布仓库的前置条件很明确：支持 v4.3 preset composition 的 DSH、Node.js 18 或更高版本，以及 Git。

从仓库根目录执行下面这组命令。它们对应仓库 README 中的真实路径和真实脚本名：

    git clone https://github.com/a1270425803-bit/dsh-collab-mode.git
    cd dsh-collab-mode
    export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
    mkdir -p "$DSH_HOME/.agent-presets/collab-v43-r2-1"
    cp -R agent.cordis.yml preset.yml governance plugins scripts skills dsh-route-catalog "$DSH_HOME/.agent-presets/collab-v43-r2-1/"
    sh scripts/bootstrap-catalog.sh --dry-run
    sh scripts/bootstrap-catalog.sh
    cd "$DSH_HOME/.agent-presets/collab-v43-r2-1"
    node scripts/release-sync.mjs --verify

这里有两个细节值得留意。

第一，`DSH_HOME` 不设置时使用 `~/.dsh`，也可以指向自定义目录。preset 中的 `catalogDir` 会通过 `node:path` 的 `resolve` 在加载时解析为绝对路径。

第二，`bootstrap-catalog.sh` 的 `--dry-run` 只展示动作，不改文件。正式执行时，它会初始化 `route-catalog/shared/` 及其 `bindings/`、`snapshots/` 子目录；目录权限是 `0700`，首次创建的 `catalog.json` 权限是 `0600`，已有 catalog 会校验而不会覆盖。

最后的 `release-sync.mjs --verify` 是只读校验入口：它核对 `governance/spec.md`、`governance/planner-kernel.md` 和 `agent.cordis.yml` 里的 SHA 链与内嵌内容。校验失败，就停下来检查版本，不要绕过它继续选择 preset。

可以把安装意图压缩成一句提示词：

> 请从仓库根目录开始部署：先设置 `DSH_HOME`，再复制 `agent.cordis.yml`、`preset.yml`、`governance`、`plugins`、`scripts`、`skills` 和 `dsh-route-catalog`；先运行 `sh scripts/bootstrap-catalog.sh --dry-run`，再运行 `sh scripts/bootstrap-catalog.sh`，最后运行 `node scripts/release-sync.mjs --verify`。

得到什么：你得到的不是散落的配置，而是一套有部署入口、有路径约束、有完整性校验的 preset。

## 第 3 步｜把版本锁住：approval_cycle 不是装饰

装好文件还不够。真正防止“这次对话说过了，所以就算批准”的，是版本绑定。

一次执行至少要盯住 `task_id`、`requirement_rev`、`plan_rev` 和 `approval_cycle`。`task_id` 说明是哪项任务，`requirement_rev` 和 `plan_rev` 说明使用哪一版需求与方案，`approval_cycle` 则把两次批准绑定到同一个执行周期。

工作区的当前状态由 `CURRENT.md` 记录；发布包提供 `governance/CURRENT.template.md` 作为模板。需求、方案或批准边界发生实质变化时，不要直接覆盖旧版本：回到对应停点，产生新版本和新的 `approval_cycle`。

这一步最重要的习惯是：不要把“继续”“看着处理”或沉默当成批准。批准必须对应明确展示过的版本，也必须能在之后被核对。

可以这样要求你的 Planner：

> 每次执行前先核对 task_id、requirement_rev、plan_rev 和 approval_cycle；正文发生变化就生成新版本，不把“继续”当作批准。若批准边界失效，先停下来并返回对应停点。

得到什么：任务不会因为聊天记录变长而悄悄换版本；出了问题，你能回答“这份交付到底对应哪一次批准”。

## 第 4 步｜冻结候选，再让全新 Reviewer 来审

Executor 只负责在批准边界内生产候选和证据；Planner 再冻结一个可重建的 `candidate_ref`。

`candidate_ref` 不是“当前工作区”，而应指向内容寻址的 Git commit 或 tree 对象。这样，审查者拿到的不是一段解释，而是一份可以重新构建、重新核对的交付对象。

接下来不是让写代码的人自评，而是启动一个全新的上下文，让 Fresh Reviewer 只读取当前批准、任务书、`base_ref`、`candidate_ref`、完整变更清单和证据，然后独立重跑验收。执行者的推理可以作为线索，但不能替代证据。

审查结论只有 `PASS`、`FAIL`、`BLOCKED`。`FAIL` 表示当前批准边界内可以返工；`BLOCKED` 表示缺少必要信息、权限或裁决，或者候选无法重建，此时应该停止并返回 Planner。它不是“差不多过了”，而是一条明确的状态分支。

[图：article/images/inline-2.png]

可以把 Reviewer 的边界写得非常直接：

> 只审当前冻结的 candidate_ref，不接受执行者的解释替代证据；从独立上下文重建候选，重跑全部验收，并至少做一次风险相称的反例检查。结论只能是 PASS、FAIL 或 BLOCKED。

得到什么：审查不再是作者给自己的确认，而变成另一个上下文对同一份候选的可复现检查。

## 第 5 步｜把仓库也装修成可交付形态

最后一步，是把仓库从“能运行的文件堆”整理成别人敢接手的交付物。

你看到的不是一个巨大 prompt，而是一套有入口、有目录、有说明的 preset：

- `preset.yml` 声明显示名“协作模式 v4.3 r2.1”。
- `agent.cordis.yml` 保存运行版本、双 SHA 字段，并嵌入 Planner kernel。
- `governance/` 放规范、运行内核、角色书和 `CURRENT.md` 模板。
- `scripts/bootstrap-catalog.sh` 和 `scripts/release-sync.mjs` 是部署与校验的真实入口。
- `plugins/route-binding.mjs`、`dsh-route-catalog/index.mjs` 和 `skills/` 负责路由绑定、共享目录能力与条件操作手册。
- 发布版文档和视觉资产按既定契约落位：`README.md` 负责安装、使用和原理说明，`LICENSE` 使用 MIT，Hero 图是 `assets/banner.png`，社交预览图是 `assets/social-preview.png`，文章配图放在 `article/images/` 下。

README 的价值不只是介绍项目，而是把第一次部署需要的命令、路径和停止条件放到同一个入口里。视觉资产也不只是装饰：它们让仓库在打开、分享和阅读长文时保持同一套识别语言。

[图：article/images/inline-3.png]

可以用下面这段提示词做最后检查：

> 请以交付者视角整理仓库：README 先说明安装和验证，LICENSE 明确许可，治理文件说明状态与角色，scripts 只保留真实入口，图片按既定路径放置；任何说明都回到仓库现有文件核对。

得到什么：别人拿到仓库后，知道从哪里开始、如何验证、出了问题何时停下，也知道哪些文件是运行入口，哪些文件只是说明。

## 写在最后

这套协作模式的迁移价值，不在于多了几个术语，而在于把“聪明地继续”改成“满足条件才继续”：先批准需求，再批准方案；执行者交候选，Planner 冻结引用；全新 Reviewer 独立复核；缺条件就停止或返回。

它是轻量软协议，不是平台安全边界，也不会替你批准公开发布、推送、付费等外部动作。它做的事很朴素：把协作变成可追踪、可重建、可审查的过程。

如果你想把这套规矩装进自己的 Agent，仓库在 GitHub： [dsh-collab-mode](https://github.com/a1270425803-bit/dsh-collab-mode)。先看 README 的安装段落，再按自己的 `DSH_HOME` 运行部署与校验命令。

你不需要复制我的业务流程；只要保留双停点、版本绑定、候选冻结和独立审查这四个骨架，就能给自己的工作流加一层刹车。后续我也会继续把这套模式用在更多长任务上，把“可复现”而不只是“看起来完成”当成默认交付标准。
