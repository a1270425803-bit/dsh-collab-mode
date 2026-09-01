<p align="center">
  <img src="assets/banner.png" alt="DSH 协作模式 v4.3 r2.1" width="1280" height="640">
</p>

<p align="center"><strong>让 Agent 协作可批准、可冻结、可复核。</strong></p>

<p align="center">
  <a href="https://github.com/a1270425803-bit/dsh-collab-mode/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg"></a>
  <a href="https://github.com/a1270425803-bit/dsh-collab-mode/releases"><img alt="Release" src="https://img.shields.io/github/v/release/a1270425803-bit/dsh-collab-mode?display_name=tag&sort=semver"></a>
  <a href="https://github.com/a1270425803-bit/dsh-collab-mode"><img alt="DSH compatibility" src="https://img.shields.io/badge/DSH-v4.3%20compatible-111827.svg"></a>
</p>

<p align="center">
  <a href="#中文">中文</a> · <a href="#english">English</a>
</p>

<a id="中文"></a>
# DSH 协作模式 v4.3 r2.1

> [安装](#安装) · [使用](#使用) · [原理](#原理) · [English](#english)

## 这是什么

`dsh-collab-mode` 是 DSH（DeepSeek Harness）的 Agent preset：把容易失控的 AI 协作，收敛成一条可追踪的轻量状态机。它用双停点批准明确“做什么”和“怎么做”，用不可移动的候选引用冻结交付，再交给全新上下文的 Reviewer 独立审查；任何一步不满足条件，就停止或回到批准边界内返工，而不是凭对话惯性继续推进。

## 特性

- 🛑 **双停点批准**：先确认版本化需求，再确认方案、路由、范围与风险。
- 🔗 **版本绑定**：`task_id`、需求版本、方案版本与 `approval_cycle` 共同锁定当前执行。
- 🧊 **候选冻结**：用内容寻址的 `base_ref` 与 `candidate_ref` 描述可重建对象，避免“当前工作区”漂移。
- 🧪 **Fresh Reviewer 独立审查**：审查者从独立上下文读取候选，不接受执行者的推理辩护替代证据。
- 🔐 **SHA 链校验**：把规范、运行内核和 YAML 投影的关系固定下来，冲突时停止发布。
- 🧭 **绝对路径参数化**：`DSH_HOME` 缺省为 `~/.dsh`，catalog 路径在加载时解析为绝对路径。
- ♻️ **可复跑部署**：提供零依赖的 Node 校验脚本与 POSIX bootstrap 脚本，初始化目录并验证既有 catalog。

<a id="安装"></a>
## 安装

### 前置条件

- 已安装支持 v4.3 preset composition 的 DSH。
- Node.js 18 或更高版本。
- Git。

### 快速开始

1. **获取仓库**：

   ```sh
   git clone https://github.com/a1270425803-bit/dsh-collab-mode.git
   cd dsh-collab-mode
   ```

2. **设置 DSH_HOME 并准备 preset 目录**（不设置时使用 `~/.dsh`）：

   ```sh
   export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
   mkdir -p "$DSH_HOME/.agent-presets/collab-v43-r2-1"
   ```

3. **复制 preset 文件**：

   ```sh
   cp -R agent.cordis.yml preset.yml governance plugins scripts skills dsh-route-catalog \
     "$DSH_HOME/.agent-presets/collab-v43-r2-1/"
   ```

4. **初始化共享路由目录**：先用 dry-run 查看动作，再执行初始化。脚本会创建 `route-catalog/shared/`、`bindings/`、`snapshots/` 私有目录，并在缺失时创建受保护的 `catalog.json`；已有 catalog 只校验、不覆盖。

   ```sh
   sh scripts/bootstrap-catalog.sh --dry-run
   sh scripts/bootstrap-catalog.sh
   ```

5. **校验三处投影**：从已复制的 preset 根目录执行；命令只读检查 `spec.md`、`planner-kernel.md` 与 `agent.cordis.yml` 的 SHA 链和嵌入内容。

   ```sh
   cd "$DSH_HOME/.agent-presets/collab-v43-r2-1"
   node scripts/release-sync.mjs --verify
   ```

6. **在 DSH 中选择 preset**：选择 `协作模式 v4.3 r2.1`，然后按 DSH 的正常会话流程使用。

> `DSH_HOME` 可以指向自定义目录；preset 中的 `catalogDir` 会通过 `node:path.resolve` 将它解析为绝对路径。若校验失败，请停止部署，确认复制的是同一版本的文件，并从 preset 根目录重新运行 `node scripts/release-sync.mjs --verify`；不要绕过校验继续选择 preset。

<a id="使用"></a>
## 使用

一次协作按以下顺序推进：

1. **停点一：需求批准**。Planner 把目标、交付、范围、禁止项和验收写成版本化需求；未获明确批准，不创建交付候选。
2. **停点二：方案批准**。Planner 固定实现路线、模型路由、权限、风险、并行关系和停止条件；未获第二次明确批准，不进入执行。
3. **执行与冻结**。Executor 按任务书生产候选，记录命令和证据；Planner 冻结可重建的候选引用。
4. **独立审查**。Fresh Reviewer 对同一候选重跑验收并做风险相称的反例检查：`PASS` 才能进入完成路径，`FAIL` 在批准边界内返工，`BLOCKED` 则停止并返回 Planner 处理。

```mermaid
stateDiagram-v2
    [*] --> RequirementPending: 提出任务
    RequirementPending --> PlanPending: 停点一批准
    PlanPending --> Executing: 停点二批准
    Executing --> CandidateFrozen: Executor 生成候选
    CandidateFrozen --> IndependentReview: Fresh Reviewer 独立审查
    IndependentReview --> Done: PASS
    IndependentReview --> Executing: FAIL / 按批准边界返工
    IndependentReview --> Blocked: BLOCKED / 停止
    Done --> [*]
```

执行者只提交候选与证据，不自行宣布最终通过；最终状态由独立审查和 Planner 的状态记录共同决定。

<a id="原理"></a>
## 原理

### 三处投影与一条 SHA 链

- `governance/spec.md`：v4.3 的唯一规范真源。
- `governance/planner-kernel.md`：从规范中抽取的常驻运行投影，保留状态、批准、路由、证据与完成规则。
- `agent.cordis.yml`：把同一份 kernel 原文嵌入 persona 的哨兵区间，并在头部保存 `norm_sha256` 与 `runtime_projection_sha256`。

`scripts/release-sync.mjs` 会按 NFC、LF、去行尾空白和单一结尾换行规范化文本，再计算 UTF-8 SHA-256。默认模式负责同步；`--verify` 逐项比较规范哈希、kernel 哈希和 YAML 哨兵区间的逐字节内容，任一不一致都会以非零退出码停止。

```mermaid
flowchart LR
    S["governance/spec.md<br/>唯一规范真源"]
    K["governance/planner-kernel.md<br/>常驻运行投影"]
    Y["agent.cordis.yml<br/>persona 嵌入区间"]
    V["node scripts/release-sync.mjs --verify"]
    C["可重建候选"]
    S -->|规范化并写入 norm_sha256| Y
    S -->|抽取并校对规则| K
    K -->|逐字节嵌入并写入 runtime_projection_sha256| Y
    Y --> V
    K --> V
    V -->|一致| C
```

### 路由目录

`bootstrap-catalog.sh` 使用 `DSH_HOME`（缺省 `~/.dsh`）初始化共享路由目录。目录和绑定/快照子目录为 `0700`，初始 `catalog.json` 为 `0600`，并带有自校验 digest；已有 catalog 不会被覆盖。

<a id="版本命名"></a>
## 版本命名说明

对外发布名是 **r2.1**；内核中的 `norm_version` 是 **collab-v4.3-r2.2**。这是历史命名差异：发布标签用于识别仓库交付，`norm_version` 用于识别内核规范版本，二者不代表两套不同的功能逻辑。

<a id="FAQ"></a>
## FAQ

**Q：为什么发布名是 r2.1，内核却写 r2.2？**  
A：这是已知的历史命名差异。部署完整性以 `node scripts/release-sync.mjs --verify` 的实际 SHA 校验为准，不要手工改写 `norm_version`。

**Q：可以把 DSH_HOME 放到别处吗？**  
A：可以。在复制 preset 和运行 `sh scripts/bootstrap-catalog.sh` 前导出自定义 `DSH_HOME`；它会被解析为绝对路径，缺省值仍是 `~/.dsh`。

**Q：catalog 已经存在时，bootstrap 会覆盖它吗？**  
A：不会。脚本会检查真实文件、权限、JSON 字段和 digest；校验不通过就停止，避免静默覆盖已有路由数据。

<a id="许可证"></a>
## License

本项目采用 [MIT License](LICENSE)。版权声明见 [`LICENSE`](LICENSE)。

## 致谢

感谢 DSH 及其协作模式的使用者与贡献者；本 preset 的目标是让 Agent 协作更容易理解、复现和审查。

---

<a id="english"></a>
# English

> [中文](#中文) · [Install](#install) · [Usage](#usage) · [How it works](#how-it-works)

## What is this?

`dsh-collab-mode` is the DSH (DeepSeek Harness) Agent preset for turning failure-prone AI collaboration into a traceable, lightweight state machine. Two approval gates clarify what to do and how to do it; immutable candidate references freeze the deliverable; a fresh Reviewer independently checks the same candidate. When a condition is not met, the process stops or returns for bounded rework instead of continuing on conversational momentum.

## Features

- 🛑 **Two approval gates**: approve the versioned requirement first, then the plan, route, scope, and risk.
- 🔗 **Version binding**: lock the execution to `task_id`, requirement revision, plan revision, and `approval_cycle`.
- 🧊 **Candidate freeze**: use content-addressed `base_ref` and `candidate_ref` instead of a drifting working tree.
- 🧪 **Fresh Reviewer**: review from an independent context; execution-side reasoning is not a substitute for evidence.
- 🔐 **SHA-chain verification**: keep the specification, runtime kernel, and YAML projection consistent.
- 🧭 **Absolute-path configuration**: default `DSH_HOME` to `~/.dsh` and resolve the catalog path at load time.
- ♻️ **Repeatable deployment**: use the dependency-free Node verifier and POSIX bootstrap script to initialize and validate the catalog.

<a id="install"></a>
## Install and deploy

### Prerequisites

- A DSH runtime that supports the v4.3 preset composition.
- Node.js 18 or newer.
- Git.

### Quick start

1. **Clone the repository**:

   ```sh
   git clone https://github.com/a1270425803-bit/dsh-collab-mode.git
   cd dsh-collab-mode
   ```

2. **Set `DSH_HOME` and prepare the preset directory** (defaults to `~/.dsh`):

   ```sh
   export DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
   mkdir -p "$DSH_HOME/.agent-presets/collab-v43-r2-1"
   ```

3. **Copy the preset files**:

   ```sh
   cp -R agent.cordis.yml preset.yml governance plugins scripts skills dsh-route-catalog \
     "$DSH_HOME/.agent-presets/collab-v43-r2-1/"
   ```

4. **Initialize the shared route catalog**:

   ```sh
   sh scripts/bootstrap-catalog.sh --dry-run
   sh scripts/bootstrap-catalog.sh
   ```

   The script creates private `route-catalog/shared/`, `bindings/`, and `snapshots/` directories and creates a protected `catalog.json` only when it is absent. An existing catalog is validated, not overwritten.

5. **Verify the three projections** from the copied preset root:

   ```sh
   cd "$DSH_HOME/.agent-presets/collab-v43-r2-1"
   node scripts/release-sync.mjs --verify
   ```

6. **Select the preset in DSH**: choose `协作模式 v4.3 r2.1` and continue with a normal DSH session.

> `DSH_HOME` may point to a custom directory. `catalogDir` uses `node:path.resolve` to turn it into an absolute path. If verification fails, stop deployment, confirm that all files come from the same release, and rerun `node scripts/release-sync.mjs --verify` from the preset root; do not bypass verification.

<a id="usage"></a>
## Usage

1. **Requirement gate**: Planner records the goal, deliverables, scope, prohibitions, and acceptance criteria as a versioned requirement and waits for explicit approval.
2. **Plan gate**: Planner fixes the route, model, permissions, risk, parallel structure, and stop conditions and waits for the second explicit approval.
3. **Execute and freeze**: Executor produces a candidate and evidence under the taskbook; Planner freezes a reproducible candidate reference.
4. **Review independently**: a fresh Reviewer reruns acceptance and a risk-proportionate counterexample check. `PASS` enters the completion path, `FAIL` triggers bounded rework, and `BLOCKED` stops for Planner handling.

```mermaid
stateDiagram-v2
    [*] --> RequirementPending: Submit task
    RequirementPending --> PlanPending: Gate 1 approved
    PlanPending --> Executing: Gate 2 approved
    Executing --> CandidateFrozen: Executor produces candidate
    CandidateFrozen --> IndependentReview: Fresh Reviewer
    IndependentReview --> Done: PASS
    IndependentReview --> Executing: FAIL / bounded rework
    IndependentReview --> Blocked: BLOCKED / stop
    Done --> [*]
```

The Executor submits candidates and evidence only; it does not declare the final result.

<a id="how-it-works"></a>
## How it works

### Three projections, one SHA chain

- `governance/spec.md` is the sole v4.3 specification source.
- `governance/planner-kernel.md` is the resident runtime projection containing the state, approval, routing, evidence, and completion rules.
- `agent.cordis.yml` embeds the same kernel text inside the persona sentinel range and stores `norm_sha256` plus `runtime_projection_sha256` in its header.

`scripts/release-sync.mjs` normalizes text as NFC, LF, no trailing whitespace, and exactly one final newline before computing UTF-8 SHA-256 values. Its default mode synchronizes; `--verify` compares the specification hash, kernel hash, and embedded YAML bytes and exits nonzero on any mismatch.

```mermaid
flowchart LR
    S["governance/spec.md<br/>sole specification source"]
    K["governance/planner-kernel.md<br/>resident runtime projection"]
    Y["agent.cordis.yml<br/>persona sentinel range"]
    V["node scripts/release-sync.mjs --verify"]
    C["reproducible candidate"]
    S -->|normalized norm_sha256| Y
    S -->|rules projected into| K
    K -->|embedded runtime_projection_sha256| Y
    Y --> V
    K --> V
    V -->|consistent| C
```

### Route catalog

`scripts/bootstrap-catalog.sh` uses `DSH_HOME` (default `~/.dsh`) to initialize the shared route catalog. The directories and binding/snapshot subdirectories are `0700`; the initial `catalog.json` is `0600` and carries a self-checking digest. Existing catalogs are never overwritten.

<a id="version-naming"></a>
## Version naming

The public release name is **r2.1**, while the kernel `norm_version` is **collab-v4.3-r2.2**. This is a known historical naming difference: the release label identifies the repository delivery, while `norm_version` identifies the kernel specification version. They do not represent two different feature sets.

<a id="faq"></a>
## FAQ

**Q: Why does the release say r2.1 while the kernel says r2.2?**  
A: It is a historical naming difference. Trust the actual integrity check, `node scripts/release-sync.mjs --verify`, rather than editing `norm_version` by hand.

**Q: Can I use a custom DSH_HOME?**  
A: Yes. Export it before copying the preset and running `sh scripts/bootstrap-catalog.sh`; it is resolved to an absolute path. The default remains `~/.dsh`.

**Q: Will bootstrap overwrite an existing catalog?**  
A: No. It validates the real file, permissions, JSON fields, and digest, then stops on invalid data rather than silently overwriting route data.

<a id="license"></a>
## License

This project is released under the [MIT License](LICENSE). See [`LICENSE`](LICENSE) for the copyright and permission notice.

## Acknowledgements

Thanks to DSH and the users and contributors of collaborative Agent workflows. This preset is designed to make Agent collaboration easier to understand, reproduce, and review.
