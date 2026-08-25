# 自有 Kernel 核心与 Cordis 的等价性说明

> 状态：v1.0.0（feature/v1.2.0 起）。本文档记录 v1 移除 `cordis` 依赖、用自有实现替代后，内核核心与 cordis 的逐元素对照。参考实现为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `vendor/cordis/src/`（`context.ts`/`fiber.ts`/`reflect.ts`/`registry.ts`/`service.ts`/`events.ts`）。作为 Phase 3 决定是否补齐"隐式依赖注入 + 自动重挂载"时的基线。

## 1. 背景

v1 的 Cordis 基座（ADR 0018）最初直接依赖 `cordis@^3.18.1`。Phase 1 收尾后，为消除这个唯一的外部运行时依赖，改为自有实现：`packages/kernel/src/context.ts`（约 210 行）+ 配套的 `EventBus`（`events.ts`）、`EffectScope`（`effects.ts`）、`BeeAgentPlugin`（`plugin.ts`）与插件 handle（`plugin-handle.ts`/`plugin-adapter.ts`）。移除后 `@bee-agent/kernel` 只剩 `zod` 一个外部依赖。

## 2. Cordis 的元素模型

vendor cordis 把内核拆成八个元素，其中 **Context 是组合根**：它自身只做 Proxy 外壳与作用域派生，服务解析、插件注册、事件、生命周期分别由四个内置服务承载：

| 元素         | 文件          | 它是什么             | 它管什么                                                                                  |
| ------------ | ------------- | -------------------- | ----------------------------------------------------------------------------------------- |
| **Context**  | `context.ts`  | Proxy 外壳 + 组合根  | 属性读走服务解析；`extend/isolate/intercept` 派生子 context；`root`/`baseUrl`/`static is` |
| **Service**  | `service.ts`  | 插件/服务的基类      | `super(ctx, name)` 把自己注册到 `ctx.reflect.provide`；`invoke/check/extend` 等符号       |
| **Reflect**  | `reflect.ts`  | ctx 的代理和服务字典 | `ctx.xxx` 怎么解析、服务怎么 provide/get/set/accessor/mixin/alias                         |
| **Registry** | `registry.ts` | 插件注册表           | `ctx.plugin()`、按 `inject` 依赖启动/重挂载                                               |
| **Fiber**    | `fiber.ts`    | 插件的运行实例       | 生命周期状态、依赖追踪、effect 收集、update/restart                                       |
| **effect**   | （Fiber 内）  | 可逆注册机制         | 注册时登记、销毁时逆序清理                                                                |
| **Events**   | `events.ts`   | 事件总线             | 五种派发模式 + Hook 记录                                                                  |
| **Hook**     | `events.ts`   | 一条监听器记录       | 保存 callback、归属 ctx、prepend/global 标记                                              |

## 3. 逐元素对照

| cordis 元素  | 本项目对应                                                       | 完整性                                                 |
| ------------ | ---------------------------------------------------------------- | ------------------------------------------------------ |
| **Context**  | `Context`（`context.ts`）单体类                                  | ⚠️ 单体合并，无 Proxy/intercept/logger                 |
| **Service**  | `BeeAgentPlugin` 接口（`plugin.ts`）+ `Kernel.useBeeAgentPlugin` | ✅ 基本完整（接口而非基类）                            |
| **Reflect**  | `Context.get/set`（含 `isolate`）                                | ⚠️ 简化（无 accessor/mixin/alias/provide）             |
| **Registry** | `Context.plugin()`                                               | ⚠️ 简化（无 inject 依赖解析）                          |
| **Fiber**    | `ForkScope` + `CordisPluginHandle`/`CordisBeeAgentPluginHandle`  | 🟡 部分完整（有状态机/effect，无 inject 追踪/restart） |
| **effect**   | `Context.effect()` + `EffectScope`（`effects.ts`）               | ✅ 完整（逆序 + 失败聚合）                             |
| **Events**   | `EventBus`（`events.ts`）+ `Context.on/emit`                     | 🟡 四种模式，缺 `bail` 同步短路                        |
| **Hook**     | `Context.#events` 的 `Set<listener>`                             | ⚠️ 简化（只存 callback）                               |

## 4. Context 元素详解（本次补充）

vendor cordis 的 `Context` 是**薄组合根**，它自己几乎不含业务逻辑，只做四件事：

