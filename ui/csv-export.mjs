// 明细导出的「保存 / 预览」这一段留在前端。
//
// CSV 的拼装已经搬到引擎（runtime/engine/services/details-csv.js，RPC：token-tracker.details.csv）：
// 明细服务端分页之后，前端手里只有一页，而导出的语义是「当前筛选 + 当前排序下的全部行」。
// 这里只负责把拿到的 CSV 文本交给宿主的保存能力，拿不到就退回预览框。
export async function saveDetailsCSV(hana, content, range, { suffix = "", count = 0, preview = showCSVPreview } = {}) {
  if (typeof content !== "string") {
    // 行拼装已不在前端：再传一批行进来是调用方没跟上，早报比导出半截文件强。
    throw new Error("导出内容必须是引擎生成的 CSV 文本");
  }
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
  preview({ name, content, count });
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
