// 明细 CSV 的拼装。原样从 ui/csv-export.mjs 搬进引擎。
//
// 为什么往下搬：服务端分页之后，前端手里只有一页（50 行），而导出的语义是
// 「当前筛选 + 当前排序下的全部行」。把上万行搬到前端再拼 CSV 既慢又要顶 4 MiB 响应硬顶；
// 引擎直接查库拼好文本（约 1.5 MB）更省事。命中率口径仍与界面同一处（hitRate）。
import { hitRate } from "../../../ui/details-view.mjs";

export function buildDetailsCSV(rows, { currency = "cny", fxRate = null } = {}) {
  const header = ["时间", "Agent", "Provider", "模型", "输入Token", "输出Token", "缓存命中率", "调用次数", "总Token", "成本"];
  // 成本列跟界面上的币种走：表里与屏幕上两份数字必须是同一种钱。
  //
  // r.cost 现在**本来就是人民币**（价格表基准币种）。
  // 上一版它是美元，所以这里乘了一次汇率；基准改成人民币后若还乘，
  // 导出的每个数都会变成 6.7 倍 ——而看上去毫无异常。
  // 现在：选人民币就原样输出，选美元才除一次。
  const r0 = Number(fxRate);
  const toUsd = currency === "usd" && r0 > 0;
  const toMoney = (cny) => {
    if (cny == null || cny === "") return "";
    const v = Number(cny);
    if (!Number.isFinite(v)) return "";
    return toUsd ? +(v / r0).toFixed(4) : v;
  };
  const lines = rows.map((r) => {
    // 缓存命中率是这两列里唯一需要算的：没口径就留空，不写 0%（那会读成“完全没命中”）。
    const hr = hitRate(r);
    return [r.time || "", r.agentName || r.agent || "", r.provider || "", r.model || "",
      r.inputTokens ?? "", r.outputTokens ?? "",
      hr == null ? "" : (hr * 100).toFixed(1) + "%",
      r.calls ?? "",
      r.totalTokens ?? 0, toMoney(r.cost)];
  });
  // 表头带上币种：单独一个 CSV 文件离开了界面，必须能自己说清这一列是什么钱。
  // 选了美元但没汇率时退回人民币 —— 与界面同一套规则，不然两边又对不上。
  header[header.length - 1] = toUsd ? "成本(USD)" : "成本(CNY)";
  return "\uFEFF" + [header, ...lines].map(line => line.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

export default { buildDetailsCSV };
