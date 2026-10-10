# Token 用量

Hana 的本地 Token 用量看板。把你机器上已经有的会话文件与宿主账本扫成一份能看、能筛、能导出的用量记录，再把各家的余额与额度并到同一页。

数据不出本机。出网只有两处：你在设置页填了凭据的余额查询，以及「检查更新」时读一次 GitHub Release。两处都可以不用。

- **形态**：Hana v2 App（不是 v1 插件）。一套代码贡献四张面孔：整页工作台、多功能卡、输入栏旁的功能面板、设置页，另加输入栏状态位一行。
- **依赖**：运行时零依赖，不装 npm 包，不动系统 Python。缓存与明细用 Node 内置 `node:sqlite`（Node 22.5+）；拿不到这个驱动时自动退回 JSON 快照，功能不受影响。
- **接续旧数据**：从 v1 插件 `plugin-data/token-tracker` 一次性复制旧文件过来（只复制，不改名、不删除、不覆盖已有的 App 数据）。

## 它长什么样

### 整页工作台（`ui/workspace.html`）

四个视图：用量总览 / 账户余额 / 消费明细 / 实时监控。

- 时间范围：今日 / 近3天 / 近7天 / 近30天 / 本月 / 全部历史。
- 四个筛选都是多选：Agent / 供应商 / 模型 / 类型。选中的值写回同一份状态，看板、明细、图表同源同步；下拉面板里按住 Shift 或 Ctrl 能一次挑多项，选中项带勾。
- 左右分栏可拖，宽度记住；视图之间横向拖拽换页；图表区域按住可平移（文字区不抢选字）。
- 主题三档：深黑 / 浅色 / Hana 原生。数字单位两套：中文（万 / 亿）与英文（K / M / B）。

### 多功能卡（`ui/card.html`）

最多九个页签，三点菜单里勾选要显示哪几个：

| 页签 | 内容 |
| --- | --- |
| 用量 | 总量、按 Agent / 模型拆分、按天趋势 |
| 余额 | 各家余额与额度 |
| 明细 | 按用量倒序的消费明细 |
| 实时 | 生成速度与首字响应时间 |
| 工作空间 | 各工作空间的活跃分布 |
| 日活 | 活跃度日历式分布 |
| 请求分布 | 单轮请求大小分布 |
| 时段模型 | 0–24 时分布，按模型分层 |
| 每日模型 | 每日模型用量比例 |

页签多到装不下时那条带子自己横向滚，不设上限。

### 功能面板与独立窗口

- `ui/navigation.html`：输入栏旁功能面板里的紧凑版。
- `ui/standalone.html`：把卡片拆成独立窗口时加载的完整页面。

### 输入栏状态位

输入框旁边一行，显示本会话的缓存命中率、最近一次生成速度与首字响应时间。这一行显示哪几项可以在设置页逐项关掉。

### 消费明细

定位是「把最大的几笔捞到眼前」，不是翻到第 900 页找某一天。

- 三种排序：时间 / 用量 / 未命中输入（命中缓存的输入单价低一个量级，贵在未命中那部分）。
- 门槛：只看超过某条线的记录。
- 点开一行能还原出这一轮的会话文件与逐次调用（有几次调用、每次多少、哪次失败）。
- 导出 CSV：当前筛选 + 当前排序下的**全部**行，由引擎拼好文本再交给宿主的保存能力。服务端分页之后前端手里只有一页，所以拼装不在前端做。

### 余额与额度

七家，统一成一套响应契约（`{ provider, status, type, display, used, limit, remain, updatedAt, error }`）：

DeepSeek / GLM / MiniMax（含 TokenPlan）/ 商汤（IAM 登录 + 积分池）/ 火山方舟 Coding Plan / OpenCode Go / DeepSeek 官网账单。

单家失败只产生一条 `status: "error"` 的条目，不拖垮整次查询。DeepSeek 与 GLM 的密钥自动读 Hana 里已配好的，设置页只管开关；其余的要填凭据。

### DeepSeek 官网账单

直连 `platform.deepseek.com` 的用量与消费接口，凭证是浏览器 localStorage 里的 `userToken`（不是 API key，`sk-` 开头的 API key 查不了用量）。因为 Hana 内置浏览器按会话隔离存储，这个 token 只能去磁盘上的 LevelDB 里找，必要时先按块做 snappy 解压。**token 只留在内存，不落盘。**

拉回来的按天用量与消费按行写进 SQLite，避免整文件反复擦写。界面上给一张按天的总量趋势 + 缓存命中率折线，余额旁显示总消费。

## 口径：这些数字是怎么来的

这一节比功能列表重要。同一个数字，口径不同差一个量级。

