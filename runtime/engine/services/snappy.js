// 最小 snappy 解压：只实现「解压」，够 LevelDB 的 .ldb（SSTable）块用。
//
// 为什么需要它：Hana 内置浏览器把 localStorage 写进 LevelDB 之后，后台 compaction 会把
// 追加日志（.log，明文）合并进 .ldb，块按 snappy 压缩。这时在文件字节里直接搜 token
// 搜不到，必须先按块解压再读。浏览器关得越久，明文越少、压缩块越多。
//
// 格式（https://github.com/google/snappy/blob/main/format_description.txt）：
//   开头 varint：解压后的总长度
//   随后若干 element，每个以 1 字节 tag 开头，低 2 位是类型：
//     0 literal   高 6 位是最长 60 的短长度；值 >= 60 时，低 6 位表示「长度字段占几个字节」
//     1 copy1     长度 = ((tag>>2)&7)+4，偏移 = ((tag>>5)<<8) | 下一字节
//     2 copy2     长度 = (tag>>2)+1，偏移 = 后两字节小端
//     3 copy4     长度 = (tag>>2)+1，偏移 = 后四字节小端
// 只做解压，不做校验；坏数据一律抛错，调用方按「这块读不出来就跳过」对待。

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const b = buf[pos++];
    result += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value: result, pos };
    shift += 7;
    if (shift > 35) throw new Error("snappy: varint too long");
  }
  throw new Error("snappy: varint out of range");
}

export function snappyUncompress(input, expectedLength = 0) {
  const src = input instanceof Uint8Array ? input : new Uint8Array(input);
  let pos = 0;
  const head = readVarint(src, pos);
  pos = head.pos;
  const length = expectedLength > 0 ? expectedLength : head.value;
  const out = new Uint8Array(length);
  let o = 0;

  while (pos < src.length) {
    const tag = src[pos++];
    const type = tag & 0x03;

    if (type === 0) {
      // literal
      let run = tag >> 2;
      if (run >= 60) {
        const extra = run - 59;              // 1..4 字节的长度
        run = 0;
        for (let i = 0; i < extra; i++) run += src[pos + i] * 2 ** (8 * i);
        pos += extra;
      }
      run += 1;
      if (o + run > out.length) throw new Error("snappy: literal overflow");
      out.set(src.subarray(pos, pos + run), o);
      pos += run;
      o += run;
      continue;
    }

    let copyLen;
    let offset;
    if (type === 1) {
      copyLen = ((tag >> 2) & 0x07) + 4;
      offset = ((tag >> 5) << 8) | src[pos++];
    } else if (type === 2) {
      copyLen = (tag >> 2) + 1;
      offset = src[pos] | (src[pos + 1] << 8);
      pos += 2;
    } else {
      copyLen = (tag >> 2) + 1;
      offset = (src[pos] | (src[pos + 1] << 8) | (src[pos + 2] << 16) | (src[pos + 3] << 24)) >>> 0;
      pos += 4;
    }
    if (offset === 0 || offset > o) throw new Error("snappy: bad copy offset");
    if (o + copyLen > out.length) throw new Error("snappy: copy overflow");
    // 逐字节复制：snappy 允许 copy 区间与写入区间重叠（正是它压缩重复串的方式）
    let from = o - offset;
    for (let i = 0; i < copyLen; i++) out[o++] = out[from++];
  }

  if (o !== out.length) throw new Error("snappy: length mismatch " + o + "/" + out.length);
  return out;
}

export default { snappyUncompress };
