// 明细 CSV 的拼装。原样从 ui/csv-export.mjs 搬进引擎。
//
// 为什么往下搬：服务端分页之后，前端手里只有一页（50 行），而导出的语义是
// 「当前筛选 + 当前排序下的全部行」。把上万行搬到前端再拼 CSV 既慢又要顶 4 MiB 响应硬顶；
// 引擎直接查库拼好文本（约 1.5 MB）更省事。命中率口径仍与界面同一处（hitRate）。
import { hitRate } from "../../../ui/details-view.mjs";

export function buildDetailsCSV(rows) {
  const header = ["时间", "Agent", "Provider", "模型", "输入Token", "输出Token", "缓存命中率", "调用次数", "总Token", "成本"];
  const lines = rows.map((r) => {
    // 缓存命中率是这两列里唯一需要算的：没口径就留空，不写 0%（那会读成“完全没命中”）。
    const hr = hitRate(r);
    return [r.time || "", r.agentName || r.agent || "", r.provider || "", r.model || "",
      r.inputTokens ?? "", r.outputTokens ?? "",
      hr == null ? "" : (hr * 100).toFixed(1) + "%",
      r.calls ?? "",
      r.totalTokens ?? 0, r.cost ?? ""];
  });
  return "\uFEFF" + [header, ...lines].map(line => line.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n");
}

export default { buildDetailsCSV };
