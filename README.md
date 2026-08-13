# Codex Trace Viewer

> 把 Codex 的每一次工作，从“聊天记录”升级成一条可以理解、定位和复盘的完整轨迹。

如果你每天使用 Codex，却只能在结束后凭感觉回忆“刚才到底做了什么”，这个项目就是为你准备的。Codex Trace Viewer 把本地 Codex rollout trace 组织成类似 Langfuse 的可观测工作台：先按日期找到活动，再进入具体 session，最后查看连贯的 Trace 树、时间线、关系图、对话和节点详情。

它不要求 Langfuse、Docker、数据库或云端账号。数据默认留在本机，界面直接做成适合长期使用的桌面工作台。你可以用它回答：

- 今天我主要用 Codex 做了什么？
- 哪些 session 最慢、最复杂或失败了？
- 哪些工具、Skill 和 MCP 使用最多？
- 某个模型调用是怎样触发工具和子任务的？
- 哪些能力已经很久没有使用，是否值得清理或重新整理？

这是一个独立社区项目，不隶属于 OpenAI、Codex 或 Langfuse，也不上传数据到 Langfuse。

## 为什么值得使用

Codex 很强，但原始运行过程通常分散在终端输出、会话文件、工具结果和模型请求中。这个项目把这些信息重新拼成一张可读的使用地图：

- **像产品一样浏览**：日期 -> session -> Trace，先总览，再逐层深入。
- **像 Langfuse 一样理解调用链**：树、瀑布时间线、从上到下的关系图和对话视图互相配合。
- **像调试器一样定位问题**：慢节点、失败节点、模型调用、工具调用、Token 和原始 Payload 都能追溯。
- **像个人分析师一样复盘**：每日统计使用习惯、常用场景、工具组合、Skill/MCP 活跃度和长期未使用项。
- **让 Harness 可控进化**：Agent 检索全量或增量 Trace，结合当前 Codex 配置提出建议；只有用户逐项批准的具体操作才能执行。
- **默认 local-first**：不需要注册账号，不需要部署服务，原始 trace 不会自动离开本机。

## 适合谁

### 不熟悉技术的用户

你只需要让 Codex 产生一次会话，然后打开桌面窗口。页面会按日期列出活动，点进日期看到 session，再点进 session 查看完整轨迹。大多数情况下不需要手动读 JSON，也不需要理解 trace 文件结构。

### 需要调试和分析的开发者

你可以查看 reduced state、原始 Payload 引用、模型与工具边界、子 Agent 关系、Token 使用、失败原因，并通过 `codex debug trace-reduce` 对 Raw bundle 进行可重复归约。

### 想了解长期使用习惯的人

每日复盘会把会话、模型、Provider、工具、Skill、MCP、项目、活跃时段、缓存和 Token 汇总起来。还可以在设置中启用 OpenAI 兼容 LLM，让模型从聚合数据中归纳规则分类之外的新场景和跨信号习惯。

## 30 秒开始使用

### 环境要求

- 能写入 rollout trace 的 Codex CLI 或本地 Codex App runtime。
- Windows 用户可以直接安装 Electron 安装程序；只使用已打包的安装程序时不需要单独安装 Node.js。
- 从源码运行时需要 Node.js 22 或更高版本。

### 第一步：安装并启动桌面程序

Windows 用户运行安装程序后，从桌面快捷方式或开始菜单打开 **Codex Trace Viewer**。首次启动会出现设置向导，它会：

1. 自动检测 PATH 中的 Codex CLI，并显示可用版本。
2. 优先复用已有的 `CODEX_ROLLOUT_TRACE_ROOT`、`CODEX_HOME` 和日报目录；也可以点击“选择目录”改用其他位置。
3. 保存 Codex CLI 路径、trace 目录、日报目录和 Codex home。
4. 在 Windows 下可选写入用户级 `CODEX_ROLLOUT_TRACE_ROOT` 与 `CODEX_INSIGHTS_ROOT`，让之后新启动的 CLI/App 自动写入同一个目录。

向导只在第一次启动时出现。配置文件保存在 Electron 的用户数据目录，原始 trace 和日报仍保存在你选择的目录中。已经运行的 Codex 进程需要完全退出后重新启动，才能读取新的用户级环境变量。

从源码运行时：

```powershell
npm install
npm run desktop
```

要生成 Windows 安装程序：

```powershell
npm run dist:win
```

安装程序会输出到 `dist/`，默认创建桌面快捷方式和开始菜单快捷方式。安装后的 Electron 应用可以直接启动，不需要再执行 PowerShell 脚本。

