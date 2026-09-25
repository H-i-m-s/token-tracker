// 自绘浮层（下拉 / 日期弹层）的清理入口。
//
// 这两个模块各自把浮层 append 到 document.body，触发器却可能随着宿主容器被
// replaceChildren 重渲染而消失。任何会重建浮层宿主容器的渲染入口，都应在最前面
// 调用 closeAllPickers()，把已打开的浮层立即摘除，避免留下悬空的孤儿面板。
//
// 仅做 re-export + 编排，不引入重复实现：清理逻辑各自留在 custom-select / custom-date 内。
export { closeOpenSelect } from "./custom-select.mjs";
export { closeOpenDate } from "./custom-date.mjs";

import { closeOpenSelect } from "./custom-select.mjs";
import { closeOpenDate } from "./custom-date.mjs";

export function closeAllPickers() {
  closeOpenSelect();
  closeOpenDate();
}
