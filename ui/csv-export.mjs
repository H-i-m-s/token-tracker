import { hitRate } from "./details-view.mjs";

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

export async function saveDetailsCSV(hana, rows, range, { suffix = "", preview = showCSVPreview } = {}) {
  const content = buildDetailsCSV(rows);
  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  // suffix：明细按用量设了门槛时把档位写进文件名，不然一份被筛过的 CSV 会自称是全部。
  const name = `token-details-${range}${suffix}-${date}.csv`;
  // Sandboxed App surfaces cannot reliably trigger an <a download>.
  // The host validates slot and resource grants; never bypass those checks.
  if (hana?.resources?.saveFile) {
    try {
      const bytes = new TextEncoder().encode(content);
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const result = await hana.resources.saveFile({ suggestedName: name, mimeType: "text/csv", contentBase64: btoa(binary) });
      if (["saved", "canceled", "download-started"].includes(result?.kind)) return result;
    } catch { /* Preserve an accessible export even when native saving is unavailable. */ }
  }
  preview({ name, content, count: rows.length });
  return { kind: "preview" };
}

function showCSVPreview({ name, content, count }) {
  document.querySelector(".tt-export-dialog")?.remove();
  const dialog = document.createElement("dialog");
  dialog.className = "tt-export-dialog";
  const title = document.createElement("h2");
  title.textContent = `导出 CSV · ${count} 条`;
  const note = document.createElement("p");
  note.textContent = `当前无法打开文件保存窗口。请复制下方内容，保存为 ${name}（UTF-8）。`;
  const area = document.createElement("textarea");
  area.readOnly = true;
  area.value = content;
  area.setAttribute("aria-label", "CSV 导出内容");
  const select = document.createElement("button");
  select.className = "tt-btn";
  select.textContent = "全选内容";
  select.onclick = () => { area.focus(); area.select(); };
  const close = document.createElement("button");
  close.className = "tt-btn";
  close.textContent = "关闭";
  close.onclick = () => dialog.close();
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.append(title, note, area, select, close);
  document.body.appendChild(dialog);
  dialog.showModal();
}
