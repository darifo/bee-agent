# Bee Agent 内核升级实施与开发指南

> 状态：Implemented
>
> 分支：`feature/kernel-opt`
>
> 日期：2026-08-25
>
> 迁移策略：clean break；不保留旧 Kernel、Context、EventBus、TaskScope、PluginHandle 或 testing 子路径兼容层

## 1. 结论

Bee Agent 已采用一套 **Cordis 派生的 Context–Registry–Fiber 运行时 + Bee StructureGeneration 治理层**。

Cordis 层负责活的插件图：

- Proxy Context 与作用域服务解析；
- `inject` 驱动的依赖等待、卸载和重新挂载；
- Registry 管理插件运行记录；
- Fiber 管理状态、配置、依赖和 effects；
- `ctx.effect()`、`ctx.on()`、`ctx.provide()` 自动归属当前 Fiber；
- `extend()`、`isolate()`、`intercept()` 提供 Context 派生能力。

Bee 层负责 Cordis 不解决的产品不变量：

- `PluginGraph` 是一次结构期望；
- `StructureGeneration` 是不可变、可引用计数的运行时切片；
- 新结构先 prepare，成功后 activate，再 drain 旧代；
- Turn 通过 `GenerationLease` 固定 `structureVersion` 和服务实现；
- `ContextPolicy` 对子作用域实施单调收紧；
- tier B 使用新 generation 接管新 Turn，tier C 显式返回 restart-required；
- Host 的 Chronicle、Kanban、Model、Tools、AgentLoop 均通过插件提供。
- `PluginFactoryRegistry` 已把 `EffectiveStructure` 转换为真实 `PluginGraph`，`StructureReconciler` 负责持久化并串行应用结构变更。

这不是给旧内核增加一层 Cordis adapter。旧内核已删除，`@bee-agent/kernel` 只有一套公共语义。

## 2. 当前目录结构

```text
packages/kernel/
├── src/
│   ├── cordis/                 # MIT 移植层：Context/Reflect/Registry/Fiber/Events
│   │   ├── NOTICE.md
│   │   ├── context.ts
│   │   ├── events.ts
│   │   ├── fiber.ts
│   │   ├── reflect.ts
│   │   ├── registry.ts
│   │   └── ...
│   ├── kernel.ts               # Kernel、PluginGraph、StructureGeneration、Lease、Policy
│   ├── structure.ts            # Bundle/EffectiveStructure/digest/trace
│   ├── plugin.ts               # 静态插件 manifest schema
│   └── index.ts                # 唯一公共出口
└── tests/
    ├── cordis-port.test.ts
    ├── kernel.test.ts
    └── structure.test.ts

packages/runtime/src/model-request-service.ts # 模型调用、manifest、生命周期事实与重建
packages/runtime/src/tool-execution.ts # Tool intent → ActionRequest → ExecutionWorld
packages/runtime/src/plugin.ts   # ModelRequestService / AgentLoop 标准 RuntimePlugin
apps/bee/src/kernel-runtime.ts   # Host 插件图与 Turn generation pinning

packages/execution/src/execution-world.ts # 授权、审批、幂等、sandbox、diff、审计
```

已删除的旧实现包括：`context.ts`、`effects.ts`、`events.ts`、`emitter.ts`、旧 `kernel.ts` 内容、`replacement.ts`、`task-scope.ts`、`plugin-adapter.ts`、`plugin-handle.ts`、`types.ts`、`testing.ts` 及对应旧测试。`@bee-agent/kernel/testing` 也已移除。

## 3. 与 DeepSeek Harness Cordis 底座的区别

| 维度          | DeepSeek Harness / Cordis                | Bee Agent                                                          |
| ------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| 活插件图      | Context、Registry、Fiber、inject、effect | 移植并保留相同核心语义                                             |
| 结构切换      | 主要是 Fiber 原地 restart/update         | 使用不可变 `StructureGeneration`，新旧两代可并存                   |
| 执行中一致性  | 服务变化可以响应式影响 Fiber             | Turn 持有 generation lease，执行中不会切换 Model/Tool/Loop         |
| desired state | 插件配置与宿主装配                       | `EffectiveStructure` 经 `PluginFactoryRegistry` 生成 `PluginGraph` |
| 持久事实      | 不由 Cordis 负责                         | Chronicle 是事实源；Fiber 只保存瞬时运行状态                       |
| 权限          | Context isolate/intercept/filter         | 叠加 `ContextPolicy`，派生作用域只能收紧                           |
| 替换治理      | restart/update                           | tier B generation replacement；tier C restart-required             |
| 产品组合      | Harness 自身插件体系                     | 单一 `bee` Profile；Host 核心服务全部插件化                        |

