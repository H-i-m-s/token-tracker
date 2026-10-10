// 更新说明弹窗。
//
// 这里只负责"画"和"关"：内容与版本判断都在插件进程（lib/update-check.mjs 去读 GitHub Release），
// 界面不硬编码任何一条说明，也不自己算版本高低。
//
// 三条路能走回背景：点背景（弹窗外那圈模糊处）、点 ×、点「我已知晓」。
// 除此之外没有第四种走法：内容区里点、拖、滚都不会关掉它。Esc 按「先不看」算。
//
// 两种关闭不是同一件事：
//   点背景 / × / Esc → 「先不看」：只记在插件进程内存里，本次 App 会话内不再弹，下次启动还会提醒一次。
//   「我已知晓」      → 落盘记住这个版本，直到发了下一版才会再提。
// 两条路都会广播，别的界面收到就把自己的弹窗一起关掉。
//
// 外观上它是个模态：背景整层模糊，底下的界面点不动。模糊靠 dialog::backdrop 的 backdrop-filter，
// 样式在 token-tracker.css 的 .tt-update-dialog 一节。

import { h } from "./components.mjs";

// SSE 之外的安全网：连接断了也不会整个功能哑掉。
const POLL_MS = 5 * 60 * 1000;
// 页面稳住之后再浮起来，别刚打开就砸下来。
const AUTO_DELAY_MS = 1200;

