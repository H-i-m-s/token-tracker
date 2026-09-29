// DeepSeek 官网 userToken 的磁盘来源。
//
// 背景：官网用量（platform.deepseek.com）只认 localStorage 里的 userToken——它既不在 cookie
// 里，也不是 API key。而 Hana 内置浏览器按会话隔离存储，每个会话一间 partition，登录态不跨
// 会话共享。所以插件要拿官网用量，只能自己去磁盘上把 token 找出来。
//
// 每个 partition 里的 localStorage 是一本 LevelDB：
//   .log（WAL）        追加写、明文，浏览器活着时最新数据就在这；
//   .ldb（SSTable）    后台 compaction 合并后的形态，块按 snappy 压缩，要解压才读得到。
// 只读 .log 会在浏览器关久了之后一无所获，所以两种都要读。
//
// 安全约定：
//   - token 只通过返回值交给调用方，本模块不写盘、不打日志、不进任何缓存；
//   - 后续的「线索」（记住上次在哪找到）也只存路径与时间，不含 token 本身。
import fs from "node:fs";
import path from "node:path";
import { snappyUncompress } from "./snappy.js";

const TOKEN_KEY = "userToken";
const FOOTER_SIZE = 48;
const LDB_MAGIC = Buffer.from([0x57, 0xfb, 0x80, 0x8b, 0x24, 0x75, 0x47, 0xdb]); // 0xdb4775248b80fb57 小端

// ── 定位 partition 根目录 ──
// 常规情况下 Electron 的 userData 就是 %APPDATA%\hanako，内置浏览器把数据放在其 Partitions/ 下。
// 但内嵌 runtime 跑在受限环境里（hana-win-sandbox），环境变量可能被清空，所以这里多路探测，
// 不把 APPDATA 当成唯一事实。
export function candidatePartitionsDirs({ env = process.env } = {}) {
  const out = [];
  if (env.APPDATA) out.push(path.join(env.APPDATA, "hanako", "Partitions"));
  const home = env.USERPROFILE || env.HOME;
  if (home) out.push(path.join(home, "AppData", "Roaming", "hanako", "Partitions"));
  // HANA_HOME 默认就是 <home>/.hanako，它的父目录即家目录
  if (env.HANA_HOME) {
    const parent = path.dirname(env.HANA_HOME);
    out.push(path.join(parent, "AppData", "Roaming", "hanako", "Partitions"));
  }
  return [...new Set(out.filter(Boolean))];
}

export function defaultPartitionsDir(opts = {}) {
  const dirs = candidatePartitionsDirs(opts);
  for (const d of dirs) {
    try {
      if (fs.statSync(d).isDirectory()) return d;
    } catch {
      // 这条路不通，试下一条
    }
  }
  return dirs[0] || "";
}

// ── 从字节里抠出本文件「最后一次写入」的 userToken ──
// localStorage 的键值在 LevelDB 里是明文（ASCII 值按单字节存），UTF-8 解码即可读。
// 同一个文件里可能先写有值、后写 null（登出），所以取最后一次出现的那条，而不是最后一条非空。
function extractUserToken(text) {
  const re = /userToken/g;
  let last;
  let m;
  while ((m = re.exec(text)) !== null) {
    const seg = text.slice(m.index, m.index + 256);
    const vm = /"value"\s*:\s*(null|"([^"]*)")/.exec(seg);
    if (!vm) continue;
    last = vm[1] === "null" ? null : vm[2];
  }
  return last;
}

function readUint32LE(buf, pos) {
  return buf[pos] | (buf[pos + 1] << 8) | (buf[pos + 2] << 16) | (buf[pos + 3] << 24);
}

function readVarintBuf(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value: result, pos };
    shift += 7;
    if (shift > 35) throw new Error("varint too long");
  }
  throw new Error("varint out of range");
}

// BlockHandle 的 size 只算「块内容」，不含后面 5 字节 trailer（1 字节压缩类型 + 4 字节 crc）。
// 把 trailer 当成内容去切，会把块砍掉一截——这正是最初解不出内容的原因。
function readBlock(buf, off, size) {
  if (off < 0 || size <= 0 || off + size > buf.length) throw new Error("block out of range");
  const content = buf.subarray(off, off + size);
  const type = off + size < buf.length ? buf[off + size] : 0;
  if (type === 0) return content;
  if (type === 1) return Buffer.from(snappyUncompress(content));
  throw new Error("unsupported compression type " + type);
}

// 解析 block 内的前缀压缩条目（LevelDB 的标准布局），返回 {key, value} 列表。
function parseBlockEntries(block) {
  const out = [];
  if (block.length < 4) return out;
  const numRestarts = readUint32LE(block, block.length - 4);
  const end = block.length - 4 - numRestarts * 4;
  let pos = 0;
  let lastKey = Buffer.alloc(0);
  while (pos < end) {
    let r = readVarintBuf(block, pos); const shared = r.value; pos = r.pos;
    r = readVarintBuf(block, pos); const nonShared = r.value; pos = r.pos;
    r = readVarintBuf(block, pos); const valueLen = r.value; pos = r.pos;
    const delta = block.subarray(pos, pos + nonShared); pos += nonShared;
    const value = block.subarray(pos, pos + valueLen); pos += valueLen;
    const key = Buffer.concat([lastKey.subarray(0, shared), delta]);
    lastKey = key;
    out.push({ key, value });
  }
  return out;
}