- **缓存命中率** = Σ缓存读 ÷ (Σ缓存读 + Σ未命中输入)。范围：本条会话、当前模型、最近 50 条记录。这个式子不是自己发明的：宿主账本每条记录同时给 `cache.readTokens` 和 `input.uncachedTokens`，比值与宿主自己的 `cache.hitRatio` 一致。
- 不把各次请求的 hitRatio 取平均。每次请求的输入体量差几个量级，平均值没有意义。
- 不把「没有缓存信息」当 0。供应商没上报和真的没命中是两回事。
- **生成速度**：分母是「本条回复落笔 − 上一条记录落笔」，所以工具执行时间不进分母，用户发送前的阅读与书写也不进分母。每次请求开始吐字前那段固定开销（排队、预填充、首字等待、网络）由最近 8 条采样的一元回归当截距解出来；拟合不成立时按 1 秒固定开销直接除，所以总有数。它是估算，同批样本四分位离散度约 ±25%，主要来自服务端排队与负载。界面上不给它加修饰语，要不要表达「这是估算」由用户决定，不由代码替用户决定。
- **首字响应时间（TTFT）**：请求即将发出（`provider/before-request`）到收到响应（`provider/after-response`）两个时间戳之差。两处都只取时间戳，不改请求、不读内容。
- **不臆造**：不给推断出来的请求时间；宿主账本里的 `durationMs` 实测恒为 0，就不拿它当精确值。
- **历史归档**：核心账本（usage-ledger）是 5000 条环形缓冲，满了会挤掉最旧的。App 把每条账本记录按 requestId 去重搬进独立归档，统计从归档构建，所以账本丢数据不影响历史。归档只追加，不整文件重写。

## 架构

```
Hana 宿主
├─ App 主进程  index.js
│    路由（/snapshot /dashboard /details /turn /balance /ds-usage /settings /events /update-check …）
│    宿主钩子（首字响应时间）、输入栏状态位、更新检查
│    └─ lib/local-client.mjs
│         用 ctx.runtime.start 拉起引擎子进程，再经 ctx.runtime.fetch(runtimeId, "/rpc") 通信
├─ 引擎子进程  runtime/service.mjs（profile: local-machine、network: external、回环端口 + 每次启动新密钥）
│    ├─ engine/index.js          扫会话 JSONL 与宿主账本，落进 cache.sqlite
│    └─ engine/routes/dashboard.js + engine/services/*
│         看板数据、明细查询与分页、余额适配、DeepSeek 官网账单、LevelDB + snappy 取 token
└─ UI iframe  ui/*.html
     向主进程要数据，并订阅 /events 的 SSE（别的界面关掉更新弹窗时，这边跟着关）
```

几条一直在维护的边界：

- 引擎是**独立进程**，不是主进程里的一块。它启动要过宿主授权，退出会被整个进程树回收，崩了主进程有超时与报错路径（「内置数据服务未能启动，请查看 Hana 应用运行日志」「启动超时，请稍后刷新」），不静默降级成空数据。
- 主进程与引擎之间每次启动生成一把新密钥，配置（含本机路径与密钥）只经内存传一次，读进内存后立刻删掉那个临时文件。
- 引擎自己写的东西都在 `<dataDir>/engine/` 下。主进程要读其中任何一份（比如状态位要按数字单位写文字），路径从同一个口子拿，不在两处各写一遍字符串拼贴。
- 一份口径只写一次：数字量级单位（中文万/亿 ↔ 英文 K/M/B）落在 `ui/units.mjs`，浏览器与主进程引同一份文件，保证「一次切换」真的是一次。

## 数据落在哪

`<dataDir>` = `<HanaHome>/app-data/token-tracker-app`。

| 路径 | 内容 |
| --- | --- |
| `engine/cache.sqlite` | 会话扫描缓存（每会话一行）与轮次明细（`turns` 表） |
| `engine/usage-archive.jsonl` | 独立历史归档，只追加；`.imported` 是迁移前的旧单文件留底 |
| `engine/ds-usage.sqlite` | DeepSeek 官网账单的按天用量与消费 |
| `engine/app-settings.json` | 扫描间隔、明细门槛、显示（密度、数字单位） |
| `engine/balance-apis.json` | 各家余额凭据 |
| `engine/price-table.json` | 价格表（OpenCode Go 按官方价，已与账单实测对账） |
| `engine/fx-rate.json` | 汇率缓存（看板换算用，6 小时过期） |
| `engine/migration-v1.json` | 旧插件数据迁移标记 |
| `update-notice.json` | 更新检查状态：开关、已读版本、检查间隔、上次取回的 Release |
| `input-status.json` | 输入栏状态位各项开关 |

