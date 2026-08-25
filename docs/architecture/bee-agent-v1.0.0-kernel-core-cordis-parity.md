# 自有 Kernel 核心与 Cordis 的等价性说明

> 状态：v1.0.0（feature/v1.2.0 起）。本文档记录 v1 移除 `cordis` 依赖、用自有实现替代后，内核核心与 cordis 的逐元素对照，作为 Phase 3 决定是否补齐"隐式依赖注入 + 自动重挂载"时的基线。

## 1. 背景

v1 的 Cordis 基座（ADR 0018）最初直接依赖 `cordis@^3.18.1`。在 Phase 1 收尾后，为彻底消除这个唯一的外部运行时依赖，改为自有实现：`packages/kernel/src/context.ts`（约 210 行）替代 `cordis` 的 `Context`，配套的 `EventBus`（`events.ts`）、`EffectScope`（`effects.ts`）、`BeeAgentPlugin`（`plugin.ts`）与插件 handle（`plugin-handle.ts` / `plugin-adapter.ts`）共同构成完整的插件生命周期闭环。

移除后 `@bee-agent/kernel` 只剩 `zod` 一个外部依赖，符合 v1 目标依赖 DAG（`kernel: []`，即不依赖任何内部包）。

## 2. 逐元素对照

cordis 的核心架构由七个元素构成。下表给出每个元素在本项目内核中的对应实现与完整性结论。

| cordis 元素  | 它是什么                                                    | 本项目对应                                                                         | 完整性                                                            |
| ------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Service**  | 插件/服务的基类，把自己注册到 ctx 上                        | `BeeAgentPlugin` 接口（`plugin.ts`）+ `Kernel.useBeeAgentPlugin` + `services` 选项 | ✅ 基本完整（接口而非基类）                                       |
| **Reflect**  | ctx 的代理和服务字典，管 `ctx.xxx` 解析与服务的 provide/get | `Context.get/set`（含 `isolate` 隔离）                                             | ⚠️ 简化（无 accessor/mixin/alias/provide，无 Proxy 属性访问）     |
| **Registry** | 插件注册表，管 `ctx.plugin()` 与按 inject 的依赖启动        | `Context.plugin()`（fork + apply + 追踪异步启动）                                  | ⚠️ 简化（无 inject 依赖解析）                                     |
| **Fiber**    | 插件的运行实例，管生命周期状态、依赖追踪、effect 收集       | `ForkScope` + `CordisPluginHandle`/`CordisBeeAgentPluginHandle`                    | 🟡 部分完整（有状态机/effect 收集，无 inject 追踪/reactive 重启） |
| **effect**   | 可逆注册机制，登记时注册、销毁时逆序清理                    | `Context.effect()` + `EffectScope`（`effects.ts`）                                 | ✅ 完整（且更规范：逆序 + 失败聚合）                              |
| **Events**   | 事件总线，管多种派发模式                                    | `EventBus`（`events.ts`）+ `Context.on/emit`                                       | ✅ 完整（四种模式 + waterfall）                                   |
| **Hook**     | 一条监听器记录，保存 callback 与归属 ctx                    | `Context.#events` 的 `Set<listener>`；`EventBus` 的 `Set`                          | ⚠️ 简化（只存 callback，无 per-hook 归属 ctx/global/prepend）     |

## 3. 完整性分级

### 3.1 完整实现（可直接替换 cordis 语义）

- **effect**：`Context.effect(callback)` 注册的 disposer 随 context dispose **逆序**执行；独立的 `EffectScope`（`effects.ts`，P1-2）进一步提供 `add/release`、逆序释放、失败收集报告。cordis 的 `EffectScope.reset` 是注册顺序且不聚合失败，本项目更严格。
- **Events**：`EventBus` 提供四种派发语义——`dispatch`（serial，注册顺序，首个错误 rethrow）、`emit`（broadcast，每个监听器隔离故障、本身不 reject）、`parallel`（并发，AggregateError 聚合）、`waterfall`（洋葱中间件）。cordis 的 `emit/parallel/serial/bail` 中，`bail`（同步短路）可由 `waterfall` 或 serial 短路表达；本项目反而多了 `waterfall`。

### 3.2 形式不同但功能等价

- **Service**：cordis 用**基类**（继承 + `provide` 自动 `ctx.set(name, self)` + `ctx.on('ready'/'dispose')` 挂钩 start/stop）；本项目用**接口** `BeeAgentPlugin`（manifest + start/stop），由 `Kernel.useBeeAgentPlugin` 显式挂载、经 `services` 选项发布服务。生命周期等价，但不依赖继承。
- **Fiber 的状态与 effect 收集**：cordis 的 `MainScope/ForkScope` 维护 PENDING/LOADING/ACTIVE/FAILED/DISPOSED 状态机；本项目的插件 handle 维护 `mounted/disposed/quarantined` 状态、`ready` promise、`drain`/`healthCheck` 钩子，effect 收集落在 `Context.#effects`。覆盖了运行闭环所需的状态管理。

### 3.3 刻意简化（本项目明确不用的 cordis 重型能力）

| 能力                                                              | cordis 怎么做                                                                            | 为什么不用                                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Reflect.accessor/mixin/alias/provide`                            | 服务增强：把服务方法混入 ctx、给服务起别名、惰性 accessor                                | v1 服务面很小（storage 一个键），全程显式 `get/set`，不需要属性访问语法糖                                                  |
| `Registry.inject` 依赖注入                                        | 插件声明 `inject`，`internal/service` 事件驱动"依赖满足后自动重启插件"                   | v1 的依赖声明在 `manifest.requires/capabilities`（ADR 0018），运行时靠显式装配顺序，不用隐式自动重挂载                     |
| `Hook` 的 per-hook 归属 ctx + `global`/`prepend` + isolate filter | 每条监听器记录其归属 ctx，隔离服务的 `internal/service` 事件经 filter 只传给同隔离监听者 | 本项目用更直接的规则替代：**隔离服务的 `set` 根本不 emit 全局 `internal/service`**，语义更简单，已被 91 个 kernel 测试覆盖 |

## 4. 真实缺口（当前无需求驱动，Phase 3 决策基线）

以"完全复刻 cordis"为标准，存在两点缺口，但均无当前需求：

1. **Fiber 的 reactive config / 自动 restart**：cordis 在插件 config 变化或依赖服务重注册时自动重启插件。本项目 `ForkScope.update(config)` 目前只存配置、不重挂载；热换走的是显式的 `ReplacementCoordinator`（P1-4，A/B/C 分级），而非自动 restart。
2. **Registry 的依赖驱动重挂载**：依赖服务满足后自动启动插件这个机制未实现，靠显式装配顺序保证。

**何时需要补齐**：若 Phase 3 的 ExecutionWorld 需要"能力/依赖变化时自动重绑服务"（例如 sandbox provider 切换自动重建工具），才值得为 `Context.plugin` 引入 inject 声明 + `internal/service` 驱动的重挂载。届时以本文档第 2 节对照表和 cordis 的 `Registry`/`FiberScope` 实现为基线实现。

## 5. 结论

运行一个插件生命周期闭环所需的全部机制——服务注册、effect 逆序释放、事件四模式、fork 与隔离、quarantine 状态机——在本项目内核中是**自洽且完整**的；缺失的是 cordis 那套"隐式依赖注入 + 自动重挂载"的高层编排，而那是 v1 刻意不要、改用显式装配与分级热换替代的部分。
