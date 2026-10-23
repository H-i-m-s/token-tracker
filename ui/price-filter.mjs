// 价格清单的搜索过滤：纯函数，不碰 DOM。
//
// 为什么单独一个文件：这段逻辑有两个容易做错的点，值得写测试钉住。
//   ① 匹配范围是「供应商/模型」整个键。只搜模型名的话，「想找某家全部模型」
//      就没法做 —— 而那恰恰是最常见的用法之一（比如要给 deepseek 全部模型填一个价）。
//   ② 过滤后的分组必须携带原来的 total。界面靠它区分「这块只剩三个」
//      与「这块里命中了三个」，后者要写成 3 / 共 12。
//   ③ 除了键，还认 item.searchText（「分时」「按次」「自定义」这些）。
//      它们不在键里，但确实是用户会用来找模型的说法：想批量改所有配过分时的模型，
//      总不能一个个从 58 行里找。searchText 由调用方算好（见 ui/price-card.mjs），
//      这个模块只管匹配，不碰价格结构。

/**
 * 按搜索词过滤分组。
 *
 * @param {object[]} groups  [{ provider, items: [{ key, model, ... }], total, ... }]
 * @param {string}   query   搜索词；空串或空白视为不过滤
 * @returns {{ groups: object[], matched: number, providerCount: number }}
 *          groups 为空数组时表示没有命中；matched 是命中的模型总数。
 */
export function filterPriceGroups(groups, query) {
  const list = Array.isArray(groups) ? groups : [];
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) {
    return {
      groups: list,
      matched: list.reduce((s, g) => s + (g.items?.length || 0), 0),
      providerCount: list.length,
    };
  }
  // 匹配整个键（供应商/模型），大小写不敏感。
  // 不拆成两个字段分别匹配：用户在框里看到的就是「供应商/模型」，
  // 搜索也该按同一个东西理解，不制造第二套规则。
  const hit = [];
  let matched = 0;
  for (const g of list) {
    const items = (g.items || []).filter((i) => {
      if (String(i?.key ?? "").toLowerCase().includes(q)) return true;
      // 第二处匹配范围：这个模型「怎么计价」。
      return String(i?.searchText ?? "").toLowerCase().includes(q);
    });
    if (!items.length) continue;
    matched += items.length;
    // total 保留原值（过滤前该供应商的总数），界面用它写「3 个模型 / 共 12」。
    hit.push({ ...g, items });
  }
  return { groups: hit, matched, providerCount: hit.length };
}

export default { filterPriceGroups };

/**
 * 把一段文本拆成「命中 / 未命中」的片段，供界面高亮。
 *
 * 返回 [{ text, hit }]，拼接后与原文完全一致（包括大小写）——
 * 高亮只影响显示，不能把用户看到的名字改掉。
 * 空搜索词返回单个未命中片段，调用方不必先判空。
 *
 * 大小写不敏感匹配，与 filterPriceGroups 同一套口径：
 * 搜 FLASH 能筛出来，就必须能把那里的 flash 也标上。
 */
export function splitHighlight(text, query) {
  const src = String(text ?? "");
  const q = String(query ?? "").trim();
  if (!q || !src) return [{ text: src, hit: false }];
  const hay = src.toLowerCase();
  const needle = q.toLowerCase();
  const out = [];
  let at = 0;
  for (;;) {
    const i = hay.indexOf(needle, at);
    if (i < 0) break;
    if (i > at) out.push({ text: src.slice(at, i), hit: false });
    out.push({ text: src.slice(i, i + needle.length), hit: true });
    at = i + needle.length;
  }
  if (at < src.length) out.push({ text: src.slice(at), hit: false });
  return out.length ? out : [{ text: src, hit: false }];
}
