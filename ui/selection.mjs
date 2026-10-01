// 多选语义的唯一出处：看板上凡「点一下能筛 / 能聚焦」的控件都走这里，别各写一套。
//
// 修饰键约定（跟系统文件管理器一致）：
//   · 不带修饰键点某项 = 只留它；它本来就是唯一选中项时 = 全不选（保留旧的「再点一下取消」习惯）
//   · Ctrl / Cmd 点 = 加一项或去掉一项
//   · Shift 点 = 从「锚点」（上一次不带修饰键或 Ctrl 点中的那一项）到这一项之间，
//                按控件里的显示顺序整段加选；这一段本来就已全选中时整段取消（Shift 再点一次能撤回）
//
// 控件自己记锚点（它知道显示顺序），这里只做纯计算，好单测、也好在 DOM 验收里直接断言。

// 字符串 / 数组都归一成数组：旧版本的状态里这四个筛选是字符串，读到就当成一项。
export function asList(v) {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined && String(x) !== "").map((x) => String(x));
  if (typeof v === "string" && v !== "") return [v];
  return [];
}

// 从事件里取修饰键。Ctrl 与 Cmd 同等对待（Mac 上按 Cmd 才是习惯动作）。
export function modsOf(event) {
  return {
    multi: !!(event && (event.ctrlKey || event.metaKey)),
    range: !!(event && event.shiftKey),
  };
}

// 计算点击后新的选中集合。current 是旧的选中值（数组或字符串），ordered 是控件里的显示顺序。
export function pickValues(current, id, ordered, mods = {}, anchor = null) {
  const cur = asList(current);
  const list = Array.isArray(ordered) ? ordered.map((x) => String(x)) : [];
  const target = String(id);
  // 结果一律按控件里的显示顺序排（不在清单里的值跟在后面）：
  // 这样请求串是稳定的，不因点选先后而变。
  const ordered_ = (vals) => {
    const set = new Set(vals);
    return list.filter((v) => set.has(v)).concat(vals.filter((v) => !list.includes(v)));
  };

  if (mods.range && anchor !== null && list.includes(String(anchor)) && list.includes(target)) {
    const [a, b] = [list.indexOf(String(anchor)), list.indexOf(target)].sort((x, y) => x - y);
    const span = list.slice(a, b + 1);
    if (span.every((v) => cur.includes(v))) return ordered_(cur.filter((v) => !span.includes(v)));
    return ordered_([...cur, ...span]);
  }

  const has = cur.includes(target);
  if (mods.multi) {
    if (has) return ordered_(cur.filter((v) => v !== target));
    return ordered_([...cur, target]);
  }
  // 不带修饰键：只留它；它本来就是唯一的选中项时清空（等于回到「全部」）。
  return has && cur.length === 1 ? [] : [target];
}

// 查询串取值：每个值编码后用半角逗号连接，引擎侧按同一规则切回来。
// 编两次是有原因的：插件层拿到 query 时会先解一次码，如果只编一次，
// 值里本来带的逗号（%2C）会在路上变回真逗号，被引擎当成分隔符切坏。
// 编两次后：插件解一次 → 还是 %2C → 引擎先切分再解码 → 还原成原来的逗号。
export function selectionParam(value) {
  return asList(value).map((v) => encodeURIComponent(encodeURIComponent(v))).join(",");
}

// 选中集合的稳定键：同一组值不管点的先后顺序，键都一样，免得白重取一次看板。
export function selectionKey(value) {
  return asList(value).slice().sort().join("\u0001");
}
