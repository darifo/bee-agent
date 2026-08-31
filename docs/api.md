# Bee Agent Host HTTP API 参考

> 适用：`feature/v1.4.0` 合并后的 `main`（Phase 4 完成）。
> 认证：除 `GET /health` 外，所有请求必须携带 `Authorization: Bearer <BEE_AGENT_SESSION_TOKEN>`。
> CORS：默认仅放行 loopback 来源，不反射任意 Origin。
> 数据语义：所有写入都是 Chronicle append-only 事实；所有只读视图（world/trajectory/structure/memory 导出）都是对这些事实的投影，可随时重建。

## 会话与线程（Thread–Turn–Item）

| 方法 | 路径                                                     | 说明                                                                                                                                |
| ---- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/threads`                                               | 创建线程，body `{title?, workspaceId?, memoryView?}`，返回 Thread，201                                                              |
| POST | `/threads/:threadId/turns`                               | 运行一轮对话，body `{input, structureVersion?}`；返回 `completed`（含 output）/`failed`/`cancelled`/`suspended`（含 approval 信息） |
| POST | `/threads/:threadId/turns/:turnId/approvals/:approvalId` | 裁决挂起的审批，body `{decision: 'approved'\|'rejected'}`，续跑该 Turn                                                              |
| GET  | `/threads/:threadId/items`                               | SSE 事件流（`text/event-stream`）；支持 `Last-Event-ID` 头或 `?after=<sequence>` 断线续传，`?limit=` 分页，15s 心跳                 |

Turn 的 `trigger` 字段区分来源：`user`（用户请求）与 `schedule`（调度器发起）。

会话语义：同一 thread 的 Turn 是连续对话——每个新 Turn 的模型可见历史都携带
此前所有 Turn 已完成的用户/助手消息与工具结果（按事件序）。上下文增长由两级压缩
在模型可见视图上处理：超出预算的旧工具结果被省略为占位符（manifest 记录
omission）；接近模型窗口阈值时，被覆盖的历史前缀经一次持久化模型调用压缩为
摘要，并以 `context.compacted` 事件落盘（SSE 流中可见：`summary`、
`coveredMessageCount`、`coveredDigest`）。完整历史始终保留在 Chronicle，日志只增不改。

## Kanban 任务平面

| 方法        | 路径                             | 说明                                                             |
| ----------- | -------------------------------- | ---------------------------------------------------------------- |
| POST / GET  | `/kanban/tasks`                  | 创建（201）/列表（过滤 `status`、`priority`、`labels`、`limit`） |
| GET / PATCH | `/kanban/tasks/:taskId`          | 详情 / 字段更新（`expectedVersion` 乐观并发）                    |
| POST        | `/kanban/tasks/:taskId/block`    | 转入 blocked（带 reason/依赖）                                   |
| POST        | `/kanban/tasks/:taskId/comment`  | 追加评论                                                         |
| POST        | `/kanban/tasks/:taskId/complete` | 完成（须处于合法前置状态，如 running/review）                    |
| POST        | `/kanban/tasks/:taskId/cancel`   | 取消                                                             |

状态机：`inbox→triaged→ready→running→{blocked\|review}→done`，任何活跃状态可转 `failed/cancelled/archived`；`running→ready` 为租约到期归还。

## 个人记忆（治理）

| 方法 | 路径                              | 说明                                                                                                                 |
| ---- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GET  | `/memory/claims`                  | 查看已记忆的声明，可按 `?status=active\|superseded\|retracted`、`?kind=preference\|fact\|correction\|procedure` 过滤 |
| POST | `/memory/claims/:claimId/retract` | 遗忘一条声明，body `{reason?}`；retract 是持久事件，声明保留在导出中                                                 |
| POST | `/memory/consolidate`             | 手动合并重复声明（近线派生会自动积累，此接口用于显式整理）                                                           |
| GET  | `/memory/export`                  | 导出全部声明与观察（含 provenance 与 validTime）                                                                     |

召回不需要调用方触发：Turn 生成前由 retrieve hook 按预算自动注入模型上下文；Turn 完成后近线派生自动提取偏好/纠正。远程记忆经 `BEE_AGENT_MEMORY_REMOTE_URL` 启用，断路器打开时召回优雅跳过，健康迁移持久化在 `memory` 流。

## 世界模型（只读）

| 方法 | 路径     | 说明                                                                                                                                                                |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/world` | 版本化世界投影快照：`version`、`digest`、`entities`、`relations`；过滤 `?kind=actor\|resource\|capability\|location`、`?type=used\|depends_on\|...`、`?entity=<id>` |

事实只能经带来源 projector 进入（当前默认启用工具使用与执行资源两个 projector），每条 relation 携带精确 Chronicle 位置。

## 长时运行调度

