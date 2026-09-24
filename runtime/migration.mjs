import fs from 'node:fs';
import path from 'node:path';

export const LEGACY_FILES = ['token-cache.json', 'usage-archive.json', 'price-table.json', 'balance-apis.json', 'app-settings.json', 'og-limits.json', 'og-calib.json', 'og-usage-cache.json'];

// Copy once, never move/delete the old plugin's files or overwrite App data.
// A retry after interruption fills missing files; the marker is written last.
export function migrateLegacy(homeDir, dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const marker = path.join(dataDir, 'migration-v1.json');
  if (fs.existsSync(marker)) return JSON.parse(fs.readFileSync(marker, 'utf8'));
  const source = path.join(homeDir, 'plugin-data', 'token-tracker');
  const copied = [], retained = [];
  for (const name of LEGACY_FILES) {
    const from = path.join(source, name), to = path.join(dataDir, name);
    if (fs.existsSync(to)) { retained.push(name); continue; }
    if (!fs.existsSync(from)) continue;
    if (!fs.lstatSync(from).isFile()) throw new Error(`旧数据不是普通文件：${name}`);
    const bytes = fs.readFileSync(from);
    JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    const tmp = to + '.migrating';
    fs.writeFileSync(tmp, bytes, { mode: 0o600 });
    fs.renameSync(tmp, to);
    copied.push(name);
  }
  const result = { version: 1, copied, retained, completedAt: new Date().toISOString() };
  fs.writeFileSync(marker + '.tmp', JSON.stringify(result), { mode: 0o600 });
  fs.renameSync(marker + '.tmp', marker);
  return result;
}