/** 2026-10-14T02:00:00Z → 10/14 */
function monthDay(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 分组标题的小标记色。认不出关键词就不上色，不猜。 */
function toneOf(heading) {
  const s = String(heading || "");
  if (/修复|修正|修掉|fix|bug/i.test(s)) return "fix";
  if (/新增|新功能|feature/i.test(s)) return "new";
  if (/优化|改进|调整|提升|improve|perf/i.test(s)) return "tune";
  return "";
}

export function installUpdateNotice({ hana, api, mock = false, log = () => {} } = {}) {
  if (!api?.getUpdateCheck) return null;

  let dialog = null;      // 当前挂着的弹窗节点，同一时刻最多一个
  let data = null;        // 最近一次拿到的快照
  let disposed = false;
  let showTimer = null;
  let pollTimer = null;
  let pendingShow = false;
  let stream = null;
  const listeners = new Set();   // 设置页那张「关于」卡片靠它跟着快照刷新

  function openExternal(url) {
    if (!url) return;
    const fallback = () => {
      try { window.open(url, "_blank"); }
      catch { try { hana?.toast?.show?.(`请手动打开：${url}`); } catch {} }
    };
    try {
      const p = hana?.external?.open?.(url);
      if (p && typeof p.catch === "function") p.catch(fallback);
    } catch { fallback(); }
  }

  function closeDialog() {
    const node = dialog;
    dialog = null;
    if (!node) return;
    try { node.close(); } catch {}
    node.remove();
  }

  async function settle(action, version) {
    try { await api.dismissUpdate({ action, version, mock }); }
    catch (e) { log(`更新说明状态没存上：${e?.message || e}`); }
  }

  /** 本地先记一笔，免得自己发起的关闭又被下一轮刷新重新弹出来。 */
  function markLocal(action, version) {
    data = {
      ...(data || {}),
      shouldAutoShow: false,
      dismissedThisSession: action === "later" ? true : !!(data && data.dismissedThisSession),
      ackVersion: action === "ack" ? (version || "") : ((data && data.ackVersion) || ""),
    };
  }

  function buildDialog(snapshot) {
    const hasUpdate = !!snapshot.hasUpdate;
    const failed = !!snapshot.error;
    const state = failed ? "error" : hasUpdate ? "new" : "current";
    const stateLabel = failed ? "检查失败" : hasUpdate ? "有新版本可用" : "已是最新";

    // 「先不看」：关掉，并让别的界面也一起关。
    const bail = () => {
      closeDialog();
      if (hasUpdate && snapshot.latest) {
        const version = snapshot.latest.tag;
        markLocal("later", version);
        void settle("later", version);
      }
    };

    const head = h("div", { className: "tt-update-hd" },
      h("h2", { className: "tt-update-title" }, "检查更新"),
      h("button", { type: "button", className: "tt-update-x", "aria-label": "关闭", onClick: bail }, "×"),
    );

    const stateLine = h("p", { className: `tt-update-state ${state}` },
      h("span", { className: "tt-update-dot" }),
      stateLabel,
    );

    const vers = h("div", { className: "tt-update-vers" },
      h("div", {},
        h("span", {}, "当前版本"),
        h("b", {}, `v${snapshot.current || "—"}`),
      ),
      h("div", { className: "tt-update-vr" }),
      h("div", { className: hasUpdate ? "new" : "" },
        h("span", {}, "最新版本"),
        h("b", {}, snapshot.latest ? `v${snapshot.latest.version}` : "—"),
        snapshot.latest && monthDay(snapshot.latest.date) ? h("i", {}, `· ${monthDay(snapshot.latest.date)}`) : null,
      ),
    );

    const body = h("div", { className: "tt-update-body" });
    if (failed) {
      body.append(h("p", { className: "tt-update-note err" },
        hasUpdate ? `取回失败（${snapshot.error}），下面是上次取回的那份。` : `取回失败：${snapshot.error}`));
    }
    if (hasUpdate) {
      snapshot.notes.forEach((note, index) => {
        const groups = (note.sections || []).map((section) => {
          const tone = toneOf(section.heading);
          const kids = [];
          if (section.heading) kids.push(h("h4", {}, section.heading));
          kids.push(h("ul", {}, ...section.items.map((text) => h("li", {}, text))));
          return h("div", { className: `tt-update-grp${tone ? ` ${tone}` : ""}${section.heading ? "" : " bare"}` }, ...kids);
        });
        body.append(h("section", { className: "tt-update-ver" },
          h("div", { className: "tt-update-ver-hd" },
            h("b", {}, `v${note.version}`),
            monthDay(note.date) ? h("span", {}, monthDay(note.date)) : null,
            index === 0 ? h("em", {}, "最新") : null,
          ),
          ...groups,
        ));
      });
    } else if (!failed) {
      body.append(h("p", { className: "tt-update-note" },
        `当前版本 v${snapshot.current || "—"} 已是最新，没有要看的说明。`));
    }

    const foot = h("div", { className: "tt-update-ft" });
    if (hasUpdate) {
      foot.append(
        h("button", { type: "button", className: "tt-btn ghost", onClick: () => openExternal(snapshot.releaseUrl) }, "在 GitHub 查看 ↗"),
        h("button", {
          type: "button",
          className: "tt-btn primary",
          onClick: () => {
            const version = snapshot.latest?.tag || "";
            closeDialog();
            markLocal("ack", version);
            void settle("ack", version);
          },
        }, "我已知晓"),
      );
    } else if (failed) {
      foot.append(
        h("button", { type: "button", className: "tt-btn ghost", onClick: () => { closeDialog(); void refresh({ force: true }).then((next) => { if (next) show(next); }); } }, "重试"),
        h("button", { type: "button", className: "tt-btn primary", onClick: bail }, "关闭"),
      );
    } else {
      foot.append(h("button", { type: "button", className: "tt-btn primary", onClick: bail }, "关闭"));
    }

    const node = h("dialog", { className: "tt-update-dialog", "aria-label": "检查更新" }, head, stateLine, vers, body, foot);

    // 点背景关闭：必须按坐标判断点落在弹窗外，否则点弹窗自己的留白也会被判成「点背景」。
    // 用 pointerdown 而不是 click：在弹窗里划选文字、手指抬到外面时，click 的落点算在外侧，会误关。
    node.addEventListener("pointerdown", (event) => {
      const rect = node.getBoundingClientRect();
      const outside = event.clientX < rect.left || event.clientX > rect.right
        || event.clientY < rect.top || event.clientY > rect.bottom;
      if (outside) bail();
    });
    // Esc 等同点背景（默认行为会直接关掉，这里拦下来自己走一遍，好把「先不看」记上）。
    node.addEventListener("cancel", (event) => { event.preventDefault(); bail(); });
    return node;
  }

  function show(snapshot) {
    if (disposed || !snapshot) return;
    clearTimer();
    closeDialog();
    dialog = buildDialog(snapshot);
    document.body.appendChild(dialog);
    try { dialog.showModal(); }
    catch { try { dialog.setAttribute("open", ""); } catch {} }
  }

  function clearTimer() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  }

  function scheduleAuto() {
    if (disposed || showTimer || dialog) return;
    // 窄面板（输入栏旁边那个功能面板）里不自动浮：那里一弹就盖掉了聊天。手动打开不受此限。
    try { if (window.innerWidth < 380) return; } catch {}
    if (typeof document !== "undefined" && document.hidden) { pendingShow = true; return; }
    showTimer = setTimeout(() => {
      showTimer = null;
      if (!disposed && !dialog && data?.shouldAutoShow) show(data);
    }, AUTO_DELAY_MS);
  }

  /** 用事件里带来的快照对账：该弹就排上，别的界面关掉了就把自己的也收起来。 */
  function reconcile(snapshot, { allowAuto = true } = {}) {
    if (!snapshot || disposed) return;
    data = snapshot;
    for (const fn of listeners) { try { fn(data); } catch {} }
    if (!snapshot.shouldAutoShow) { clearTimer(); pendingShow = false; if (dialog) closeDialog(); return; }
    if (allowAuto) scheduleAuto();
  }

  async function refresh({ force = false } = {}) {
    try {
      const snapshot = await api.getUpdateCheck({ force, mock });
      reconcile(snapshot);
      return snapshot;
    } catch (e) {
      log(`检查更新失败：${e?.message || e}`);
      return null;
    }
  }

  /** 「检查更新」按钮：无论有没有新版都把结果摆出来。 */
  async function openManual() {
    const snapshot = await refresh({ force: true });
    show(snapshot || {
      current: "", latest: null, hasUpdate: false, notes: [], error: "检查更新失败", releaseUrl: "",
    });
    return snapshot;
  }

  /** 「查看更新说明」：拿手里的快照直接开，不再打一次网络。 */
  function openCached() {
    if (data) show(data);
    else return openManual();
    return data;
  }

  // 事件流：别的界面点了「我已知晓」或「先不看」，这里要跟着关。
  // 挂在 /events 上（同一个 App 的 SSE），断了不致命，下面的轮询是安全网。
  try {
    const controller = new AbortController();
    stream = controller;
    api.watchEvents({
      signal: controller.signal,
      onEvent: (event) => {
        if (event?.type !== "update" || !event.updateNotice) return;
        reconcile(event.updateNotice, { allowAuto: true });
      },
    }).catch(() => {});
  } catch (e) {
    log(`事件流没接上（改用轮询）：${e?.message || e}`);
  }

  pollTimer = setInterval(() => { void refresh(); }, POLL_MS);

  const onVisibility = () => {
    if (disposed || !pendingShow || document.hidden) return;
    pendingShow = false;
    scheduleAuto();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // 打开界面就先看一次（服务端有 TTL，短时间反复打开界面不会把 GitHub 问爆）。
  void refresh();

  const controller = {
    openManual,
    openCached,
    refresh,
    get data() { return data; },
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      if (data) { try { fn(data); } catch {} }
      return () => listeners.delete(fn);
    },
    dispose() {
      disposed = true;
      clearTimer();
      if (pollTimer) clearInterval(pollTimer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      try { stream?.abort(); } catch {}
      listeners.clear();
      closeDialog();
    },
  };
  // 界面被拆掉（关卡片、换页）时把事件流与定时器一并收回，不在后台留着。
  function onPageHide() { controller.dispose(); }
  window.addEventListener("pagehide", onPageHide, { once: true });
  return controller;
}