| 方法       | 路径                             | 说明                                                                                                                                                            |
| ---------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET / POST | `/scheduler/triggers`            | 列出/注册触发器。三类互斥触发条件：一次性 `at`、周期 `intervalMs`、条件 `when.taskStatus`（Kanban 任务到达状态，停机可追赶）或 `when.event`（匹配事件边沿触发） |
| POST       | `/scheduler/tick`                | 手动触发一次求值（Host 默认每 5s 自动 tick）                                                                                                                    |
| DELETE     | `/scheduler/triggers/:triggerId` | 移除触发器，body `{reason?}`                                                                                                                                    |

触发器绑定一个 threadId，每次触发以注册的 input 续跑该线程；停机错过的周期按 fire-once 合并（响应含 `missedIntervals`）并按原节律恢复。

## 轨迹回放（只读）

| 方法 | 路径                                          | 说明                                                                                                                                                                                   |
| ---- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/threads/:threadId/turns/:turnId/trajectory` | 该 Turn 的因果链：`generations`（stepIndex/attempt、structureVersion、inputDigest、stopReason、usage）、`tools`（capability、授权 decision、outcome、execution 流位置）、`checkpoints` |
| GET  | `/model-requests/:requestId/replay`           | 精确重放某次模型调用的可见上下文（manifest + sources + 重建 bundle，digest 校验）                                                                                                      |

## 后台学习（Phase 5，治理）

| 方法 | 路径                                         | 说明                                                                                                  |
| ---- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| POST | `/learning/run`                              | 手动跑一次慢循环（Selection→Derivation→Consolidation→Pattern），返回运行报告；Host 默认每小时自动运行 |
| GET  | `/learning/budget`                           | 当前循环预算（轨迹上限/每次提案上限/各阈值）                                                          |
| GET  | `/learning/proposals`                        | 提案列表，过滤 `?status=`、`?type=`、`?origin=loop\|user`、`?autonomyLevel=0-3`、`?limit=`            |
| GET  | `/learning/proposals/:proposalId`            | 提案详情（假设、证据轨迹、预期收益、风险、评测与回滚计划）                                            |
| POST | `/learning/proposals/:proposalId/transition` | 用户驱动的生命周期迁移，body `{to, expectedVersion, reason?}`；非法迁移或过期版本返回 409             |

提案生命周期：`draft → testing → review → trial → promoted`，任一非终态可 `rejected`，`trial/promoted` 可 `rolled-back`。循环只产出提案、绝不直接改变行为；每次运行都有持久审计事实。

## 结构治理（本地管理面）

| 方法 | 路径                   | 说明                                                                                          |
| ---- | ---------------------- | --------------------------------------------------------------------------------------------- |
| GET  | `/structure`           | active 结构、`lineage`（版本相位史/替代链）、kernel `generations`/`doctor`、configSource 状态 |
| POST | `/structure/reconcile` | 提交 EffectiveStructure（digest 复算校验），失败保留当前 generation                           |

文件部署可用 `BEE_AGENT_STRUCTURE_FILE` 指向结构 JSON，变更自动热重载。

## 健康检查

| 方法 | 路径      | 说明           |
| ---- | --------- | -------------- |
| GET  | `/health` | 免认证存活探针 |

## 环境变量速查

| 变量                                                                            | 作用                                                                                                       |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `BEE_AGENT_MODEL_API_KEY` / `BEE_AGENT_MODEL_NAME` / `BEE_AGENT_MODEL_BASE_URL` | OpenAI 兼容模型接入（必填前两项）                                                                          |
| `BEE_AGENT_SESSION_TOKEN`                                                       | 会话令牌；非 loopback 监听必填                                                                             |
| `BEE_AGENT_HOST` / `BEE_AGENT_PORT`                                             | 监听地址（默认 127.0.0.1:3000）                                                                            |
| `BEE_AGENT_DATA_DIR`                                                            | 统一个人数据目录（默认 macOS `~/Library/Application Support/bee-agent`、Linux `$XDG_DATA_HOME/bee-agent`） |
| `BEE_AGENT_STORAGE_SQLITE_FILENAME`                                             | 显式 SQLite 文件名（覆盖数据目录默认落位）                                                                 |
| `BEE_AGENT_STRUCTURE_FILE`                                                      | 结构热重载文件                                                                                             |
| `BEE_AGENT_MEMORY_REMOTE_URL` / `BEE_AGENT_MEMORY_REMOTE_TOKEN`                 | 远程记忆（HTTP transport + 断路器）                                                                        |
| `BEE_AGENT_COMMAND_*` / `BEE_AGENT_PYTHON_*` / `BEE_AGENT_MCP_MANIFESTS`        | 可选外部工具（未配置不进模型上下文）                                                                       |
