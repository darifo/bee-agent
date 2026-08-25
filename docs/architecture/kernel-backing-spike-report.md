# Kernel Backing Spike 报告（Stage 0 S0-1）

> 状态：Done
> 关联：`docs/architecture/kernel-opt-development-plan.md` §5.1 Stage 0
> 目标：为"内核底层以何种方式复用 cordis"给出可执行的实证结论
> 日期：2026-08-25

## 1. 结论（TLDR）

**移植 deepseek-harness 的 vendored cordis 4.0.1 源到 `@bee-agent/kernel`，不引入 npm `cordis` 依赖。** cordis@4 实测完整提供本计划所需的 Context/Reflect/Registry/Fiber/inject/scoped effects/响应式依赖/配置热更新语义，且跑通于 Node 22。npm `cordis@4.0.0-rc.8` 仍为 release candidate（API 声明不稳定），不宜作长期基座；而 deepseek-harness 把 cordis 以 `@deepseek-ai/cordis@4.0.1` 形式 vendored 了完整 TypeScript 源（2693 LOC，MIT），可直接移植、自持源码。移植成本（约 2.7k LOC + 约 60 LOC cosmokit 子集）远低于从零自研同量级的异步生命周期。

## 2. Ground truth：cordis@4 实际 API 面

cordis@4（npm `4.0.0-rc.8` 与 vendored `4.0.1` 为同一代码谱系）实际导出（据其 `.d.ts` 与运行时探测）：

| 概念                             | 是否提供 | 说明                                                                                                                                                             |
| -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Context                          | ✅       | 内置 `events`/`logger`/`reflect`/`registry` 服务；`isolate`/`intercept`/`extend`/`root`；Proxy 服务访问（经模块增强 `interface Context` 类型化 `ctx.<service>`） |
| Reflect（服务解析）              | ✅       | `ReflectService`：`get/set/provide/mixin/accessor/notify/trace/bind`，`Impl{name,fiber,value,check}`                                                             |
| Registry（插件注册）             | ✅       | `RegistryService`：`resolve/get/has/delete/plugin/inject`，`Plugin.Runtime{name,fibers,callback,Config}`                                                         |
| Fiber（插件运行实例）            | ✅       | `FiberState` = PENDING/LOADING/ACTIVE/FAILED/DISPOSED/UNLOADING；`effect`/`inject`/`config`/`state`/`dispose`/`restart`/`update`                                 |
| inject                           | ✅       | `Inject` 装饰器 + `Inject.resolve`；函数插件经 `plugin.inject` 声明依赖                                                                                          |
| scoped effects                   | ✅       | `Fiber.effect()`（同步/异步），LIFO、异步可 await、失败可观察                                                                                                    |
| 响应式依赖                       | ✅       | 依赖缺失/消失时 Fiber 退回 PENDING/waiting，出现后重新激活                                                                                                       |
| isolate / intercept              | ✅       | `ctx.isolate(name, label)`、`ctx.intercept(name, config)`                                                                                                        |
| 配置校验                         | ✅       | Standard Schema v1（`@standard-schema/spec`），`ValidationError`                                                                                                 |
| **StructureGeneration**          | ❌       | 不在 cordis，需自研（两代并存 + 引用计数）                                                                                                                       |
| **Turn 结构冻结 / TurnContext**  | ❌       | 需自研                                                                                                                                                           |
| **权限单调收紧 / ContextPolicy** | ❌       | cordis 只有 `intercept`/`filter`，Bee 的权限模型需自研                                                                                                           |
| **A/B/C 替换治理**               | ❌       | cordis 有 restart/update，但 A/B/C 分级需自研                                                                                                                    |
| **Chronicle 集成**               | ❌       | 需自研                                                                                                                                                           |

依赖：`cosmokit`（工具库）、`@standard-schema/spec`（Standard Schema v1 类型）。

### 2.1 vendored 源（deepseek-harness）

deepseek-harness 将 cordis vendored 为 `@deepseek-ai/cordis@4.0.1`（`vendor/cordis`），带完整 TypeScript 源：

