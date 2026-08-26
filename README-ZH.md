<p align="center">
  <img src="docs/assets/bee-agent-logo.png" alt="Bee Agent Logo" width="200" />
</p>

<h1 align="center">Bee Agent</h1>

<p align="center">
  <strong>基于 Cordis 的插件组合、模块化、可跟踪、可扩展、自进化的智能体</strong>
</p>

<p align="center">
  <a href="https://github.com/darifo/bee-agent/actions/workflows/ci.yml">
    <img src="https://github.com/darifo/bee-agent/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License" />
  </a>
  <a href="https://nodejs.org/">
    <img src="https://img.shields.io/badge/node-%3E%3D22-green.svg" alt="Node" />
  </a>
  <a href="https://www.typescriptlang.org/">
    <img src="https://img.shields.io/badge/TypeScript-strict-3178C6.svg" alt="TypeScript" />
  </a>
  <img src="https://img.shields.io/badge/readiness-engineering%20preview-orange.svg" alt="Engineering preview" />
</p>

<p align="center">
  <a href="./README.md">English</a> | 简体中文
</p>

---

## 项目状态

**v0.11 处于维护模式。** 积极开发在 `feature/v1.0.0` 分支上进行，目标是把
Bee Agent 重构为本地优先的个人超级智能体：Thread–Turn–Item 交互协议、持久
Kanban 任务、Chronicle 事件溯源、预算化上下文、沙箱化执行与受治理的后台学
习。`main` 只接收 v0 的关键缺陷修复，v0 线冻结于 `v0.11.0-legacy` tag。
v1 架构方案与重构开发计划见
[`docs/architecture`](./docs/architecture)。

## 项目总览

Bee Agent 是一个开源的、基于 Cordis 的插件组合智能体。它将智能体运行时、
工具、策略、存储适配器和外部 worker 以插件方式组装在一起，而不把它们耦合进
单一的单体核心。项目围绕显式的生命周期管理、只追加（append-only）的执行
历史、稳定的插件契约和可替换的基础设施来设计。

项目旨在通过一个可检查、可测试、可暂停、可恢复、可扩展的共享运行时，支持
编程、研究、办公自动化、数据分析与内容创作等工作流。

## 为什么选择 Bee Agent？

- **模块化设计** — 运行时能力位于包与插件边界之后，而不是堆积在单一核心中。
- **可跟踪执行** — 任务事件只追加、有序、可重放。
- **生命周期安全** — Cordis 上下文与作用域管理服务、副作用（effect）和任务级
  资源清理。
- **存储可移植** — 领域契约将 SQLite 与 PostgreSQL 的细节隔离在运行时代码
  之外。
- **Schema 优先契约** — Zod schema 在各包之间同时提供运行时校验和严格的
  TypeScript 类型。
- **可扩展能力** — 架构为工具、策略、模型、MCP 集成、Python worker 和外部
  智能体预留了干净的边界。
- **自进化组合** — 智能体通过在稳定契约之后挂载、替换和升级插件来演化，
  而不是重写核心。

## 架构

```mermaid
flowchart TB
  clients["客户端<br/>Web · CLI · 桌面"]
  server["智能体服务器<br/>HTTP · SSE · 组合根"]
  kernel["Cordis 内核<br/>上下文 · 作用域 · 服务 · 生命周期"]
  runtime["核心运行时<br/>任务 · 智能体 · 策略 · 记忆"]
  storage["存储契约<br/>事件存储 · 向量存储"]
  plugins["能力插件<br/>工具 · 模型 · 策略"]
  adapters["外部适配器<br/>MCP · Python · 智能体框架"]

  clients --> server
  server --> kernel
  kernel --> runtime
  runtime --> storage
  runtime --> plugins
  plugins --> adapters
```

上图中 Web 客户端属于规划中的层次。服务器、客户端 SDK 与 CLI 目前已经实现，
与内核、核心运行时、契约、存储抽象和 SQLite 事件存储一起构成可用的基座。

## 当前能力

