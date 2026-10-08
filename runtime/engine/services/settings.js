import { readTextFile } from "./platform.js";
import fs from 'node:fs';
import path from 'node:path';
import { loadBalanceApis } from './balance.js';

const PROVIDERS = {
  deepseek: ['enabled'], glm: ['enabled'], minimax: ['enabled'],
  'minimax-token-plan': ['enabled'],
  sensenova: ['enabled', 'token', 'username', 'password'],
  'volcengine-coding': ['enabled', 'ak', 'sk', 'region'],
  'opencode-go': ['enabled', 'workspaceId', 'cookie'],
};
const SECRETS = new Set(['token', 'password', 'ak', 'sk', 'cookie']);
const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_SETTINGS' });

// display 读出来给前端的形状：表格密度 + 数字单位（中文万/亿 ↔ 英文 K/M/B）。
// colorScheme 一直是 auto 占位。坏值一律回到默认：设置文件里一个手改的字符串不该把整页数字搞变形。
function normalizeDisplay(value) {
  const d = value && typeof value === 'object' ? value : {};
  return {
    density: d.density === 'comfortable' ? 'comfortable' : 'compact',
    units: d.units === 'en' ? 'en' : 'zh',
    colorScheme: 'auto',
  };
}
function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function createSettingsService({ dataDir, config }) {
  const file = path.join(dataDir, 'app-settings.json');
  const apiFile = path.join(dataDir, 'balance-apis.json');
  const load = () => fs.existsSync(file) ? JSON.parse(readTextFile(file)) : {};
  function read() {
    const saved = load();
    const apis = loadBalanceApis(dataDir);
    const balanceApis = {};
    for (const [id, fields] of Object.entries(PROVIDERS)) {
      const source = apis[id] || {};
      const item = { enabled: source.enabled ?? ['deepseek', 'glm'].includes(id), configured: {} };
      for (const key of fields) {
        if (SECRETS.has(key)) item.configured[key] = !!source[key];
        else if (source[key] !== undefined) item[key] = source[key];
      }
      balanceApis[id] = item;
    }
    return { scanInterval: saved.scanInterval ?? config?.get('scanInterval') ?? 60,
      highUsageThreshold: saved.highUsageThreshold ?? config?.get('highUsageThreshold') ?? 30000,
      display: normalizeDisplay(saved.display), balanceApis };
  }
  function write(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('设置必须是对象');
    const next = { ...load() };
    for (const [key, min, max] of [['scanInterval', 10, 86400], ['highUsageThreshold', 0, 1e12]]) {
      if (patch[key] !== undefined) {
        if (!Number.isFinite(patch[key]) || patch[key] < min || patch[key] > max) throw invalid(`${key} 超出范围`);
        next[key] = patch[key];
      }
    }
    if (patch.display !== undefined) {
      // 两项都可以单独发（显示设置菜单只换数字单位，设置页两项一起发）：没发的沿用盘上那份。
      // 盘上那份要先按 read() 的规矩规范化再用：从没存过 display、或文件被手改坏了，
      // 这里就该拿到默认值，而不是 undefined —— 拿到 undefined 会直接判成「无效的显示密度」。
      const stored = normalizeDisplay(next.display);
      const density = patch.display?.density ?? stored.density;
      if (!['compact', 'comfortable'].includes(density)) throw invalid('无效的显示密度');
      const units = patch.display?.units ?? stored.units;
      if (!['zh', 'en'].includes(units)) throw invalid('无效的数字单位');
      next.display = normalizeDisplay({ density, units });
    }
    const apis = fs.existsSync(apiFile) ? JSON.parse(readTextFile(apiFile)) : {};
    if (patch.balanceApis !== undefined) {
      if (!patch.balanceApis || typeof patch.balanceApis !== 'object' || Array.isArray(patch.balanceApis)) throw invalid('无效的余额配置');
      for (const [id, item] of Object.entries(patch.balanceApis)) {
        if (!PROVIDERS[id] || !item || typeof item !== 'object' || Array.isArray(item)) throw invalid('未知供应商配置');
        const nextApi = { ...apis[id] };
        for (const key of PROVIDERS[id]) {
          if (item[key] === undefined) continue;
          if (key === 'enabled') {
            if (typeof item[key] !== 'boolean') throw invalid('enabled 必须是布尔值');
          } else if (typeof item[key] !== 'string' || item[key].length > 16384) throw invalid('无效的凭据字段');
          // Empty password inputs preserve stored credentials. Never echo them to the iframe.
          if (SECRETS.has(key) && !item[key].trim()) continue;
          nextApi[key] = item[key];
        }
        apis[id] = nextApi;
      }
    }
    fs.mkdirSync(dataDir, { recursive: true });
    if (patch.balanceApis !== undefined) atomicWrite(apiFile, apis);
    atomicWrite(file, next);
    return read();
  }
  return { read, write };
}
