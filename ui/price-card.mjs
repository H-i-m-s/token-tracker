// 「模型价格」那张卡。
//
// 为什么单独一个文件而不是塞进 settings.mjs：
//   这一张卡的操作方式和其他四张卡不一样。其他卡是「改一处 → 提交整张卡」，
//   这里是几百个独立的小格子、还要支持批量套用，需要自己的一套状态（选中集、批量栏）。
//   硬塞进去会让那套「read/baseline/diff」机制多出一堆特例。
//
// 保存契约仍是设置页那一条：改完就存，没有保存按钮。
// 差别在粒度：按项存。一个输入框失焦就 PATCH 它自己那一项，
// 批量套用是一次 PATCH 多项。这样 58 个模型 × 4 个框才改得动。
//
// 价格来源用三种标记说清，不靠颜色猜：
//   「你填的」   用户表里有这一项，输入框显示它
//   「默认」     程序自带的价格，输入框留空、显示默认值作占位
//   「未填」     谁都没给，这一项算不出钱
//
// 一行里只有两样东西：模型名 + 四个价格框。
// 不加用量、不加最后使用日期、不加上面那三种来源标签、不加「恢复默认」按钮。
// 这些曾经都加过，代价是把模型名挤成「dee...」—— 填价前先得看清填的是哪个模型，
// 名字只占得到一点点，后面摆什么都白废。
// 「恢复默认」的行为保留，但不再用按钮：把四格清空就是恢复默认（这个语义本来就有）。
import { h } from "./components.mjs";
import { filterPriceGroups, splitHighlight } from "./price-filter.mjs";
import { displayPrice, toStoredPrice, priceUnitLabel } from "./price-money.mjs";
// 折叠动画的节奏。跟 doc-intake 的「环境依赖管理」取同一套参数：
// 时长随位移缩放（收起一个空块不该等 400ms），缓动同一条曲线，
// 让两处折叠在手上的感觉是同一个东西。
const COLLAPSE_MIN_MS = 200;
const COLLAPSE_MAX_MS = 420;
const COLLAPSE_EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const collapseDuration = (height) => Math.round(Math.min(
  COLLAPSE_MAX_MS,
  Math.max(COLLAPSE_MIN_MS, 150 + height * 0.22),
));

// 四个价位。cacheWrite 放最后：绝大多数模型是 0，用户确认过「不写就是 0」。
export const PRICE_FIELDS = [
  { key: "input", label: "输入", hint: "缓存未命中" },
  { key: "cacheRead", label: "缓存读", hint: "命中缓存" },
  { key: "output", label: "输出", hint: "" },
  { key: "cacheWrite", label: "缓存写", hint: "多数模型为 0" },
];

// 一个价格对象 → 界面上的四个字符串。
// 人民币基准下「界面价」就是「文件里的价」，displayPrice 原样返回，
// 保留这一层是为了将来若真要支持多币种录入，改动集中在一处。
// 缺的项给空串（不是 0）：空 = 没填。
function priceToValues(price) {
  const shown = displayPrice(price);
  const out = {};
  for (const f of PRICE_FIELDS) {
    const v = shown?.[f.key];
    out[f.key] = Number.isFinite(v) ? String(v) : "";
  }
  return out;
}

export class PriceCard {
  constructor({ api, mock, log = () => {} }) {
    this.api = api;
    this.mock = mock;
    this.log = log;
    this.data = null;          // 服务端给的并集清单
    this.selected = new Set(); // 勾选的 key（批量套用用）
    this.collapsed = true;     // 默认收起：这一卡有 58 行，不收起会把整页顶下去
    this.batch = { input: "", cacheRead: "", output: "", cacheWrite: "" };
    this.saving = new Set();
    this.el = null;
    this.bodyEl = null;
    this.batchEl = null;
    this.staleValues = new Map(); // key → 正在编辑但还没保存的值，避免重绘把字冲掉
    // 搜索词。空串 = 不过滤。
    // 这是本地过滤，不请求服务端：全量也就几十上百行，重画代价小于一次往返。
    this.query = "";
  }

  async load() {
    const res = await this.api.getPriceTable({ mock: this.mock });
    this.data = res;
    return res;
  }

