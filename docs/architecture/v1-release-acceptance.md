# v1.0.0 发布验收报告（方案 §20）

> 分支：`develop`（收官审计时点）
> 基线：559 workspace tests 全绿（1 平台性 skip）；build / typecheck /
> lint + 包边界 / format 全部通过；CI 绿（含 Ubuntu bubblewrap 真实
> 沙箱契约）。
> 本报告逐项核验方案 §20.1–§20.6，标注证据（测试/提交/文档）与残余
> 背离。结论：**六组标准全部满足或有明确记录的等价实现**，可以定版。

## 20.1 简单且好用

| 标准                                        | 结论    | 证据                                                                                                                    |
| ------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| 默认安装不要求 PG/容器/多常驻服务           | ✅      | 默认单进程 + SQLite + 统一数据目录（ADR 0027）；`resolveBeeDataDir` 测试                                                |
| 一个 Host 承载同人的连续 Thread/记忆/Skills | ✅      | Thread 流 + memory 流 + Skill Registry 同库；重启全量恢复有测试（memory/kanban/structure/scheduler 四投影 rebuild）     |
| 能力经 bundle 组合，无需切换产品            | ✅ 等价 | Bundle→EffectiveStructure 组合是机制（§7.3）；Coding/Research 等预置 bundle 是内容配置，属发布后内容工作（见"残余"）    |
| Goal/Plan 复杂自动出现、简单零仪式          | ✅      | planner 复杂度门控单测：简单问答零输出；组合验收中 plan hook 仅在多步骤措辞输入触发                                     |
| 用户能看懂它在做什么/为何要权限/结果在哪    | ✅      | 审批展示展开后的真实 argv/路径（非模型描述）；`/structure` `/world` `/trajectory` `/diagnostics` + user-guide §7 排障表 |

残余记录：预置能力 bundle（Coding/Research/Writing 模板）未随 v1 发布
——机制完整（POST /structure/reconcile + BEE_AGENT_STRUCTURE_FILE 热重
载），属内容而非代码，记入 backlog。

## 20.2 协议与组合

| 标准                                                       | 结论 | 证据                                                                                   |
| ---------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------- |
| CLI/Web/SDK 同一 Thread–Turn–Item 协议                     | ✅   | 三者都走 `@bee-agent/client`；client 契约测试 + web/CLI 各自集成测试                   |
| Item 生命周期可恢复/分页/回放                              | ✅   | SSE `Last-Event-ID` 恢复不丢事件测试；`readThreadEvents` after 分页；trajectory 重放   |
| Thread 协议是内核之上的必装插件                            | ✅   | kernel-runtime 插件图：chronicle/llm/agentLoop 均为插件服务，非内核内置                |
| 插件显式依赖 + 可逆 effect + 缺失 fail loud                | ✅   | cordis-port/kernel 契约测试：未声明访问失败、effects LIFO、缺依赖激活前失败            |
| effective tree 可查来源；执行中 Turn 固定 StructureVersion | ✅   | traceStructure 来源查询；generation lease 测试（挂起审批跨换代仍钉旧代）               |
| A/B/C 热换边界可测试                                       | ✅   | kernel 契约测试覆盖三级各自边界与回滚；tier C 报 restart-required 不半换               |
| 替换 Model/Memory/Sandbox/Tool 不改 AgentLoop              | ✅   | AgentLoop 只依赖 LlmRuntime/ToolExecutionPort 抽象；换代换模型实测（模型密钥切换实况） |

## 20.3 Kanban 与委派

| 标准                                                      | 结论 | 证据                                                                                    |
| --------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------- |
| CLI/Web/Scheduler/Agent tools 同一持久 Store              | ✅   | 组合验收：对话建任务→REST→dispatcher 同 store；Web 看板同源测试                         |
| 跨 Thread/重启可认领/阻塞/复核/恢复/取消/完成             | ✅   | kanban store 契约：杀 worker 恢复、租约过期回收、跨重启续跑                             |
| claim/lease/heartbeat/幂等/依赖/expected-version 故障注入 | ✅   | dispatcher 全套故障注入测试（P2 CI 门禁延续至今）                                       |
| 与来源 Thread/Turn/Episode/Artifact/Trajectory 双向追踪   | ✅   | source threadId/itemId 双向一步跳转测试；trajectory 因果链含每个工具的 execution 流位置 |
| Subagent 只承担 Episode 内有界委派                        | ✅   | DelegationSupervisor 深度/并发/子数/时间/token/成本/世界动作七维上限测试                |

