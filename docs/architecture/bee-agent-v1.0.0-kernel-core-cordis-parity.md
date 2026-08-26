# Bee Kernel 与 Cordis 元素模型对照

> 状态：Superseded by implementation
>
> 日期：2026-08-25
> 决策：ADR 0030

本文曾用于论证“保留最小自有 Context、暂不引入 Proxy/inject/Registry/Fiber”。该结论已被 `feature/kernel-opt` 的源码验证推翻，不再代表当前架构。

## 当前结论

Bee 已把 DeepSeek Harness vendored cordis 4.0.1 的 MIT 源码移植到 `packages/kernel/src/cordis`，所以 Context、Reflect、Registry、Fiber、Events、Service 和 scoped effects 不再是“自有近似物”，而是同一代码谱系上的实现。

| Cordis 元素         | Bee 当前实现                                 | 状态                                               |
| ------------------- | -------------------------------------------- | -------------------------------------------------- |
| Context Proxy       | `kernel/src/cordis/context.ts`               | 完整移植；支持 extend/isolate/intercept            |
| Reflect             | `kernel/src/cordis/reflect.ts`               | 完整移植；负责作用域解析和 Proxy 服务访问          |
| Registry            | `kernel/src/cordis/registry.ts`              | 完整移植；负责 plugin/inject/runtime records       |
| Fiber               | `kernel/src/cordis/fiber.ts`                 | 完整移植；负责依赖、配置、状态、restart 和 effects |
| Events/Hook         | `kernel/src/cordis/events.ts`                | 完整移植；监听器自动归属 Fiber Context             |
| Service             | `kernel/src/cordis/service.ts`               | 完整移植                                           |
| StructureGeneration | `kernel/src/kernel.ts`                       | Bee 扩展；Cordis 本身不提供                        |
| Turn pinning        | `GenerationLease` + Host `PinnedAgentLoop`   | Bee 扩展                                           |
| 权限单调收紧        | `ContextPolicy` / `ContextScope`             | Bee 扩展                                           |
| A/B/C 替换治理      | `Kernel.reconcile()` / `createReconcilePlan` | Bee 扩展                                           |
| 插件安装目录        | `PluginCatalog`                              | Bee 扩展；精确版本、受信任工厂                     |
| 配置热更新          | `StructureConfigController`                  | Bee 扩展；串行、合并、失败保留旧代                 |
| 运行诊断            | `Kernel.doctor()` / quarantine               | Bee 扩展                                           |

## 已清除的旧近似层

旧 `Context`、`EventBus`、`EffectScope`、`TaskScope`、`PluginHandle`、`ReplacementCoordinator` 和相应 testing 出口已删除。项目不得再建立第二套 service map、plugin lifecycle 或 effect ownership。

## 仍然成立的边界

- Cordis/Fiber 只保存瞬时运行状态，Chronicle 保存可回放事实；
- 单代内部的依赖出现/消失由 Fiber 响应式处理；
- A 级配置变化仅在没有 lease 时原地更新；否则通过新 `StructureGeneration`
  切换，不能污染执行中的 Turn；
- 业务代码只依赖 `@bee-agent/kernel`，不得直接依赖 npm `cordis` 或 `cosmokit`；
- 插件通过 `RuntimePlugin.inject` 声明 Proxy 服务访问，通过 `ctx.provide/on/effect` 注册可逆资源。

完整实现和可复制模板见 [Bee Agent 内核升级实施与开发指南](./kernel-opt-development-plan.md)。