  // 卡片骨架。价格数据是异步来的，先把壳挂上去，数据到了再填，避免整页等一次请求。
  //
  // 折叠的写法照着 doc-intake 的「环境依赖管理」：
  //   · 卡片头本身就是一个按钮（左侧三角 + 标题 + 一句结论）
  //   · 三角用 border 画，展开时旋转 90°
  //   · 高度用 WAAPI 量高后过渡，不写死、不靠 max-height 猜
  render() {
    this.countEl = h("span", { className: "tts-price__summary" }, "检测中…");
    this.caretEl = h("span", { className: "tts-price__caret", "aria-hidden": "true" });
    // 卡片头整个是按钮：点标题、点三角、点摘要都是同一次开合。
    const head = h("button", {
      type: "button",
      className: "tts-price__head",
      id: "price-toggle",
      "aria-expanded": String(!this.collapsed),
      "aria-controls": "price-body",
      onClick: () => this.setCollapsed(!this.collapsed),
    },
      this.caretEl,
      h("span", { className: "tts-price__label" },
        h("span", { className: "tts-price__title" }, "模型价格"),
        this.countEl,
      ),
    );

    this.bodyEl = h("div", { className: "tts-price__body", id: "price-body" });
    this.bodyEl.hidden = this.collapsed;
    // 批量栏只建一次，内容当场填好，之后由 paint() 负责插到搜索框下方。
    //
    // 之前踩过的坑：早期版本只 new 了元素存在 this.batchEl 上，
    // 靠 hidden 控制显隐，但它从来没被 append 进任何父节点 ——
    // 于是「批量填价」面板其实一直没显示过。这里建完立即 fillBatchBar()，
    // 让「元素存在」与「有内容」不能分开。
    this.batchEl = h("div", { className: "tts-price__batch" });
    this.batchEl.hidden = true;
    this.batchEl.append(this.renderBatchBar());
    // 清单区：位置固定，内容靠 repaintList() 整块替换。
    // 先建好并挂在 body 里，这样「清单在哪」永远只有一个答案，
    // 不依赖批量栏显隐、也不靠别的节点的 nextSibling 推算。
    this.listEl = h("div", { className: "tts-price__list" });

    this.el = h("section", { className: "tts-card tts-price" },
      head,
      h("p", { className: "tts-card__desc" },
        // 单位就是人民币，不再写「美元」。
        // 上一版这里写的是「单位是美元，换币种只是显示时换算」——
        // 那是把「存美元」当成了事实写进说明，与用户要的人民币基准正好相反。
        `按用量给每个模型算钱。单位是「${priceUnitLabel()} / 每百万 token」。填了才会计入预估费用；`,
        "没填的模型在消费明细里显示「未完整定价」。价格存在 price-table.json，可以用编辑器直接改，",
        "填多少就是多少，不做币种换算。"),
      this.bodyEl,
    );
    return this.el;
  }

