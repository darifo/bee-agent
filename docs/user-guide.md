# Bee Agent 用户手册

> 适用：v1（Phase 1–6 完成后的 `develop`/`main`）。
> 面向使用者——不需要理解内部架构就能完成真实任务；需要架构与决策时见
> [`docs/architecture`](./architecture) 与 [`docs/adr`](./adr)。
> HTTP API 逐端点参考见 [`docs/api.md`](./api.md)。

## 1. 它是什么

Bee Agent 是一台运行在你自己电脑上的**个人智能体主机**（Personal Bee
Host）：一个进程、一个 SQLite 数据文件、一个对话界面。它会记住你的偏
好、能安全地替你执行命令和脚本、能在看板上管理任务、能在你不在的时候
按计划继续工作——而每一次记忆、每一次执行、每一次自我改进都是**可查看、
可纠正、可撤回**的持久事实。

三条使用原则，先记住就够了：

1. **对话即事实**：你说的每句话、它做的每件事都被永久记录，重启不丢；
2. **敏感操作会问你**：需要动文件/跑命令时先审批，审批里展示的就是将要
   发生的真实命令与路径；
3. **记住是自动的，忘记是显式的**：偏好类陈述自动进记忆；要删必须你亲手
   操作（下文 §5）。

## 2. 十分钟上手

### 2.1 配置

```bash
cd apps/bee
cp .env.example .env
# 编辑 .env，最少填两项：
#   BEE_AGENT_MODEL_API_KEY=sk-...        （任意 OpenAI 兼容密钥）
#   BEE_AGENT_MODEL_NAME=deepseek-chat
#   BEE_AGENT_SESSION_TOKEN=local-dev     （CLI/Web 连接用，建议固定）
```

### 2.2 启动

```bash
pnpm --filter @bee-agent/bee start        # 默认 http://127.0.0.1:3000
```

数据落在统一个人数据目录（macOS：
`~/Library/Application Support/bee-agent`；Linux：`$XDG_DATA_HOME/bee-agent`），
改 `.env` 后需重启（启动日志会打印当前密钥指纹，便于确认加载的是哪把钥匙）。

### 2.3 三种使用方式

```bash
# CLI 对话（审批时会出现 [y/N] 提示）
pnpm --filter @bee-agent/cli bee -- chat

# Web 控制台（Chat / Board / Memory / Learning 四个视图）
VITE_BEE_AGENT_URL=http://127.0.0.1:3000 \
VITE_BEE_AGENT_SESSION_TOKEN=local-dev \
pnpm --filter @bee-agent/web dev
```

或直接 HTTP（完整参考 `docs/api.md`）。

### 2.4 第一轮对话试什么

试试让它用工具并观察审批：

```
you> 用 command_run 列出 /tmp 目录的内容
bee> approval "Allow tool:command_run?" — approve? [y/N] y
bee> /tmp 下有 …
```

再说一句偏好，验证记忆闭环：

```
you> 从现在起请一直用中文回复。
（下一轮起它会记得——见 §5 查看它记住了什么）
```

## 3. 日常任务

### 3.1 对话与审批

- 普通问答不需要任何确认；
- 涉及文件/命令/网络的工具调用会**挂起等审批**，CLI 里 `[y/N]`，Web 里
  点按钮，API 里 `POST .../approvals/:id`；
- 审批详情展示的是**展开后的真实命令与读写路径**，不是模型的描述——看
  一眼再批。

### 3.2 看板任务

长任务交给看板而不是塞进一轮对话：

```
you> 帮我建个看板任务：整理本周工作计划，优先级 medium
```

之后用 CLI/Web/对话都能推进；任务有依赖、认领、超时回收，Host 重启后
自动恢复。

### 3.3 定时与条件触发

让它在指定时间、或某件事完成后继续工作：

```bash
# 每天早上跑一次（绑定线程跨天续跑）
bee learning …  # 见 §5；调度用：
curl -X POST :3000/scheduler/triggers -H "$H" -d '{
  "threadId": "<某线程>", "input": "给我今日摘要",
  "intervalMs": 86400000 }'

# 某个看板任务完成后触发后续
… -d '{"threadId": "<线程>", "input": "任务完成了，做收尾",
       "when": {"taskStatus": {"taskId": "<任务>", "status": "done"}}}'
```

Host 停机期间错过的周期任务会在重启后**合并补跑一次**并按原节律恢复。

## 4. 给它执行能力（可选，默认关闭）

