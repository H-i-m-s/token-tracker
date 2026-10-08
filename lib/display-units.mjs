// 数字单位（中文万/亿 ↔ 英文 K/M/B）的读口。
//
// 真相在引擎写的 app-settings.json 里（设置页与显示设置菜单改的都是那一格），主进程不参与写，
// 只在拼「输入栏状态位」的文字时现读一次。单独成一个文件是为了这段路径能被测到：
// 设置文件不在 dataDir 根下，而在 dataDir/engine/（引擎自己的数据目录）——两处各拼一遍就是 bug 的温床。
//
// 不缓存：一次几 KB 的读盘，比维护一份副本更不容易跟设置页脱节（用户改完，下一条回复就该按新写法出数字）。
// 读不到（没写过、文件被手改坏了、没有数据目录）一律返回 null，由调用方退回默认单位制。
import fs from "node:fs";
import path from "node:path";
import { engineDataDir } from "./local-client.mjs";

export function createDisplayUnitsReader({ dataDir }) {
  const file = dataDir ? path.join(engineDataDir(dataDir), "app-settings.json") : null;
  return function readDisplayUnits() {
    if (!file) return null;
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"))?.display?.units ?? null;
    } catch {
      return null;
    }
  };
}