  // ── 开合（WAAPI 量高，和 doc-intake 同一套）──
  // 三条坑都是 doc-intake 那边踩过的，原样避开：
  //   ① fill:"forwards" 的动画播完会继续锁住高度，之后内容长高就溢出 —— 播完必须 cancel。
  //   ② 收起的块 body 是 hidden，量高得先临时揭开，量完盖回去。
  //   ③ reduced-motion 下直接切，不做动画。
  setCollapsed(collapsed) {
    const next = !!collapsed;
    if (next === this.collapsed && this.bodyEl) return;
    const body = this.bodyEl;
    if (!body) { this.collapsed = next; return; }
    const from = body.hidden ? 0 : body.getBoundingClientRect().height;
    this.collapsed = next;
    const to = next ? 0 : this.measureBody();
    const head = this.el?.querySelector(".tts-price__head");
    if (head) head.setAttribute("aria-expanded", String(!next));

    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduce || from === to) { this.paintCollapse(next); return; }
    if (this.anim) { try { this.anim.cancel(); } catch {} this.anim = null; }
    body.hidden = false;
    // 只锁 overflow：高度动画期间内容不能溢出。
    body.style.overflow = "hidden";
    body.style.height = `${from}px`;
    const anim = body.animate(
      [{ height: `${from}px` }, { height: `${to}px` }],
      { duration: collapseDuration(Math.abs(to - from)), easing: COLLAPSE_EASE, fill: "forwards" },
    );
    this.anim = anim;
    // 收尾必须拿**局部变量 anim** 去 cancel，不能靠 paintCollapse 里那个 `if (this.anim)`。
    //
    // 踩过的坑（本轮的 bug）：
    //   this.anim = null; this.paintCollapse(next);
    // 先把字段置空再交给 paintCollapse，而 paintCollapse 能不能 cancel 全看这个字段
    // —— 条件永远不成立，动画就从来没被取消过。
    // fill:"forwards" 于是永久铉住高度：
    //   展开之后不论内容怎么长（勾选弹出批量栏、搜索后清空），
    //   body 的高度都停在动画结束那一瞬的值上，内容直接从卡片下缘滲出去。
    // 表现就是「批量选中时部分模型被顶出卡片」，且刷新后一切正常（新卡没跑过动画）。
    anim.onfinish = () => {
      if (this.anim === anim) this.anim = null;
      this.paintCollapse(next, anim);
    };
  }

  /** 量展开后的高度：先把 hidden 揭开量，量完盖回去，避免闪一下。
   *
   *  不再夹 max-height：内容区已改成随页面长，没有内滚动。
   *  （以前夹它是因为卡内有个 460px 的滚动框，内容超过上限时要停在 460，
   *   否则动画会先越过上限再弹回来，看出一下多余的下探。）
   */
  measureBody() {
    const body = this.bodyEl;
    const wasHidden = body.hidden;
    if (wasHidden) body.hidden = false;
    const raw = body.scrollHeight;
    if (wasHidden) body.hidden = true;
    return raw;
  }

  /** 过渡落地：把动画留下的内联高度清掉，交回布局自己算。
   *
   *  `extra` 是刚播完、还没来得及取消的那一个动画。
   *  必须在这里显式 cancel 掉它 —— 否则 `fill: "forwards"` 会继续铉住高度，
   *  而内联 height 已经被清空，看上去一切正常，只有内容长高时才会露出来。
   */
  paintCollapse(collapsed, extra = null) {
    const body = this.bodyEl;
    for (const a of [this.anim, extra]) {
      if (!a) continue;
      try { a.cancel(); } catch {}
    }
    this.anim = null;
    body.hidden = collapsed;
    body.style.height = "";
    body.style.overflow = "";
  }

  /**
   * 内容要变了，先确保没有遗留的高度动画在铉住 body。
   *
   * paint() 会 replaceChildren 重建整块内容，高度会变；
   * 但一个 fill:"forwards" 的旧动画会把 body 高度铉在旧值上，而 body 自己不滚，
   * 于是多出来的内容直接漫出卡片。这一个备份间避免以后再踩同一个坑。
   */
  releaseHeightLock() {
    const body = this.bodyEl;
    if (!body) return;
    const live = typeof body.getAnimations === "function" ? body.getAnimations() : [];
    for (const a of live) { try { a.cancel(); } catch {} }
    if (this.anim) { try { this.anim.cancel(); } catch {} this.anim = null; }
    // 只清掉动画留下的那两个内联属性；用户主动展开时它们本来就不该存在。
    if (body.style.height) body.style.height = "";
    if (body.style.overflow === "hidden") body.style.overflow = "";
  }

  // 数据到了：重画整块。价格表重画是廉价的，不值得为增量更新写一套 diff。
  paint() {
    if (!this.data) return;
    this.releaseHeightLock();
    const { count } = this.data;
    this.bodyEl.replaceChildren();
    // 添加模型与搜索永远在最上面，哪怕清单是空的 ——
    // 没有这两行，一个全新用户打开这张卡就只看到一句「还没有可填的模型」，无处下手。
    this.bodyEl.append(this.renderAddBar());
    this.bodyEl.append(this.renderSearchBar());

    // 清单不完整时说清楚原因。这比一句空白的「还没有模型」有用得多。
    const missing = this.missingNote();
    if (missing) this.bodyEl.append(h("p", { className: "tts-price__empty" }, missing));

    // 批量栏与清单区的**位置关系只在这里定义一次**：
    // 批量栏、然后清单区。两者都只 append 到 body，不会插到别人前面。
    // repaintList() 只换清单区内部的内容，不再碰兄弟节点。
    this.bodyEl.append(this.batchEl);
    this.bodyEl.append(this.listEl);

    this.repaintList();
  }

  /**
   * 按搜索词过滤后的分组。逻辑在 price-filter.mjs（纯函数，有单测）。
   * 这里只把 this.query 递过去。
   */
  filteredGroups() {
    return filterPriceGroups(this.data?.groups || [], this.query).groups;
  }

  /** 卡片头那句：命中数 / 总数。搜索时两句都要有，否则不知道是没搜到还是本来就没有。 */
  syncSummary(total, visible, groupCount) {
    if (!this.countEl) return;
    if (!total) { this.countEl.textContent = "尚未加载到模型"; return; }
    if (!this.query.trim()) { this.countEl.textContent = `${total} 个模型`; return; }
    this.countEl.textContent = visible
      ? `找到 ${visible} / ${total} 个模型（${groupCount} 个供应商）`
      : `没有匹配「${this.query}」的模型`;
  }

  // ── 搜索 ──
  // 只过滤界面，不碰数据、不写盘。空词就是不过滤。
  // 不做防抖：本地过滤几十行是微秒级，加了防抖反而让输入跟手变差。
  renderSearchBar() {
    const input = h("input", {
      type: "search",
      className: "tts-price__search-input",
      placeholder: "搜模型或供应商，例：flash / deepseek",
      spellcheck: "false",
      value: this.query,
      autocomplete: "off",
    });
    // 输入框是重建的，重建后要保持打字位置。
    if (this.query) {
      queueMicrotask(() => {
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    }
    const clear = h("button", {
      type: "button",
      className: "tts-price__search-clear",
      title: "清空搜索",
      "aria-label": "清空搜索",
      onClick: () => { this.query = ""; this.paint(); this.focusSearch(); },
    }, "×");
    clear.hidden = !this.query;

    input.addEventListener("input", () => {
      const next = input.value;
      if (next === this.query) return;
      this.query = next;
      // 重画会把输入框换掉，打字会断。所以搜索只重画清单部分，
      // 输入框保持原样 —— 见 repaintList()。
      this.repaintList();
      if (clear) clear.hidden = !this.query;
    });
    // Esc 清空：搜索框里的惯例。
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.query) { e.preventDefault(); this.query = ""; this.paint(); this.focusSearch(); }
    });

    this.searchInput = input;
    return h("div", { className: "tts-price__search" },
      h("span", { className: "tts-price__search-icon", "aria-hidden": "true" }),
      input, clear,
    );
  }

  focusSearch() {
    try { this.searchInput?.focus(); } catch {}
  }

  /**
   * 只重画清单（不动添加栏与搜索框本身）。
   * 搜索输入时走这条：整块重画会把正在打字的 input 换掉，光标与法输入全部断。
   */
  repaintList() {
    if (!this.data) return;
    const { count } = this.data;
    const visible = this.filteredGroups();
    const visibleCount = visible.reduce((s, g) => s + g.items.length, 0);
    this.syncSummary(count, visibleCount, visible.length);

    // 清单区是一个固定位置的容器，只换它里面的内容。
    //
    // 以前这里是「每次搜索都把列头与分组插入到批量栏后面」，依赖 anchor.nextSibling 定位：
    //   · 那段代码每插一个节点就重读一次 nextSibling，于是列头被放到了末尾、
    //     第一个分组又被插到了列头前面 —— 结果表头跑到所有行下面。
    //   · 更麻烦的是它靠“别的节点在哪”推算自己的位置，而那些节点会因为批量栏显隐而进出。
    // 改成固定容器后，位置只有一个真相：listEl 在 body 里的位置。
    // 重画就是 listEl.replaceChildren(...)，不可能再错位。
    const listEl = this.listEl;
    const nodes = [];

    if (!count || !visibleCount) {
      // 批量栏在没结果时也不该露出来。
      // 两种「空」的文案必须分开：
      //   count 为 0 = 清单本身就空（还没加载到模型），提示用户去添加；
      //   count > 0 而 visibleCount 为 0 = 搜不到，提示改词。
      nodes.push(h("p", { className: "tts-price__empty tts-price__empty--filter" },
        count
          ? `没有匹配「${this.query}」的模型。`
          : "清单里还没有模型。上面填一个「供应商 / 模型名」就能开始加价。"));
      listEl.replaceChildren(...nodes);
      this.syncBatchBar();
      return;
    }

    nodes.push(h("div", { className: "tts-price__colhead" },
      h("span", { className: "tts-price__colhead-name" }, "模型"),
      PRICE_FIELDS.map((f) => h("span", { className: "tts-price__colhead-cell", title: f.hint || f.label }, f.label)),
    ));
    for (const group of visible) nodes.push(this.renderGroup(group));
    listEl.replaceChildren(...nodes);
    this.syncBatchBar();
  }

  /**
   * 清单不完整时的说明。两份外部数据（用过的 / 现在展示的）都由引擎提供，
   * 引擎还是旧的或查询失败时它们都是空，用户会以为「我的模型不见了」。
   * 不把这件事说出来，比少列几行更坑。
   */
  missingNote() {
    const d = this.data;
    if (!d) return "";
    const used = d.usedReady === true;
    const shown = d.shownReady === true;
    if (used && shown) return "";
    if (!used && !shown) {
      return d.sourceError
        ? `暂时读不到你在用的模型（内置服务还是旧版本：${d.sourceError}）。重启 Hana 之后会自动列出来；现在可以先在下面自己添加。`
        : "暂时读不到你在用的模型。现在可以先在下面自己添加。";
    }
    if (!used) return "读不到「用过的模型」这一半，只列出了配置里有的模型。";
    return "读不到「配置里有的模型」这一半，只列出了用过的模型。";
  }

  // ── 自己加一个模型 ──
  // 并集只能盖住「用过的」与「catalog 里配过的」。用户手里总有第三个来源：
  // 刚签的供应商、手动算的套餐、朋友报的一个价 —— 这些不该逼他先去用一次、
  // 或者先去改 provider-catalog.json 才能填价。
  //
  // 输入方式就是价格表自己的键形状（供应商/模型），不另设两个下拉：
  //   供应商名与模型名本来就没有权威清单（catalog 只是「Hana 知道的那部分」），
  //   硬做下拉反而把用户关在里面。分隔符接受 / 和 空格外的第一个斜杠，
  //   模型名里允许再带斜杠（如 magpie-gateway/workbuddy/xxx）。
  renderAddBar() {
    const keyInput = h("input", {
      type: "text",
      className: "tts-price__add-key",
      placeholder: "供应商/模型名，例：deepseek/deepseek-v4-flash",
      spellcheck: "false",
    });
    this.addKeyInput = keyInput;
    const note = h("span", { className: "tts-price__add-note" });
    this.addNote = note;

    const commit = async () => {
      const raw = keyInput.value.trim();
      if (!raw) return;
      const at = raw.indexOf("/");
      if (at <= 0 || at === raw.length - 1) {
        this.setAddNote("要写成「供应商/模型名」，中间那个斜杠不能省", true);
        return;
      }
      const key = raw.slice(0, at) + "/" + raw.slice(at + 1);
      // 已存在就只把它展开定位，不重写一个空价把人家填过的值盖掉。
      const exists = this.data?.groups?.some((g) => g.items.some((i) => i.key === key));
      if (exists) {
        this.setAddNote(`${key} 已经在清单里，直接在上面改就行`, true);
        return;
      }
      // 先写一个空价对象：只立键、不填数，让它立刻出现在清单里、能接着填。
      // 不能写成四个 0：那是「免费」，与「还不知道」是两件事。
      // 后端对空对象的处理是「立键但不写数字」，不会推出「恢复默认」。
      const ok = await this.patch([{ key, price: {}, declare: true }], key);
      if (ok) {
        this.setAddNote(`已加入 ${key}，在上面那行填价`);
        keyInput.value = "";
      }
    };

    keyInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); void commit(); }
    });

    const btn = h("button", { type: "button", className: "tt-btn ghost", onClick: () => void commit() }, "添加模型");
    return h("div", { className: "tts-price__add" },
      h("div", { className: "tts-price__add-row" },
        h("span", { className: "tts-price__add-title" }, "清单里没有的模型"),
        keyInput, btn,
      ),
      note,
    );
  }

  setAddNote(text, isError = false) {
    if (!this.addNote) return;
    this.addNote.textContent = text || "";
    if (isError) this.addNote.dataset.kind = "err";
    else delete this.addNote.dataset.kind;
  }

  // ── 批量套用栏（内容）──
  //
  // 这里的输入框**不**用 .tts-price__cell：那个类现在带 width:100%，
  // 是为「行里占满一列」（grid 列）设计的，拿到批量栏的 flex 行里就会被拉成半行。
  // 两处尺寸诉求相反，共用一个类只能靠覆盖，覆盖又很容易漏 —— 分开两个类最省事。
  renderBatchBar() {
    const inputs = {};
    this.batchInputs = inputs;
    const field = (spec) => {
      const input = h("input", {
        type: "text",
        inputmode: "decimal",
        className: "tts-price__batch-input",
        placeholder: "0",
        name: `batch-${spec.key}`,
        title: spec.hint ? `${spec.label}（${spec.hint}）` : spec.label,
      });
      input.addEventListener("input", () => { this.batch[spec.key] = input.value; this.syncBatchBar(); });
      inputs[spec.key] = input;
      return h("label", { className: "tts-price__batch-cell" },
        h("span", { className: "tts-price__batch-label" }, spec.label), input);
    };
    this.applyBtn = h("button", {
      type: "button",
      className: "tt-btn",
      onClick: () => this.applyBatch(),
    }, "套用到选中");
    this.clearBtn = h("button", {
      type: "button",
      className: "tt-btn ghost",
      onClick: () => this.clearSelection(),
    }, "取消选择");
    this.batchNote = h("span", { className: "tts-price__batch-note" });

    return h("div", { className: "tts-price__batch-inner" },
      h("div", { className: "tts-price__batch-head" },
        h("span", { className: "tts-price__batch-title" }, "批量填价"),
        this.batchNote,
      ),
      h("div", { className: "tts-price__batch-fields" }, PRICE_FIELDS.map(field)),
      h("div", { className: "tts-price__batch-actions" }, this.clearBtn, this.applyBtn),
    );
  }

  syncBatchBar() {
    if (!this.batchNote) return;
    const n = this.selected.size;
    // 搜索时会出现一个真陷阱：选中集是跨组的，而你只看得见其中一部分。
    // 「套用到选中」会把价写给**你看不见的**那些行 —— 用户根本不知道发生了什么。
    // 所以这里把「选了几个 / 其中几个看不见」写给用户，不隐逗。
    let hidden = 0;
    if (this.query.trim() && n) {
      const shownKeys = new Set();
      for (const g of this.filteredGroups()) for (const i of g.items) shownKeys.add(i.key);
      for (const k of this.selected) if (!shownKeys.has(k)) hidden++;
    }
    if (!n) {
      this.batchNote.textContent = "先勾选模型，或勾上某个供应商的名字整块选中";
    } else if (hidden) {
      this.batchNote.textContent = `已选 ${n} 个，其中 ${hidden} 个不在当前搜索结果里（套用会一起写入）`;
      this.batchNote.dataset.kind = "warn";
    } else {
      this.batchNote.textContent = `已选 ${n} 个模型`;
      delete this.batchNote.dataset.kind;
    }
    // 没选东西、或者四格全空，就不给按 —— 避免「点了没反应」。
    const anyFilled = PRICE_FIELDS.some((f) => String(this.batch[f.key] ?? "").trim() !== "");
    this.applyBtn.disabled = n === 0 || !anyFilled;
    this.clearBtn.disabled = n === 0;
    // 批量栏的显隐会改内容高度。若此刻 body 上还挂着一个 forwards 动画，
    // 高度会停在旧值而内容继续长（就是「被顶出卡片」那个 bug）。
    // 先把锁拆了再改显隐，顺序不能反。
    this.releaseHeightLock();
    if (this.batchEl) this.batchEl.hidden = n === 0;
  }

  // ── 一个供应商一块 ──
  //
  // group.items 是**过滤后**的（搜索时只含命中行），所以块头的全选框
  // 勾的是「这块里你现在看得见的那些」，不是你搜之前勾过的全部。
  // 反过来也要安全：全选框取消勾选时只能动可见行，不能把用户在别的搜索结果里
  // 勾好的行默默清掉。两者都做到了，因为 keys 取自 group.items。
  renderGroup(group) {
    const allBox = h("input", { type: "checkbox", className: "tts-price__box" });
    const keys = group.items.map((i) => i.key);
    const syncAll = () => {
      const on = keys.filter((k) => this.selected.has(k)).length;
      allBox.checked = on === keys.length && keys.length > 0;
      allBox.indeterminate = on > 0 && on < keys.length;
    };
    allBox.addEventListener("change", () => {
      if (allBox.checked) for (const k of keys) this.selected.add(k);
      else for (const k of keys) this.selected.delete(k);
      this.paint();
    });
    syncAll();

    // 供应商名也高亮：搜「deepseek」时命中的就是这个字，不标出来就不知道为何剩下这几行。
    const denominator = group.total !== group.items.length ? ` / 共 ${group.total}` : "";
    const head = h("div", { className: "tts-price__group-head" },
      h("label", { className: "tts-price__group-label" },
        allBox,
        h("span", { className: "tts-price__group-name" }, this.markText(group.provider)),
        h("span", { className: "tts-price__group-meta" }, `${group.items.length} 个模型${denominator}`),
      ),
    );

    const rows = group.items.map((item) => this.renderRow(item));
    return h("div", { className: "tts-price__group" }, head, h("div", { className: "tts-price__rows" }, rows));
  }

  renderRow(item) {
    const box = h("input", { type: "checkbox", className: "tts-price__box", checked: this.selected.has(item.key) ? "" : undefined });
    box.addEventListener("change", () => {
      if (box.checked) this.selected.add(item.key);
      else this.selected.delete(item.key);
      this.syncBatchBar();
      // 只重画块头的全选框状态，不重画整行（重画会打断正在编辑的输入框）
      const groupEl = box.closest(".tts-price__group");
      const groupBox = groupEl?.querySelector(".tts-price__group-label .tts-price__box");
      if (groupBox) {
        const boxes = [...groupEl.querySelectorAll(".tts-price__rows .tts-price__box")];
        const on = boxes.filter((b) => b.checked).length;
        groupBox.checked = on === boxes.length;
        groupBox.indeterminate = on > 0 && on < boxes.length;
      }
    });

    // 显示用哪一份价：填过的显示填的，否则把默认价当占位符（灰色）。
    // 两者都是人民币值，displayPrice 现在是恒等映身（保留挂点）。
    const shown = displayPrice(item.price) || null;
    const placeholder = displayPrice(item.defaultPrice) || null;
    const cells = {};
    for (const spec of PRICE_FIELDS) {
      const input = h("input", {
        type: "text",
        inputmode: "decimal",
        className: "tts-price__cell",
        value: shown?.[spec.key] ?? "",
        placeholder: placeholder?.[spec.key] != null ? String(placeholder[spec.key]) : "0",
        title: `${spec.label}${spec.hint ? `（${spec.hint}）` : ""}`,
      });
      input.dataset.key = item.key;
      input.dataset.field = spec.key;
      input.addEventListener("input", () => this.staleValues.set(item.key, this.readRow(cells)));
      input.addEventListener("blur", () => void this.commitRow(item, cells));
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") input.blur(); });
      cells[spec.key] = input;
    }

    // 只有模型名与四个价格框。
    // 四个输入框直接拼进行里、自己占一列（grid），不再包一层容器 ——
    // 包一层就得多给那层写 display:contents，而 contents 会连带
    // 影响无障碍树里这一层的语义，不值当。
    // title 给完整键（供应商/模型），因为模型名可能重名；显示上只留模型名，
    // 供应商已经在块头写着了。
    return h("div", { className: "tts-price__row" },
      h("label", { className: "tts-price__row-name" },
        box,
        h("span", { className: "tts-price__model", title: item.key }, this.markText(item.model)),
      ),
      PRICE_FIELDS.map((f) => cells[f.key]),
    );
  }

  /**
   * 把一段文字里命中搜索词的部分包成 <mark>。
   * 没搜索时原样返回字符串（不多包一层标签，DOM 保持干净）。
   */
  markText(text) {
    const q = this.query.trim();
    if (!q) return text;
    const parts = splitHighlight(text, q);
    if (!parts.some((p) => p.hit)) return text;
    return parts.map((p) => (p.hit
      ? h("mark", { className: "tts-price__mark" }, p.text)
      : p.text));
  }

  readRow(cells) {
    const out = {};
    for (const spec of PRICE_FIELDS) out[spec.key] = cells[spec.key].value.trim();
    return out;
  }

  // 一个输入框失焦：把这一行四格一起提交。
  // 为什么整行提交而不是只提交那一格：用户经常连着填「输入」「输出」两格，
  // 一格一次 PATCH 会打出两三个请求；整行一次既有原子性（这一行的价要么全旧要么全新），
  // 也少一半请求。
  async commitRow(item, cells) {
    const values = this.readRow(cells);
    const current = item.price ? priceToValues(item.price) : { input: "", cacheRead: "", output: "", cacheWrite: "" };
    if (PRICE_FIELDS.every((f) => values[f.key] === current[f.key])) return; // 没改
    // 全空 = 用户把这一行清空了 = 恢复默认（从文件里删掉），不是「四个 0」。
    const empty = PRICE_FIELDS.every((f) => values[f.key] === "");
    await this.patch([{ key: item.key, price: empty ? null : this.toPatch(values) }], item.key);
    this.staleValues.delete(item.key);
  }

  // 界面上的字符串 → 提交体。
  //
  // 这里的口径是：**填多少就存多少**。人民币基准，没有币种换算。
  // toStoredPrice 只负责把数字收成 10 位有效数字（避免 1.7999999999999998）。
  //
  // 空串不写字段：没填 ≠ 0。
  toPatch(values) {
    const displayed = {};
    for (const spec of PRICE_FIELDS) {
      const raw = values[spec.key];
      if (raw === "" || raw == null) continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return null; // 非法：整行不提交
      displayed[spec.key] = n;
    }
    if (!Object.keys(displayed).length) return null;
    const stored = toStoredPrice(displayed);
    return stored && Object.keys(stored).length ? stored : null;
  }

  async applyBatch() {
    const price = {};
    for (const spec of PRICE_FIELDS) {
      const raw = String(this.batch[spec.key] ?? "").trim();
      if (raw === "") continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        this.note(`「${spec.label}」填的不是有效数字`, true);
        return;
      }
      price[spec.key] = n;
    }
    if (!Object.keys(price).length) { this.note("四格都空着，没有可套用的价", true); return; }
    const keys = [...this.selected];
    if (!keys.length) { this.note("还没选模型", true); return; }
    this.applyBtn.disabled = true;
    this.note(`正在写入 ${keys.length} 个模型…`);
    const ok = await this.patch(keys.map((key) => ({ key, price })), keys.join(","));
    if (ok) {
      // 套用成功后清空四格并取消选择：这样下一批可以直接开始，不用手动清。
      this.batch = { input: "", cacheRead: "", output: "", cacheWrite: "" };
      for (const el of Object.values(this.batchInputs || {})) el.value = "";
      this.selected.clear();
      this.note(`已写入 ${keys.length} 个模型`);
    }
  }

  // 统一出口：提交 + 重新拉清单（因为「已定价」计数、来源标记都会变）。
  // 不做本地乐观更新：价格直接影响金额，界面上的数必须与盘上一致。
  async patch(patches, token) {
    try {
      await this.api.savePrices(patches, { mock: this.mock });
      await this.load();
      // 保留用户正在编辑、还没提交的其他行，别让重画把它们冲掉
      const editing = new Map(this.staleValues);
      this.paint();
      for (const [key, values] of editing) {
        const row = this.bodyEl.querySelector(`.tts-price__row [data-key="${CSS.escape(key)}"]`)?.closest(".tts-price__row");
        if (!row) continue;
        for (const spec of PRICE_FIELDS) {
          const input = row.querySelector(`[data-field="${spec.key}"]`);
          if (input) input.value = values[spec.key];
        }
      }
      return true;
    } catch (err) {
      this.note(`保存失败：${err?.message || err}`, true);
      this.log("price save failed", err);
      return false;
    } finally {
      this.syncBatchBar();
    }
  }

  note(text, isError = false) {
    if (!this.batchNote) return;
    this.batchNote.textContent = text;
    if (isError) this.batchNote.dataset.kind = "err";
    else delete this.batchNote.dataset.kind;
  }

  clearSelection() {
    this.selected.clear();
    this.paint();
  }
}

export default PriceCard;
