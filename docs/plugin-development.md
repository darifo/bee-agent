# Bee Agent 插件开发指南

> 适用：v1 插件体系（Cordis 派生 Context–Registry–Fiber 内核 + Bee
> StructureGeneration 治理层）。内核规则全文见
> [`architecture/kernel-opt-development-plan.md`](./architecture/kernel-opt-development-plan.md)；
> 本页只讲"怎么写一个能跑的插件"。

## 1. 模型速览

一个插件 = 一个带元数据的对象，`apply(ctx)` 在挂载时运行：

```ts
import type { Context, RuntimePlugin } from '@bee-agent/kernel'

export interface MyService {
  greet(name: string): string
}

export function createMyPlugin(config: { greeting: string }): RuntimePlugin {
  return {
    id: 'bee.my-plugin', // 唯一 id
    version: '1.0.0',
    config, // 参与结构 digest；tier A 热更新即改它
    inject: ['chronicle'], // 必须声明你要用的服务，未声明访问会失败
    provides: ['myService'], // 你对外提供的服务名
    replacementTier: 'b', // a=原地配置更新 b=换代 c=需重启
    apply(ctx) {
      const services = ctx as Context & { chronicle: unknown }
      const service: MyService = {
        greet: (name) => `${config.greeting}, ${name}!`,
      }
      ctx.provide('myService', service)
      // 所有资源必须经 ctx 注册，卸载时按逆序自动清理：
      ctx.effect(
        () => () => {
          /* 关 sockets/timers/workers */
        },
        'my-plugin:resources',
      )
      ctx.on('host/stop', async () => {
        /* 可选事件清理 */
      })
    },
    healthCheck() {
      return { status: 'healthy' } // 候选代 prepare 时会调用；unhealthy 则整代回滚
    },
  }
}
```

## 2. 五条硬规则

1. **先声明后使用**：`inject` 里没写的服务，`ctx` 上访问直接报错；
2. **资源必须托管**：timer/listener/socket 只能通过 `ctx.effect()/ctx.on()`
   注册——自己 `setInterval` 的插件换代会泄漏；
3. **不要保存 ctx**：插件外持有 Context 引用会让生命周期治理失效；
4. **持久状态只进 Chronicle**：Fiber 是瞬时运行状态；跨重启的事实必须走
   事件流（见 §5）；
5. **一个服务恰好一个 provider**：重复提供同一个服务名在激活前就会失败。

## 3. 替换分级（replacementTier）

| tier | 语义               | 换代会发生什么                                                                |
| ---- | ------------------ | ----------------------------------------------------------------------------- |
| `a`  | 纯配置变化         | 无运行中 Turn 时原地 `Fiber.update()`，失败自动回滚；有 Turn 时自动升级为换代 |
| `b`  | 实现/依赖/拓扑变化 | 新旧两代并存：新 Turn 用新代，进行中 Turn 钉在旧代跑完                        |
| `c`  | 进程级资源         | 不热换，报告 restart-required                                                 |

选 `a` 能让用户改配置零中断；拿不准就选 `b`（默认值）。

## 4. 从配置到运行：结构管线

```
Bundle（含 includes 组合） ──resolve──▶ EffectiveStructure（canonical sha256 digest）
      │                                        │
      ▼                                        ▼
PluginCatalog（精确 id@version 受信注册）   structure.resolved 事件入 Chronicle
                                               │
                                               ▼
                              StructureReconciler → Kernel.reconcile
                                               │
                        prepare(挂载+健康检查，失败保旧代) → activate → drain 旧代
```

要点：

- **Bundle 只能"选择"Catalog 里已注册的 `id@version`**——配置永远不能触
  发任意路径的动态导入；`entry` 字段只是包元数据；
- manifest 的 `requires`/服务声明/`replacementTier` 是**权威**，会覆盖工
  厂自报的值（工厂不能自己给自己授权）；
- 外部提交的 EffectiveStructure 会**复算 digest**，不匹配在创建插件图之
  前就被拒绝。

注册进 Catalog 的插件需要 manifest：

```ts
catalog.register({
  manifest: {
    id: 'my-plugin',
    name: 'My Plugin',
    version: '1.0.0',
    engine: { pluginApi: '1' }, // 必须匹配 BEE_PLUGIN_API_VERSION
    requires: [], // 依赖的服务名
    capabilities: [{ type: 'service', name: 'myService' }],
    permissions: [], // 如需执行能力在此声明
    replacementTier: 'b',
    entry: './dist/index.js',
  },
  create(entry) {
    return createMyPlugin(entry.config)
  },
})
```

## 5. 需要持久事实？走 Chronicle

插件不做自己的数据库。定义你的事件类型并注册：

```ts
import { newChronicleEvent } from '@bee-agent/knowledge'

registry.register('my.thing.happened', {
  payload: z.object({ detail: z.string() }),
})

await store.append(
  `my-things`, // 一条序列化流
  [
    newChronicleEvent({
      eventType: 'my.thing.happened',
      actor: { type: 'agent', id: 'bee' },
      payload: { detail: '…' },
    }),
  ],
  { expectedSequence: (await store.getLatestSequence('my-things')) + 1 },
)
```

重放即恢复：投影类插件（参考 memory-bee / kanban 的做法）在启动时
`rebuild()` 重放自己的流。大 payload 不要直接进事件——用内容寻址
ArtifactStore 存引用。

## 6. 需要执行副作用？没有直路

插件**不能** import `child_process`（仓库级静态边界强制，唯一例外是
`packages/execution`）。唯一路径是把能力声明成 ToolAdapter，交给
ExecutionWorld：声明（describe）/执行（execute）分离，执行必经授权 →
审批 → 沙箱。参考 `adapters/tools/command` —— 它的 `execute()` 只有
一行：`throw new Error('must be executed by PlatformCommandSandbox')`。
这不是形式：声明层坏了最坏是一次报错的 Turn，执行层绕过就是安全事故。

## 7. 调试与验收清单

```bash
pnpm --filter @bee-agent/<你的包> typecheck && pnpm --filter @bee-agent/<你的包> test
pnpm lint        # 含包边界检查：依赖方向、spawn 禁令都会在这里拦
pnpm test        # 全仓 559+ 测试
```

提交前自检：

- [ ] `inject` 与实际用到的服务一致；
- [ ] 所有可释放资源都经 `ctx.effect/on` 注册；
- [ ] 持久状态在 Chronicle 事件里，Fiber 里只有投影；
- [ ] `healthCheck` 覆盖真实可用性（不只是返回 healthy）；
- [ ] tier 选择正确（纯配置变化选 `a`）；
- [ ] 事件 payload 有 Zod schema 并注册到 registry；
- [ ] `pnpm lint` 的边界扫描通过。

## 8. 参考实现（按复杂度递增）

| 想写什么                | 读哪里                                                   |
| ----------------------- | -------------------------------------------------------- |
| 纯服务插件              | `apps/bee/src/kernel-runtime.ts` 的 `servicePlugin()`    |
| 带 Chronicle 投影的领域 | `packages/kanban/src/store.ts`（ChronicleKanbanStore）   |
| 工具声明                | `adapters/tools/command/src/index.ts`                    |
| 领域契约 + 契约套件     | `packages/knowledge/src/memory.ts` + `memory-testing.ts` |
| 后台循环插件            | `packages/learning/src/loop.ts`                          |
