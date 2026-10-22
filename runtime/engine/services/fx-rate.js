// USD → CNY 汇率的唯一出处。
//
// 为什么单独一个模块：它原本长在 routes/dashboard.js（2200 行）里，而它其实和看板无关 ——
// 只要界面上要显示人民币，就需要这个数。左侧摘要、卡片、设置页里的样例都可能先于看板用上它。
// 搬出来之后：
//   · routes/dashboard.js 只负责「算钱」，汇率从这儿取；
//   · 引擎的 /snapshot 也能直接给出汇率，不必等用户先打开一次看板。
//
// 三个设计约束（都是踩过的）：
//   1) 缓存必须落磁盘。内存缓存随进程消失，而这个 App 的 runtime 每次打开都可能重启，
//      于是每次进来都要重新请求一次。落盘后下次启动直接可用。
//   2) 首屏只等很短时间。拉不到就先用已知值（磁盘缓存或垫底值），后台再试 ——
//      绝不能让一个网络请求把界面拖住。
//   3) 请求要能被真正打断。用 AbortSignal.timeout 而不是 https 的 timeout 选项：
//      后者只管 socket 空闲，管不住 DNS 解析，域名不可达时照样能把首屏拖住好几秒。
import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { readTextFile } from "./platform.js";

const FX_TTL_MS = 6 * 3600 * 1000;
export const FX_FALLBACK = 7.1;   // 既无缓存又拉不到时的垫底值，避免凭空造出 0 汇率
const FX_TIMEOUT_MS = 400;        // 首屏只给它这么点时间
const FX_REFRESH_TIMEOUT_MS = 3000;
const FX_ENDPOINT = "https://open.er-api.com/v6/latest/USD";

let cache = { rate: null, ts: 0 };
let refreshing = null;

const cacheFile = (dataDir) => path.join(dataDir || "", "fx-rate.json");

function readFromDisk(dataDir) {
  try {
    if (!dataDir) return null;
    const file = cacheFile(dataDir);
    if (!fs.existsSync(file)) return null;
    const saved = JSON.parse(readTextFile(file));
    if (saved && Number(saved.rate) > 0) return { rate: Number(saved.rate), ts: Number(saved.ts) || 0 };
  } catch {}
  return null;
}

function writeToDisk(dataDir, rate, ts) {
  try {
    if (!dataDir) return;
    fs.writeFileSync(cacheFile(dataDir), JSON.stringify({ rate, ts }));
  } catch {}
}

// 单次请求；失败/超时返回 null，不抛。
export function requestFxRate(timeoutMs = FX_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };
    let req;
    try {
      req = https.get(FX_ENDPOINT, { signal: AbortSignal.timeout(timeoutMs) }, (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            const cny = JSON.parse(buf)?.rates?.CNY;
            finish(cny > 0 ? cny : null);
          } catch { finish(null); }
        });
      });
    } catch { finish(null); return; }
    req.on("error", () => finish(null));
  });
}

// 后台刷新：只在已经拿得到值时用，绝不让请求等它。
function refreshInBackground(dataDir) {
  if (refreshing) return;
  refreshing = requestFxRate(FX_REFRESH_TIMEOUT_MS)
    .then((rate) => {
      if (!rate) return;
      cache = { rate, ts: Date.now() };
      writeToDisk(dataDir, rate, cache.ts);
    })
    .catch(() => {})
    .finally(() => { refreshing = null; });
}

/**
 * 取当前汇率（1 美元 = N 元）。永不抛、永不返回 0。
 *
 * @param {string} dataDir 引擎数据目录（放 fx-rate.json）
 * @returns {Promise<number>}
 */
export async function fetchFxRate(dataDir) {
  const now = Date.now();
  if (cache.rate && now - cache.ts < FX_TTL_MS) return cache.rate;
  // 内存没有就翻磁盘：上次跑过的汇率足够先用，不必为了它卡住首屏
  const disk = readFromDisk(dataDir);
  if (disk) cache = disk;
  if (cache.rate) {
    if (now - cache.ts >= FX_TTL_MS) refreshInBackground(dataDir);
    return cache.rate;
  }
  // 一个值都没有（全新安装）：只等一次，限时；拿不到就用垫底值，并丢到后台继续试
  const fresh = await requestFxRate();
  if (fresh) {
    cache = { rate: fresh, ts: now };
    writeToDisk(dataDir, fresh, now);
    return fresh;
  }
  refreshInBackground(dataDir);
  return FX_FALLBACK;
}

/** 只读汇率（不触发任何网络请求）。给 /snapshot 用：用户还没打开过看板时也要能算出人民币。 */
export function cachedFxRate(dataDir) {
  if (cache.rate) return cache.rate;
  const disk = readFromDisk(dataDir);
  if (disk) { cache = disk; return disk.rate; }
  return null;
}

/** 测试缝：预填汇率缓存，离线测试不打 open.er-api.com。 */
export function setFxRateForTests(rate) {
  cache = { rate, ts: Date.now() };
}

export default { fetchFxRate, requestFxRate, cachedFxRate, setFxRateForTests, FX_FALLBACK };
