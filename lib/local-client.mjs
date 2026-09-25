import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { BusClient } from './bus-client.mjs';
import { shapeDashboard } from './snapshot-service.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// The only production transport is this App's own host-managed runtime.
export class LocalClient {
  constructor({ ctx, log = () => {}, defaultMock = false }) {
    this.ctx = ctx; this.log = log; this.defaultMock = defaultMock;
    this.mock = new BusClient({ defaultMock: true });
    this.secret = randomBytes(32).toString('hex');
    this.runtimeId = null; this.starting = null; this.disposed = false;
    this.configFile = null; this.polls = new Set(); this.unsubscribers = new Set();
  }

  async start() {
    if (this.disposed) throw new Error('Token 用量已停止');
    if (this.starting) return this.starting;
    this.starting = this._start().catch(error => { this.starting = null; throw error; });
    return this.starting;
  }

  async _start() {
    if (!this.ctx.runtime?.start || !this.ctx.dataDir) throw new Error('请使用 HanaAgent 0.978.0 或更新版本，并允许 Token 用量的本机运行与联网权限');
    const port = randomInt(40000, 60000);
    await fs.mkdir(this.ctx.dataDir, { recursive: true });
    this.configFile = path.join(this.ctx.dataDir, 'runtime-' + randomUUID() + '.json');
    // dataDir is host-issued: <HANA_HOME>/app-data/<appId>.
    await fs.writeFile(this.configFile, JSON.stringify({ port, secret: this.secret, homeDir: path.resolve(this.ctx.dataDir, '../..'), dataDir: path.join(this.ctx.dataDir, 'engine') }), { mode: 0o600 });
    // 收尾时自己那份配置会删掉（见 dispose）；这里是兜底：把历史上被硬杀留下的残留扫掉。
    // 只删“不是本次这份”且“已经超过 10 分钟”的，避开并发启动的实例。
    try {
      const names = await fs.readdir(this.ctx.dataDir);
      let swept = 0;
      for (const name of names) {
        if (!name.startsWith('runtime-') || !name.endsWith('.json')) continue;
        const full = path.join(this.ctx.dataDir, name);
        if (full === this.configFile) continue;
        try {
          const st = await fs.stat(full);
          if (Date.now() - st.mtimeMs > 10 * 60 * 1000) { await fs.rm(full, { force: true }); swept += 1; }
        } catch {}
      }
      if (swept) this.log('info', `清理了 ${swept} 个历史运行配置`);
    } catch {}
    try {
      const runtime = await this.ctx.runtime.start({ runtime: 'node', profile: 'local-machine', network: 'external', entry: 'runtime/service.mjs', args: [this.configFile], service: { port, readyMarker: 'TOKEN_TRACKER_READY' } });
      this.runtimeId = runtime.runtimeId;
      const deadline = Date.now() + 25000;
      let info = runtime;
      while (info?.state !== 'ready' || info.service?.state !== 'ready') {
        if (this.disposed || !info || ['failed','exited','stopped'].includes(info.state)) throw new Error('内置数据服务未能启动，请查看 Hana 应用运行日志');
        if (Date.now() > deadline) throw new Error('内置数据服务启动超时，请稍后刷新');
        await pause(100);
        info = await this.ctx.runtime.get(this.runtimeId);
      }
      if (this.disposed) throw new Error('Token 用量已停止');
      return this.runtimeId;
    } catch (error) {
      if (this.runtimeId) await this.ctx.runtime.stop(this.runtimeId).catch(() => {});
      this.runtimeId = null;
      if (this.configFile) await fs.rm(this.configFile, { force: true }).catch(() => {});
      throw error;
    }
  }

  async call(method, payload) {
    const id = await this.start();
    const response = await this.ctx.runtime.fetch(id, '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.secret }, body: JSON.stringify({ method, payload }), timeoutMs: 30000 });
    const body = await response.json();
    if (!response.ok || body.error) throw Object.assign(new Error(body.error?.message || '内置数据服务请求失败'), { code: body.error?.code || 'SERVICE_ERROR' });
    return body.value;
  }

  async request(event, payload = {}, { mock = this.defaultMock } = {}) {
    if (mock) {
      const raw = await this.mock.request(event, payload);
      return event === 'token-tracker.dashboard' ? shapeDashboard(raw) : raw;
    }
    return this.call(event.replace(/^token-tracker\./, '').replaceAll('.', '/'), payload);
  }

  subscribe(event, handler, { mock = this.defaultMock } = {}) {
    if (mock) return this.mock.subscribe(event, handler);
    let stopped = false, polling = false, revision = null;
    const poll = async () => {
      if (stopped || polling || this.disposed) return;
      polling = true;
      try {
        const snapshot = await this.call('snapshot');
        if (snapshot.revision !== revision) { revision = snapshot.revision; handler({ type: 'update', lastScan: snapshot.lastScan, realtime: snapshot.realtime }); }
      } catch (e) { this.log('warn', '内置数据服务不可用：', e.code || e.message); }
      finally { polling = false; }
    };
    const off = () => { stopped = true; if (timer) clearInterval(timer); this.polls.delete(off); };
    let timer;
    this.polls.add(off);
    this.start().then(() => { if (stopped || this.disposed) return; poll(); timer = setInterval(poll, 2000); timer.unref?.(); }).catch(e => this.log('warn', '内置数据服务尚未启动：', e.code || e.message));
    if (this.ctx.bus?.subscribe) {
      try {
      const unsubscribe = this.ctx.bus.subscribe((event, sessionPath) => {
        if (stopped || this.disposed) return;
        const update = event?.type === 'llm_usage' ? this.call('usage', event.entry)
          : event?.type === 'context_usage' ? this.call('context', { tokens: event.tokens, contextWindow: event.contextWindow, sessionPath }) : null;
        update?.then(poll).catch(e => this.log('warn', '实时用量更新失败：', e.code || e.message));
      }, { types: ['llm_usage', 'context_usage'] });
      unsubscribe?.ready?.catch(e => this.log('warn', '实时用量需要 app/usage.read 权限：', e.code || e.message));
      if (typeof unsubscribe === 'function') this.unsubscribers.add(unsubscribe);
      } catch (e) { this.log('warn', '实时用量需要 app/usage.read 权限：', e.code || e.message); }
    }
    return off;
  }

  async dispose() {
    this.disposed = true;
    for (const off of [...this.polls]) off();
    for (const off of this.unsubscribers) { try { off(); } catch {} }
    this.unsubscribers.clear();
    if (this.starting) await this.starting.catch(() => {});
    if (this.runtimeId) await this.ctx.runtime.stop(this.runtimeId).catch(() => {});
    if (this.configFile) await fs.rm(this.configFile, { force: true }).catch(() => {});
    this.runtimeId = null;
  }
}