| 领域              | 状态   | 说明                                                                                                                                                                                                               |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Monorepo 工具链   | 已可用 | pnpm workspaces、严格 TypeScript、ESLint、Prettier、Vitest、Changesets、CI                                                                                                                                         |
| 共享契约          | 已可用 | 任务、事件、工具、审批、记忆、嵌入、向量检索、API 与 SSE schema                                                                                                                                                    |
| Cordis 内核       | 已可用 | 生命周期状态机、服务键目录与等待、带 waterfall 中间件的领域事件、支持服务隔离的任务作用域、Cordis 与 Bee Agent 插件挂载                                                                                            |
| 核心运行时        | 已可用 | 带可重放生命周期事件与快照的任务状态机、智能体契约与模拟智能体、工具注册表与 `tools/execute` 管线、含审批挂起、过期与取消的策略引擎                                                                                |
| SQLite 存储       | 已可用 | 迁移、事务、回滚、只追加事件、原子任务序列、重放，由共享存储契约套件验证                                                                                                                                           |
| 服务器            | 已可用 | Fastify 组合根：含任务列表的 REST 命令、支持 `Last-Event-ID` 续传的 SSE 事件流、审批决定、CORS（含劫持流）、状态码映射的错误信封                                                                                   |
| 客户端 SDK 与 CLI | 已可用 | `@bee-agent/client`（REST + 支持中止的 SSE 流，浏览器安全的 fetch）与 `bee` CLI（任务 list/create/run/watch/cancel 与审批 decide）                                                                                 |
| Web 界面          | 已可用 | 基于 Client SDK 的 React 19 + Vite 控制台：任务创建、实时 SSE 事件流、带理由的审批通过与拒绝、取消，jsdom 组件测试                                                                                                 |
| PostgreSQL 存储   | 已可用 | 基于共享契约套件的连接池适配器：重入自动加入的事务、原子序列分配、JSONB 事件、最旧优先任务列表、单方言服务器模式                                                                                                   |
| pgvector 存储     | 已可用 | 基于 pgvector 的 Vector Store 适配器：校验维度并冻结模型/度量的嵌入空间注册表、带工作区隔离与元数据过滤的 cosine/euclidean/inner_product 检索，已过契约套件；供给它的记忆运行时属后续阶段                          |
| 记忆运行时        | 已可用 | 工作区语义记忆（ADR 0012）：按词边界分块、可插拔 `Embedder`（真实模型提供商就绪前用确定性 mock）、按向量近似度排序的 recall，REST/SDK/CLI 三端 `remember`/`recall`/`forget`                                        |
| 模型提供商        | 已可用 | OpenAI 兼容 HTTP 提供商（ADR 0013）：带回合上限工具调用循环的 `OpenAIChatAgent` 与声明维度的 `OpenAIEmbedder`；DeepSeek/OpenAI/兼容网关经 `BEE_AGENT_MODEL_*` / `BEE_AGENT_EMBEDDING_*` 环境变量接入，密钥永不落盘 |
| Command 工具      | 已可用 | 可选 `command_run` adapter：Host 固定 native executable allowlist 与 workspace，展开后的命令、路径、资源和 effects 经精确审批，只能由 Seatbelt/bwrap 创建进程                                                      |
| Python 工具       | 已可用 | 可选 `python_run` adapter：固定 native interpreter、bounded JSON stdin、workspace/runtime 只读边界、超时和输出上限；adapter 内不持有进程 API                                                                       |
| MCP 工具          | 已可用 | Host manifest 固定的 stdio adapter：分阶段 initialize/call JSON-RPC、静态工具 schema、声明 executable/path/secret scope；ExecutionWorld 与 Seatbelt/bwrap 独占进程生命周期                                         |
| 外部智能体        | 计划中 | v0 RemoteAgent/CommandAgent 已随 clean break 删除；替代 adapter 必须保留 Thread–Turn–Item、审批、取消和 trajectory lineage                                                                                         |

## 环境要求