因此不需要再替换内核底座；需要长期维护的是 Bee 在 Cordis 之上的治理层，并避免把持久状态塞回 Fiber。

## 4. 核心运行流程

```text
EffectiveStructure / host config
              │
              ▼
      PluginFactoryRegistry
              │
              ▼
         PluginGraph
              │ validate provider uniqueness / missing deps / cycles
              ▼
 candidate StructureGeneration
              │ prepare: mount plugins, await Fiber, health check
              ├── failed ──▶ dispose candidate, keep active generation
              ▼
           activate
              │
              ├── new Turn ──▶ acquire GenerationLease
              │                  └─ fixed structureVersion + service graph
              ▼
       drain old generation
              │
              └── referenceCount == 0 ──▶ reverse Fiber disposal
```

关键规则：

1. 同一个 `structureVersion` 不得表示不同插件图；否则抛 `StructureVersionCollisionError`。
2. required service 必须恰有一个 provider；缺失、重复、依赖环都在 activation 前失败。
3. 插件读取 Proxy service 前必须声明 `inject`；未声明访问会失败。
4. 插件所有资源注册必须发生在 Fiber Context 中，卸载时由 Fiber 逆序释放。
5. candidate 启动失败不得破坏当前 active generation。
6. draining generation 只有在最后一个 lease 释放后才能销毁。
7. tier C 变更不热换，Kernel 暴露 `restartRequired` 和 `restartRequiredPlugins`。
8. Host 不直接调用 `Kernel.reconcile()`；所有变更必须经过 `StructureReconciler`，先写 `structure.resolved` 再激活。

## 5. 可复制的插件开发模板

```ts
import type { Context, RuntimePlugin } from '@bee-agent/kernel'

interface ModelService {
  generate(input: string): Promise<string>
}

interface ToolService {
  execute(name: string, input: unknown): Promise<unknown>
}

interface AgentContext extends Context {
  readonly llm: ModelService
  readonly tools: ToolService
}

export interface AgentPluginConfig {
  readonly maxSteps: number
}

export function createAgentPlugin(
  config: AgentPluginConfig,
): RuntimePlugin<AgentPluginConfig> {
  return {
    id: 'bee.agent',
    version: '1.0.0',
    config,
    inject: ['llm', 'tools'],
    provides: ['agent'],
    replacementTier: 'b',
    apply(ctx, resolvedConfig) {
      const services = ctx as AgentContext
      const agent = {
        run: (input: string) => services.llm.generate(input),
        maxSteps: resolvedConfig.maxSteps,
      }

      ctx.provide('agent', agent)
      ctx.on('host/stop', async () => {
        // optional event cleanup is owned by this Fiber
      })
      ctx.effect(
        () => async () => {
          // close sockets/workers/timers created by this plugin
        },
        'agent:resources',
      )
    },
    healthCheck(ctx) {
      return ctx.get('agent') === undefined
        ? { status: 'unhealthy', detail: 'agent service missing' }
        : { status: 'healthy' }
    },
  }
}
```

不要在插件外保存 `ctx`，不要直接操作 Registry/Reflect 的内部 store，不要使用未托管的 listener、timer、worker 或 socket，不要用 `ctx.get()` 绕过插件内的 `inject` 约束。`ctx.get()` 只用于 Kernel/health/diagnostics 等受控边界。

## 6. 可复制的 Kernel/Host 组合模板

```ts
import { createKernel, type RuntimePlugin } from '@bee-agent/kernel'

const kernel = createKernel({
  onLifecycleEvent(event) {
    console.info(event.type, event.structureVersion)
  },
})

const plugins: RuntimePlugin[] = [
  {
    id: 'bee.model',
    version: '1.0.0',
    provides: ['llm'],
    replacementTier: 'b',
    apply(ctx) {
      ctx.provide('llm', model)
    },
  },
  createAgentPlugin({ maxSteps: 12 }),
]

await kernel.reconcile({
  structureVersion: 'sha256:<effective-structure-digest>',
  plugins,
})

const turn = kernel.beginTurn()
try {
  const agent = turn.service<{ run(input: string): Promise<string> }>('agent')
  await agent.run('hello')
} finally {
  turn.release()
}

await kernel.stop()
```