### 手动设置（可选）

如果你不使用向导，或者需要给 CI/服务进程配置固定目录，可以手动设置用户级环境变量。Windows PowerShell 示例：

```powershell
$traceRoot = "E:\interesting\codex\.codex-traces"
$dataRoot = "E:\interesting\codex\.codex-insights"

New-Item -ItemType Directory -Force $traceRoot, $dataRoot | Out-Null

[Environment]::SetEnvironmentVariable("CODEX_ROLLOUT_TRACE_ROOT", $traceRoot, "User")
[Environment]::SetEnvironmentVariable("CODEX_INSIGHTS_ROOT", $dataRoot, "User")
```

设置后重新打开终端和 Codex。也可以只对当前终端临时设置：

```powershell
$env:CODEX_ROLLOUT_TRACE_ROOT = "E:\codex-traces"
$env:CODEX_INSIGHTS_ROOT = "E:\codex-insights"
codex
```

Electron 主进程会自动启动本地 viewer 服务，使用随机 loopback 端口创建原生 `BrowserWindow`，关闭桌面窗口时也会关闭对应服务，不依赖 Edge 标签页，也不会和 `4319` 上的独立服务冲突。

如果当前机器不方便安装 Electron，项目仍保留一个轻量的 Edge App 兼容入口：

```text
open-desktop.cmd
```

如果不需要桌面窗口，也可以直接打开：

<http://127.0.0.1:4319/>

### 第二步：产生一条会话

运行一次 Codex，完成一个任务，然后回到工作台刷新。你会看到类似下面的目录：

```text
E:\interesting\codex\.codex-traces\
└─ trace-...\
   ├─ manifest.json
   ├─ trace.jsonl
   ├─ payloads\
   └─ state.json        # 归约完成后出现
```

Ready session 会直接打开。Raw session 第一次打开时会显示“需要归约”，点击归约即可，系统会调用本机 Codex CLI 完成处理。

## CLI、Desktop App 和云端 Codex

这个项目读取的是本地文件，不是通过网络拦截 Codex：

```text
Codex CLI / 本地 Desktop App
          |
          | CODEX_ROLLOUT_TRACE_ROOT
          v
本地 trace bundle -> Codex reducer -> Codex Trace Viewer
```

### Codex CLI

CLI 是最直接、最稳定的使用方式。只要启动 CLI 的进程继承了 `CODEX_ROLLOUT_TRACE_ROOT`，每个独立 rollout 会产生一个 `trace-*` 目录。

### Codex Desktop App

桌面 App 是独立进程，不能只依赖某个临时 PowerShell 窗口中的 `$env:` 变量。推荐使用上面的 `User` 级环境变量，然后完全退出桌面 App（包括托盘进程）再重新打开。只要 App 使用的本地 Codex runtime 支持 rollout trace，它就会写入同一个目录。

`codex app` 命令本身主要负责打开桌面 App；真正是否产生 trace，取决于桌面 App 内部使用的 runtime。云端 Codex、ChatGPT 网页版 Codex 和远程 session 不会写入本机 trace，因此不在当前工具的采集范围内。

## 你能看到什么

### Trace 工作区

- 日期浏览：活跃天数、session 数、完成数、Raw 数量和总耗时。
- Session 列表：首条用户指令、状态、耗时、模型、项目、工具数和 Token。
- Trace 树：从根 session 到 runtime turn、model generation、tool、MCP 和子任务的层级结构。
- 时间线：按时间查看模型调用、工具调用、慢节点和失败节点。
- 关系图：从上到下展示调用关系，支持鼠标拖动和滚轮缩放。
- 对话视图：把用户、助手和工具消息恢复成更容易阅读的对话。
- 节点详情：概览、Input、Output、Metadata 和 Raw JSON，Payload 按需加载。
- 搜索与筛选：按指令、Rollout ID、项目、模型、状态和节点类型定位内容。

### 每日复盘

每日复盘不是单纯的会话计数，而是一个本地使用分析报告：

- 会话完成率、运行时回合、活跃时间和活跃时段。
- 模型、Provider、项目、输入/输出/推理/缓存 Token。
- 工具、Skill、MCP 的使用次数和最后使用时间。
- 规则统计出的常见使用习惯和场景。
- 长期没有使用过的工具、Skill 和 MCP 建议。
- 可选的 OpenAI 兼容 LLM 分析，用于动态归纳场景、习惯和改进建议。

清理项只是建议，系统不会自动删除 Skill、MCP、日报或 trace bundle。