| 项        | 值                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| cordis 源 | 2693 LOC（`context/events/fiber/logger/reflect/registry/service/utils`），MIT（原作者 Shigma）                                      |
| cosmokit  | 477 LOC（`vendor/cosmokit`）；内核只用 `Dict`/`Awaitable`/`Promisify` 类型 + `defineProperty`/`isNullable`/`hyphenate`（约 60 LOC） |
| 配置校验  | `@standard-schema/spec`（类型，`fiber.ts`/`registry.ts` 各一处 import）                                                             |
| 相对导入  | `./x.ts`（与本仓库 `allowImportingTsExtensions` + NodeNext 约定一致）                                                               |

移植即：取 cordis 7 个源文件 + cosmokit 约 60 LOC 子集 + `@standard-schema/spec` 类型，剥离 `@deepseek-ai/*` 作用域、保留 MIT 署名。

## 3. Spike 实证结果（最小垂直切片）

在 `/tmp` 用 `cordis@4.0.0-rc.8` + Node 22 验证以下语义，全部通过（vendored 4.0.1 为同一谱系、更晚版本）：

1. **inject + 依赖驱动激活**：带 `inject:['llm','threads']` 的插件先挂载，依赖未齐时保持 `PENDING`；两个依赖分别 `provide` 后才 `LOADING→ACTIVE`。
2. **响应式依赖丢失**：`provide` 返回的 disposer 移除 `llm` 后，依赖它的 Fiber 从 `ACTIVE` 退回 `PENDING`（等待服务重新出现）。
3. **effect 生命周期**：`ctx.effect()` 注册的 disposer 在 `fiber.dispose()` 时按 LIFO 逆序执行，异步 disposer 被 await。
4. **配置热更新**：`fiber.update(newConfig)` 重跑插件体；`fiber.restart()` 再次重跑。
5. **服务访问**：`ctx.provide(name, value)` + `ctx.get(name)` 直接往返。

结论：方案所需的"活的插件图"语义无需自研，直接可用。

## 4. 三种方案对比

| 维度       | npm `cordis@4.0.0-rc.8` 依赖       | 从零自研                                         | 移植 vendored 源（推荐）                           |
| ---------- | ---------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| 代码获取   | 依赖 RC 包                         | 自研 ~1000–1500 LOC（在现有 2.3k LOC 之上）      | 移植 ~2.7k LOC + ~60 LOC 子集                      |
| 运行时依赖 | +cordis +cosmokit +standard-schema | 无                                               | +standard-schema（类型，可内联）                   |
| 稳定性     | RC，API 未冻结                     | 自研，需大量 contract/failure-injection 测试补足 | MIT 源，自持可控                                   |
| 可修改性   | 不能改底层                         | 完全可控                                         | 完全可控                                           |
| 主要风险   | RC 升级破坏 + 供应链               | 异步生命周期边缘问题 + 维护成本                  | 维护 ~2.7k LOC 移植码（MIT 允许 fork，可脱离上游） |

## 5. 推荐与移植清单

**推荐：移植 vendored cordis 源。** 移植清单：

1. vendor cordis 7 个源文件（`context/events/fiber/logger/reflect/registry/service/utils`）+ cosmokit 子集（约 60 LOC）到 `@bee-agent/kernel`；
2. 剥离 `@deepseek-ai/*` 作用域 → `@bee-agent/*`，保留 MIT 署名；
3. 配置校验：保留 `@standard-schema/spec` 类型依赖（或内联 `StandardSchemaV1` 类型）；
4. 工作区不引入 npm `cordis` 包（静态门禁 + ESLint `no-restricted-imports` 强制）；
5. 业务包只 `import '@bee-agent/kernel'`，上层不泄漏 cordis 类型。

## 6. 实施验证结果

- `isolate` 保留 Cordis 的 realm 语义；服务可见性由 Bee `ContextPolicy` 单调收紧；
- 配置/结构更新在 Bee 层创建 candidate `StructureGeneration`，不对执行中的 Turn 原地 restart；单代内部依赖出现/消失仍由 Fiber 响应式重挂载；
- Standard Schema v1 类型已内联，工作区无额外运行时依赖；
- 移植代码位于 `packages/kernel/src/cordis`，`NOTICE.md` 保留 MIT 来源；上游同步是显式维护动作，不自动跟随 npm RC；
- smoke 与 Kernel contract tests 已覆盖 Proxy、inject、Fiber effect、依赖图和 generation 切换。
