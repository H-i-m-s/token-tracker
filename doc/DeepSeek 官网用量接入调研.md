# DeepSeek 官网用量接入调研

> 记录时间：2026-09-29
> 状态：数据链路已端到端验证通过，待实现
> 本文只记录调研结论与实测证据，不含任何真实 token 值。

## 0. 目标

在 Token 用量 App 的「余额与额度」视图下，新增一块数据来自 **DeepSeek 官网账单**（而非本地日志估算）的可视化：

- 面积图：总 token 用量，横轴为**日期**
- 折线：缓存命中率（与面积图共图，双 Y 轴）
- 余额旁显示：**总消费金额**（不进图）

约束：不要求用户手动粘贴 token，插件自动获取。零新增依赖，不改系统 Python。

---

## 1. 数据源：DeepSeek 官网接口

### 1.1 接口

Base：`https://platform.deepseek.com`

| 用途 | 方法 | 路径 | 参数 |
|---|---|---|---|
| Token 用量 | GET | `/api/v0/usage/amount` | `month`、`year` |
| 消费金额 | GET | `/api/v0/usage/cost` | `month`、`year` |
| 校验凭证 | GET | `/api/v0/users/get_user_summary` | — |

### 1.2 鉴权

- 请求头：`Authorization: Bearer <userToken>`
- **`userToken` 不在 cookie 里**，在浏览器的 `localStorage` 中。
- **不是 API key**。`sk-` 开头的 API key 只能查余额（`api.deepseek.com/user/balance`），查不了用量。
- 实测：不带 `Origin` / `Referer` 也请求成功。

### 1.3 返回结构

```jsonc
{
  "code": 0,
  "msg": "",
  "data": {
    "biz_code": 0,
    "biz_msg": "",
    "biz_data": {
      "total": [ { "model": "...", "usage": [ { "type": "...", "amount": "..." } ] } ],
      "days":  [ { "date": "YYYY-MM-DD", "data": [ /* 同上结构 */ ] } ],
      "currency": "CNY"   // 仅 cost 接口有
    }
  }
}
```

`usage[].type` 五类：

- `PROMPT_TOKEN` — 输入 token（总量口径）
- `PROMPT_CACHE_HIT_TOKEN` — 缓存命中
- `PROMPT_CACHE_MISS_TOKEN` — 缓存未命中
- `RESPONSE_TOKEN` — 输出
- `REQUEST` — 请求数

> `amount` 接口的 `amount` 是 token 数；`cost` 接口复用同一结构，`amount` 变成金额（CNY）。两者口径不同，不要混在一条曲线里比。

### 1.4 能力与限制

- 粒度：**按天**（`days[]`），按模型拆分。**没有小时粒度**。
- 范围：任意月份可取（实测 1 月、7 月均返回 200），跨年历史需逐月循环拉取。
- 缓存命中率 = `CACHE_HIT / (CACHE_HIT + CACHE_MISS)`。

---

## 2. token 存在哪：Hana 内置浏览器存储

### 2.1 存储布局