### Agent

Agent 页面与每日复盘完全独立。每日复盘是给用户阅读的统计报告，不会作为 Harness 修改输入；Agent 则按需查询原始 Trace 索引和当前 Harness，寻找能够让 Codex 更符合个人使用习惯的改进。

Agent 的固定流程是：

```text
Analyze -> Propose -> Await Approval -> Apply -> Verify
```

- 支持全量分析和基于 Cursor 的增量分析，不会一次把所有 Trace 塞进模型上下文。
- 增量运行分别保存输入 `baseCursor` 和成功完成后的 `analysisCursor`。失败或停止不会推进 Dashboard 的增量基线，恢复时仍从原始 Cursor 重跑。
- 可限制回看天数、项目白名单和 Payload 读取权限，并为每次运行设置轮次、累计 Token、时长、工具结果和 Payload 预算；实际模型 usage 会写入 Run。
- 分析阶段只有 Trace/Harness 只读工具和 `proposal_create`，没有 shell、任意文件写入或 Harness 写工具。
- 每条 Proposal 必须携带可回读的 Trace evidence locator，并绑定目标对象、operation hash 和目标 hash。
- Agent 页面可以点击 evidence locator 回读经过裁剪和脱敏的会话窗口、Turn、工具调用或 Payload，而不会把整份 Trace 复制进 Proposal。
- 批准、拒绝、暂缓和编辑后批准均逐项保存。批准令牌一次性使用、会过期，并且只能执行批准时的 exact operation。
- 应用前创建快照；写入后验证发现失败会自动恢复；已完成的 Change 可以由用户一键回滚。
- AGENTS、Skills、MCP、`config.toml`、Rules、Hooks 和 Plugins 通过各自的受控适配器修改，不开放任意路径写入。TOML 使用正式解析器校验，写入时保留原文件布局。

Agent 数据保存在独立目录，不修改原始 Trace：

```text
.codex-insights/
├─ agent/
│  ├─ runs/
│  ├─ proposals/
│  ├─ approvals/
│  ├─ changes/
│  ├─ snapshots/
│  ├─ analysis-index/
│  ├─ trash/
│  └─ metadata.json
├─ reports/
└─ settings.json
```

当前 Agent store schema 为 v2，并带有 v0 -> v1 -> v2 迁移。所有 Agent JSON 使用同目录临时文件加原子重命名写入。服务重启后，分析、Proposal、审批和 Change 状态都会保留；中断的本地文件变更会按快照恢复，外部 Codex CLI 操作无法可靠判定完成状态时会停止并要求人工核验。

Plugin 的外部更新由 Codex CLI 的 `plugin remove/add` 完成，并用 `plugin list --available --json` 验证安装状态。当前 CLI 不能指定安装旧版本，因此 Plugin 回滚可以恢复配置和已安装状态，但不能承诺恢复更新前的二进制版本；UI 和审计记录会保留这一限制。AGENTS、Skill、Rules、Hooks、MCP 配置和 `config.toml` 等文件型对象仍使用精确快照回滚。

## 共享模型服务

每日复盘与 Agent 共用一套 OpenAI 兼容模型配置。默认情况下，两项功能都可以关闭，不会调用外部模型。你可以在“设置 -> 模型服务”中配置：

- API 基础地址，例如 `https://api.openai.com/v1`。
- 点击“发现”从兼容的 `GET /models` 接口读取模型列表，再从下拉框中直接选择。
- 可选 API Key；不需要授权的本地服务可以留空。
- 5 到 600 秒的共享请求超时。
- 保存前可以点击“测试所选模型”。

“用于每日复盘”和“Agent 分析”仍是两个独立开关，但 API 地址、API Key、模型和超时不会重复配置。旧版本的独立 Agent 设置会在载入时迁移到共享模型服务。

手动复盘和定时复盘使用同一条链路。LLM 超时、HTTP 错误或返回无效 JSON 时，规则日报仍然会保存，界面会明确显示“失败，已降级”。

发送给 LLM 的内容是有上限的聚合指标、Top 使用项、清理信号和经过裁剪/脱敏的提示预览，不包含原始 Payload、源码或完整命令输出。API Key 只保存在本机设置文件中，设置接口不会返回明文 Key。

## Windows 开机启动

如果希望服务在登录后自动启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
```

安装脚本会创建当前用户的 `CodexDailyInsights` 登录任务，并保存 trace 与日报目录。移除任务：

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall-windows.ps1
```