派生数据的权威永远在原始文件（`agents/*/sessions/*.jsonl`、宿主账本），上面这些是加速用的缓存，删掉只会让下次启动慢一遍。

## 权限

装的时候能看到的九项，各自是为了什么：

| 能力 | 用来做什么 |
| --- | --- |
| `app/runtime.execute` | 拉起引擎子进程 |
| `app/runtime.local-machine` | 以你的身份读本机文件：会话 JSONL、宿主账本、内置浏览器的 LevelDB |
| `app/runtime.network` | 引擎出站：各家余额接口、DeepSeek 官网账单 |
| `app/usage.read` | 读宿主用量账本（只有 request id、时间、状态、模型标识、归一化 token 与费用） |
| `app/sessions.read` | 认会话文件与工作空间，供状态位与「点得开」用 |
| `app/input.status` | 写输入栏那一行 |
| `app/ui.open-external` | 点「在 GitHub 查看」时打开浏览器 |
| `app/hooks.provider-before-request` | 记下请求即将发出的时间戳（首字响应时间的起点） |
| `app/hooks.observe` | 记下收到响应的时间戳（终点） |

**要说清楚的一件事**：`profile: "local-machine"` 是「用户明确授予本机应用工作流」的运行模式，宿主对它的说明是**不提供文件系统或网络隔离**。也就是说引擎子进程以你当前的 OS 用户权限运行，理论上能读到本机其他文件和凭据。这个 App 只用它做上面那几件事，但这是它实际拿到的权力，不藏着。

主进程受控出站的声明是 `network.allowedHosts: ["github.com"]`、只允许 GET。**引擎那一层的出站不受这份白名单约束**（它走的是 `network: "external"` 这个运行档），所以余额查询能连各家接口。

## 开发

需要 Node 22.5+（`node:sqlite`），零 npm 依赖。

```bash
node --test test/*.test.js     # 或 npm test；241 项
```

- **UI 直接加载源码**：改 `ui/` 下的文件后重载 App 即生效。`dist/` 里的 zip 只用于发布，不参与开发。
- **mock 模式**：`TOKEN_TRACKER_MOCK=1` 时界面拿固定样张，不出网、不读盘，用来单独开发界面。
- **目录约定**：`ui/` 里能被主进程复用的纯函数放 `ui/` 而不是 `lib/`，因为 iframe 里的页面只拿得到 `ui/` 这一层。
- `test/` 与 `doc/`、`scripts/` 不进发布包（见 `scripts/pack.mjs` 的排除清单）。

## 出包与发版

```powershell
.\scripts\release.ps1                 # 只出包，不联网
.\scripts\release.ps1 -Publish        # 出包并发布到 GitHub Release
```

产物落在 `dist/`，三件：`<id>-v<version>.zip`、`.zip.sha256`、`app-<id>-<version>.entry.json`。

- `manifest.json` 的 `version` 是**唯一事实源**：tag 由它推出，发布门禁也校验它。`package.json` 里的 version 历史上跟它漂过，不参与判断。
- `-Publish` 的门禁：工作区干净、本地提交已推到 `origin/master`、`gh` 已登录、该 tag 的 Release 不存在、版本号与 manifest 一致、entry 附件不超过市场同步器的 512 KiB 上限。任一条没过就停在发布之前，包已经出好了。
- 市场只读 GitHub 的「latest 正式 Release」（草稿与预发布一律拒），并且要求两个附件同时在场、名字逐字符匹配。发布后不要手改 entry 里的 `sha256` 与 `size`，那会让市场校验失败。

## 已知边界

有意不做的事，写下来免得被当成缺陷：

- 不猜请求时间。拿不到就不给。
- 不把「供应商没上报缓存」写成 0% 命中。
- 不往生成速度上自动加「约」字。
- 界面上不自己发明表述用户数据的修饰语；要不要加，由用户决定。
- 远端更新说明的 HTML 只用来切分组、取条目，绝不原样塞进页面。
- 账本丢了记录不重算历史（历史在归档里）；归档不删除任何一份旧文件，改名冲突就用带时间戳的新名。

## 许可证

本仓库以 **Mozilla Public License v. 2.0** 授权，全文见 [`LICENSE`](LICENSE)，
第三方与衍生关系见 [`NOTICE`](NOTICE)。

MPL-2.0 以文件为单位生效，需要单独留意的两处：

- `release/pack.mjs` 与 `release/selfcheck.mjs` 含衍生自 GitHana 的代码（MPL-2.0），
  文件头部保留了原始声明；`release/` 下其余文件取自同作者的 git-save-load。
- `ui/sdk/` 下的宿主 UI SDK 与第三方组件，许可原文见 `ui/sdk/THIRD_PARTY_NOTICES.txt` 与 `ui/sdk/components.js.LEGAL.txt`。