// 读一个 .ldb（SSTable）：footer → index block → 各 data block，解压后拼成明文。
export function readLdbText(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < FOOTER_SIZE) return "";
  const footer = buf.subarray(buf.length - FOOTER_SIZE);
  if (!footer.subarray(40, 48).equals(LDB_MAGIC)) return "";
  let r = readVarintBuf(footer, 0);
  r = readVarintBuf(footer, r.pos);            // metaindex: offset, size
  r = readVarintBuf(footer, r.pos);            // index: offset
  const indexOffset = r.value;
  r = readVarintBuf(footer, r.pos);            // index: size
  const indexSize = r.value;

  const indexBlock = readBlock(buf, indexOffset, indexSize);
  const chunks = [];
  for (const entry of parseBlockEntries(indexBlock)) {
    let p = readVarintBuf(entry.value, 0);
    const off = p.value;
    p = readVarintBuf(entry.value, p.pos);
    const size = p.value;
    try {
      chunks.push(readBlock(buf, off, size));
    } catch {
      // 单个坏块不影响其余块；能读多少读多少
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── 扫一个文件 ──
function readTokenFromFile(file) {
  try {
    if (file.endsWith(".ldb")) {
      return extractUserToken(readLdbText(file));
    }
    return extractUserToken(fs.readFileSync(file).toString("utf8"));
  } catch {
    return undefined; // 读不了就当作「这里没有」，交给别的候选
  }
}

// ── 全盘扫描：所有 partition 的 leveldb 目录 ──
// 返回按修改时间倒序的候选列表（含 token 为 null 的登出态，便于诊断）。
export function scanTokenCandidates({ partitionsDir = defaultPartitionsDir() } = {}) {
  const hits = [];
  if (!partitionsDir) return hits;
  let partitions;
  try {
    partitions = fs.readdirSync(partitionsDir, { withFileTypes: true });
  } catch {
    return hits;
  }
  for (const p of partitions) {
    if (!p.isDirectory()) continue;
    const ldb = path.join(partitionsDir, p.name, "Local Storage", "leveldb");
    let files;
    try {
      files = fs.readdirSync(ldb);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!/\.(log|ldb)$/.test(f)) continue;
      const full = path.join(ldb, f);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      const token = readTokenFromFile(full);
      if (token === undefined) continue; // 这个文件里压根没有 userToken
      hits.push({ partition: p.name, file: full, mtime: st.mtimeMs, token });
    }
  }
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits;
}

// 诊断：把「为什么没拿到 token」拆成能分辨的几种情况，避免静默失败。
// 区分：目录不存在 / 目录不可读（权限）/ 读得到但没有 token / 只有登出态。
export function diagnosePartitions({ partitionsDir, env = process.env } = {}) {
  const candidates = candidatePartitionsDirs({ env });
  const dir = partitionsDir || defaultPartitionsDir({ env });
  const info = {
    partitionsDir: dir || null,
    candidates,
    env: { APPDATA: env.APPDATA || null, USERPROFILE: env.USERPROFILE || null, HANA_HOME: env.HANA_HOME || null },
    exists: false,
    readable: false,
    entries: 0,
    error: null,
    filesWithTokenKey: 0,
    filesWithValue: 0,
  };
  if (!dir) {
    info.error = "NO_PATH";
    return info;
  }
  try {
    info.exists = fs.statSync(dir).isDirectory();
  } catch (e) {
    info.error = e.code || String(e.message);
    return info;
  }
  try {
    info.entries = fs.readdirSync(dir).length;
    info.readable = true;
  } catch (e) {
    info.error = e.code || String(e.message);
    return info;
  }
  try {
    const hits = scanTokenCandidates({ partitionsDir: dir });
    info.filesWithTokenKey = hits.length;
    info.filesWithValue = hits.filter(h => h.token).length;
  } catch (e) {
    info.error = e.code || String(e.message);
  }
  return info;
}

// 对外入口：拿最新的一把有效 token。
// hint：上次命中的 { file, mtime }，文件没变就直接用，省一次全盘扫描。
// 返回 { token, source } 或 null。token 为 null 表示最近一次是登出态（仍带 source 供诊断）。
export function findUserToken({ partitionsDir = defaultPartitionsDir(), hint = null } = {}) {
  if (hint && hint.file) {
    try {
      const st = fs.statSync(hint.file);
      if (!hint.mtime || st.mtimeMs === hint.mtime) {
        const token = readTokenFromFile(hint.file);
        if (token !== undefined) return { token, source: { partition: hint.partition, file: hint.file, mtime: st.mtimeMs } };
      }
    } catch {
      // 线索失效：文件没了或被改了，退回全盘扫描
    }
  }
  const hits = scanTokenCandidates({ partitionsDir });
  if (!hits.length) return null;
  const best = hits.find(h => h.token) || hits[0];
  return { token: best.token, source: { partition: best.partition, file: best.file, mtime: best.mtime } };
}

export default { findUserToken, scanTokenCandidates, defaultPartitionsDir, candidatePartitionsDirs, diagnosePartitions, readLdbText };