审批挂起时不能释放 lease。`apps/bee/src/kernel-runtime.ts` 的 `PinnedAgentLoop` 以 `turnId` 保存 lease，在 Turn completed/failed/cancelled 后释放。

## 7. Context 派生和权限模板

```ts
import { ContextPolicy } from '@bee-agent/kernel'

const turn = kernel.beginTurn(new ContextPolicy(['llm', 'tools', 'agent']))
const subagent = turn.scope.derive(['llm', 'tools'])
const toolOnly = subagent.derive(['tools', 'root-secret'])

toolOnly.service('tools') // allowed
toolOnly.service('llm') // RestrictedServiceAccessError
toolOnly.service('root-secret') // RestrictedServiceAccessError
```

`restrict()` 取父集合与子集合的交集，所以子 Context 不能扩大权限。需要同名服务的 agent-scoped 注册时，先对该服务调用 `scope.isolate(serviceName, agentLabel)`，再在派生 Context 的 Fiber 内 `provide`。

## 8. 测试与门禁

```bash
pnpm --filter @bee-agent/kernel typecheck
pnpm --filter @bee-agent/kernel test
pnpm --filter @bee-agent/kernel build
pnpm --filter @bee-agent/runtime typecheck
pnpm --filter @bee-agent/bee typecheck
pnpm test:boundaries
node scripts/check-package-boundaries.mjs
```

边界扫描现在覆盖 `packages/*`、`apps/bee` 和 SQLite adapter，并禁止业务代码直接依赖 npm `cordis`/`cosmokit`。业务包只能通过 `@bee-agent/kernel` 使用内核能力。

Host 提供两个本地管理入口：`GET /structure` 查看 active generation、restart-required 和 Fiber 快照；`POST /structure/reconcile` 提交经过 `EffectiveStructureSchema` 校验的结构。配置文件或 Bundle watcher 应调用同一 `BeeServer.reconcileStructure()` 边界，不得绕过协调器。

内核测试覆盖：Proxy 服务解析、inject 等待、依赖出现后激活、effects LIFO 清理、未声明访问失败、缺失依赖、provider 冲突、依赖环、candidate 回滚、generation pinning、tier C、结构版本碰撞和 ContextPolicy 单调收紧。

## 9. ModelRequest 与恢复确定性（已完成）

模型 Provider 不再由 `AgentLoop` 直接调用。标准链路为：

```text
AgentLoop
  └─ modelRequest.generate()
       ├─ atomically append: context.manifest + model.requested
       ├─ LlmRuntime.generate()
       └─ append: model.completed | model.failed
```

每个 request 使用独立 `model-request:<requestId>` Chronicle stream。`model.requested` 保存按 section 切分的 canonical source snapshot 和整个 `ContextBundle` 的摘要；`ContextManifest` 保存 rendererVersion、priority、tokens 和 section digest。`rebuildModelRequest()` 必须先逐 section 复算 digest，再复算 bundle digest，任何漂移都显式失败。

`AgentLoop` 的 checkpoint 恢复遵守以下不变量：

1. checkpoint 的 `stepIndex` 就是下一次调用的索引，恢复时不得再次 `+1`；
2. assistant tool calls 与工具结果的 exact `content` / `isError` 必须进入 Thread Item；
3. 从 committed Item 重建 history 后必须复算 `stateDigest`；
4. 不匹配时追加 `agent.recovery_failed` 并抛出 `CheckpointDigestMismatchError`，禁止带着漂移状态继续执行；
5. ModelRequestService、ToolExecution、Model、ToolExecutor、AgentLoop 都是 tier B 插件，结构变化通过新 generation 接管新 Turn。

## 10. ExecutionWorld（核心管线已完成）

AgentLoop 不再直接调用工具。标准链路为：

```text
LLM tool intent
  → ToolExecutor.describe()       # 展开 capability / resources / effects
  → ActionRequestSchema           # 完整校验
  → StaticAuthorizationPolicy     # deny-by-default；deny → ask → allow
  → durable approval              # Thread Approval Item + generation lease
  → SecretBroker.materialize()    # 仅引用晚绑定；无 broker 时 fail closed
  → SandboxProvider               # capability report 不足时 fail closed
  → snapshot → execute → snapshot → diff
  → execution.completed | execution.failed
```