这项任务负责启动本地 Node 服务。Electron 桌面版可以从开始菜单或桌面快捷方式启动；开发环境也可以继续使用 `npm run desktop`。

## 命令行参数和目录

| 参数 | 默认值 | 作用 |
| --- | --- | --- |
| `--trace-root <path>` | `CODEX_ROLLOUT_TRACE_ROOT` 或 `./traces` | rollout trace bundle 目录 |
| `--data-root <path>` | `CODEX_INSIGHTS_ROOT` 或 `./.codex-insights` | 日报、设置和归约相关数据目录 |
| `--codex <executable>` | `codex` | Raw bundle 归约时调用的 Codex CLI |
| `--codex-home <path>` | `CODEX_HOME` 或用户目录下的 `.codex` | Skill 与 MCP inventory 来源 |
| `--host <address>` | `127.0.0.1` | HTTP 绑定地址 |
| `--port <number>` | `4319` | HTTP 端口 |

常见启动命令：

```powershell
node server.mjs `
  --trace-root E:\interesting\codex\.codex-traces `
  --data-root E:\interesting\codex\.codex-insights `
  --codex-home C:\Users\26891\.codex `
  --port 4319
```

服务提供的主要本地 API：

| API | 用途 |
| --- | --- |
| `GET /api/config` | 查看路径、Codex CLI 和采集状态 |
| `GET /api/traces` | 获取 session 列表 |
| `GET /api/traces/:id` | 获取归约后的 Trace state |
| `GET /api/traces/:id/payloads/:payloadId` | 按需读取 Payload |
| `GET /api/reviews` | 获取历史日报 |
| `POST /api/reviews/run` | 生成一次日报 |
| `GET/PUT /api/settings` | 读取或保存设置 |
| `POST /api/settings/models` | 从共享模型服务发现可选模型 |
| `POST /api/settings/test-llm` | 测试 OpenAI 兼容接口 |
| `POST /api/settings/test-agent` | 使用共享模型配置测试 Agent 工具调用接口 |
| `GET /api/agent` | 获取 Agent 运行、Proposal、Change 和索引状态 |
| `GET /api/agent/evidence` | 获取 Trace 聚合与 Harness 只读快照；携带 `bundleId` 与 locator 参数时回读具体证据 |
| `POST /api/agent/runs` | 启动全量或增量 Agent 分析 |
| `GET/DELETE /api/agent/runs/:id` | 读取或停止一次 Agent 分析 |
| `POST /api/agent/runs/:id/resume` | 从失败运行的原 Cursor 创建恢复运行 |
| `GET /api/agent/proposals/:id` | 读取 Proposal 与来源运行 |
| `POST /api/agent/proposals/:id/decision` | 批准、拒绝、暂缓或编辑后批准 |
| `POST /api/agent/proposals/:id/apply` | 使用一次性审批令牌应用 exact operation |
| `POST /api/agent/changes/:id/rollback` | 显式确认后回滚一个 Change |

## 技术架构

项目分成七层：

1. **Codex runtime**：在本地写入有序 raw event 和 Payload 引用。
2. **Reducer**：调用 `codex debug trace-reduce <bundle-directory>`，将 raw bundle 还原成语义化 Trace graph。
3. **Node.js viewer service**：发现 bundle、读取 state、提供本地 API、执行每日复盘和定时任务。
4. **Electron main process**：创建原生窗口、启动/关闭 viewer service、处理单实例和本地 URL。
5. **Renderer UI**：纯 HTML/CSS/JavaScript，在 Electron `BrowserWindow` 中展示 Trace 工作台，不需要 React、Webpack 或前端构建链。
6. **Agent query and loop**：增量 Trace 索引、Harness 只读发现和 OpenAI-compatible 工具循环，只负责形成 evidence-backed Proposal。
7. **Approval and mutation**：后端审批校验、受控 Harness 适配器、快照、验证、审计和回滚。

原始数据和归约数据的区别很重要：Raw bundle 是证据，`state.json` 是可浏览的语义图。Ready session 会直接读取 `state.json`，不会重复归约；Raw session 只有在用户明确请求时才会归约。

主要文件：

