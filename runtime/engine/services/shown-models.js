// 「Hana 里配了哪些模型」—— 只能由引擎读。
//
// 为什么不在 App 层：App 进程被 Node 权限模型限制，只能读自己的 dataDir。
// 读 ~/.hanako 根下的 provider-catalog.json 会直接报
//   Access to this API has been restricted. Use --allow-fs-read to manage permissions.
// 这个限制是宿主有意设的（App 不该随便翻整个 HANA_HOME），
// 不该因为一张价格表去动它。
//
// 所以：App 层要这份数据时，走 RPC 问引擎要（见 index.js 的 token-tracker.used-models）。
import fs from "node:fs";
import path from "node:path";

// Windows 编辑器可能写 BOM 与 CRLF，JSON.parse 不认 BOM。
function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

/**
 * 现在展示的模型：Hana 里配了的。两处来源：
 *   provider-catalog.json —— 文本模型供应商
 *   user/preferences.json 的 imageGeneration / videoGeneration —— 多媒体默认模型
 *
 * 读不到就当空，不因为一个文件缺失让整张价格表空掉。
 * 返回 [{ provider, model, source }]，source 记着它从哪儿来的（catalog / imageGeneration / …）。
 */
export function readShownModels(home) {
  if (!home) return [];
  const out = [];
  const add = (provider, model, source) => {
    if (provider && model) out.push({ provider, model, source });
  };
  try {
    const catalog = JSON.parse(readText(path.join(home, "provider-catalog.json")));
    for (const [pid, pd] of Object.entries(catalog.providers || {})) {
      for (const m of pd?.models || []) add(pid, typeof m === "string" ? m : m?.id, "catalog");
    }
  } catch {}
  try {
    const pref = JSON.parse(readText(path.join(home, "user", "preferences.json")));
    for (const cap of ["imageGeneration", "videoGeneration"]) {
      const defaults = pref?.[cap]?.providerDefaults || {};
      for (const [pid, pv] of Object.entries(defaults)) {
        for (const mid of Object.keys(pv?.models || {})) add(pid, mid, cap);
      }
    }
  } catch {}
  return out;
}

export default { readShownModels };
