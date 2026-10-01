// 输入栏状态位卡片（contributes.ui.inputStatus#session-cache）的四个开关。
//
// 只留一处真相：这份偏好归插件进程，落在 app 数据目录下的 input-status.json。
// 前端每次拨开关都走 HTTP 落到这里，再拿返回值刷新本地副本 —— 宿主 iframe 与插件进程不共享内存，
// 前端那套 shared prefs 插件读不到，所以真相不能在浏览器侧，否则两处会各说各话。
//
// 文件形如 {"card":true,"cache":true,"speed":true,"ttft":true}：
//   card  —— 这张卡片整体显示与否
//   cache —— 卡片文本里是否出现「缓存：xx.x%」
//   speed —— 卡片文本里是否出现「速度：NN tok/s」
//   ttft  —— 卡片文本里是否出现「首字：N.N s」
// 缺失 / 损坏 / 非法值一律回落到全 true，读路径不抛错：卡片是锦上添花，
// 不该因为一个配置文件坏掉就把整个应用拖下水。

import fs from "node:fs";
import path from "node:path";

export const PREF_KEYS = ["card", "cache", "speed", "ttft"];
export const DEFAULT_PREFS = Object.freeze({ card: true, cache: true, speed: true, ttft: true });

// 把任意形状的输入收敛成一份完整偏好：只认这四个键的布尔值，未知键与非法值一并丢弃。
export function normalizePrefs(raw) {
  const out = { ...DEFAULT_PREFS };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const key of PREF_KEYS) {
      if (typeof raw[key] === "boolean") out[key] = raw[key];
    }
  }
  return out;
}

export function createInputStatusPrefs({ file = null, log = () => {} } = {}) {
  // 读取永远反映落盘的最新值：每次都重新读文件，不缓存。写入很稀疏，这点 IO 不值得换来一份会过期的副本。
  function read() {
    if (!file) return { ...DEFAULT_PREFS };
    try {
      if (!fs.existsSync(file)) return { ...DEFAULT_PREFS };
      // Windows 编辑器可能写 BOM，JSON.parse 不认，先剥掉。
      const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
      return normalizePrefs(JSON.parse(text));
    } catch (e) {
      log("warn", `输入栏偏好读取失败，按全开处理：${e?.message || e}`);
      return { ...DEFAULT_PREFS };
    }
  }

  // 只覆盖传入的键，且只接受布尔值：非法值与未知键都当没传（不落盘）。
  function write(patch) {
    const next = read();
    if (patch && typeof patch === "object" && !Array.isArray(patch)) {
      for (const key of PREF_KEYS) {
        if (typeof patch[key] === "boolean") next[key] = patch[key];
      }
    }
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    return next;
  }

  return { read, write };
}