浏览器数据在 `%APPDATA%\hanako\Partitions\<partition>\` 下：

| 内容 | 位置 | 说明 |
|---|---|---|
| cookie | `Network\Cookies`（SQLite） | **不含登录凭证**，DS 只有 `smidV2`、`.thumbcache_*` 等匿名标识 |
| localStorage | `Local Storage\leveldb\`（LevelDB） | `userToken` 在这里，**明文**存储 |

`userToken` 的值形如：

```jsonc
// localStorage["userToken"] 的字面值
{ "value": "<64 字符的 token>", "__version": "0" }
```

取 `.value` 作为 Bearer。

### 2.2 partition 机制（关键）

内置浏览器按 **会话** 隔离存储：

```
partition 名 = "hana-browser-" + sha256(会话文件绝对路径)[:32]
```

实测对账：磁盘上 23 个 `hana-browser-<hash>` partition，**精确匹配 23 个不同的会话文件**（跨不同 agent）。每个用过内置浏览器的会话，都留下一间专属存储。

另有共享 partition `hana-web`，仅在"关闭会话隔离"时使用。

### 2.3 会话隔离开关（不可靠）

设置界面里有「会话隔离」开关。实测行为：

- 切换开关的那一刻会**重建浏览器视图**并生效（确实建出了共享的 `hana-web`）；
- **Hana 重启后失效**，视图恢复仍回到各自的会话专属目录。

结论：**不要依赖这个开关做跨会话共享**。实测多次登录的 token 始终落在会话专属 partition 里。

---

## 3. token 读取：技术细节

### 3.1 明文 vs 压缩

LevelDB 的写入分层：

1. 新数据先落 memtable，同时追加到 `NNNNNN.log`（WAL）。**这层明文**，字节搜索即可见。
2. memtable 满后刷成 `NNNNNN.ldb`（SSTable），**块用 snappy 压缩**。
3. 后台 compaction 合并 `.ldb`。

所以：

- 浏览器**运行时**：数据在 `.log`，明文，直接搜 `userToken` 就能拿到。
- 浏览器**关闭后**：数据 compact 进 `.ldb`，字节搜索搜不到，但**用解析器（SSTable + snappy 解压）仍可完整还原**。

> 实测：写了一个最小 LevelDB 解析器（含 snappy 解压），从已关闭 partition 的 `.ldb` 中读出了完整的 localStorage 明文（key 和 value 均可还原）。

### 3.2 文件独占

浏览器**活跃**时：

- `Network\Cookies` 被独占，外部连只读打开都失败（`Permission denied`）；
- leveldb 的 `.log` 可读，仅 `LOCK` 文件被锁。

### 3.3 读取策略

- 优先读 `.log`（浏览器开着时，最快）；
- 兜底解析 `.ldb`（浏览器关了，需要 snappy 解压）；
- 多个 partition 都有 token 时，按文件 mtime 取最新。

---

## 4. 端到端验证（已完成）

**不经过浏览器**，直接从磁盘读出 token 后用 HTTP 请求：

```
amount: http 200  code 0  biz 0  days 30   模型 6 个
cost  : http 200  code 0  currency CNY  days 30
```

证明：读 token → 请求接口 → 拿数据，整条链路可脱离浏览器与 Hana 设置独立工作。

---

## 5. 插件实现方案

**全程 Node，零新增依赖，不涉及 Python。**

可用的内置能力（现有插件已在用）：

- `node:fs` — 扫描 partition、读文件
- `node:sqlite` — 读 cookie（如需）、现有缓存落盘
- 内置 `fetch` — 请求官网接口

步骤：

1. 扫描 `%APPDATA%\hanako\Partitions\*\Local Storage\leveldb\`，按 mtime 取最新的 `userToken`（`.log` 优先，必要时解析 `.ldb`）。
2. 逐月拉 `amount` + `cost`，落盘缓存（沿用现有 SQLite）。
3. 「余额与额度」视图：
   - 面积图：总 token，横轴日期；
   - 折线：缓存命中率（双 Y 轴，注意量级差）；
   - 余额旁：总消费（各月 `cost` 累加，注意与"余额减少"不是同一账本）。

---

## 6. 坑与风险

- **token 会过期**，有效期未知；过期后需重新登录一次内置浏览器。
- **会话隔离开关不可靠**，不要依赖它。
- **凭证敏感**：token 等价于账号级权限，插件持有它即具备代表用户操作 DS 账号的能力。
- **Hana / Electron 升级**可能改变 partition 结构或存储格式。
- **leveldb compact** 后 `.log` 明文消失，需 snappy 解析器兜底（Node 无内置 snappy，需纯 JS 实现，约数十行）。
- **多个 token** 需按时间取最新，避免用到过期的那份。

---

## 7. 未验证 / 待补

- token 的有效期（服务端控制，未知）。
- Node 端 snappy 解压实现（纯 JS）。
- 是否所有历史月份都能取（只抽测了 1、7、9 月）。
- DS 官网接口是否会因前端重构而变更。