## 20.4 上下文、Skills 与工具

| 标准                                             | 结论 | 证据                                                                                                                                                      |
| ------------------------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 每次调用可重建 ContextManifest + 分类 token 成本 | ✅   | manifest 含 rendererVersion/tokens/digest；rebuildContextInput 漂移即抛；交互加固又加两级压缩（工具结果省略 + LLM 摘要，`context.compacted` digest 校验） |
| Skill/长尾 Tool 两阶段加载                       | ✅   | 索引仅摘要、按需解析全量；"索引远便宜于全量"测试                                                                                                          |
| 压缩保留未决审批/工具结果/任务约束/引用/来源     | ✅   | 7 类受保护内容永不丢弃测试                                                                                                                                |
| 典型任务上下文明显低于全量基线                   | ✅   | token baseline CI 门禁：savingsRatio < 0.6 不回归                                                                                                         |
| Tool/Skill 版本 Turn 内固定                      | ✅   | generation lease 保证：热重载换代不打断进行中 Turn                                                                                                        |

## 20.5 记忆与成长

| 标准                                               | 结论 | 证据                                                                                                                  |
| -------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------- |
| Claim 有 provenance/valid time/confidence/矛盾关系 | ✅   | MemoryClaimSchema 全字段；supersedes 链 + 矛盾并存直至纠正的契约用例                                                  |
| memory-bee 与 memory-remote 同一 contract suite    | ✅   | 两实现消费同一套件；套件自身以参考实现自验证                                                                          |
| 用户可查看/纠正/删除记忆/关闭学习                  | ✅   | `/memory` + `bee memory` + Web Memory 视图；关闭学习=不启 learning 或撤回激活（均可逆）                               |
| 后台学习独立预算不阻塞 Turn                        | ✅   | 慢循环预算上限 + 每次运行持久审计事实；ADR 0025 分离原则                                                              |
| L2/L3 未经批准不进 active runtime；退化自动回滚    | ✅   | 激活只在 promote（用户路径）；L0 永不激活、L3 fail closed；DriftMonitor 退化自动回滚带数字 reason；退出演示 11 步全过 |

## 20.6 执行安全与可靠性

| 标准                                             | 结论 | 证据                                                                                            |
| ------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------- |
| 所有真实执行能力经 ExecutionWorld                | ✅   | 仓库级 spawn 禁令（lint+CI）；adapter execute() 只 throw；组合验收全链路走 world                |
| 网络/文件/进程/secret/资源/时间由 OS 强制        | ✅   | Seatbelt/bwrap 真实契约（Ubuntu CI 强制）；Keychain/Secret Service；超时/输出/进程组取消        |
| 审批跨重启恢复并展示展开后细节                   | ✅   | 挂起审批跨重启续跑测试；审批详情为 canonical ActionRequest 展开非模型描述                       |
| worktree 不污染稳定 checkout；取消无孤儿         | ✅   | worktree 生命周期走 ExecutionWorld Git action；进程组取消 macOS/Linux 契约                      |
| Host/模型流/MCP/外部 Memory 故障可恢复或显式降级 | ✅   | 模型请求持久化+digest 恢复；断路器+持久健康事件；outage 验收（Turn 照常、事实完整、降级可审计） |
| replay/rebuild/sandbox/跨天进 CI                 | ✅   | 全部在日常测试套件内；fake-clock 跨周召回；无密钥回放测试台（交互加固落地）                     |

## 结论

六组标准逐项满足。两项内容性残余（预置能力 bundle、MCP 记忆
transport 变体）不阻塞发布——机制与契约均已就绪，属发布后内容迭代。
建议：消费积压 changesets 定版 1.0.0，develop 经最终审计合入 main。
