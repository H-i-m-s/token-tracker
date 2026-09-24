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
export function readTextFile(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}