- [Node.js](https://nodejs.org/zh-cn) 22 或更高版本
- [pnpm](https://pnpm.io/zh-cn) 10

## 快速开始

克隆仓库并安装依赖：

```bash
git clone git@github.com:darifo/bee-agent.git
cd bee-agent
pnpm install
```

运行完整的本地验证套件：

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

启动服务器并用 CLI 或 Web 控制台驱动：

```bash
pnpm --filter @bee-agent/server start          # http://127.0.0.1:3000

export BEE_AGENT_URL=http://127.0.0.1:3000
bee() { pnpm --filter @bee-agent/cli bee -- "$@"; }
bee task create -i "hello"                     # 输出任务 id
bee task run <taskId>                          # 流式输出事件直到任务结束

pnpm --filter @bee-agent/web dev               # http://localhost:5173
```

### 接入真实模型（DeepSeek 及其他 OpenAI 兼容提供商）

默认使用模拟智能体；通过环境变量把服务器指向任意 OpenAI 兼容提供商
（ADR 0013 —— 密钥绝不进仓库）：

```bash
BEE_AGENT_MODEL_PROVIDER=openai-compatible \
BEE_AGENT_MODEL_BASE_URL=https://api.deepseek.com \
BEE_AGENT_MODEL_API_KEY=$DEEPSEEK_API_KEY \
BEE_AGENT_MODEL_NAME=deepseek-chat \
pnpm --filter @bee-agent/server start

bee task create -i "用计算器计算 12*7+15" -a agent.deepseek
bee task run <taskId>    # 模型会调用计算器工具，然后给出答案
```

同一套变量模式可为记忆配置真实嵌入器
（`BEE_AGENT_EMBEDDING_PROVIDER/BASE_URL/API_KEY/MODEL/DIMENSIONS`）。

### 挂载 MCP 工具服务器

`BEE_AGENT_MCP_MANIFESTS` 接受 Host 审阅过的 stdio server manifest JSON 数组；
工具注册为 `mcp__<server>__<tool>`。启动时不执行未审批的动态 discovery，每次
调用由平台沙箱分阶段完成 initialize 与 tools/call：

```bash
BEE_AGENT_MCP_MANIFESTS='[{"name":"local","protocolVersion":"2024-11-05","executable":"/绝对路径/native-node","arguments":["/workspace/server.mjs"],"workspaceRoot":"/workspace","runtimeReadPaths":["/node/runtime"],"readPaths":["server.mjs"],"writePaths":[],"tools":[{"name":"lookup","description":"查询本地数据","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}]}]' \
pnpm --filter @bee-agent/bee start
```

### 启用 Python 工具

`python_run` 每次调用都在强制平台沙箱中的全新解释器运行，且需要显式配置
native interpreter、workspace 与解释器 runtime 只读根：

```bash
BEE_AGENT_PYTHON_EXECUTABLE=/绝对路径/native-python3 \
BEE_AGENT_PYTHON_WORKSPACE="$PWD" \
BEE_AGENT_PYTHON_RUNTIME_READ_PATHS=/python/runtime \
pnpm --filter @bee-agent/bee start
```

### 注册外部智能体

v0 的 `RemoteAgent` 与 `CommandAgent` 已删除，当前 Host 不暴露外部智能体
配置。替代实现属于 P3-5 的下一阶段，必须经过 ExecutionWorld，并保留
Thread–Turn–Item、审批、取消、generation lease 与 trajectory lineage。

### 运行在 PostgreSQL 上

每个实例只启用一种存储方言（ADR 0004），通过环境变量选择，默认 SQLite：

```bash
docker run -d --name bee-agent-pg \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bee_agent \
  -p 127.0.0.1:5432:5432 pgvector/pgvector:pg17

BEE_AGENT_STORAGE_DIALECT=postgres \
BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent \
BEE_AGENT_VECTOR_STORE=pgvector \
pnpm --filter @bee-agent/server start
```

`BEE_AGENT_VECTOR_STORE=pgvector` 会把 Vector Store 插件（ADR 0005）挂载到
内核的 `vector-store` 服务键下；它依赖 PostgreSQL 方言，向量保存在独立的表中
（ADR 0006）。它同时启用基于同一存储的工作区记忆：

```bash
bee memory remember -w docs -t "the cat sat on the mat"
bee memory recall -w docs -q "cat mat"
```

PostgreSQL 集成测试需要同样的 URL，未设置时自动跳过：

```bash
BEE_AGENT_STORAGE_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:5432/bee_agent pnpm test
```

## 仓库结构

```text
bee-agent/
├── apps/
│   ├── server/              # Fastify HTTP + SSE 组合根
│   ├── cli/                 # 基于 Commander 的 `bee` 客户端
│   └── web/                 # React 19 + Vite 任务控制台
├── packages/
│   ├── contracts/           # Zod schema 与共享领域/传输类型
│   ├── plugin-sdk/          # 公开的插件清单与生命周期契约
│   ├── kernel/              # Cordis 基座：生命周期、服务、作用域、插件
│   ├── runtime/             # 核心运行时：任务循环、状态机、智能体、策略、工具
│   ├── client/              # 客户端 SDK：REST 命令 + SSE 事件流
│   ├── model-providers/     # OpenAI 兼容的 Agent 与 Embedder 提供商
│   ├── storage/             # 存储与事务边界
│   ├── event-store/         # 只追加事件存储契约
│   └── vector-store/        # 向量存储与嵌入空间边界
├── plugins/
│   ├── storage/sqlite/      # 可用的 SQLite 存储与事件存储
│   ├── storage/postgres/    # 可用的 PostgreSQL 存储与事件存储
│   ├── tools/calculator/    # 旧版目录（v1 逻辑工具已迁入领域包）
│   └── vector/pgvector/     # 可用的 pgvector 向量存储
├── adapters/
│   ├── storage/sqlite/      # v1 SQLite adapter
│   └── tools/
│       ├── command/         # command_run 声明
│       ├── python/          # python_run JSON/stdin 声明
│       └── mcp/             # manifest-pinned MCP stdio 声明
├── python/                  # 未来的 Python worker 项目
├── tests/                   # 共享集成与端到端测试套件
└── docs/                    # ADR 与 v1 架构/重构计划
```

## 开发

| 命令                | 用途                              |
| ------------------- | --------------------------------- |
| `pnpm build`        | 构建所有已实现的 workspace 包     |
| `pnpm typecheck`    | 在整个 workspace 运行严格 TS 检查 |
| `pnpm lint`         | 运行 ESLint                       |
| `pnpm test`         | 运行所有包的测试                  |
| `pnpm format`       | 使用 Prettier 格式化支持的文件    |
| `pnpm format:check` | 只校验格式，不修改文件            |
| `pnpm changeset`    | 描述一次包级别的发布变更          |

### 工作区规则

- 只通过包导出（package exports）引用其他 workspace，绝不引用其内部 `src/`
  路径。
- 核心包保持独立，不依赖具体插件。
- 数据库特定行为保持在存储适配器内部。
- 每个包和插件都有自己的 manifest 与公开边界。
- 为公开契约和生命周期敏感行为添加测试。

## 数据库模型

SQLite 是本阶段唯一可用的数据库适配器。其事件存储通过事务和每任务序列行
来分配单调递增的事件序列，不使用不安全的 `MAX(sequence) + 1` 分配方式。

SQLite 与 PostgreSQL 是两种独立的运行模式：Bee Agent 绝不会同时双写两个
数据库。向量数据也通过独立的 Vector Store 契约与任务事件表分离。

## 路线图

- [x] 初始化 pnpm TypeScript monorepo 与质量工具链
- [x] 定义共享契约与插件 SDK 边界
- [x] 实现 Cordis 内核与任务作用域清理
- [x] 实现并测试 SQLite 事件存储
- [x] 增加任务状态机、策略引擎、计算器工具与模拟智能体
- [x] 增加 HTTP/SSE 服务器、客户端 SDK 与 CLI
- [x] 增加 React Web 界面
- [x] 基于共享存储契约套件实现 PostgreSQL
- [x] 实现 pgvector 与嵌入空间校验
- [x] 在 Vector Store 之上增加记忆运行时
- [x] 基于 OpenAI 兼容 HTTP 增加真实模型提供商
- [x] 基于 stdio 桥接增加 MCP 工具服务器
- [x] 增加选择性启用的 Python worker 工具
- [x] 在 Agent 契约之下增加外部智能体
- [ ] v1 Phase 0：冻结 v0、核心 ADR、新包骨架与 CI 门禁
- [ ] v1 Phase 1：Cordis 基座与 Thread–Turn–Item 协议
- [ ] v1 Phase 2：Kanban、上下文预算与 Skill/Tool 延迟加载
- [ ] v1 Phase 3：统一 ExecutionWorld 与沙箱边界
- [ ] v1 Phase 4：个人记忆、世界模型与长时运行 Host
- [ ] v1 Phase 5：后台学习与受治理的改进
- [ ] v1 Phase 6：体验收敛与 1.0.0 发布

架构决策及其约束记录在 [`docs/adr`](./docs/adr) 中；v1 计划见
[`docs/architecture`](./docs/architecture)。

## 参与贡献

在架构成型阶段，欢迎参与贡献。

1. 先提 issue 讨论重大的行为或公开 API 变更。
2. Fork 仓库并创建一个聚焦的分支。
3. 为你的变更新增或更新测试。
4. 运行 `pnpm build`、`pnpm typecheck`、`pnpm lint` 与 `pnpm test`。
5. 提交 pull request，说明动机、行为与取舍。

请将变更控制在包边界之内，并将重大架构决策记录为 ADR。

## 许可证

Bee Agent 基于 [MIT License](./LICENSE) 发布。
