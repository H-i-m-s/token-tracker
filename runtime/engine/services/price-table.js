// 引擎侧的价格：只做两件事 —— 读价、算钱。
//
// 它不再认识「批量」「添加」「恢复默认」这些编辑动作。那些在 App 层
// （lib/price-file.mjs 是唯一写盘的地方），因为引擎是常驻子进程，
// 改它的代码要重启才生效，而价格表是会被反复调整的东西。
//
// 算术本身在 lib/price-core.mjs，两个进程共用同一份 ——
// 若各留一份，早晚漂成「界面上说已定价、看板上却算不出钱」。
import { readUserPrices } from "../../../lib/price-file.mjs";
import {
  DEFAULT_PRICE_TABLE, mergePriceTables, pickPrice, calcCost, isPriced,
} from "../../../lib/price-core.mjs";

export { DEFAULT_PRICE_TABLE, pickPrice, calcCost, isPriced };

/**
 * 生效价格表 = 默认表 + 用户表（按项覆盖）。
 *
 * 只读不写。读到坏文件时按「没有自定义价格」继续，文件原样保留 ——
 * 那是用户手改的东西，改名或删除等于把他的东西藏起来。
 *
 * 每个看板请求都会调一次（价格可能刚被设置页改过，引擎不做跨进程通知）。
 * 代价是一次同步读盘，与它省下的复杂度相比可以接受。
 */
export function loadPriceTable(dataDir, log) {
  if (!dataDir) return { ...DEFAULT_PRICE_TABLE };
  // readUserPrices 内部已经做了存在性判断与容错，不必在这里再套一层 try。
  const user = readUserPrices(dataDir, log);
  return mergePriceTables(user, DEFAULT_PRICE_TABLE);
}