1. **Proxy 外壳**：`new Proxy(this, ReflectService.handler)`，普通属性读（`ctx.xxx`）经反射层解析成服务；`set` 反向写入服务。
2. **组装内置服务**：构造时装配 `fiber`、`reflect`、`registry`、`events`、`logger` 五个服务实例。
3. **作用域派生**（三个纯函数，都不变更父 context）：
   - `extend(meta)`：prototype 继承 + 自身属性覆盖，产生任意子 context；
   - `isolate(name, label)`：基于 `extend` 给 `name` 换一个 `symbols.isolate` 标签，实现服务作用域隔离（相同 `label` 合并作用域）；
   - `intercept(name, config)`：基于 `extend` 给 `name` 加 intercept 配置，插件启动时合并进该服务的 config。
4. **跨 context 元信息**：`root`（根引用）、`baseUrl`（相对插件路径解析）、`static is()`（用全局 symbol 跨 realm 判型）。

本项目的 `Context`（`context.ts`）把上述第 1、2 点**内联进一个单体类**，而非 Proxy + 组合服务：

- 服务解析（`get`/`set`）直接内联，不再有独立的 `ReflectService`，也没有 `ctx.xxx` 属性访问语法（全程显式 `get/set`）。
- 插件注册（`plugin`）直接内联，不再有独立的 `RegistryService`。
- 事件（`on`/`emit`）直接内联，`EventBus` 只承载带语义的派发模式。
- `isolate` 等价于 cordis 的 `isolate`（相同 realm 合并作用域，被 kernel 测试覆盖）。
- `root` 有 getter；`baseUrl` 用 `baseDir` 替代（用途不同，v1 不做插件模块路径解析）。
- **没有** `extend`（通用子 context 派生由 `plugin`/`isolate` 内部的 `new Context(config, parent)` 表达）、**没有** `intercept`、**没有** `logger`、**没有** `static is`（v1 单进程、无跨 realm 需求）。

## 5. 完整性分级

### 5.1 完整实现

- **effect**：`Context.effect` 注册的 disposer 随 context dispose 逆序执行；独立 `EffectScope`（P1-2）再提供 `add/release`、逆序、失败收集。比 cordis 更严格。
- **Service 的生命周期等价**：接口 + 显式挂载替代基类 + 自动注册，功能等价。

### 5.2 刻意简化（v1 明确不用）

| 能力                                                | cordis 怎么做                         | 为什么不用                                                          |
| --------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| Proxy 属性访问 `ctx.xxx`                            | 属性读走反射层                        | 服务面小（storage 一个键），显式 `get/set` 更直白                   |
| `Reflect.accessor/mixin/alias`                      | 服务混入/别名/惰性访问器              | 从不需要                                                            |
| `Registry.inject`                                   | 声明依赖，服务满足后自动启动/重启插件 | 依赖在 `manifest.requires/capabilities`，靠显式装配顺序（ADR 0018） |
| `intercept`                                         | 服务 config 拦截合并                  | 无此需求                                                            |
| `logger` 内置服务                                   | 内建日志门面                          | Host 层用 fastify logger，kernel 不内建日志                         |
| `Hook` 的归属 ctx + prepend/global + isolate filter | 每条监听器记录归属与过滤              | 用更直接规则替代：隔离服务的 `set` 不 emit 全局 `internal/service`  |

## 6. 真实缺口（当前无需求驱动，Phase 3 决策基线）

1. **Events 缺 `bail` 同步短路**：vendor cordis 五种派发（`emit`/`parallel`/`serial`/`bail`/`waterfall`），本项目 `EventBus` 实现了四种（`dispatch`=serial / `emit`=broadcast / `parallel` / `waterfall`），缺 `bail`。当前可用 serial + 同步 listener 或 waterfall 短路近似，无独立需求。
2. **Fiber 的 inject 追踪 / reactive config / 自动 restart**：vendor cordis 的 `Fiber.update()` 校验 config 后 `restart()`，`inject` 依赖变化由 `internal/service` 事件驱动重挂载。本项目 `ForkScope.update` 只存配置、不重挂载；热换走显式 `ReplacementCoordinator`（P1-4）。
3. **Registry 的依赖驱动重挂载**：依赖满足后自动启动插件未实现，靠显式装配顺序。

**何时补齐**：若 Phase 3 的 ExecutionWorld 需要"能力/依赖变化时自动重绑服务"（例如 sandbox provider 切换自动重建工具），再为 `Context.plugin` 引入 inject 声明 + `internal/service` 驱动的重挂载，并以 vendor cordis 的 `fiber.ts`/`registry.ts` 为基线。

## 7. 结论

运行一个插件生命周期闭环所需的全部机制——服务注册、effect 逆序释放、事件派发、fork 与隔离、quarantine 状态机——在本项目内核中自洽且完整；缺的是 cordis 那套"隐式依赖注入 + 自动重挂载"的高层编排，以及 Proxy 属性访问等语法糖，而那是 v1 刻意不要、改用显式装配与分级热换替代的部分。
