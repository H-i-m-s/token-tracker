import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Match the native user's home on Windows, even when Git/MSYS supplies HOME.
// HANA_HOME remains the explicit override for portable/custom installations.
export function resolveHanaHome({ env = process.env, platform = process.platform, homedir = os.homedir } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (env.HANA_HOME) {
    let override = env.HANA_HOME;
    if (override === '~' || override.startsWith('~/') || (platform === 'win32' && override.startsWith('~\\'))) {
      const home = platform === 'win32' ? (env.USERPROFILE || homedir()) : (env.HOME || homedir());
      override = paths.join(home, override.slice(2));
    }
    return paths.resolve(override);
  }
  const userHome = platform === 'win32' ? (env.USERPROFILE || homedir()) : (env.HOME || homedir());
  return paths.join(userHome, '.hanako');
}

// Windows editors can write a UTF-8 BOM and CRLF; JSON.parse rejects the BOM.
//
// replace 不管有没有匹配都返回新字符串，等于每读一个文件多复制两份；最大的会话文件
// 70 MB，白扔 140 MB 临时内存。先探一下子再决定要不要归一：没有 BOM、没有 \r 就直接
// 返回原字符串。探测用 indexOf，比正则快一个量级，且不分配。
// 等价性：BOM 只在开头去掉（原文就是 ^\uFEFF），\r\n 和孤立 \r 都归一成 \n（原文是 \r\n?）。
export function readTextFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const bom = text.charCodeAt(0) === 0xfeff;
  const cr = text.indexOf('\r') !== -1;
  if (!bom && !cr) return text;
  const body = bom ? text.slice(1) : text;
  return cr ? body.replace(/\r\n?/g, '\n') : body;
}