```text
server.mjs                本地 HTTP API、bundle 发现、归约和调度器
insights.mjs              每日复盘聚合、设置、日报持久化
llm-review.mjs            OpenAI 兼容 LLM 分析链路
agent-schema.mjs          Agent 状态机与持久化数据 schema
agent-store.mjs           原子 JSON 存储、审批令牌和分析 Cursor
trace-query.mjs           Trace 轻量索引、检索、反馈与 Payload 回读
harness-tools.mjs         Harness 发现、读取、hash 和敏感字段遮蔽
harness-mutations.mjs     受控 Harness 修改、验证、快照和回滚
agent-engine.mjs          只读工具循环、预算和 Proposal 创建
agent-service.mjs         审批、应用、恢复和回滚事务编排
desktop/main.mjs          Electron 主进程和原生窗口生命周期
desktop/wizard.html/js    首次启动向导、Codex 检测和目录选择
public/index.html         工作台页面结构
public/app.js             路由、状态、交互和日报渲染
public/trace-detail.js    Trace 树和节点详情归一化
public/styles.css         深色、响应式桌面工作台样式
open-desktop.ps1          Edge App 兼容启动器
open-desktop.cmd          Edge App 可双击启动入口
fixtures/                 小型确定性测试 bundle
```

## 常见问题

### 页面显示没有 session

在设置向导中确认 trace 目录正确，并完全退出后重新启动 Codex。检查该目录下是否出现新的 `trace-*` 文件夹。当前工具只读取本地 rollout trace，不会从普通聊天记录推测 session。

如果向导没有自动找到 Codex CLI，可以点击“选择文件”指定 `codex.exe` 或 `codex.cmd`，也可以填写 PATH 中的命令名 `codex`。重新检测只更新 Codex 字段，不会覆盖你已经填写的目录。

### 打开 Raw session 时出现 409

这是预期状态，不代表服务器坏了。说明 bundle 有 `manifest.json` 和 raw event，但还没有 `state.json`。在界面中点击归约，或手动运行：

```powershell
codex debug trace-reduce E:\path\to\trace-bundle
```

### 出现 500

先查看界面中的具体错误。常见原因是 trace 正在写入、bundle 文件不完整、Codex CLI 路径不可用或 Payload 文件损坏。刷新后重试；如果是 Raw bundle，优先确认 `codex debug trace-reduce` 可以独立运行。

### Desktop App 没有产生新 trace

完全退出 App 后重新打开，确认使用的是用户级环境变量，而不是只在某个 PowerShell 窗口中设置的临时变量。如果仍然没有新的 `trace-*` 目录，当前 App runtime 可能没有启用 rollout trace；监测工具本身不能给一个不产生 trace 的闭源远程 App 强行补上事件。

### Skill 或 MCP 没有出现在日报中

使用 `--codex-home` 指向真正的 Codex home。Skill 通常从 `skills` 和插件缓存目录读取，MCP 则从对应的 `config.toml` 中识别。inventory 只用于本地统计，不会自动修改配置。

## 隐私与安全

Trace 可能包含提示词、模型响应、工具参数、命令输出、本地路径和源码。请把它当作敏感数据处理：

- 默认只绑定 `127.0.0.1`，不要直接暴露到不可信网络。
- 不要把真实 API Key、业务密钥或敏感 Payload 提交到 Git。
- 启用 LLM 分析前，先确认所填服务的存储和日志策略。
- Agent 模型会按工具查询读取经过范围限制与脱敏的数据；全量分析并不等于一次发送全部原始 Trace。
- API Key、token、password、authorization 等敏感配置字段在 Harness 读取结果中会被遮蔽。
- Harness 写入只能由用户批准的目标和 operation 触发；审批不能扩大到其他文件、MCP 或 Plugin。
- 本项目不会自动上传 Langfuse，也不依赖 Langfuse、Docker 或数据库。
- 清理建议不会自动执行删除操作。

## 开发与测试

viewer 服务本身使用 Node.js 内置模块和浏览器 API；Electron 只作为桌面程序运行时和打包工具。运行测试：

```powershell
npm test
node --check server.mjs
node --check public/app.js
node --check public/trace-detail.js
git diff --check
```

开发桌面版：

```powershell
npm run desktop
```

服务启动：

```powershell
npm start -- --trace-root E:\codex-traces --data-root E:\codex-insights
```

仓库只包含独立 viewer、日报逻辑、Windows 启动脚本、fixtures 和测试，不包含 Codex 源码，也不包含任何本地 trace 或日报数据。

## 项目关系与许可证

本项目借鉴了 Langfuse 在 Trace 树、时间线和关系图方面的交互思路，但没有复制 Langfuse 运行时、没有调用 Langfuse 服务，也不要求安装 Langfuse。

项目采用 [MIT License](LICENSE)。Copyright 2026 Jin Zhangzheng。

项目地址：<https://github.com/Jane-o-O-o-O/Make-Codex-Your-Own>
