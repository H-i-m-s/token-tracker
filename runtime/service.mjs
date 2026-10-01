import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { migrateLegacy } from './migration.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!path.isAbsolute(config.homeDir) || !path.isAbsolute(config.dataDir) || !/^[a-f0-9]{64}$/.test(config.secret)) throw new Error('Invalid runtime configuration');
// 配置里装的是本机访问密钥，已读进内存就没用了：立刻删掉，不给硬盘留垃圾。
// （父进程收尾时也会删一次，那是兜底；被硬杀留下的残留由下次启动清扫。）
try { fs.rmSync(process.argv[2], { force: true }); } catch {}
process.env.HANA_HOME = config.homeDir;
process.env.TOKEN_TRACKER_DATA_DIR = config.dataDir;
const migration = migrateLegacy(config.homeDir, config.dataDir);
// Import after setting the runtime's own paths. No dependency on an installed plugin.
const { default: Engine } = await import('./engine/index.js');
const { default: registerDashboard } = await import('./engine/routes/dashboard.js');
const { shapeDashboard } = await import('../lib/snapshot-service.mjs');
const handlers = new Map(), subscribers = new Set(), disposers = [];
let revision = 0;
const bus = {
  handle(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
  subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
  emit() { revision++; },
  async request(name) {
    if (name !== 'agent:list') throw new Error('Unsupported internal request');
    const root = path.join(config.homeDir, 'agents');
    let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return { agents: [] }; throw e; }
    return { agents: entries.filter(e => e.isDirectory()).map(e => {
      let name = e.name;
      try { const match = fs.readFileSync(path.join(root, e.name, 'identity.md'), 'utf8').replace(/^\uFEFF/, '').match(/^#\s+(.+)/m); if (match && !match[1].includes('{{')) name = match[1].trim(); } catch {}
      return { id: e.name, name };
    }) };
  },
};
const engine = new Engine();
engine.ctx = { dataDir: config.dataDir, config: { get: () => undefined }, log: { info: (...args) => console.log(...args), warn: (...args) => console.warn(...args), error: (...args) => console.error(...args) }, bus };
engine.register = fn => disposers.push(fn);
let initializationError = null;

async function request(method, payload = {}) {
  if (initializationError) throw initializationError;
  const cache = engine.ctx._tokenCache;
  const cached = cache?.data;
  // 上一轮扫描的结果（启动时已从 SQLite 播下）是完整的，先用它顶住首屏。
  const hasCached = !!(cached && cached.sessions && Object.keys(cached.sessions).length);
  const handlersReady = handlers.has('token-tracker.snapshot');
  // 与扫描无关的方法（余额打外网、官网用量读自己的库）不该被“扫描中”拦住。
  const scanIndependent = method === 'balance' || method === 'ds-usage';
  if (!handlersReady || (!cache?.ready && !(scanIndependent || hasCached))) {
    if (method === 'snapshot') return { ready: false, realtime: null, balances: [], agentNames: {}, revision };
    throw Object.assign(new Error('数据扫描中，请稍后刷新'), { code: 'NOT_READY' });
  }
  if (method === 'dashboard') {
    const raw = await engine.ctx._buildDashboardData(payload, { skipBalances: true, ...(Number.isFinite(config.fxRate) ? { fxRate: config.fxRate } : {}) });
    if (raw.error || raw.notReady) throw Object.assign(new Error(raw.error || '数据扫描中，请稍后刷新'), { code: 'NOT_READY' });
    // Strip message bodies, paths and provider configuration before the HTTP bridge.
    const view = shapeDashboard(raw);
    view.summary.highUsageThreshold = handlers.get('token-tracker.settings.read')().highUsageThreshold;
    return view;
  }
  // details：只取「消费明细」这一块（界面翻页/换排序/换门槛时用），不重算整份看板。
  // 挂法与 dashboard 同：直接调挂在 ctx 上的函数（_buildDetailsOnly），不经过 bus handler 表。
  if (method === 'details') {
    const fn = engine.ctx._buildDetailsOnly;
    if (typeof fn !== 'function') throw Object.assign(new Error('消费明细服务未就绪（等待路由注册）'), { code: 'NOT_READY' });
    const raw = await fn(payload);
    if (raw.error || raw.notReady) throw Object.assign(new Error(raw.error || '数据扫描中，请稍后刷新'), { code: 'NOT_READY' });
    // highUsageThreshold 必须带上：界面靠它给高用量行加底色，缺了行高亮会消失。
    return { details: raw.details ?? null, summary: { highUsageThreshold: handlers.get('token-tracker.settings.read')().highUsageThreshold } };
  }
  // diagnostics：体检（只读）。挂法与 dashboard 同：直接调挂在 ctx 上的函数（_buildDiagnostics）。
  // bytes=1 时引擎会重算一遍整份看板拆字节，所以界面把它做成单独一次点击，不跟着打开面板一起做。
  if (method === 'diagnostics') {
    const fn = engine.ctx._buildDiagnostics;
    if (typeof fn !== 'function') throw Object.assign(new Error('体检服务未就绪（等待路由注册）'), { code: 'NOT_READY' });
    return await fn(payload && typeof payload === 'object' ? payload : {});
  }
  // turn：轮次详情（「点得开」）。挂法与 dashboard 同：直接调挂在 ctx 上的函数（_readTurnCalls），
  // 不经过 bus handler 表。gate 与 dashboard 同源（都要缓存里有会话）。
  if (method === 'turn') {
    const fn = engine.ctx._readTurnCalls;
    if (typeof fn !== 'function') throw Object.assign(new Error('轮次详情服务未就绪（等待路由注册）'), { code: 'NOT_READY' });
    const p = payload && typeof payload === 'object' ? payload : {};
    return await fn(p.sessionKey, p.seq);
  }
  // details/csv：明细 CSV 导出（引擎拼好文本，约 1.5 MB）。gate 与 dashboard 同源（都要缓存就绪）。
  const name = { snapshot: 'snapshot', balance: 'balance', refresh: 'refresh', speed: 'speed', 'ds-usage': 'ds-usage', 'details/csv': 'details.csv', 'settings/read': 'settings.read', 'settings/write': 'settings.write' }[method];
  if (!name) throw Object.assign(new Error('Unknown method'), { status: 404 });
  const value = await handlers.get('token-tracker.' + name)(payload);
  if (method === 'snapshot') { value.revision = revision; if (value.realtime) delete value.realtime.sessionPath; }
  if (value?.error) throw new Error(value.error);
  return value;
}

const seenUsage = new Set();
function acceptUsage(entry) {
  if (!entry?.requestId || !entry.usage) return;
  if (seenUsage.has(entry.requestId)) return;
  seenUsage.add(entry.requestId);
  if (seenUsage.size > 5000) seenUsage.delete(seenUsage.values().next().value);
  const u = entry.usage;
  const total = v => typeof v === 'number' ? v : Number(v?.totalTokens) || 0;
  const id = entry.attribution?.agentId || 'unknown';
  const session = entry.attribution?.sessionId || entry.requestId;
  const event = { type: 'token_usage', modelId: entry.model?.modelId, modelProvider: entry.model?.provider,
    usage: { input: total(u.input), output: total(u.output), totalTokens: u.totalTokens || total(u.input) + total(u.output), cacheRead: u.cache?.readTokens || 0, reasoningTokens: u.output?.reasoningTokens || 0, cost: u.costTotal ?? u.cost?.total ?? 0 } };
  for (const fn of subscribers) fn(event, path.join(config.homeDir, 'agents', id, 'sessions', session));
  // Pick up the newly persisted usage promptly; scanner still deduplicates by mtime/requestId.
  engine.ctx._tokenCache?.scan(false).catch(() => {});
}

const server = http.createServer(async (req, res) => {
  const reply = (body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  const auth = Buffer.from(req.headers.authorization || ''), expected = Buffer.from('Bearer ' + config.secret);
  if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { reply({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401); return; }
  try {
    if (req.method !== 'POST' || req.url !== '/rpc') { reply({ error: { message: 'Not found' } }, 404); return; }
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { reply({ error: { message: 'Body too large' } }, 413); return; } chunks.push(chunk); }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reply({ error: { code: 'INVALID_JSON', message: 'Invalid JSON' } }, 400); return; }
    if (input.method === 'usage') { acceptUsage(input.payload); reply({ value: { accepted: true } }); return; }
    if (input.method === 'context') {
      const payload = input.payload || {};
      for (const fn of subscribers) fn({ type: 'context_usage', tokens: payload.tokens, contextWindow: payload.contextWindow }, payload.sessionPath);
      reply({ value: { accepted: true } }); return;
    }
    if (input.method === 'status') { reply({ value: { ready: !!engine.ctx._tokenCache?.ready, migration, revision } }); return; }
    reply({ value: await request(input.method, input.payload) });
  } catch (e) { reply({ error: { code: e.code || 'SERVICE_ERROR', message: e.message } }, e.code === 'INVALID_SETTINGS' ? 400 : e.status || 503); }
});
server.requestTimeout = 30000;
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', resolve); });
console.log('TOKEN_TRACKER_READY');
// Let the host mark the HTTP service ready before the initial history scan.
// Large histories must not be mistaken for a failed runtime startup.
setImmediate(async () => {
  // 注意：这里传的是一个空壳 router（get/post 都不干活）。routes/dashboard.js 里的 app.get/app.post
  // 全部注册在这个空壳上，等于不生效——那是引擎自带旧看板的残留（页面资产已删）。
  // 真正在用的是它的另一件事：把 ctx._buildDashboardData 挂到引擎上下文上（下面几行的总线处理器要它）。
  try { await engine.onload(); registerDashboard({ get() {}, post() {} }, engine.ctx); }
  catch (error) { initializationError = error; console.error('Token scanner initialization failed:', error.code || error.message); }
});
function stop() { for (const fn of disposers.reverse()) { try { fn(); } catch {} } server.close(); server.closeAllConnections(); }
process.once('SIGTERM', () => { stop(); process.exit(0); });
process.once('SIGINT', () => { stop(); process.exit(0); });