每个动作使用 `tool:<turnId>:<callId>` 作为幂等键，并写入独立 `execution:<sha256(idempotencyKey)>` stream：

- 已完成动作直接返回持久化结果，不再次产生副作用；
- 相同幂等键对应不同 ActionRequest 时抛 `IdempotencyKeyCollisionError`；
- 已写 `execution.started` 但没有 durable result 时返回 `reconciliation-required`，禁止盲目重放；
- 审批详情由展开后的 input、路径、网络目标、命令、`secretEnv` 引用、预期副作用和验证方式生成，不采用模型自然语言标题；
- 读写路径、工作目录和 executable 必须是绝对路径，并在授权、审批和幂等摘要之前解析 symlink 与不存在路径的最近现存父目录；
- 未声明 capability 默认 deny；结构中未启用的工具不会进入授权规则；
- `InProcessToolSandbox` 只允许不需要文件、网络或进程隔离的逻辑工具。遇到这些要求会因 capability report 不足而拒绝，不能退化为裸执行。
- `RoutingSandboxProvider` 按完整 ActionRequest 选择逻辑或平台 provider，并保证 snapshot/diff 归属同一 provider；
- `PlatformCommandSandbox` 在 macOS 使用 Seatbelt、Linux 使用 bubblewrap；启动前做真实可用性探测，宿主不允许嵌套沙箱时 capability report 返回 false；
- 子进程不使用 shell、不继承 `process.env`，只注入 `secretEnv` 指定的晚绑定值；timeout、输出上限与 `AbortSignal` 会终止整个 detached process group；
- `MacOSKeychainSecretBroker` 使用 `keychain:<service>/<account>` 引用，通过 `/usr/bin/security` 晚绑定并对结果、diff 和错误统一脱敏；
- 静态包边界禁止 `packages/execution` 之外导入 `child_process`，新增执行能力不能绕过 ExecutionWorld。

当前完成的是 ExecutionWorld 核心契约、逻辑工具 provider、Seatbelt/bwrap 首版、进程树取消、Keychain SecretBroker、Host/AgentLoop 路由，以及正式的 `command_run` / `python_run` / MCP stdio adapters。新的 `ToolAdapter` 契约把 model spec、默认 authorization 和 executor/resolver 绑定为单一注册单元，Host 自动派生 Structure 和规则并拒绝重名，避免三份配置漂移。Command adapter 收敛 executable/workspace/resources；Python adapter 固定 native interpreter 并声明 bounded JSON stdin；MCP adapter 固定 Host-reviewed manifest，并用通用 staged JSON-lines 描述完成 initialize→initialized→tools/call。所有 adapter 的 `execute()` 都 fail closed，stdin pipe、协议推进与真实进程只能由平台 provider 创建；纯 `present()` 负责把已持久化的沙箱结果映射成模型内容。沙箱外 macOS 契约覆盖 approval、Seatbelt、stdin/staged stdio 和进程组回收。Linux bwrap 仍需在 Linux CI 做真实契约验收，RemoteAgent 尚未迁入，因此 Phase 3 还不能标记完成。

## 11. 后续开发边界

本次内核 clean break 已完成。以下是建立在新内核上的后续产品工作，不应重新引入第二套内核抽象：

- 完成 hard deny、Structure permission、task scope、plugin declaration 与 sandbox capability 的完整交集权限快照；
- 把 ContextBudget 的压缩决策直接接入 ModelRequestService，而非只记录最终 bundle；
- 以同一声明/执行分离模式完成 RemoteAgent adapter，并补 Linux bwrap、网络逃逸与跨平台孤儿进程 CI 契约测试；
- 扩展 SecretBroker 的 artifact/日志扫描，并实现非 macOS 的系统凭据 provider；
- 完成多 tool-call 的并行调度、失败隔离和 batch 级 checkpoint；
- 为 generation/Fiber 增加 doctor 输出、故障注入和长时泄漏测试。

这些能力应作为 runtime/protocol/observability 层继续演进，而不是修改 Context–Registry–Fiber 的基本所有权模型。