不配置就完全没有执行类工具。需要时在 `.env` 里开启（细节与安全边界见
`README` §可选外部工具）：

```bash
BEE_AGENT_COMMAND_EXECUTABLES=/bin/ls,/usr/bin/git   # 白名单原生程序
BEE_AGENT_COMMAND_WORKSPACE=/Users/你/工作目录
BEE_AGENT_PYTHON_EXECUTABLE=/绝对路径/python3        # 固定解释器
```

每条命令执行前仍需审批；执行在操作系统级沙箱（macOS Seatbelt / Linux
bubblewrap）内：只能读写声明的路径、完全断网、空环境变量（不继承你的
密钥）。想让 Bee"写代码给自己用"，正确姿势是让它把脚本写到工作区再调
`python_run` 执行——脚本作为数据在沙箱里跑，而不是换进程内脏。

## 5. 管理它的记忆

它自动从对话中提取两类记忆：**偏好**（你明确表达的习惯）与**纠正**（你
推翻了它先前的做法）。查看与治理：

```bash
bee memory list                       # 它记住了什么（含状态徽章）
bee memory forget <claimId>           # 忘记一条（持久、可审计）
bee memory consolidate                # 合并重复
# Web: Memory 视图同样可点
```

记忆不可用时**对话照常工作**——记忆只是投影，事实都在 Chronicle 里，
绝不会有"静默空记忆"。

## 6. 自我改进（学习）——建议怎么用

Bee 会从真实使用中学习，但一切改进都必须**过证据关、经你批准、可撤回**：

```
真实对话 → 慢循环发现模式（如某工具高频使用）
        → 产出改进提案（含证据、评测计划、回滚计划）
        → 隔离实验：冻结数据复算证据（虚报直接被拒并归档）
        → 你批准（review → trial → promote）
        → 立即生效（下一轮对话真实召回采纳的模式）
        → 漂移监控：采纳后表现退化则自动回滚
```

操作入口：

```bash
bee learning run                      # 手动跑一次慢循环（默认每小时自动）
bee learning list                     # 提案列表
bee learning experiment <id>          # 触发隔离实验
bee learning trial|promote <id> <v>   # 试用 / 批准生效
bee learning rollback <id> <v>        # 一键撤回
bee learning monitor                  # 漂移检查
bee doctor                            # 一屏健康总览
```

Web 的 Learning 视图有同样按钮。**建议节奏**：平时不用管；每周看一眼
`bee learning list`，对 `review` 状态、证据属实的提案点 trial→promote 试
用；不满意就 rollback——一次点击，完全撤回。

## 7. 健康检查与排障

```bash
bee doctor          # 总览：结构/记忆/世界/调度/学习/线程
```

常见问题：

| 症状                                       | 处置                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `Authentication Fails … api key invalid`   | 换新密钥到 `apps/bee/.env`，**重启** Host；启动日志的 `apiKeyFingerprint` 应显示新钥匙末四位       |
| 改了 `.env` 不生效                         | 环境只在启动时读取一次，重启                                                                       |
| Host 起不来报 `No model provider is bound` | 旧版问题，已修复；若复现检查 `BEE_AGENT_MODEL_NAME` 拼写                                           |
| 审批挂起没人处理                           | Web/CLI 重新打开该线程即可看到挂起审批；跨重启仍在                                                 |
| 想彻底重来                                 | 停 Host，删掉数据目录下的 sqlite 文件（**会丢全部对话/记忆**），或设 `BEE_AGENT_DATA_DIR` 到新目录 |

## 8. 从 v0 迁移

```bash
bee import /绝对路径/v0.db
# imported N tasks (M events); skipped K already-present
```

v0 的每个任务变成一条 v1 线程（对话、工具结果、审批决定完整保留）；
重复执行安全（已导入的自动跳过）。

## 9. 隐私与安全边界（一页版）

- 默认只监听本机；暴露到网络必须显式设会话令牌，否则拒绝启动；
- 模型密钥只在内存，绝不进日志/事件/记忆；
- 命令执行：白名单 + 审批 + OS 沙箱 + 空环境 + 全程审计，缺一不可；
- 自我改进永不能触碰安全策略、审批规则、凭据——这些是不可自改的根信
  任区；学习提案最高 L2（建议类），改代码级能力（L3）需要显式批准的
  独立管线；
- 一切可导出（`GET /memory/export`、`GET /threads/:id/items`）——你的数
  据是你的。
