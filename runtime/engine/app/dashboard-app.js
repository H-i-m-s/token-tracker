// dashboard-app.js — Token 用量仪表盘 (Apple Minimalist)
(function(){
"use strict";

var D, R = "today", tc, mc, ac, _allAgents = null, _allModels = null, _allProviders = null, _selAgent = "", _selModel = "", _selProvider = "", _selType = "", _selBalance = "deepseek", _showDeleted = false, _provNames = null, _modelProv = "", _provRowHtml = "", _fxRate = null, _dispCur = "CNY";
(function(){ try{_provNames=JSON.parse(localStorage.getItem("tt-prov-names")||"{}");}catch(e){_provNames={};} })();

function $(id) { return document.getElementById(id); }
function fmt(n) { if(!n||n===0) return "0"; if(n>=1e8) return (n/1e8).toFixed(1)+"亿("+n.toLocaleString()+")"; if(n>=1e6) return (n/1e6).toFixed(2)+"M"; if(n>=1e3) return (n/1e3).toFixed(1)+"K"; return n.toLocaleString(); }
// tooltip 缩写：B/M/K 均两位小数（6.0 显示优化，两种提示模式统一口径）
function fmtTip(n) { if(!n||n===0) return "0"; if(n>=1e9) return (n/1e9).toFixed(2)+"B"; if(n>=1e6) return (n/1e6).toFixed(2)+"M"; if(n>=1e3) return (n/1e3).toFixed(2)+"K"; return String(n); }
// 次数：精确数值，不做 k/M 简化（采样数等调用计数专用）
function fmtN(n) { return (n||0).toLocaleString(); }
function fmtAxis(n) { if(!n||n===0) return "0"; if(n>=1e8) return (n/1e8).toFixed(1)+"亿"; if(n>=1e6) return (n/1e6).toFixed(2)+"M"; if(n>=1e3) return (n/1e3).toFixed(1)+"K"; return n.toLocaleString(); }
// token 量格式化：万亿/亿/M/K（中文亿优先）
function fmtT(n) { if(!n||n===0) return "0"; if(n>=1e12) return (n/1e12).toFixed(2)+"万亿"; if(n>=1e8) return (n/1e8).toFixed(1)+"亿"; if(n>=1e6) return (n/1e6).toFixed(1)+"M"; if(n>=1e3) return (n/1e3).toFixed(1)+"K"; return n.toLocaleString(); }
// 消费明细用的中文量级：亿/万/具体值
function fmtCN(n) { if(!(n>0)) return "0"; if(n>=1e8) return (n/1e8).toFixed(1)+"亿"; if(n>=1e4) return Math.round(n/1e4)+"万"; return Math.round(n).toLocaleString(); }
function _pn(p) { return (_provNames && _provNames[p]) || p; }
// 模型显示名：deepseek-* → DS-* 缩写 + 首字母大写（仅展示层，筛选值保持原 id）
function mn(m) { if(!m) return m; var s=String(m).replace(/deepseek/gi,"DS"); if(/^[a-z]/.test(s)) s=s[0].toUpperCase()+s.slice(1); return s; }
// Sensenova 模型名：sensenova-6.7-flash-lite → SenseNova 6.7 Flash Lite；deepseek-* → DS-*
function snModelName(m) { if(!m) return m; var s=String(m).replace(/^deepseek-/i,"DS-").replace(/^sensenova-/i,"SenseNova ").replace(/-/g," ").replace(/\b\w/g,function(c){return c.toUpperCase()}); return s; }
// 展示币种偏好（localStorage + 头部按钮切换）：USD / CNY，全页单一币种
function getDispCur() { try { return localStorage.getItem("tt-disp-cur") || "CNY"; } catch(e) { return "CNY"; } }
function setDispCur(v) { try { localStorage.setItem("tt-disp-cur", v); } catch(e) {} _dispCur = v; }
function syncCurBtn() {
  var b = $("cur-btn");
  if (b) b.textContent = _dispCur === "CNY" ? "¥" : "$";
}
function toggleCur() {
  _dispCur = _dispCur === "CNY" ? "USD" : "CNY";
  try { localStorage.setItem("tt-disp-cur", _dispCur); } catch(e) {}
  syncCurBtn();
  if (D) render();
}
// 美元→人民币（汇率来自后端 _fxRate，失败时仅显示美元）
function cny(v) {
  if (!(v > 0) || !_fxRate) return "";
  return "¥" + (_fxRate * v).toFixed(2);
}
// 美元金额：按 _dispCur 只显示一种币种
function dual(v) {
  if (!(v > 0)) return _dispCur === "CNY" ? "¥0" : "$0";
  if (_dispCur === "CNY") {
    var y = cny(v);
    return y ? y : "$" + (v >= 1 ? v.toFixed(2) : v.toFixed(4));
  }
  return "$" + (v >= 1 ? v.toFixed(2) : v.toFixed(4));
}
// 本地货币 → 美元（统一合计口径）；CNY 价用汇率折算，USD 原值
function toUsd(v, cur) {
  if (!(v > 0)) return 0;
  if (cur === "CNY") return _fxRate ? v / _fxRate : v;
  return v;
}
// 按模型货币显示：一律按 _dispCur 显示单一币种
function dualByCur(v, cur) {
  if (!(v > 0)) return _dispCur === "CNY" ? "¥0" : "$0";
  if (_dispCur === "CNY") {
    var cnyAmt = cur === "CNY" ? v : (_fxRate ? v * _fxRate : v);
    return "¥" + (cnyAmt >= 1 ? cnyAmt.toFixed(2) : cnyAmt.toFixed(4));
  }
  var usd = toUsd(v, cur);
  return "$" + (usd >= 1 ? usd.toFixed(2) : usd.toFixed(4));
}

function cnToday(){return new Date().toLocaleDateString("en-CA",{timeZone:"Asia/Shanghai"})}

var _THEME_KEY = "tt-theme";
function getThemeMode() {
  try { return localStorage.getItem(_THEME_KEY) || "auto"; } catch(e) { return "auto"; }
}
function setThemeMode(m) {
  try { localStorage.setItem(_THEME_KEY, m); } catch(e) {}
}
var _ICON_SUN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>';
var _ICON_MOON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
function syncThemeUI(theme, mode) {
  var b = $("th-btn");
  if (b) {
    var dark = theme === "dark";
    b.title = dark ? "切换浅色模式" : "切换深色模式";
    b.innerHTML = dark ? _ICON_SUN : _ICON_MOON;
  }
  var opts = document.querySelectorAll(".set-theme-opt");
  for (var i = 0; i < opts.length; i++) {
    opts[i].classList.toggle("on", opts[i].dataset.v === mode);
  }
}
function syncHanaTheme() {
  var mode = getThemeMode();
  var theme;
  if (mode === "light") theme = "light";
  else if (mode === "dark") theme = "dark";
  else {
    var ht = document.body.getAttribute("data-hana-theme") || "warm-paper";
    if (ht === "midnight") theme = "dark";
    else if (ht === "warm-paper") theme = "light";
    else if (ht === "inherit" || ht === "system") {
      theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } else {
      theme = "light";
    }
  }
  document.body.setAttribute("data-theme", theme);
  syncThemeUI(theme, mode);
}
function toggleTheme() {
  var cur = document.body.getAttribute("data-theme") === "dark" ? "dark" : "light";
  setThemeMode(cur === "dark" ? "light" : "dark");
  syncHanaTheme();
  if (D) render();
}

function chartColors() {
  const s = getComputedStyle(document.body);
  return {
    text: s.getPropertyValue("--chart-text").trim(),
    grid: s.getPropertyValue("--chart-grid").trim(),
    chat: s.getPropertyValue("--chart-bar-chat").trim(),
    channel: s.getPropertyValue("--chart-bar-channel").trim(),
    doughnut: s.getPropertyValue("--chart-doughnut-colors").trim().split(",").map(c => c.trim()),
    agent: s.getPropertyValue("--chart-agent-colors").trim().split(",").map(c => c.trim()),
    hitRate: s.getPropertyValue("--chart-hit-rate").trim(),
    reqCount: s.getPropertyValue("--chart-req-count").trim(),
  };
}

function isHourlyMode() {
  if (R === "today") return true;
  const df = $("df"), dt = $("dt");
  if (df && dt && df.value && dt.value && df.value === dt.value) return true;
  return false;
}

function syncDateInputs() {
  var df=$("df"),dt=$("dt");
  if(!df||!dt)return;
  var t=cnToday();
  if(R==="today"){df.value=t;dt.value=t;}
  else if(R==="week"){
    var d=new Date(),day=d.getDay();
    d.setDate(d.getDate()-((day+6)%7));
    df.value=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");dt.value=t;
  }else if(R==="year"){
    var d=new Date();
    df.value=d.getFullYear()+"-01-01";dt.value=t;
  }else if(R==="lyear"){
    var d=new Date();
    var ly=d.getFullYear()-1;
    df.value=ly+"-01-01";dt.value=ly+"-12-31";
  }else if(R==="month"){
    var d=new Date();
    df.value=d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-01";dt.value=t;
  }else if(R==="all"){
    df.value=(D&&D.earliest)?D.earliest:"";dt.value=D?t:"";
  }
}

function updateFilterOpts() {
  var sa=$("sa"),sp=$("sp"),sm=$("sm"); if(!sa||!sm) return;
  var la=sa.querySelector(".cs-list"),lp=sp?.querySelector(".cs-list"),lm=sm.querySelector(".cs-list");
  var ta=sa.querySelector(".cs-txt"),tp=sp?.querySelector(".cs-txt"),tm=sm.querySelector(".cs-txt");
  if(!la||!lm||!ta||!tm) return;
  ta.textContent=_selAgent?((D.agentNames||{})[_selAgent]||_selAgent):"Agent";
  if(tp){
    if(_selProvider)tp.textContent=_pn(_selProvider);
    else tp.textContent="供应商";
  }
  tm.textContent=mn(_selModel)||"模型";
  if(_allAgents) {
    var h='<div class="cs-opt'+(_selAgent===""?" sel":"")+'" data-v="">全部 Agent</div>';
    _allAgents.forEach(function(a){if(!_showDeleted&&a.deleted)return;var n=(D.agentNames||{})[a.id]||a.id;if(a.deleted)n+=' (已删除)';h+='<div class="cs-opt'+(_selAgent===a.id?" sel":"")+'" data-v="'+a.id+'">'+n+'</div>'});
    la.innerHTML=h;
  }
    if(sp&&lp&&D&&D.providers){
    var seen={},ph='<div class="cs-opt'+(_selProvider===""?" sel":"")+'" data-v="">全部</div>';
    D.providers.forEach(function(p){if(!seen[p.provider]){seen[p.provider]=1;ph+='<div class="cs-opt'+(_selProvider===p.provider?" sel":"")+'" data-v="'+p.provider+'">'+_pn(p.provider)+'</div>'}});
    lp.innerHTML=ph;
  }
  if(_allModels || D.modelOptions) {
    var h='<div class="cs-opt'+(_selModel===""?" sel":"")+'" data-v="">全部模型</div>';
    var filtered=D.modelOptions||_allModels||[];
    filtered.forEach(function(m){h+='<div class="cs-opt'+(_selModel===m.id?" sel":"")+'" data-v="'+m.id+'">'+mn(m.id)+'</div>'});
    lm.innerHTML=h;
  }
}

$("app").innerHTML =
  '<div class="app-layout">'+
  '<div class="sidebar">'+
  '<div class="sidebar-section">'+
  '<div class="sidebar-label">时间范围</div>'+
  '<div class="time-group">'+
  '<button class="fb" data-r="all">全部</button>'+
  '<button class="fb" data-r="lyear">去年</button>'+
  '<button class="fb" data-r="year">本年</button>'+
  '<button class="fb" data-r="month">本月</button>'+
  '<button class="fb" data-r="week">本周</button>'+
  '<button class="fb act" data-r="today">今日</button>'+
  '</div></div>'+
  '<div class="sidebar-divider"></div>'+
  '<div class="sidebar-section">'+
  '<div class="sidebar-label">日期</div>'+
  '<div class="date-row"><span class="fi-wrap"><input type="text" readonly class="fi" id="df"></span></div>'+
  '<div class="date-row" style="margin-top:4px"><span class="fi-wrap"><input type="text" readonly class="fi" id="dt"></span></div>'+
  '</div>'+
  '<div class="sidebar-divider"></div>'+
  '<div class="sidebar-section sidebar-filter">'+
  '<div class="sidebar-label">筛选</div>'+
  '<span class="cs" id="sa"><span class="cs-txt">Agent</span><span class="cs-arw">▾</span><div class="cs-list"></div></span>'+
  '<span class="cs" id="sp"><span class="cs-txt">供应商</span><span class="cs-arw">▾</span><div class="cs-list"></div></span>'+
  '<span class="cs" id="sm"><span class="cs-txt">模型</span><span class="cs-arw">▾</span><div class="cs-list"></div></span>'+
  '<span class="cs" id="stype"><span class="cs-txt">类型</span><span class="cs-arw">▾</span><div class="cs-list"><div class="cs-opt sel" data-v="">全部</div><div class="cs-opt" data-v="desktop">聊天</div><div class="cs-opt" data-v="channel">频道</div></div></span>'+
  '<div class="sd-toggle"><label class="tg"><input type="checkbox" id="sd-chk"><span class="tg-slider"></span><span class="tg-label">显示已删除</span></label></div>'+
  '</div>'+
  '<div class="sidebar-divider"></div>'+
  '<div class="sidebar-section sidebar-quota-nav">'+
  '<div class="sidebar-label">余量查询</div>'+
  '<button class="sb-nav-btn" id="btn-og-quota">OpenCodeGo 余量</button>'+
  '<button class="sb-nav-btn" id="btn-sensenova-quota">商汤</button>'+
  '</div>'+
  '<div class="sidebar-divider"></div>'+
  '<div class="sidebar-section sidebar-balance">'+
  '<div class="sidebar-label">余额</div>'+
  '<span class="cs sb-picker" id="sb-picker"><span class="cs-txt" id="sb-name">DeepSeek</span><span class="cs-arw">▾</span><div class="cs-list" id="sb-list"></div></span>'+
  '<div id="sb-display" class="sb-card">—</div>'+
  '<div id="fx" class="fx-side">—</div>'+
  '</div>'+
  '</div>'+
  '<div class="main-area">'+
  '<div class="archive-intro"><span>PERSONAL USAGE ARCHIVE / 01</span><p>把每一次调用，放回工作流里看。</p></div>'+
  '<div class="hdr"><div class="hdr-left"><span class="hdr-title">用量</span><span id="lu">—</span></div><div id="hdrQuota" class="hdr-quota"></div><div class="hdr-right"><button class="btn-icon" id="rf" title="刷新数据"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button><button class="btn-icon" id="cur-btn" title="切换展示币种">¥</button><button class="btn-icon" id="th-btn" title="切换深色模式"></button><button class="btn-icon" id="st-btn" title="设置"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button><span class="unit-hint" id="uh">ⓘ</span></div></div>'+
  '<div id="cards" class="cg"></div>'+
  '<div id="media-section" style="display:none"></div>'+
  '<div class="main-layout"><div class="main-left">'+
  '<div class="trend-card"><div class="ct" id="tc-title">消耗趋势</div><canvas id="tc"></canvas></div>'+
  '<div class="chart-row"><div class="cx"><div class="ct">Agent 消耗对比</div><canvas id="ac"></canvas></div></div>'+
  '</div></div>'+
  '<div class="drawer-shade" id="drawer-shade" style="display:none"></div>'+
  '<div class="drawer" id="drawer"><div class="drawer-hdr"><span>订阅余量与消费明细</span><button class="btn-icon" id="drawer-close" title="关闭">✕</button></div><div class="drawer-times" id="drawer-times"></div><div class="drawer-body"><div id="drawer-quota" style="display:none"></div><div id="drawer-cs" style="display:none"></div></div></div>'+
  '<div id="ld" class="ld">翻阅档案…</div>'+
  '</div>'+
  '</div>'+
  '<div class="set-shade" id="set-shade" style="display:none"></div><div class="set-panel" id="set-panel" style="display:none"><div class="set-hdr"><span>设置</span><div style="display:flex;gap:8px;align-items:center"><button class="btn" id="set-save">保存</button><button class="btn" id="set-close">✕</button></div></div><div class="set-body"><div class="set-sec"><div class="set-sec-title">外观</div><div class="set-theme-row" id="set-theme"><button class="set-theme-opt" data-v="auto">跟随系统</button><button class="set-theme-opt" data-v="light">浅色</button><button class="set-theme-opt" data-v="dark">深色</button></div></div><div class="set-sec"><div class="set-sec-title">余额查询 API</div><div id="set-bal-apis" class="set-prov-list"></div></div><div class="set-sec"><div class="set-sec-title">模型定价</div><div id="set-prices" class="set-prov-list"></div></div><div class="set-sec"><div class="set-sec-title">显示偏好</div><div class="set-pref-row"><span class="set-pref-key">趋势图提示</span><select id="set-tooltip-mode" class="set-pref-sel"><option value="single">仅当前项</option><option value="all">全部来源</option></select></div><div class="set-pref-row"><span class="set-pref-key">隐藏余额</span><label class="tg" onclick="event.stopPropagation()"><input type="checkbox" id="set-hide-balance"><span class="tg-slider"></span></label></div></div></div></div></div>'+
  '<div id="modal" class="modal" style="display:none"><div class="modal-bg"></div><div class="modal-box"><div class="modal-hdr"><span class="modal-tit">对话详情</span><button class="btn" onclick="document.getElementById(\'modal\').style.display=\'none\'">✕</button></div><div class="modal-body" id="modal-body"></div></div></div>';

function load(refreshFirst) {
  const el = $("ld"); if (el) el.style.display = "block";
  const qs = window.location.search;
  const sep = qs ? '&' : '?';

  var p = "range="+R+($("df").value?"&from="+$("df").value:"")+($("dt").value?"&to="+$("dt").value:"")+(_selAgent?"&agent="+encodeURIComponent(_selAgent):"")+(_selProvider?"&provider="+encodeURIComponent(_selProvider):"")+(_selModel?"&model="+encodeURIComponent(_selModel):"")+(_selType?"&type="+_selType:"");
  const doFetch = () => fetch(window.location.pathname + "/data" + qs + sep + p).then(r => {
    if (!r.ok) throw Error(r.statusText);
    return r.json();
  }).then(d => {
    if (d.error) { if (el) el.textContent = d.error; return; }
    if(!_allAgents||!D){_allAgents=d.agents.slice();_allModels=d.models.slice();_allProviders=d.providers?d.providers.slice():null}
    D = d; _fxRate = d._fxRate || null; if (el) el.style.display = "none";
    render();
  }).catch(e => { if (el) el.textContent = "加载失败: "+e.message; });

  if (refreshFirst) {
    fetch(window.location.pathname + "/refresh" + qs + sep + "range=" + R, {method: "POST"})
      .then(doFetch).catch(doFetch);
  } else {
    doFetch();
  }
}

function refresh() { load(true); }

function render() {
  if (!D) return;
  syncDateInputs();
  updateFilterOpts();
  renderHdrQuota();
  $("lu").textContent = D.lastScan ? new Date(D.lastScan).toLocaleString("zh-CN") : "";
  // 汇率标注（双币显示时展示换算依据）
  var fxEl=$("fx");
  if(fxEl){
    if(_fxRate&&_fxRate>0)fxEl.textContent="1 USD = "+_fxRate.toFixed(4)+" CNY";
    else fxEl.textContent="";
  }
  $("cards").innerHTML =
    '<div class="cd cd-total"><div class="cl">总消耗</div><div class="cv">'+fmt(D.summary.totalTokens)+'</div></div>'+
    '<div class="cd cd-chat"><div class="cl">聊天</div><div class="cv">'+fmt(D.summary.totalDesktop)+'</div></div>'+
    '<div class="cd cd-channel"><div class="cl">频道</div><div class="cv">'+fmt(D.summary.totalChannel)+'</div></div>'+
    '<div class="cd cd-output"><div class="cl">输出</div><div class="cv">'+fmt(D.summary.totalOutput)+'</div></div>'+
    '<div class="cd cd-input"><div class="cl">输入(未命中)</div><div class="cv">'+fmt(D.summary.totalInput)+'</div></div>'+
    '<div class="cd cd-cache"><div class="cl">输入(命中)</div><div class="cv">'+fmt(D.summary.totalCacheRead)+'</div></div>'+
    '<div class="cd cd-hitrate"><div class="cl">缓存命中率</div><div class="cv">'+(D.summary.cacheHitRate||0)+'%</div></div>'+
    (D._speedStats?'<div class="cd cd-speed" id="speed-card" title="点击查看速度明细与模型榜"><div class="cl">生成速度</div><div class="cv">'+D._speedStats.avgTps+'<span class="sp-unit"> tok/s</span></div><div class="sp-sub">最近 '+D._speedStats.recentTps+' · 共 '+fmtN(D._speedStats.count)+' 次</div></div>':'');

  (function(){
    var cEl=$("cards");if(!cEl)return;
    var items=cEl.children;
    for(var i=0;i<items.length;i++){
      var el=items[i];
      el.style.animation="tt-fade-up .45s "+(0.05+i*0.05)+"s ease-out backwards";
      el.addEventListener("animationend",function(ev){ev.currentTarget.style.animation="";},{once:true});
    }
  })();

  renderMediaSection();
  renderTrend();
  renderAgent();
  renderConsumption();
  // 隐藏余额偏好（默认开启）：只隐藏金额数值，供应商选择器保持可用
  var _sbEl = document.querySelector(".sidebar-balance");
  if (_sbEl) _sbEl.style.display = "";
  renderBalance();
  renderSubscriptionQuotas();
}

// 显示偏好：隐藏余额（默认隐藏，localStorage "tt-hide-balance" 存 "0" 才显示）
function _hideBal(){try{return localStorage.getItem("tt-hide-balance")!=="0";}catch(e){return true;}}

function renderModelCosts(){
  var costs=D._modelCosts||[];
  var hasCost=false;
  for(var i=0;i<costs.length;i++){if(costs[i].cost>0){hasCost=true;break;}}
  if(!hasCost)return;
  var el=$("model-costs");if(!el)return;
  var h='<div class="mc-grid">';
  for(var i=0;i<costs.length;i++){
    var c=costs[i];
    if(c.cost<=0)continue;
    var label=c.provider?c.provider+"/"+c.model:c.model;
    h+='<div class="mc-row"><span class="mc-label">'+escHTML(label)+'</span><span class="mc-val">$'+c.cost.toFixed(2)+'</span></div>';
  }
  h+='</div>';
  el.innerHTML=h;
  el.style.display="";
}



function renderMediaSection(){
  var mg=D.mediaGen||[];
  var el=$("media-section");
  if(!el)return;
  if(!mg.length){el.style.display="none";return;}
  var imgItems=[],vidItems=[];
  var imgTotal=0,vidTotal=0,imgCost=0,vidCost=0;
  var costs=D._modelCosts||[];
  for(var i=0;i<mg.length;i++){
    var g=mg[i];
    var key=g.provider+"/"+g.model;
    var costEntry=null;
    for(var k=0;k<costs.length;k++){if(costs[k].provider+"/"+costs[k].model===key){costEntry=costs[k];break;}}
    var cost=costEntry?costEntry.cost:0;
    var item={provider:g.provider,model:g.model,callCount:g.callCount||0,successCount:g.successCount||0,cost:cost};
    if(g.kind==='video'){vidItems.push(item);vidTotal+=g.callCount||0;vidCost+=cost;}
    else{imgItems.push(item);imgTotal+=g.callCount||0;imgCost+=cost;}
  }
  if(!imgTotal&&!vidTotal){el.style.display="none";return;}
  el.style.display="";
  var h='<div class="media-sec">';
  if(imgTotal){
    h+='<div class="media-cat"><div class="media-cat-hdr"><span class="media-cat-icon">IMAGE</span><span class="media-cat-title">图片生成</span><span class="media-cat-sum">'+imgTotal+'张'+(imgCost>0?' · '+dual(imgCost):'')+'</span></div>';
    h+='<div class="media-cat-grid">';
    for(var i=0;i<imgItems.length;i++){
      var it=imgItems[i];
      h+='<div class="media-item"><div class="media-item-model">'+escHTML(it.provider)+'/'+escHTML(mn(it.model))+'</div><div class="media-item-stats"><span>'+it.callCount+'次</span>'+(it.successCount>0&&it.successCount!==it.callCount?'<span class="media-item-succ">成功'+it.successCount+'</span>':'')+(it.cost>0?'<span class="media-item-cost">'+dual(it.cost)+'</span>':'')+'</div></div>';
    }
    h+='</div></div>';
  }
  if(vidTotal){
    h+='<div class="media-cat"><div class="media-cat-hdr"><span class="media-cat-icon">VIDEO</span><span class="media-cat-title">视频生成</span><span class="media-cat-sum">'+vidTotal+'个'+(vidCost>0?' · '+dual(vidCost):'')+'</span></div>';
    h+='<div class="media-cat-grid">';
    for(var i=0;i<vidItems.length;i++){
      var it=vidItems[i];
      h+='<div class="media-item"><div class="media-item-model">'+escHTML(it.provider)+'/'+escHTML(mn(it.model))+'</div><div class="media-item-stats"><span>'+it.callCount+'次</span>'+(it.successCount>0&&it.successCount!==it.callCount?'<span class="media-item-succ">成功'+it.successCount+'</span>':'')+(it.cost>0?'<span class="media-item-cost">'+dual(it.cost)+'</span>':'')+'</div></div>';
    }
    h+='</div></div>';
  }
  h+='</div>';
  el.innerHTML=h;
}

function renderFloatingCards(){
  var costs=D._modelCosts||[];
  var balances=D._balances||[];
  var provConfig=D._providerConfig||[];
  var mgData=D.mediaGen||[];
  var mgMap={};
  for(var i=0;i<mgData.length;i++){mgMap[mgData[i].provider+"/"+mgData[i].model]=mgData[i];}
  if(!costs.length&&!balances.length&&!mgData.length)return'';
  var balMap={};
  for(var i=0;i<balances.length;i++)balMap[balances[i].provider]=balances[i];
  var h='<div class="float-cards">';
  for(var i=0;i<provConfig.length;i++){
    var prov=provConfig[i];
    var bal=balMap[prov.id];
    // 只有真有余额数据（money/quota）才算有内容；none/no-key/error 都视为无余额
    var hasBal=bal && (bal.type==='money' || bal.type==='quota');
    var hasContent=hasBal;
    for(var j=0;j<prov.models.length;j++){for(var k=0;k<costs.length;k++){if(costs[k].model===prov.models[j]&&costs[k].cost>0){hasContent=true;break;}}}
    if(!hasContent)continue;
    h+='<div class="fc-prov"><div class="fc-prov-title">'+escHTML(prov.id)+'</div>';
    if(bal&&bal.type==='money'){
      var bc=bal.total>50?'var(--color-green)':(bal.total>20?'var(--color-orange)':'var(--color-red)');
      h+='<div class="fc-section">';
      h+='<div class="fc-row fc-balance"><span class="fc-label">可用余额</span><span class="fc-val" style="color:'+bc+'">'+bal.display+'</span></div>';
      if(bal.details&&bal.details.length>1){
        for(var d=0;d<bal.details.length;d++){
          var det=bal.details[d];
          h+='<div class="fc-row fc-detail"><span class="fc-label">'+escHTML(det.label)+'</span><span class="fc-val">$'+det.amount.toFixed(2)+'</span></div>';
        }
      }
      h+='</div>';
    }else if(bal&&bal.type==='quota'){
      var bc2=bal.remain>50?'var(--color-green)':(bal.remain>20?'var(--color-orange)':'var(--color-red)');
      h+='<div class="fc-section">';
      h+='<div class="fc-row fc-balance"><span class="fc-label">剩余配额</span><span class="fc-val" style="color:'+bc2+'">'+bal.display+'</span></div>';
      h+='<div class="fc-bar"><div class="fc-bar-used" style="width:'+bal.used+'%"></div><div class="fc-bar-remain" style="width:'+bal.remain+'%"></div></div>';
      h+='</div>';
    }
    var provCost=0;
    var hasCostRow=false;
    for(var j=0;j<prov.models.length;j++){
      var mk=prov.models[j];
      var cost=0,tokens=0,unit="token";
      for(var k=0;k<costs.length;k++){if(costs[k].model===mk){cost=costs[k].cost;unit=costs[k].unit||"token";break;}}
      for(var k=0;k<(D.models||[]).length;k++){if(D.models[k].id===mk){tokens=D.models[k].totalTokens||0;break;}}
      var isQuota=bal&&bal.type==='quota';
      if(isQuota){
        if(tokens<=0)continue;
        if(!hasCostRow){h+='<div class="fc-section"><div class="fc-section-title">消费</div>';hasCostRow=true;}
        h+='<div class="fc-row"><span class="fc-label">'+escHTML(mk)+'</span><span class="fc-val fc-tokens">'+fmt(tokens)+' tok</span></div>';
      }else if(unit==='per_call'){
        var mgEntry=mgMap[prov.id+"/"+mk];
        var calls=mgEntry?mgEntry.callCount:0;
        var succ=mgEntry?mgEntry.successCount:0;
        if(calls<=0&&cost<=0)continue;
        if(!hasCostRow){h+='<div class="fc-section"><div class="fc-section-title">消费</div>';hasCostRow=true;}
        provCost+=cost;
        h+='<div class="fc-row"><span class="fc-label">'+escHTML(mk)+'</span><span class="fc-val fc-cost">$'+cost.toFixed(2)+' <small style="opacity:.5">'+calls+'次'+(succ>0&&succ!==calls?' 成功'+succ:'')+'</small></span></div>';
      }else if(unit==='per_char'){
        if(cost<=0)continue;
        if(!hasCostRow){h+='<div class="fc-section"><div class="fc-section-title">消费</div>';hasCostRow=true;}
        provCost+=cost;
        h+='<div class="fc-row"><span class="fc-label">'+escHTML(mk)+'</span><span class="fc-val fc-cost">$'+cost.toFixed(2)+' <small style="opacity:.5">按字符</small></span></div>';
      }else{
        if(cost<=0)continue;
        if(!hasCostRow){h+='<div class="fc-section"><div class="fc-section-title">消费</div>';hasCostRow=true;}
        provCost+=cost;
        h+='<div class="fc-row"><span class="fc-label">'+escHTML(mk)+'</span><span class="fc-val fc-cost">$'+cost.toFixed(2)+'</span></div>';
      }
    }
    if(hasCostRow){
      if(provCost>0){
        h+='<div class="fc-row fc-subtotal"><span class="fc-label">总消费</span><span class="fc-val fc-cost">$'+provCost.toFixed(2)+'</span></div>';
      }
      h+='</div>';
    }
    h+='</div>';
  }
  var provSeen2={};
  for(var i=0;i<provConfig.length;i++)provSeen2[provConfig[i].id]=true;
  for(var i=0;i<mgData.length;i++){
    var mg2=mgData[i];
    if(provSeen2[mg2.provider])continue;
    provSeen2[mg2.provider]=true;
    var mgCost=mg2.cost||0;
    if(mg2.callCount<=0&&mgCost<=0)continue;
    h+='<div class="fc-prov"><div class="fc-prov-title">'+escHTML(mg2.provider)+'</div>';
    h+='<div class="fc-row"><span class="fc-label">'+escHTML(mn(mg2.model))+'</span><span class="fc-val fc-cost">'+(mgCost>0?'$'+mgCost.toFixed(2)+' ':'')+'<small style="opacity:.5">'+(mg2.kind==='video'?'VIDEO':'IMAGE')+' '+mg2.callCount+'次'+(mg2.successCount>0&&mg2.successCount!==mg2.callCount?' 成功'+mg2.successCount:'')+'</small></span></div>';
    h+='</div>';
  }
  var total=D.summary&&D.summary.estimatedCost>0?D.summary.estimatedCost:0;
  if(total>0){
    h+='<div class="fc-prov fc-total"><span class="fc-label">合计消费</span><span class="fc-val fc-cost">$'+total.toFixed(2)+'</span></div>';
  }
  h+='</div>';
  return h;
}

var _trendMode = "scene";
function renderTrend() {
  if (tc) tc.destroy();
  const cc = chartColors();
  const useHourly = isHourlyMode() && D.hourly && D.hourly.length > 0;
  let data = useHourly ? D.hourly : D.daily;
  try{_trendMode=localStorage.getItem("tt-trend-mode")||"scene";}catch(e){_trendMode="scene";}

  var tEl = $("tc-title");
  tEl.textContent = (useHourly ? "消耗趋势（按小时）" : "消耗趋势");
  if (!data || !data.length) return;

  if (!useHourly) {
    const now = new Date();
    let startDate;
    if (R === "all") {
      const d = new Date();
      d.setDate(d.getDate() - 30);
      startDate = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
    } else if (R === "month") {
      startDate = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-01";
    } else if (R === "week") {
      const d = new Date();
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      startDate = d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
    }
    if (startDate) data = data.filter(d => d.date >= startDate);
  }

  const labels = data.map(d => useHourly ? d.hour+":00" : d.date.slice(5));
  // 趋势图提示模式（显示偏好：仅当前项 / 全部来源，默认全部来源）
  var tipMode="all";try{tipMode=localStorage.getItem("tt-tooltip-mode")||"all";}catch(e){}
  var tipLabel=function(ctx){var val=ctx.parsed.y;if(!val||val===0)return null;return ctx.dataset.label+": "+fmtTip(val);};
  var tooltipCfg=tipMode==="all"?{mode:"index",intersect:false,callbacks:{label:tipLabel}}:{callbacks:{label:tipLabel}};

  // 视图切换：场景（聊天/频道） / 构成（输入/推理/输出/缓存）
  if(!tEl.querySelector(".mm-switch")){
    var sw=document.createElement("span");
    sw.className="mm-switch";
    sw.innerHTML='<button data-v="scene" class="'+( _trendMode==="scene"?"on":"")+'">场景</button><button data-v="mix" class="'+( _trendMode==="mix"?"on":"")+'">构成</button>';
    sw.addEventListener("click",function(e){
      var b=e.target.closest("button"); if(!b)return;
      _trendMode=b.getAttribute("data-v");
      try{localStorage.setItem("tt-trend-mode",_trendMode);}catch(err){}
      renderTrend();
    });
    tEl.appendChild(sw);
  }else{
    var btns=tEl.querySelectorAll(".mm-switch button");
    for(var bi=0;bi<btns.length;bi++)btns[bi].className=(btns[bi].getAttribute("data-v")===_trendMode?"on":"");
  }

  if(_trendMode==="mix"){
    var sumInp=0,sumOut=0,sumRsn=0,sumCache=0,sumTotal=0;
    for(var i=0;i<data.length;i++){var d=data[i];sumInp+=d.input||0;sumOut+=d.output||0;sumRsn+=d.reasoning||0;sumCache+=d.cacheRead||0;sumTotal+=d.totalTokens||0;}
    var hasInp=sumInp>0,hasOut=sumOut>0,hasRsn=sumRsn>0;
    var inp,rsn,out,cache;
    if(hasInp||hasOut){
      inp=data.map(function(d){return (d.input||0)-(hasRsn?(d.reasoning||0):0);});
      rsn=hasRsn?data.map(function(d){return d.reasoning||0;}):null;
      out=data.map(function(d){return d.output||0;});
      cache=data.map(function(d){return d.cacheRead||0;});
    }else{
      var ttlInp=D.summary&&D.summary.totalInput?D.summary.totalInput:0;
      var ttlOut=D.summary&&D.summary.totalOutput?D.summary.totalOutput:0;
      var ttlSum=D.summary&&D.summary.totalTokens?D.summary.totalTokens:sumTotal;
      if(ttlInp>0||ttlOut>0){
        inp=data.map(function(d){var r=(d.totalTokens||0)/ttlSum;return Math.round(ttlInp*r);});
        out=data.map(function(d){var r=(d.totalTokens||0)/ttlSum;return Math.round(ttlOut*r);});
        rsn=null;
        cache=data.map(function(d){return d.cacheRead||0;});
      }else{
        inp=null;out=null;rsn=null;
        cache=data.map(function(d){return d.cacheRead||0;});
      }
    }
    var datasets=[];
    if(inp)datasets.push({label:"输入",data:inp,backgroundColor:cc.doughnut[0],borderRadius:4,borderSkipped:false,barPercentage:0.7,categoryPercentage:0.8});
    if(rsn)datasets.push({label:"推理",data:rsn,backgroundColor:cc.doughnut[4],borderRadius:4,borderSkipped:false,barPercentage:0.7,categoryPercentage:0.8});
    if(out)datasets.push({label:"输出",data:out,backgroundColor:cc.hitRate,borderRadius:4,borderSkipped:false,barPercentage:0.7,categoryPercentage:0.8});
    datasets.push({label:"缓存命中",data:cache,backgroundColor:cc.channel,borderRadius:4,borderSkipped:false,barPercentage:0.7,categoryPercentage:0.8});
    tc = new Chart($("tc"),{type:"bar",data:{labels,datasets:datasets},options:{responsive:true,maintainAspectRatio:false,color:cc.text,plugins:{tooltip:tooltipCfg,legend:{position:"top",align:"start",labels:{color:cc.text,boxWidth:12,boxHeight:12,font:{size:13,weight:'500'},padding:20,usePointStyle:true,pointStyle:"rectRounded"}}},scales:{x:{stacked:true,grid:{display:false},ticks:{font:{size:12}}},y:{stacked:true,grid:{color:cc.grid},ticks:{callback:function(v){return fmtAxis(v)},font:{size:12}}}}}});
    return;
  }

  const desk = data.map(d => d.desktop||0);
  const chan = data.map(d => d.channel||0);
  tc = new Chart($("tc"),{type:"bar",data:{labels,datasets:[
    {label:"聊天",data:desk,backgroundColor:cc.chat,borderRadius:4,borderSkipped:false,barPercentage:0.7,categoryPercentage:0.8},
    {label:"频道",data:chan,backgroundColor:cc.channel,borderRadius:4,borderSkipped:false,barPercentage:0.7,categoryPercentage:0.8}
  ]},options:{responsive:true,maintainAspectRatio:false,color:cc.text,plugins:{tooltip:tooltipCfg,legend:{position:"top",align:"start",labels:{color:cc.text,boxWidth:12,boxHeight:12,font:{size:13,weight:'500'},padding:20,usePointStyle:true,pointStyle:"rectRounded"}}},scales:{x:{stacked:true,grid:{display:false},ticks:{font:{size:12}}},y:{stacked:true,grid:{color:cc.grid},ticks:{callback:function(v){return fmtAxis(v)},font:{size:12}}}}}});
}

function renderModel() {
  const cc = chartColors(); if (mc) { mc.destroy(); mc = null; }
  var listEl = $("mc-list");
  if (!listEl) {
    listEl = document.createElement("div");
    listEl.id = "mc-list";
    listEl.className = "model-rank";
    $("mc").parentNode.appendChild(listEl);
  }
  var smv=$("sm")?_selModel:"";
  var items = [];
  var title = "模型占比";
  if (smv && !_selAgent) {
    var ag=!D.agents?null:D.agents.filter(function(a){return _showDeleted||!a.deleted;}); if(!ag||!ag.length)return;
    title = "Agent 占比";
    items = ag.map(function(a,i){var n=(D.agentNames||{})[a.id]||a.id;if(a.deleted)n+=' (已删除)';return{label:n,tokens:a.totalTokens,count:0,cost:0,color:cc.agent[i%cc.agent.length]};});
  } else if (D.providerBreakdown && D.providerBreakdown.length) {
    // 供应商选择分类（卡内筛选，仅影响模型占比视图）
    var provs=[], seenP={};
    for(var pi=0;pi<D.providerBreakdown.length;pi++){var pp=D.providerBreakdown[pi].provider;if(!seenP[pp]){seenP[pp]=1;provs.push(pp);}}
    if(_modelProv && !seenP[_modelProv]) _modelProv="";
    var pbd = _modelProv ? D.providerBreakdown.filter(function(p){return p.provider===_modelProv;}) : D.providerBreakdown;
    var pLabels = pbd.map(function(p){return p.model;});
    var costMap={}, countMap={};
    // 1) opencode-go 官方费用/次数优先（真实计费数据，仅 opencode 有官方账单）
    if(D._subscriptionQuotas){for(var oi=0;oi<D._subscriptionQuotas.length;oi++){var ogq=D._subscriptionQuotas[oi];if(ogq&&ogq.modelSummary){for(var oj=0;oj<ogq.modelSummary.length;oj++){var msm=ogq.modelSummary[oj];if(msm&&msm.model){costMap[msm.model]=(msm.costUsd||0);countMap[msm.model]=(msm.count||0);}}}}}
    // 2) 非 opencode 模型：费用从价格表估算（未配置时为 0），次数用本地扫描 count
    if(D._modelCosts){for(var mi2=0;mi2<D._modelCosts.length;mi2++){var mmc=D._modelCosts[mi2];if(mmc&&mmc.model&&!costMap[mmc.model])costMap[mmc.model]=mmc.cost||0;}}
    items = pbd.map(function(p,i){return{label:pLabels[i],tokens:p.totalTokens||0,count:countMap[p.model]!==undefined?countMap[p.model]:(p.count||0),cost:costMap[p.model]||0,color:cc.doughnut[i%cc.doughnut.length]};});
    // 卡内供应商筛选行（始终展示，供应商即分类）
    var provRow='<div class="mr-prov-row"><button data-p="" class="'+( _modelProv===""?"on":"")+'">全部</button>';
    for(var pj=0;pj<provs.length;pj++){
      provRow+='<button data-p="'+escHTML(provs[pj])+'" class="'+( _modelProv===provs[pj]?"on":"")+'">'+escHTML(_pn(provs[pj]))+'</button>';
    }
    provRow+='</div>';
    _provRowHtml=provRow;
  } else {
    var m=D.models; if(!m||!m.length)return;
    items = m.map(function(md,i){return{label:md.id,tokens:md.totalTokens||0,count:0,cost:0,color:cc.doughnut[i%cc.doughnut.length]};});
  }
  var ctEl=$("mc").parentElement.querySelector(".ct");
  ctEl.textContent=title;

  // 三栏独立排行：Token / 次数 / 费用
  var TOP=8;
  function rankBy(fn, valFn, fmtFn, hasFn){
    var arr=items.filter(hasFn).slice().sort(function(a,b){return fn(b)-fn(a);}).slice(0,TOP);
    var total=0; for(var i=0;i<arr.length;i++)total+=fn(arr[i]);
    if(!total)return {arr:[],total:0,empty:true};
    var h='<div class="mr-col-item">';
    arr.forEach(function(it,k){
      var w=total>0?(fn(it)/total*100):0;
      h+='<div class="mr-row"><div class="mr-rank">'+(k+1)+'</div>'+
        '<span class="mr-dot" style="background:'+it.color+'"></span>'+
        '<div class="mr-info"><div class="mr-name">'+escHTML(mn(it.label))+'</div>'+
        '<div class="mr-bar"><div class="mr-bar-fill" style="width:'+w+'%;background:'+it.color+'"></div></div></div>'+
        '<div class="mr-val">'+fmtFn(fn(it))+'</div></div>';
    });
    h+='</div>';
    return {arr:arr,total:total,html:h};
  }
  var colToken=rankBy(function(it){return it.tokens||0;},null,function(v){return fmtAxis(v);},function(it){return (it.tokens||0)>0;});
  var colCount=rankBy(function(it){return it.count||0;},null,function(v){return fmt(v)+" 次";},function(it){return (it.count||0)>0;});
  var colCost=rankBy(function(it){return it.cost||0;},null,function(v){return dual(v);},function(it){return (it.cost||0)>0;});

  var html=(_provRowHtml||"")+'<div class="mr-cols">';
  html+='<div class="mr-col"><div class="mr-col-title">Token</div>'+(colToken.html||'<div class="mr-col-empty">无数据</div>')+'</div>';
  html+='<div class="mr-col"><div class="mr-col-title">次数</div>'+(colCount.html||'<div class="mr-col-empty">无数据</div>')+'</div>';
  html+='<div class="mr-col"><div class="mr-col-title">费用</div>'+(colCost.html||'<div class="mr-col-empty">无数据</div>')+'</div>';
  html+='</div>';
  // 消费明细并入模型占比卡片（费用优先官方账单口径）
  var csHtml=buildConsumptionTable(costMap);
  if(csHtml)html+='<div class="mr-cs">'+csHtml+'</div>';
  listEl.innerHTML=html;
  $("mc").style.display="none";
  listEl.style.display="block";
  // 供应商筛选点击（委托绑定，避免重复注册）
  if(!listEl.__provBound){
    listEl.__provBound=true;
    listEl.addEventListener("click",function(e){
      var b=e.target.closest(".mr-prov-row button");
      if(!b)return;
      _modelProv=b.getAttribute("data-p")||"";
      renderModel();
    });
  }
}

function renderAgent() {
  const cc = chartColors(); if (ac) ac.destroy();
  if (_selAgent && !_selModel) {
    var ag=D.agents.find(function(a){return a.id===_selAgent}); if(!ag||!ag.models)return;
    var mods=Object.entries(ag.models).sort(function(a,b){return(b[1].totalTokens||0)-(a[1].totalTokens||0)});
    if(!mods.length)return;
    $("ac").parentElement.querySelector(".ct").textContent="模型占比";
    ac = new Chart($("ac"),{type:"bar",data:{labels:mods.map(function(m){return mn(m[0])}),datasets:[{label:"消耗",data:mods.map(function(m){return m[1].totalTokens||0}),backgroundColor:cc.doughnut.slice(0,mods.length),borderRadius:6,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,color:cc.text,indexAxis:"y",scales:{x:{grid:{color:cc.grid},ticks:{callback:function(v){return fmtAxis(v)},font:{size:12}}},y:{grid:{display:false},ticks:{font:{size:12}}}},plugins:{legend:{display:false}}}});
  } else {
    var ags=!D.agents?null:D.agents.filter(function(a){return _showDeleted||!a.deleted;}); if(!ags||!ags.length)return;
    $("ac").parentElement.querySelector(".ct").textContent="Agent 消耗对比";
    ac = new Chart($("ac"),{type:"bar",data:{labels:ags.map(function(a){var n=(D.agentNames||{})[a.id]||a.id;if(a.deleted)n+=' (已删除)';return n}),datasets:[{label:"消耗",data:ags.map(function(a){return a.totalTokens}),backgroundColor:cc.agent.slice(0,ags.length),borderRadius:6,borderSkipped:false}]},options:{responsive:true,maintainAspectRatio:false,color:cc.text,indexAxis:"y",scales:{x:{grid:{color:cc.grid},ticks:{callback:function(v){return fmtAxis(v)},font:{size:12}}},y:{grid:{display:false},ticks:{font:{size:12}}}},plugins:{legend:{display:false}}}});
  }
}

function renderBalance(){
  var sbList=$("sb-list"),sbName=$("sb-name"),sbDisplay=$("sb-display");
  if(!sbList||!sbName||!sbDisplay)return;
  var allBal=(D._balances||[]).slice();
  // 并入订阅余量供应商（OpenCode Go / 商汤 / 火山等），侧边栏可切换查看
  var subs=D._subscriptionQuotas||[];
  for(var si=0;si<subs.length;si++){
    var sq=subs[si];
    var qt=sq.type||"";
    if(qt==="opencode-go-quota"||qt==="opencode-go-quota-est"||qt==="quota"||qt==="coding-plan-quota"){
      var dupIdx=-1;
      for(var di=0;di<allBal.length;di++){if(allBal[di].provider===sq.provider){dupIdx=di;break;}}
      if(dupIdx>=0){
        // 已有条目若是无数据状态（未配置/无 key/错误），用订阅余量覆盖
        var ot=allBal[dupIdx].type||"";
        if(ot==="none"||ot==="no-key"||ot==="error"||ot==="no-token"){
          allBal[dupIdx]={provider:sq.provider,label:sq.label||sq.provider,type:qt,display:sq.display||"",_sub:sq};
        }
      }else{
        allBal.push({provider:sq.provider,label:sq.label||sq.provider,type:qt,display:sq.display||"",_sub:sq});
      }
    }
  }
  var hasData=allBal.filter(function(b){return b.type==='money'||b.type==='quota'||b.type==='opencode-go-quota'||b.type==='opencode-go-quota-est'||b.type==='coding-plan-quota';});
  var picks=hasData.length?hasData:allBal;
  if(!picks.length){sbDisplay.textContent="无数据";sbList.innerHTML='';return;}
  var found=false;
  for(var i=0;i<picks.length;i++){if(picks[i].provider===_selBalance||picks[i].provider.toLowerCase()===_selBalance.toLowerCase()){_selBalance=picks[i].provider;found=true;break;}}
  if(!found)_selBalance=picks[0].provider;
  var curBal=null;
  for(var i=0;i<picks.length;i++){if(picks[i].provider===_selBalance){curBal=picks[i];break;}}
  var listHtml='';
  for(var i=0;i<picks.length;i++){
    var p=picks[i];
    var sel=(p.provider===_selBalance)?' sel':'';
    listHtml+='<div class="cs-opt'+sel+'" data-v="'+escHTML(p.provider)+'">'+escHTML(_pn(p.provider))+'</div>';
  }
  sbList.innerHTML=listHtml;
  sbName.textContent=_pn(curBal?curBal.provider:_selBalance);
  // 隐藏余额偏好：选择器照常可切换，仅隐藏数值
  if(_hideBal()){
    sbDisplay.className='sb-card sb-muted';
    sbDisplay.innerHTML='<div class="sb-val sm">余额已隐藏</div>';
    return;
  }
  // 订阅余量摘要（OpenCode Go / 商汤 / 火山等）
  if(curBal&&curBal._sub){
    sbDisplay.className='sb-card';
    var sq=curBal._sub;
    if(sq.type.indexOf("opencode-go")===0&&sq.windows&&sq.windows.length){
      var winNames={rolling:"5小时",weekly:"本周",monthly:"本月"};
      var totalRemain=0;
      for(var wi=0;wi<sq.windows.length;wi++){
        var w=sq.windows[wi];
        if(sq.est){totalRemain+=Math.max(0,(w.limitUsd||0)-(w.usedUsd||0));}
        else{
          var lim=(D&&D._ogLimits)||OG_LIMITS;
          var lv=lim[w.level]||0;
          totalRemain+=lv>0?Math.max(0,lv*(100-Math.min(100,Math.max(0,w.usedPercent||0)))/100):0;
        }
      }
      sbDisplay.innerHTML='<div class="sb-val">'+dual(totalRemain)+'</div><div class="sb-sub">'+sq.windows.map(function(w){return winNames[w.level]||w.level;}).join(' · ')+'</div>';
      return;
    }
    if(sq.models&&sq.models.length){
      var m0=sq.models[0];
      var mdisp=m0.display||(m0.remainPercent!=null?(+m0.remainPercent).toFixed(1)+'%':(m0.remain!=null?m0.remain+'/'+m0.limit:'余量'));
      sbDisplay.innerHTML='<div class="sb-val">'+escHTML(mdisp)+'</div><div class="sb-sub">'+escHTML(m0.modelId||m0.modelName||'')+'</div>';
      return;
    }
    if(sq.windows&&sq.windows.length){
      var w0=sq.windows[0];
      sbDisplay.innerHTML='<div class="sb-val">'+(w0.remainPercent!=null?(+w0.remainPercent).toFixed(1)+'%':'余量')+'</div><div class="sb-sub">'+(w0.level||'')+'</div>';
      return;
    }
    sbDisplay.className='sb-card sb-muted';
    sbDisplay.innerHTML='<div class="sb-val sm">'+escHTML(curBal.display||'无数据')+'</div>';
    return;
  }
  if(curBal&&(curBal.type==='money'||curBal.type==='quota')){
    var warn=curBal.type==='money'&&curBal.total<=10;
    sbDisplay.className='sb-card'+(warn?' sb-warn':'');
    sbDisplay.innerHTML='<div class="sb-val">'+escHTML(curBal.display)+'</div>'+(curBal.type==='quota'&&curBal.remain!==undefined?'<div class="sb-bar"><div class="sb-bar-fill" style="width:'+curBal.remain+'%"></div></div>':'')+(curBal.details&&curBal.details.length>1?'<div class="sb-sub">'+curBal.details.map(function(d){return escHTML(d.label)+' ¥'+d.amount.toFixed(2);}).join(' · ')+'</div>':'');
  }else if(curBal){
    sbDisplay.className='sb-card sb-muted';
    sbDisplay.innerHTML='<div class="sb-val sm">'+escHTML(curBal.display||'无数据')+'</div>';
  }else{
    sbDisplay.className='sb-card sb-muted';
    sbDisplay.textContent='无数据';
  }
}

function fmtReset(sec){
  if(!sec||sec<=0)return "即将重置";
  if(sec<60)return sec+"秒后重置";
  if(sec<3600)return Math.floor(sec/60)+"分后重置";
  if(sec<86400){var h=Math.floor(sec/3600),m=Math.floor((sec%3600)/60);return m?h+"时"+m+"分后重置":h+"时后重置";}
  var d=Math.floor(sec/86400),h2=Math.floor((sec%86400)/3600);return h2?d+"天"+h2+"时后重置":d+"天后重置";
}
// cost 字段单位为 1e-8 美元，显示 6 位精度（去尾零）
function fmtUsd(v8){
  var d=(v8||0)/1e8;
  if(d<=0)return "$0";
  var s=d.toFixed(6).replace(/0+$/,"").replace(/\.$/,"");
  return "$"+s;
}
// 柱顶短标签：金额大则 3 位，小则 4 位
function fmtUsdShort(v8){
  var d=(v8||0)/1e8;
  if(d<=0)return "$0";
  return d>=0.01?"$"+d.toFixed(3):"$"+d.toFixed(4);
}
// 美元直接量（对齐官方口径：小于 1 显示 6 位小数，其余 2 位）
function fmtUsdDollar(v){
  if(!(v>0))return "0";
  if(v<1)return v.toFixed(6);
  return v.toFixed(2);
}
// OpenCode Go 套餐窗口额度（官网 opencode.ai/docs/go）
var OG_LIMITS={rolling:12,weekly:30,monthly:60};
function quotaColor(p){
  if(p>=80)return "var(--red)";
  if(p>=60)return "var(--orange)";
  return "var(--green)";
}
function renderSubscriptionQuotas(){
  var el=$("drawer-quota");
  if(!el)return;
  var qs=D._subscriptionQuotas||[];
  var hasData=false;
  for(var i=0;i<qs.length;i++){
    var qt=qs[i].type||"";
    if(qt==="opencode-go-quota"||qt==="opencode-go-quota-est"||qt==="quota"||qt==="coding-plan-quota"||qt==="tokenplan-points"||qt==="error"||qt==="no-token"){hasData=true;break;}
  }
  if(!hasData){el.style.display="none";return;}
  var h='<div class="subq-wrap"><div class="subq-title">订阅余量</div>';
  for(var i=0;i<qs.length;i++){
    var q=qs[i];
    var label=q.label||q.provider||"";
    var isOg=(q.type==="opencode-go-quota"||q.type==="opencode-go-quota-est");
    var srcBadge=isOg?(q.est?'<span class="subq-src est">本地估算</span>':'<span class="subq-src">官方</span>'):'';
    h+='<div class="subq-card"><div class="subq-hdr"><span class="subq-prov">'+escHTML(label)+'</span>'+srcBadge+'</div>';
    if(isOg&&q.est&&q.type==="opencode-go-quota-est"){
      // cookie 失效或未配置时的明确提示：本地估算只是兜底，官方数据拿不到
      h+='<div class="og-cookie-warn">官方接口未连接（cookie 失效或未配置），以下为本地估算。请到设置 → OpenCode Go 更新 auth cookie。</div>';
    }
    if(q._ogSubStart){
      var fdt=function(ts){var d=new Date(ts);var p2=function(n){return String(n).padStart(2,"0")};return d.getFullYear()+"/"+p2(d.getMonth()+1)+"/"+p2(d.getDate())+" "+p2(d.getHours())+":"+p2(d.getMinutes());};
      h+='<div class="subq-dates">订阅约 '+fdt(q._ogSubStart)+' · 预计到期 '+fdt(q._ogSubEnd)+'</div>';
    }
    if((q.type==="opencode-go-quota"||q.type==="opencode-go-quota-est")&&q.windows&&q.windows.length){
      var winNames={rolling:"滚动 5 小时",weekly:"本周",monthly:"本月"};
      var uh='';
      // 账单 vs 窗口对照：usagePercent 是实时美元价值（含预扣/未结算），账单是已结算扣费
      // 对照区固定用订阅周期内账单（_ogBilledSub，订阅起点至今），与窗口实时同口径，不随筛选范围变；
      // fallback 顺序：订阅周期 → 筛选范围 → 当月
      if(!q.est&&(q._ogBilledSub||q._ogBilledRange||q._ogBilledMonth)>0){
        var mLimit=((D&&D._ogLimits&&D._ogLimits.monthly)||60);
        var mWinUsd=0;
        for(var wj=0;wj<q.windows.length;wj++){if(q.windows[wj].level==="monthly"){mWinUsd=((q.windows[wj].usedPercent||0)/100)*mLimit;}}
        var billUsd = (q._ogBilledSub!=null?q._ogBilledSub:(q._ogBilledRange!=null?q._ogBilledRange:q._ogBilledMonth));
        var diffTxt='';
        if(mWinUsd>billUsd+0.001){
          var dAmt=mWinUsd-billUsd;
          diffTxt='<em>差额 '+dual(dAmt)+'：窗口实时为官方标价口径（含预扣/未结算），账单为已结算扣费，两口径存在天然差</em>';
        }
        uh+='<div class="og-bill-note">窗口实时 '+dual(mWinUsd)+'<em class="og-limit"> / '+dual(mLimit)+'</em> · 已结算账单 '+dual(billUsd)+diffTxt+'</div>';
      }
      // ── 模型月额度：官方每模型 $15/$60 配额 vs 当月已用（官方成本优先）──
      // 数据源固定当月口径（后端 monthlyModelUsage），不随页面筛选范围变化；为空则不显示
      var ptAll=D&&D._priceTable?D._priceTable:{};
      var ogUsageSrc=q.monthlyModelUsage||[];
      if(ogUsageSrc&&ogUsageSrc.length){
        var allowRows=[];
        for(var oai=0;oai<ogUsageSrc.length;oai++){
          var oms=ogUsageSrc[oai];
          var ope=ptAll["opencode-go/"+oms.model]||{};
          var allow=ope.monthlyAllowance||0;
          if(!allow)continue;
          var usedAmt=oms.costUsd||0;
          var usedPct=Math.min(100,Math.max(0,usedAmt/allow*100));
          allowRows.push({model:oms.model,allow:allow,used:usedAmt,pct:usedPct,count:oms.count||0});
        }
        if(allowRows.length){
          var scopeTag=q.modelCostScope==='all-keys'?' · 全部 KEY':'';
          var costSrcTag=q.monthlyCostSource==='official'?'<em class="og-remain-sub">官方账单</em>':(q.monthlyCostSource==='official+usage-cache'?'<em class="og-remain-sub">官方+缓存回退</em>':'');
          uh+='<div class="og-usage"><div class="og-cost-title">模型月额度<span class="og-title-total">套餐月限 $60'+scopeTag+'</span>'+costSrcTag+'</div>';
          for(var oai2=0;oai2<allowRows.length;oai2++){
            var ar=allowRows[oai2];
            var ac=quotaColor(ar.pct);
            uh+='<div class="og-usage-row og-mrow"><span class="og-u-model">'+escHTML(mn(ar.model))+'</span><span class="og-u-tok">已用 '+dual(ar.used)+' / '+dual(ar.allow)+'</span><span class="og-u-pct" style="color:'+ac+'">'+ar.pct.toFixed(1)+'%</span></div>';
          }
          uh+='</div>';
        }
      }
      // 剩余预估可用次数：窗口剩余按窗口内实际消耗比例拆分 ÷ 你的平均单次成本（卡片式）
      if(q._ogRemainEst&&q._ogRemainEst.length){
        uh+='<div class="og-remain"><div class="og-remain-title">剩余预估可用次数<span class="og-remain-sub">（窗口剩余 × 你的实际消耗占比）÷ 你的平均单次成本</span></div>';
        uh+='<div class="og-remain-grid">';
        for(var ri=0;ri<q._ogRemainEst.length;ri++){
          var re=q._ogRemainEst[ri];
          uh+='<div class="og-rem-card">';
          uh+='<div class="og-rem-hdr"><span class="og-rem-name">'+escHTML(mn(re.model))+'</span><span class="og-rem-share">窗口 '+re.sharePct+'%</span></div>';
          uh+='<div class="og-rem-calls">'+fmt(re.remainCalls)+'<small> 次</small></div>';
          uh+='<div class="og-rem-tok">'+(re.remainTokens>0?'约 '+fmtT(re.remainTokens)+' token':'—')+'</div>';
          uh+='<div class="og-rem-foot">剩 '+dual(re.remainUsd)+' · 平均 '+dual(re.avgCostUsd)+'/次</div>';
          uh+='</div>';
        }
        uh+='</div></div>';
      }
      // ── Key 汇总：每个 key 单独卡片并排（自适应），内部下钻模型明细 ──
      if(q.keySummary&&q.keySummary.length){
        var ogCallsTmp = 0;
        for(var kt0=0;kt0<q.keySummary.length;kt0++){ogCallsTmp+=(q.keySummary[kt0].count||0);}
        uh+='<div class="og-usage"><div class="og-cost-title">Key 汇总<span class="og-title-total">'+ogCallsTmp.toLocaleString()+' 次</span></div><div class="ogk-grid">';
        var ksCalls=0;
        for(var ki0=0;ki0<q.keySummary.length;ki0++){ksCalls+=(q.keySummary[ki0].count||0);}
        for(var ki=0;ki<q.keySummary.length;ki++){
          var ks=q.keySummary[ki];
          var kname=(ks.name||ks.keyId||"");
          var kShort=kname.split(" - ").pop();
          if(kShort.length>22)kShort=kShort.slice(0,20)+"…";
          var kpct=ksCalls>0?Math.round((ks.count||0)/ksCalls*100):0;
          uh+='<div class="ogk-card"><div class="ogk-hdr"><span class="ogk-name">'+escHTML(kShort)+'</span><span class="ogk-cost">'+dual(ks.costUsd||0)+'</span><span class="ogk-pct">'+kpct+'%</span></div>';
          uh+='<div class="ogk-sub">'+(ks.count||0).toLocaleString()+' 次</div>';
          uh+='<div class="ogk-bar"><div class="ogk-bar-fill" style="width:'+kpct+'%"></div></div>';
          // 该 key 下的模型明细（模型费用占 key 比例）
          if(ks.models&&ks.models.length){
            var kmTotal=0;for(var kmt=0;kmt<ks.models.length;kmt++){kmTotal+=(ks.models[kmt].count||0);}
            uh+='<div class="ogk-models">';
            for(var kmi=0;kmi<ks.models.length;kmi++){
              var km=ks.models[kmi];
              var kmpct=kmTotal>0?Math.round((km.count||0)/kmTotal*100):0;
              uh+='<div class="og-usage-row og-mrow"><span class="og-u-model">'+escHTML(mn(km.model))+'</span><span class="og-u-tok">'+(km.count||0).toLocaleString()+' 次</span><span class="og-u-cost">'+dual(km.costUsd||0)+'</span><span class="og-u-pct">'+kmpct+'%</span></div>';
            }
            uh+='</div>';
          }
          uh+='</div>';
        }
        uh+='</div></div>';
      }
      h+=uh;
    }else if(q.type==="quota"&&q.models&&q.models.length){
      for(var w=0;w<q.models.length;w++){
        var m=q.models[w];
        if(m._isPercent){
          var remain=m.remain||0;
          var pct=Math.min(100,Math.max(0,remain));
          var c=quotaColor(100-pct);
          h+='<div class="subq-row"><div class="subq-lbl">'+escHTML(snModelName(m.modelId||m.label||m.model||("模型"+w)))+'</div>'+
            '<div class="subq-bar"><div class="subq-bar-fill" style="width:'+pct+'%;background:'+c+'"></div></div>'+
            '<div class="subq-pct" style="color:'+c+'">余 '+remain.toFixed(1)+'%</div></div>';
        }else{
          var mp=(m.limit&&m.limit>0)?Math.min(100,Math.max(0,((m.used||0)/m.limit)*100)):0;
          var mc=quotaColor(mp);
          h+='<div class="subq-row"><div class="subq-lbl">'+escHTML(mn(m.label||m.model||m.modelId||("模型"+w)))+'</div>'+
            '<div class="subq-bar"><div class="subq-bar-fill" style="width:'+mp+'%;background:'+mc+'"></div></div>'+
            '<div class="subq-pct" style="color:'+mc+'">已用 '+mp.toFixed(0)+'%</div></div>';
        }
      }
    }else if(q.type==="coding-plan-quota"&&q.windows&&q.windows.length){
      for(var w=0;w<q.windows.length;w++){
        var win=q.windows[w];
        var p=Math.min(100,Math.max(0,win.usedPercent||0));
        var c=quotaColor(p);
        h+='<div class="subq-row"><div class="subq-lbl">'+escHTML(win.level||"窗口")+'</div>'+
          '<div class="subq-bar"><div class="subq-bar-fill" style="width:'+p+'%;background:'+c+'"></div></div>'+
          '<div class="subq-pct" style="color:'+c+'">已用 '+p+'%</div></div>';
      }
    }else if(q.type==="tokenplan-points"&&q.pools&&q.pools.length){
      // 商汤 TokenPlan 积分池：每池 5h/周两窗口行 + 返赠余额
      for(var tpi=0;tpi<q.pools.length;tpi++){
        var pl=q.pools[tpi];
        h+='<div class="tp-pool"><div class="tp-pool-name">'+escHTML(pl.name||"积分池")+(pl.modelIds&&pl.modelIds.length?'<span class="tp-pool-scope">适用 '+pl.modelIds.length+' 个模型</span>':'')+'</div>';
        var tpWins=[["5小时窗口",pl.win5h],["本周窗口",pl.win7d]];
        for(var twi=0;twi<tpWins.length;twi++){
          var twName=tpWins[twi][0],tw=tpWins[twi][1];
          if(!tw)continue;
          var twp=tw.limit>0?Math.min(100,Math.max(0,(tw.used/tw.limit)*100)):0;
          var twc=quotaColor(twp);
          h+='<div class="subq-row"><div class="subq-lbl">'+twName+'</div>'+
            '<div class="subq-bar"><div class="subq-bar-fill" style="width:'+twp+'%;background:'+twc+'"></div></div>'+
            '<div class="subq-pct" style="color:'+twc+'">余 '+fmtT(tw.remaining||0)+' / '+fmtT(tw.limit||0)+'</div></div>';
          if(tw.resetAt)h+='<div class="tp-reset">'+twName+'：'+fmtReset(Math.max(0,(tw.resetAt-Date.now())/1000))+'</div>';
        }
        if(pl.grantBalance>0){
          var gExp=pl.grantExpiry?(' · 最近到期 '+new Date(pl.grantExpiry).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})):"";
          h+='<div class="tp-grant">活动返赠余额 '+fmtT(pl.grantBalance)+gExp+'</div>';
        }
        h+='</div>';
      }
    }else if(q.type==="error"||q.type==="no-token"){
      h+='<div class="subq-err">'+escHTML(q.display||"未配置")+'</div>';
    }else if(q.display){
      h+='<div class="subq-err">'+escHTML(q.display)+'</div>';
    }
    h+='</div>';
  }
  h+='</div>';
  el.innerHTML=h;
  el.style.display="";

}

function renderHdrQuota(){
  var el=$("hdrQuota");
  if(!el)return;
  var qs=D._subscriptionQuotas||[];
  var og=null;
  for(var i=0;i<qs.length;i++){
    if(qs[i].type==="opencode-go-quota"||qs[i].type==="opencode-go-quota-est"){og=qs[i];break;}
  }
  if(!og||!og.windows||!og.windows.length){el.style.display="none";return;}
  el.style.display="";
  var winNames={rolling:"5小时",weekly:"本周",monthly:"本月"};
  var h='<div class="hq-title">订阅余量</div><div class="hq-wins">';
  for(var w=0;w<og.windows.length;w++){
    var win=og.windows[w];
    var p;
    if(og.est){p=win.limitUsd>0?Math.round((win.usedUsd||0)/win.limitUsd*100):0;}
    else{p=Math.min(100,Math.max(0,win.usedPercent||0));}
    p=Math.min(100,Math.max(0,p));
    var remainPct=(100-p);
    var remainPctStr=remainPct%1===0?remainPct.toFixed(0):remainPct.toFixed(2);
    var LIMITS=(D&&D._ogLimits)||OG_LIMITS;
    var limitUsd=og.est?(win.limitUsd||0):(LIMITS[win.level]||0);
    var remainUsd=og.est?Math.max(0,limitUsd-(win.usedUsd||0)):Math.max(0,limitUsd*(100-p)/100);
    var c=quotaColor(p);
    var amtCls=p>=80?" hq-urgent":(p>=60?" hq-warn":"");
    var resetTxt=og.est?(win.resetInSec?fmtReset(win.resetInSec):"估算"):fmtReset(win.resetInSec);
    var limitTag=(limitUsd>0)?'<em class="hq-limit"> / '+dual(limitUsd)+'</em>':'';
    h+='<div class="hq-win"><span class="hq-wl">'+escHTML(winNames[win.level]||win.level)+'</span><b class="'+amtCls+'" style="color:'+c+'">'+dual(remainUsd)+limitTag+'</b><div class="hq-track"><i style="width:'+p+'%;background:'+c+'"></i></div><i class="hq-note">剩余 '+remainPctStr+'%<em class="hq-reset"><svg class="hq-hg" viewBox="0 0 12 16" aria-hidden="true"><path d="M2 1h8v2L6.5 8l3.5 5v2H2v-2l3.5-5L2 3V1z" fill="none" stroke="currentColor"/><path class="hg-sand-top" d="M3 2.1h6L6 7.5 3 2.1z" fill="currentColor"/><path class="hg-sand-bot" d="M6 8.5l3 5.4H3l3-5.4z" fill="currentColor" opacity=".45"/></svg>'+resetTxt+'</em></i></div>';
  }
  h+='</div>';
  if(og._ogSubEnd){
    _hqExpEnd=og._ogSubEnd;
    h+='<div class="hq-exp" id="hq-exp">'+expText(_hqExpEnd)+'</div>';
  }else{
    _hqExpEnd=0;
  }
  el.innerHTML=h;
  el.title="点击查看订阅余量与消费明细";
  el.onclick=function(){openDrawer();};
}
// 头部订阅余量卡：到期倒计时（每秒刷新）
var _hqExpEnd=0;
function expText(end){
  var r=end-Date.now();
  if(r<=0)return "已到期";
  var d=Math.floor(r/86400000);
  var hh=Math.floor(r%86400000/3600000);
  var mm=Math.floor(r%3600000/60000);
  var ss=Math.floor(r%60000/1000);
  var p=function(n){return String(n).padStart(2,"0")};
  return "距到期 "+d+" 天 "+p(hh)+":"+p(mm)+":"+p(ss);
}
function hqExpTick(){
  if(!_hqExpEnd)return;
  var el=$("hq-exp");if(!el)return;
  el.textContent=expText(_hqExpEnd);
}
setInterval(hqExpTick,1000);

function buildConsumptionTable(costMap,countMap){
  var costs=D._modelCosts||[];
  if(!costs.length)return null;
  var hasCost=false;
  for(var i=0;i<costs.length;i++){if(costs[i].cost>0){hasCost=true;break;}}
  if(!hasCost)return null;
  var pt=D._priceTable||{};
  var total=0;
  for(var i=0;i<costs.length;i++){if(costs[i].cost>0){total+=toUsd(costs[i].cost,costs[i].currency);}}
  var displayTotal=total;
  var h='<div class="cs-wrap">';
  h+='<div class="cs-list">';

  // 检查是否有特殊时段（跳过覆盖全天的 slot）
  var hasSlots=false;
  for(var pk2 in pt){var e2=pt[pk2];if(e2&&e2.slots&&e2.slots.length){for(var si=0;si<e2.slots.length;si++){var s=e2.slots[si];var f=s.from.split(':').map(Number),t=s.to.split(':').map(Number);if(!(f[0]*60+(f[1]||0)===0&&t[0]*60+(t[1]||0)===1440)){hasSlots=true;break;}}}}

  // 模型 token 总量
  var modelInfo={};
  for(var mi=0;mi<(D.models||[]).length;mi++){var m2=D.models[mi];modelInfo[m2.id]={tokIn:m2.input||0,tokOut:m2.output||0,tokCache:m2.cacheRead||0};}

  // slot 模型列表
  var slotModels=[];
  if(hasSlots&&D.hourly&&D.hourly.length>0){
    for(var pk2 in pt){var e2=pt[pk2];if(e2&&e2.slots&&e2.slots.length&&e2.defaultPrice){slotModels.push({key:pk2,entry:e2});}}
  }
  var slotModelUsd=0;
  for(var ci=0;ci<costs.length;ci++){var cc=costs[ci];if(cc.cost>0){for(var sji=0;sji<slotModels.length;sji++){if(slotModels[sji].key.split('/').pop()===cc.model){slotModelUsd+=toUsd(cc.cost,cc.currency);break;}}}}

  // 计算每个模型的时段拆分（有 slot 时）
  function slotSplit(mId, entry){
    var info=modelInfo[mId];
    if(!info)return null;
    var sTok=0,nTok=0;
    for(var hi=0;hi<D.hourly.length;hi++){
      var hh=D.hourly[hi];
      var mt=hh.models&&hh.models[mId];
      if(!mt||!mt.totalTokens)continue;
      var cur2=parseInt(hh.hour)*60+30;
      var inSlot2=false;
      for(var sj=0;sj<entry.slots.length;sj++){
        var s3=entry.slots[sj];
        var f3=s3.from.split(':').map(Number),t3=s3.to.split(':').map(Number);
        var fs3=f3[0]*60+(f3[1]||0),ts3=t3[0]*60+(t3[1]||0);
        if(fs3===0&&ts3===1440)continue;
        if(fs3<=ts3){if(cur2>=fs3&&cur2<ts3)inSlot2=true;}
        else{if(cur2>=fs3||cur2<ts3)inSlot2=true;}
        if(inSlot2)break;
      }
      if(inSlot2)sTok+=mt.totalTokens;else nTok+=mt.totalTokens;
    }
    if(sTok+nTok<=0)return null;
    var ratioS=sTok/(sTok+nTok),ratioN=nTok/(sTok+nTok);
    var dp3=entry.defaultPrice||{};
    var slotP=null;
    for(var sj2=0;sj2<entry.slots.length;sj2++){var s4=entry.slots[sj2];var f4=s4.from.split(':').map(Number),t4=s4.to.split(':').map(Number);if(!(f4[0]*60+(f4[1]||0)===0&&t4[0]*60+(t4[1]||0)===1440)){slotP=s4;break;}}
    if(!slotP)return null;
    var curM=entry.currency||"USD";
    var sIn=info.tokIn*ratioS,sOut=info.tokOut*ratioS,sCache=info.tokCache*ratioS;
    var nIn=info.tokIn*ratioN,nOut=info.tokOut*ratioN,nCache=info.tokCache*ratioN;
    var sAmt=sIn*(slotP.inputPerM||0)/1e6+sCache*(slotP.inputCachePerM||0)/1e6+sOut*(slotP.outputPerM||0)/1e6;
    var nAmt=nIn*(dp3.inputPerM||0)/1e6+nCache*(dp3.inputCachePerM||0)/1e6+nOut*(dp3.outputPerM||0)/1e6;
    return { sIn:sIn,sOut:sOut,sCache:sCache,nIn:nIn,nOut:nOut,nCache:nCache,sAmt:sAmt,nAmt:nAmt,curM:curM };
  }

  var slotTotalUsd=0, nonSlotTotalUsd=0;
  for(var i=0;i<costs.length;i++){
    var c=costs[i];
    if(c.cost<=0)continue;
    var curM=c.currency||"USD";
    var label=c.model;
    // 官方账单口径优先（opencode-go）：费用用官方扣费，token 用官方明细（缺时显示 —）
    var isOfficial = c.costSource === "official";
    var officialCost = isOfficial ? (c.cost||0) : ((costMap&&costMap[label]>0)?costMap[label]:0);
    if(officialCost>0){
      nonSlotTotalUsd+=toUsd(officialCost,"USD");
      var oCnt=(countMap&&countMap[label])||c.callCount||0;
      var oTok=null;
      if(isOfficial && (c.officialInputTokens!=null || c.officialOutputTokens!=null)){
        oTok={in:c.officialInputTokens,out:c.officialOutputTokens,cache:null};
      }else{
        var oi2=modelInfo[label];
        oTok=oi2?{in:oi2.tokIn,out:oi2.tokOut,cache:oi2.tokCache}:{in:null,out:null,cache:null};
      }
      var fTok=function(v){return v==null?'—':fmtCN(v);};
      var totTok=(oTok.in==null&&oTok.out==null)?'—':fmtCN((oTok.in||0)+(oTok.out||0)+(oTok.cache||0));
      h+='<div class="cs-card"><div class="cs-card-hdr"><span class="cs-model">'+escHTML(mn(label))+'</span><span class="cs-badge">'+(isOfficial?'官方账单':'官方')+'</span><span class="cs-amt">'+dual(officialCost)+'</span></div>';
      h+='<div class="cs-card-meta">'+oCnt.toLocaleString()+' 次 · 总 '+totTok+'</div>';
      h+='<div class="cs-card-meta">输入 '+fTok(oTok.in)+' · 输出 '+fTok(oTok.out)+' · 缓存 '+fTok(oTok.cache)+'</div>';
      // 缓存已并入上方 meta 行
      h+='</div>';
      continue;
    }
    var isSlot=false, split=null;
    for(var sj3=0;sj3<slotModels.length;sj3++){if(slotModels[sj3].key.split('/').pop()===c.model){isSlot=true;split=slotSplit(c.model,slotModels[sj3].entry);break;}}
    if(isSlot&&split){
      // 时段拆分行 + 高峰/非高峰子行
      slotTotalUsd+=toUsd(split.sAmt,split.curM)+toUsd(split.nAmt,split.curM);
      h+='<div class="cs-card"><div class="cs-card-hdr"><span class="cs-model">'+escHTML(mn(label))+'</span><span class="cs-badge">'+(split.curM==="CNY"?"人民币":"美元")+'</span><span class="cs-amt">'+dualByCur(split.sAmt+split.nAmt,split.curM)+'</span></div>';
      h+='<div class="cs-card-meta">'+((c.callCount||0).toLocaleString())+' 次 · 总 '+fmtCN(split.sIn+split.nIn+split.sOut+split.nOut+split.sCache+split.nCache)+'</div>';
      h+='<div class="cs-card-meta">输入 '+fmtCN(split.sIn+split.nIn)+' · 输出 '+fmtCN(split.sOut+split.nOut)+' · 缓存 '+fmtCN(split.sCache+split.nCache)+'</div>';
      // 缓存已并入上方 meta 行
      h+='<div class="cs-card-sub">高峰 '+dualByCur(split.sAmt,split.curM)+' <span>'+fmtCN(split.sIn)+' in · '+fmtCN(split.sOut)+' out</span></div>';
      h+='<div class="cs-card-sub">常规 '+dualByCur(split.nAmt,split.curM)+' <span>'+fmtCN(split.nIn)+' in · '+fmtCN(split.nOut)+' out</span></div>';
      h+='</div>';
    }else{
      // 普通模型单行
      nonSlotTotalUsd+=toUsd(c.cost,c.currency);
      var tokIn=0,tokOut=0,tokCache=0;
      var info2=modelInfo[c.model];
      if(info2){tokIn=info2.tokIn;tokOut=info2.tokOut;tokCache=info2.tokCache;}
      h+='<div class="cs-card"><div class="cs-card-hdr"><span class="cs-model">'+escHTML(mn(label))+'</span><span class="cs-badge">'+(curM==="CNY"?"人民币":"美元")+'</span><span class="cs-amt">'+dualByCur(c.cost,curM)+'</span></div>';
      h+='<div class="cs-card-meta">'+((c.callCount||0).toLocaleString())+' 次 · 总 '+fmtCN(tokIn+tokOut+tokCache)+'</div>';
      h+='<div class="cs-card-meta">输入 '+fmtCN(tokIn)+' · 输出 '+fmtCN(tokOut)+' · 缓存 '+fmtCN(tokCache)+'</div>';
      // 缓存已并入上方 meta 行
      h+='</div>';
    }
  }
  displayTotal=slotTotalUsd+nonSlotTotalUsd;
  h=h.replace('<div class="cs-list">','<div class="cs-hdr"><div class="cs-title">消费明细</div><div class="cs-card-total"><span class="cs-tl">合计</span><span class="cs-ta">'+dual(displayTotal)+'</span></div></div><div class="cs-list">');
  h+='</div></div>';
  return h;
}
// 官方费用/次数映射（modelSummary 优先，_modelCosts 兑底）
function buildOgCostMaps(){
  var costMap={}, countMap={};
  if(D._subscriptionQuotas){for(var oi=0;oi<D._subscriptionQuotas.length;oi++){var ogq=D._subscriptionQuotas[oi];if(ogq&&ogq.modelSummary){for(var oj=0;oj<ogq.modelSummary.length;oj++){var msm=ogq.modelSummary[oj];if(msm&&msm.model){costMap[msm.model]=(msm.costUsd||0);countMap[msm.model]=(msm.count||0);}}}}}
  if(D._modelCosts){for(var mi2=0;mi2<D._modelCosts.length;mi2++){var mmc=D._modelCosts[mi2];if(mmc&&mmc.model&&!costMap[mmc.model])costMap[mmc.model]=mmc.cost||0;}}
  return {costMap:costMap,countMap:countMap};
}
function renderConsumption(){
  var el=$("drawer-cs");if(!el)return;
  var maps=buildOgCostMaps();
  var h=buildConsumptionTable(maps.costMap,maps.countMap);
  if(h){el.innerHTML=h;el.style.display="";}else{el.style.display="none";}
}

var _CV=[];
function renderConversations(){
  _CV=[];
  function mkItem(c){
    _CV.push(c);
    var idx=_CV.length-1;
    var t=c.time?new Date(c.time).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",timeZone:"Asia/Shanghai"}):"";
    var tc=c.toolCalls&&c.toolCalls.length?'<span class="cv-tb">'+c.toolCalls.length+' 次调用</span>':'';
    var s=c.userSnippet||"(空)";
    var tk=fmt(c.totalTokens||0);
    var sp=c.speedAvg?'<span class="cv-tb">均速 '+c.speedAvg+' tok/s</span>':'';
    return '<div class="cv-it" data-cv="'+idx+'"><div class="cv-qt">'+s+tc+sp+'</div><div class="cv-meta">'+(c.agentName||c.agent)+' · '+t+' · '+(c.provider?_pn(c.provider)+' / ':'')+mn(c.model)+' · '+tk+' tok</div></div>';
  }
  function fill(id,arr){
    var el=$(id);if(!el)return;
    if(!arr||!arr.length){el.innerHTML='<div class="cv-empty">此间暂无记录</div>';return;}
    el.innerHTML=arr.map(function(c){return mkItem(c);}).join('');
  }
  fill("ano-list",D.abnormal);
  fill("stream-list",D.stream);
}
function _showSpeed(){
  var ss=D._speedStats; if(!ss)return;
  var b=$("modal-body"); if(!b)return;
  var mt=document.querySelector(".modal-tit"); if(mt)mt.textContent="生成速度";
  var h='<div class="spd-metrics"><span class="spd-unit">tok/s</span>'+
    '<div class="spd-metric"><div class="spd-val accent">'+ss.avgTps+'</div><div class="spd-label">全部均速</div>'+
      '<div class="spd-tip"><div class="spd-tip-t">全部加权均速</div><div class="spd-tip-s">全时段采样加权平均</div></div></div>'+
    '<div class="spd-metric"><div class="spd-val">'+ss.recentTps+'</div><div class="spd-label">最近50次</div>'+
      '<div class="spd-tip"><div class="spd-tip-t">最近 50 次加权</div><div class="spd-tip-s">最近 50 次调用的加权均速</div></div></div>'+
    (ss.hourCount?'<div class="spd-metric"><div class="spd-val">'+ss.hourTps+'</div><div class="spd-label">最近一小时</div>'+
      '<div class="spd-tip"><div class="spd-tip-t">最近一小时</div><div class="spd-tip-s">'+fmtN(ss.hourCount)+' 次调用 · 最近 1 小时内加权均速</div></div></div>':'')+
    (ss.last?'<div class="spd-metric"><div class="spd-val">'+ss.last.tps+'</div><div class="spd-label">最近一次</div>'+
      '<div class="spd-tip"><div class="spd-tip-t">最近一次调用</div><div class="spd-tip-s">'+escHTML(mn(ss.last.model))+' · 最近一次生成速度</div></div></div>':'')+
    '</div>';
  h+='<div class="spd-sec"><span>按供应商</span><span style="font-size:11px;letter-spacing:.06em">共采样 '+fmtN(ss.count)+' 次</span></div>';
  for(var _p=0;_p<ss.providerStats.length;_p++){
    var ps=ss.providerStats[_p];
    h+='<div class="spd-prov">'+
      '<div class="spd-prov-hd"><span class="spd-prov-name">'+escHTML(ps.provider)+'</span>'+
      '<span class="spd-prov-meta">'+fmtN(ps.n)+' 次 · '+ps.tps+' tok/s · 文本 '+ps.textTps+'</span></div>';
    var pms=ps.models||[];
    for(var _q=0;_q<pms.length;_q++){
      var pm=pms[_q];
      h+='<div class="spd-model"><span class="spd-model-name">'+escHTML(mn(pm.model))+'</span>'+
        '<span class="spd-model-n">'+fmtN(pm.n)+' 次</span>'+
        '<span class="spd-model-tps">'+pm.tps+' tok/s</span>'+
        '<span class="spd-model-txt">文本 '+pm.textTps+'</span></div>';
    }
    h+='</div>';
  }
  h+='<div class="spd-note">口径：会话 JSONL 相邻消息时间差 + 官方 usage-ledger durationMs 双源采集；耗时含网络与排队，为生成速度下限；文本速度为剔除思考 token 后的纯文本生成速度。</div>';
  b.innerHTML=h;
  var m=$("modal"); if(m)m.style.display="";
}
function _showCv(idx){
  var c=_CV[idx];if(!c)return;
  var b=$("modal-body");if(!b)return;
  var t=c.time?new Date(c.time).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"}):"-";
  var html='<div class="cv-dt"><div class="cv-dt-hdr">'+(c.agentName||c.agent)+' · '+t+' · '+(c.provider?_pn(c.provider)+' / ':'')+mn(c.model)+(c.speedAvg?' · 均速 '+c.speedAvg+' tok/s':'')+'</div>';
  html+='<div class="cv-dt-msg cv-dt-user">'+escHTML(c.userContent||"")+'</div>';
  if(c.steps&&c.steps.length){
    for(var _s=0;_s<c.steps.length;_s++){
      var st=c.steps[_s];
      if(st.t==="th"){
        html+='<div class="cv-step cv-step-th"><div class="cv-step-label">思考</div><div class="cv-step-cnt">'+escHTML(st.c||"")+'</div></div>';
      }else if(st.t==="tc"){
        html+='<div class="cv-step cv-step-tc"><div class="cv-step-label">工具调用</div><div><strong>'+escHTML(st.name||"")+'</strong><pre class="cv-step-code">'+escHTML(JSON.stringify(st.args,null,2))+'</pre></div></div>';
      }else if(st.t==="fm"){
        html+='<div class="cv-step cv-step-fm"><div class="cv-step-label">修改文件</div><div><strong>'+escHTML(st.name||"")+'</strong><pre class="cv-step-code">'+escHTML(JSON.stringify(st.args,null,2))+'</pre></div></div>';
      }else if(st.t==="tx"){
        html+='<div class="cv-step cv-step-tx"><div class="cv-step-label">回答</div><div class="cv-step-cnt">'+escHTML(st.c||"")+'</div></div>';
      }
    }
  }else if(c.toolCalls&&c.toolCalls.length){
    for(var _j=0;_j<c.toolCalls.length;_j++){
      var tc=c.toolCalls[_j];
      html+='<div class="cv-step cv-step-tc"><div class="cv-step-label">工具调用</div><div><strong>'+escHTML(tc.name||"")+'</strong><pre class="cv-step-code">'+escHTML(JSON.stringify(tc.args,null,2))+'</pre></div></div>';
    }
  }
  if(c.speeds&&c.speeds.length){
    html+='<div class="cv-step cv-step-tx"><div class="cv-step-label">生成速度 · 最近 '+c.speeds.length+' 次调用</div><div style="font-family:var(--font-mono,monospace);font-size:0.78rem;line-height:1.7">'+
      c.speeds.slice().reverse().map(function(sp){
        var tt=sp.ts?new Date(sp.ts).toLocaleTimeString("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit",timeZone:"Asia/Shanghai"}):"";
        return '<div style="display:flex;gap:10px;justify-content:space-between"><span>'+tt+'</span><span>'+fmt(sp.out)+' tok</span><span>'+sp.tps+' tok/s</span><span style="opacity:.65">文本 '+sp.textTps+'</span></div>';
      }).join('')+'</div></div>';
  }
  html+='<div class="cv-dt-sum">总消耗 '+fmt(c.totalTokens||0)+' tokens · '+(c.msgCount||0)+' 条消息</div></div>';
  b.innerHTML=html;
  var m=$("modal");if(m)m.style.display="";
}
function escHTML(s){if(!s)return'';return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}

$("rf").onclick = refresh;
(function(){
  var btn=$("st-btn"),panel=$("set-panel"),shade=$("set-shade"),close=$("set-close"),save=$("set-save");
  function getProvidersFromData(){
    var seen={},list=[];
    if(_allProviders){for(var i=0;i<_allProviders.length;i++){var p=_allProviders[i].provider;if(!seen[p]){seen[p]=true;list.push(p);}}}
    return list;
  }
  function openSet(){
    _dispCur = getDispCur();
    syncThemeUI(document.body.getAttribute("data-theme")==="dark"?"dark":"light", getThemeMode());
    var balApis=D&&D._balanceApis?D._balanceApis:{};
    var bhtml='';
    var balKeys=Object.keys(balApis);
    if(balKeys.length){
      for(var i=0;i<balKeys.length;i++){
        var p=balKeys[i];
        var api=balApis[p]||{url:""};
        bhtml+='<div class="set-ba-row"><span class="set-ba-key">'+escHTML(p)+'</span>';
        if(api.responseType==="opencode-go"){
          bhtml+='<div class="set-og-fields">'+
            '<input class="set-ba-inp" data-field="workspaceId" placeholder="workspace id（wrk_...，或粘贴完整 URL）" value="'+escHTML(api.workspaceId||"")+'">'+
            '<input class="set-ba-inp" data-field="cookie" placeholder="auth cookie 值（仅 Fe26.2 开头那串，不要带文字说明）" value="'+escHTML(api.cookie||"")+'">'+
            '<div class="set-og-hint">获取：DevTools → Application → Cookies → opencode.ai → auth 的值。只复制 Fe26.2**… 这段，不要带“auth=”“opencode cookie:”等前缀（粘贴了也会自动清洗）。cookie 会过期，过期后订阅余量会退回“本地估算”。</div>'+
            '<label class="tg og-tg"><input type="checkbox" data-field="enabled"'+(api.enabled?" checked":"")+'><span class="tg-slider"></span><span class="tg-label">启用</span></label>'+
            '</div>';
        }else if(api.responseType==="sensenova-iam"){
          bhtml+='<div class="set-og-fields">'+
            '<input class="set-ba-inp" data-field="username" placeholder="商汤平台账号（用户名）" value="'+escHTML(api.username||"")+'">'+
            '<input class="set-ba-inp" data-field="password" type="password" placeholder="密码（登录后自动续期，无需手动更新）" value="'+escHTML(api.password||"")+'">'+
            '<input class="set-ba-inp" data-field="token" placeholder="access_token（可选，token-only 模式）" value="'+escHTML(api.token||"")+'">'+
            '<div class="set-og-hint">推荐填账号密码自动登录（token 约 3 小时过期，插件自动续期）；也可只填 access_token（token-only 模式，过期后需重新粘贴，可从浏览器登录 platform.sensenova.cn 后 localStorage 的 access_token 获取）。启用后自动查询 TokenPlan 积分池（通用池 + Flash-Lite 专属池）。</div>'+
            '<label class="tg og-tg"><input type="checkbox" data-field="enabled"'+(api.enabled?" checked":"")+'><span class="tg-slider"></span><span class="tg-label">启用</span></label>'+
            '</div>';
        }else{
          bhtml+='<input class="set-ba-inp" data-prov="'+escHTML(p)+'" data-field="url" placeholder="余额查询URL（留空则不查询）" value="'+escHTML(api.url||"")+'">';
        }
        bhtml+='</div>';
      }
    }else{
      bhtml='<div style="font-size:13px;color:var(--text-tertiary)">暂无配置</div>';
    }
    var el0=$("set-bal-apis");if(el0)el0.innerHTML=bhtml;
    var pt=D&&D._priceTable?D._priceTable:{};
    var priceHtml='';
    priceHtml+='<div class="set-add-row"><input class="set-add-inp" id="set-ak" placeholder="输入 provider/model，如 deepseek/deepseek-chat"><button class="btn" id="set-ak-btn">添加</button></div>';
    priceHtml+='<div class="set-price-hdr"><span class="set-price-col">供应商/模型</span><span class="set-price-col">计费方式</span><span class="set-price-col">价格</span></div>';
    var renderedKeys={};
    function addPriceRow(mk,p2){
      if(renderedKeys[mk])return;
      renderedKeys[mk]=true;
      var dp=p2.defaultPrice||{inputPerM:p2.inputPerM||0,inputCachePerM:p2.inputCachePerM||0,outputPerM:p2.outputPerM||0,cacheWritePerM:p2.cacheWritePerM||0,unit:p2.unit||"token",pricePerCall:p2.pricePerCall||0,pricePer10K:p2.pricePer10K||0};
      var slots=p2.slots||[];
      var tiers=p2.contextTiers||[];
      var ek=escHTML(mk);
      var curSym='$';
      var curTag='美元计费';
      var allowTag=(p2.monthlyAllowance||0)>0?'<span class="set-cur-tag set-allow-tag">额度 $'+(p2.monthlyAllowance||0)+'/月</span>':'';
      priceHtml+='<div class="set-model-card" data-key="'+ek+'"><div class="set-model-hdr"><span>'+ek+'</span>'+allowTag+'<span class="set-cur-tag">'+curTag+'</span><button class="set-model-del" data-key="'+ek+'">✕</button></div>';
      priceHtml+='<div class="set-dflt-label">通用价格（非特殊时段）</div><div class="set-slot-price">';
      var du=dp.unit||"token";
      priceHtml+='<select class="set-dflt-sel" data-key="'+ek+'" data-f="unit"><option value="token"'+(du==="token"?" selected":"")+'>按Token</option><option value="per_call"'+(du==="per_call"?" selected":"")+'>按次</option><option value="per_char"'+(du==="per_char"?" selected":"")+'>按字符</option></select>';
      if(du==="per_call"){
        priceHtml+='<input class="set-price-inp" data-key="'+ek+'" data-f="pricePerCall" type="number" step="0.001" min="0" value="'+(dp.pricePerCall||0)+'" placeholder="'+curSym+'/次">';
      }else if(du==="per_char"){
        priceHtml+='<input class="set-price-inp" data-key="'+ek+'" data-f="pricePer10K" type="number" step="0.01" min="0" value="'+(dp.pricePer10K||0)+'" placeholder="'+curSym+'/万字符">';
      }else{
        priceHtml+='<input class="set-price-inp" data-key="'+ek+'" data-f="inputPerM" type="number" step="0.01" min="0" value="'+(dp.inputPerM||0)+'" placeholder="'+curSym+'/M·输入"><input class="set-price-inp" data-key="'+ek+'" data-f="inputCachePerM" type="number" step="0.01" min="0" value="'+(dp.inputCachePerM||0)+'" placeholder="'+curSym+'/M·缓存"><input class="set-price-inp" data-key="'+ek+'" data-f="outputPerM" type="number" step="0.01" min="0" value="'+(dp.outputPerM||0)+'" placeholder="'+curSym+'/M·输出"><input class="set-price-inp" data-key="'+ek+'" data-f="cacheWritePerM" type="number" step="0.01" min="0" value="'+(dp.cacheWritePerM||0)+'" placeholder="'+curSym+'/M·缓存写">';
      }
      priceHtml+='</div>';
      // 长上下文档位（官方分档价，如 Luna >272K、Qwen >256K）
      if(tiers.length>0){
        priceHtml+='<div class="set-slots-label">长上下文档位（单次输入超过阈值用该档）</div>';
        for(var ti=0;ti<tiers.length;ti++){
          var tier=tiers[ti];
          var tp=tier.price||{};
          priceHtml+='<div class="set-slot set-tier"><div class="set-slot-time"><span class="set-ti-sep">输入 &gt;</span><input class="set-ti set-ti-max" data-key="'+ek+'" data-f="maxContext" type="number" step="1000" min="0" value="'+(tier.maxContext||0)+'" placeholder="阈值"><span class="set-ti-sep">tokens</span><button class="set-slot-del" data-key="'+ek+'" data-tier="'+ti+'">✕</button></div><div class="set-slot-price">';
          priceHtml+='<input class="set-price-inp" data-key="'+ek+'" data-f="inputPerM" type="number" step="0.01" min="0" value="'+(tp.inputPerM||0)+'" placeholder="'+curSym+'/M·输入"><input class="set-price-inp" data-key="'+ek+'" data-f="inputCachePerM" type="number" step="0.01" min="0" value="'+(tp.inputCachePerM||0)+'" placeholder="'+curSym+'/M·缓存"><input class="set-price-inp" data-key="'+ek+'" data-f="outputPerM" type="number" step="0.01" min="0" value="'+(tp.outputPerM||0)+'" placeholder="'+curSym+'/M·输出"><input class="set-price-inp" data-key="'+ek+'" data-f="cacheWritePerM" type="number" step="0.01" min="0" value="'+(tp.cacheWritePerM||0)+'" placeholder="'+curSym+'/M·缓存写">';
          priceHtml+='</div></div>';
        }
        priceHtml+='<button class="set-slot-add set-tier-add" data-key="'+ek+'">+ 添加长上下文档位</button>';
      }
      if(slots.length>0){
        priceHtml+='<div class="set-slots-label">特殊时间段</div>';
        for(var si=0;si<slots.length;si++){
          var s=slots[si];
          var u=s.unit||du||"token";
          priceHtml+='<div class="set-slot"><div class="set-slot-time"><button class="set-ti-btn" data-key="'+ek+'" data-si="'+si+'" data-f="from" data-d="-30">−</button><input class="set-ti" data-key="'+ek+'" data-si="'+si+'" data-f="from" value="'+escHTML(s.from||"09:00")+'" placeholder="起始"><button class="set-ti-btn" data-key="'+ek+'" data-si="'+si+'" data-f="from" data-d="30">+</button><span class="set-ti-sep">至</span><button class="set-ti-btn" data-key="'+ek+'" data-si="'+si+'" data-f="to" data-d="-30">−</button><input class="set-ti" data-key="'+ek+'" data-si="'+si+'" data-f="to" value="'+escHTML(s.to||"18:00")+'" placeholder="结束"><button class="set-ti-btn" data-key="'+ek+'" data-si="'+si+'" data-f="to" data-d="30">+</button><button class="set-slot-del" data-key="'+ek+'" data-si="'+si+'">✕</button></div><div class="set-slot-price">';
          priceHtml+='<select class="set-price-sel" data-key="'+ek+'" data-si="'+si+'" data-f="unit"><option value="token"'+(u==="token"?" selected":"")+'>按Token</option><option value="per_call"'+(u==="per_call"?" selected":"")+'>按次</option><option value="per_char"'+(u==="per_char"?" selected":"")+'>按字符</option></select>';
          if(u==="per_call"){
            priceHtml+='<input class="set-price-inp" data-key="'+ek+'" data-si="'+si+'" data-f="pricePerCall" type="number" step="0.001" min="0" value="'+(s.pricePerCall||0)+'" placeholder="'+curSym+'/次">';
          }else if(u==="per_char"){
            priceHtml+='<input class="set-price-inp" data-key="'+ek+'" data-si="'+si+'" data-f="pricePer10K" type="number" step="0.01" min="0" value="'+(s.pricePer10K||0)+'" placeholder="'+curSym+'/万字符">';
          }else{
            priceHtml+='<input class="set-price-inp" data-key="'+ek+'" data-si="'+si+'" data-f="inputPerM" type="number" step="0.01" min="0" value="'+(s.inputPerM||0)+'" placeholder="'+curSym+'/M·输入"><input class="set-price-inp" data-key="'+ek+'" data-si="'+si+'" data-f="inputCachePerM" type="number" step="0.01" min="0" value="'+(s.inputCachePerM||0)+'" placeholder="'+curSym+'/M·缓存"><input class="set-price-inp" data-key="'+ek+'" data-si="'+si+'" data-f="outputPerM" type="number" step="0.01" min="0" value="'+(s.outputPerM||0)+'" placeholder="'+curSym+'/M·输出"><input class="set-price-inp" data-key="'+ek+'" data-si="'+si+'" data-f="cacheWritePerM" type="number" step="0.01" min="0" value="'+(s.cacheWritePerM||0)+'" placeholder="'+curSym+'/M·缓存写">';
          }
          priceHtml+='</div></div>';
        }
      }
      priceHtml+='<button class="set-slot-add" data-key="'+ek+'">+ 添加特殊时间段</button></div>';
    }
    var ptKeys=Object.keys(pt);
    if(ptKeys.length){
      for(var i=0;i<ptKeys.length;i++)addPriceRow(ptKeys[i],pt[ptKeys[i]]);
    }else{
      priceHtml+='<div class="set-empty">暂无配置，在上方输入模型名后点击添加</div>';
    }
    var el3=$("set-prices");if(el3)el3.innerHTML=priceHtml;
    // 显示偏好（趋势图提示 / 隐藏余额）
    var _tipModeEl=$("set-tooltip-mode");
    if(_tipModeEl)_tipModeEl.value=(function(){try{return localStorage.getItem("tt-tooltip-mode")||"all";}catch(e){return "all";}})();
    var _hideBalEl=$("set-hide-balance");
    if(_hideBalEl)_hideBalEl.checked=(function(){try{return localStorage.getItem("tt-hide-balance")!=="0";}catch(e){return true;}})();
    if(shade)shade.style.display="";
    if(panel)panel.style.display="";
  }
  function closeSet(){
    if(shade)shade.style.display="none";
    if(panel)panel.style.display="none";
  }
   function saveSettings(){
    var saveBtn = $("set-save");
    if(saveBtn){saveBtn.textContent="保存中...";saveBtn.disabled=true;}

    var baRows=document.querySelectorAll(".set-ba-row");
    var balApis={};
    var oldApis=(D&&D._balanceApis)?D._balanceApis:{};
    for(var i=0;i<baRows.length;i++){
      var row=baRows[i];
      var prov=row.querySelector(".set-ba-key").textContent;
      var urlInp=row.querySelector('input[data-field="url"]');
      var wsInp=row.querySelector('input[data-field="workspaceId"]');
      var ckInp=row.querySelector('input[data-field="cookie"]');
      var usInp=row.querySelector('input[data-field="username"]');
      var pwInp=row.querySelector('input[data-field="password"]');
      var tkInp=row.querySelector('input[data-field="token"]');
      var enChk=row.querySelector('input[data-field="enabled"]');
      var merged=Object.assign({},oldApis[prov]||{});
      var has=false;
      if(urlInp&&urlInp.value.trim()){merged.url=urlInp.value.trim();has=true;}
      if(wsInp){merged.workspaceId=wsInp.value.trim();has=has||!!merged.workspaceId;}
      if(ckInp){merged.cookie=ckInp.value.trim();has=has||!!merged.cookie;}
      if(usInp){merged.username=usInp.value.trim();has=has||!!merged.username;}
      if(pwInp){merged.password=pwInp.value.trim();has=has||!!merged.password;}
      if(tkInp){merged.token=tkInp.value.trim();has=has||!!merged.token;}
      if(enChk){merged.enabled=enChk.checked;has=true;}
      // opencode-go 保存时自动清洗：cookie 去掉 "opencode cookie:" 之类的说明前缀，
      // workspaceId 若是完整 URL 则提取 wrk_ 段，避免配置者粘贴带说明文字导致官方请求被 302 踢回登录
      if(prov==="opencode-go"){
        if(merged.cookie)merged.cookie=String(merged.cookie).replace(/^(opencode\s+cookie\s*[:：]?\s*|cookie\s*[:：]?\s*)/i,"").trim();
        if(merged.workspaceId&&/^https?:\/\//i.test(merged.workspaceId)){
          merged.workspaceId=merged.workspaceId.replace(/^https?:\/\/opencode\.ai\/workspace\//i,"").replace(/\/go$/,"");
        }
      }
      if(has)balApis[prov]=merged;
    }
    var _base = window.location.pathname.replace(/\/dashboard.*$/,"");
    var _qs = window.location.search || "";

    var p1 = fetch(_base+"/balance-apis"+_qs,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(balApis)
    });

    var prices={};
    var cards=document.querySelectorAll(".set-model-card");
    for(var i=0;i<cards.length;i++){
      var card=cards[i];
      var key=card.dataset.key;
      if(!key)continue;
      var defaultPrice={};
      var dfltSel=card.querySelector(".set-dflt-sel");
      if(dfltSel)defaultPrice.unit=dfltSel.value;
      var priceWraps=card.querySelectorAll(".set-slot-price");
      if(priceWraps.length>0){
        var inps=priceWraps[0].querySelectorAll(".set-price-inp");
        for(var k=0;k<inps.length;k++){
          var inp=inps[k];
          var fld=inp.dataset.f;
          if(fld)defaultPrice[fld]=parseFloat(inp.value)||0;
        }
      }
      var slots=[];
      var slotEls=card.querySelectorAll(".set-slot");
      for(var j=0;j<slotEls.length;j++){
        var se=slotEls[j];
        // 长上下文档位（.set-tier）不是特殊时段，跳过
        if(se.classList.contains("set-tier"))continue;
        var from=se.querySelector('input[data-f="from"]')?.value||"09:00";
        var to=se.querySelector('input[data-f="to"]')?.value||"18:00";
        var unit=se.querySelector('.set-price-sel[data-f="unit"]')?.value||"token";
        var slot={from:from,to:to,unit:unit};
        var inps=se.querySelectorAll(".set-price-inp");
        for(var k=0;k<inps.length;k++){
          var inp=inps[k];
          var fld=inp.dataset.f;
          if(fld)slot[fld]=parseFloat(inp.value)||0;
        }
        slots.push(slot);
      }
      // 长上下文档位（官方分档价）
      var tiers=[];
      var tierEls=card.querySelectorAll(".set-tier");
      for(var ti=0;ti<tierEls.length;ti++){
        var te=tierEls[ti];
        var maxC=parseInt(te.querySelector('input[data-f="maxContext"]')?.value,10)||0;
        if(!maxC)continue;
        var tprice={unit:"token"};
        var tinps=te.querySelectorAll(".set-price-inp");
        for(var tk=0;tk<tinps.length;tk++){
          var tfd=tinps[tk].dataset.f;
          if(tfd)tprice[tfd]=parseFloat(tinps[tk].value)||0;
        }
        tiers.push({maxContext:maxC,price:tprice});
      }
      var entry={currency:'USD', defaultPrice:defaultPrice};
      if(slots.length)entry.slots=slots;
      if(tiers.length)entry.contextTiers=tiers;
      // 保留每月额度（设置面板只读展示，保存时不丢失）
      var oldPt=(D&&D._priceTable)||{};
      if(oldPt[key]&&oldPt[key].monthlyAllowance)entry.monthlyAllowance=oldPt[key].monthlyAllowance;
      prices[key]=entry;
    }

    var p2 = fetch(_base+"/price-table"+_qs,{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(prices)
    });

    // 显示偏好（趋势图提示 / 隐藏余额）
    try{
      var _tipModeEl=$("set-tooltip-mode");
      if(_tipModeEl)localStorage.setItem("tt-tooltip-mode",_tipModeEl.value);
      var _hideBalEl=$("set-hide-balance");
      if(_hideBalEl)localStorage.setItem("tt-hide-balance",_hideBalEl.checked?"1":"0");
    }catch(e){}

    Promise.all([p1, p2]).then(function(){
      if(saveBtn){saveBtn.textContent="保存成功";saveBtn.disabled=false;}
      refresh();
      setTimeout(closeSet, 1500);
    }).catch(function(e){
      console.error("[token-tracker] 保存失败:", e);
      if(saveBtn){saveBtn.textContent="保存失败";saveBtn.disabled=false;}
      setTimeout(function(){if(saveBtn)saveBtn.textContent="保存";}, 2000);
    });
  }
  // 暴露函数到全局，并改用事件委托确保稳定
  window.__tokenTrackerOpenSet = openSet;
  window.__tokenTrackerCloseSet = closeSet;
  window.__tokenTrackerSaveSettings = saveSettings;
})();

  // 用事件委托：监听整个 document 的点击，匹配目标 ID
  document.addEventListener("click", function(e){
    var t = e.target.closest("#st-btn, #set-close, #set-save, #set-shade, #set-ak-btn, #th-btn, #cur-btn");
    if(t){
      if(t.id==="st-btn"){ window.__tokenTrackerOpenSet && window.__tokenTrackerOpenSet(); }
      else if(t.id==="cur-btn"){ toggleCur(); }
      else if(t.id==="th-btn"){ toggleTheme(); }
      else if(t.id==="set-close" || t.id==="set-shade"){ window.__tokenTrackerCloseSet && window.__tokenTrackerCloseSet(); }
      else if(t.id==="set-save"){ window.__tokenTrackerSaveSettings && window.__tokenTrackerSaveSettings(); }
      else if(t.id==="set-ak-btn"){
        var inp=$("set-ak");if(!inp||!inp.value.trim())return;
        var mk=inp.value.trim();
        var pricesEl=$("set-prices");
        if(!pricesEl)return;
        if(pricesEl.querySelector('.set-model-card[data-key="'+escHTML(mk)+'"]')){inp.value="";return;}
        var ekey=escHTML(mk);var curSym='$';
        var curTag2='美元计费';
        var html='<div class="set-model-card" data-key="'+ekey+'"><div class="set-model-hdr"><span>'+ekey+'</span><span class="set-cur-tag">'+curTag2+'</span><button class="set-model-del" data-key="'+ekey+'">✕</button></div><div class="set-dflt-label">通用价格（非特殊时段）</div><div class="set-slot-price"><select class="set-dflt-sel" data-key="'+ekey+'" data-f="unit"><option value="token" selected>按Token</option><option value="per_call">按次</option><option value="per_char">按字符</option></select><input class="set-price-inp" data-key="'+ekey+'" data-f="inputPerM" type="number" step="0.01" min="0" value="0" placeholder="'+curSym+'/M·输入"><input class="set-price-inp" data-key="'+ekey+'" data-f="inputCachePerM" type="number" step="0.01" min="0" value="0" placeholder="'+curSym+'/M·缓存"><input class="set-price-inp" data-key="'+ekey+'" data-f="outputPerM" type="number" step="0.01" min="0" value="0" placeholder="'+curSym+'/M·输出"><input class="set-price-inp" data-key="'+ekey+'" data-f="cacheWritePerM" type="number" step="0.01" min="0" value="0" placeholder="'+curSym+'/M·缓存写"></div><button class="set-slot-add" data-key="'+ekey+'">+ 添加特殊时间段</button><button class="set-slot-add set-tier-add" data-key="'+ekey+'">+ 添加长上下文档位</button></div>';
        pricesEl.insertAdjacentHTML("beforeend",html);
        inp.value="";
      }
      return;
    }
    var topt=e.target.closest(".set-theme-opt");
    if(topt){
      setThemeMode(topt.dataset.v || "auto");
      syncHanaTheme();
      if(D)render();
      return;
    }
    var md=e.target.closest(".set-model-del");
    if(md){
      var card=md.closest(".set-model-card");
      if(card)card.remove();
      return;
    }
    var sa=e.target.closest(".set-slot-add");
    if(sa){
      // 长上下文档位添加
      if(sa.classList.contains("set-tier-add")){
        try{
          var card2=sa.closest(".set-model-card");
          if(!card2)return;
          var mk2=card2.dataset.key;
          if(!mk2)return;
          var ekey2=escHTML(mk2);var curSym2='$';
          var html2='<div class="set-slot set-tier"><div class="set-slot-time"><span class="set-ti-sep">输入 &gt;</span><input class="set-ti set-ti-max" data-key="'+ekey2+'" data-f="maxContext" type="number" step="1000" min="0" value="0" placeholder="阈值"><span class="set-ti-sep">tokens</span><button class="set-slot-del" data-key="'+ekey2+'">✕</button></div><div class="set-slot-price"><input class="set-price-inp" data-key="'+ekey2+'" data-f="inputPerM" type="number" step="0.01" min="0" value="0" placeholder="'+curSym2+'/M·输入"><input class="set-price-inp" data-key="'+ekey2+'" data-f="inputCachePerM" type="number" step="0.01" min="0" value="0" placeholder="'+curSym2+'/M·缓存"><input class="set-price-inp" data-key="'+ekey2+'" data-f="outputPerM" type="number" step="0.01" min="0" value="0" placeholder="'+curSym2+'/M·输出"><input class="set-price-inp" data-key="'+ekey2+'" data-f="cacheWritePerM" type="number" step="0.01" min="0" value="0" placeholder="'+curSym2+'/M·缓存写"></div></div>';
          sa.insertAdjacentHTML("beforebegin",html2);
        }catch(e){console.error("[tt] add-tier error:",e);}
        return;
      }
      try{
        var card=sa.closest(".set-model-card");
        if(!card){console.error("[tt] add-slot: no card");return;}
        var mk=card.dataset.key;
        if(!mk){console.error("[tt] add-slot: no key");return;}
        var slots=card.querySelectorAll(".set-slot");
        var si=slots.length;
        var ekey=escHTML(mk);var curSym='$';
        var html='<div class="set-slot"><div class="set-slot-time"><input class="set-ti" data-key="'+ekey+'" data-si="'+si+'" data-f="from" value="00:00" placeholder="起始"><span class="set-ti-sep">至</span><input class="set-ti" data-key="'+ekey+'" data-si="'+si+'" data-f="to" value="24:00" placeholder="结束"><button class="set-slot-del" data-key="'+ekey+'" data-si="'+si+'">✕</button></div><div class="set-slot-price"><select class="set-price-sel" data-key="'+ekey+'" data-si="'+si+'" data-f="unit"><option value="token" selected>按Token</option><option value="per_call">按次</option><option value="per_char">按字符</option></select><input class="set-price-inp" data-key="'+ekey+'" data-si="'+si+'" data-f="inputPerM" type="number" step="0.01" min="0" value="0" placeholder="'+curSym+'/M·输入"><input class="set-price-inp" data-key="'+ekey+'" data-si="'+si+'" data-f="inputCachePerM" type="number" step="0.01" min="0" value="0" placeholder="'+curSym+'/M·缓存"><input class="set-price-inp" data-key="'+ekey+'" data-si="'+si+'" data-f="outputPerM" type="number" step="0.01" min="0" value="0" placeholder="'+curSym+'/M·输出"><input class="set-price-inp" data-key="'+ekey+'" data-si="'+si+'" data-f="cacheWritePerM" type="number" step="0.01" min="0" value="0" placeholder="'+curSym+'/M·缓存写"></div></div>';
        sa.insertAdjacentHTML("beforebegin",html);
      }catch(e){console.error("[tt] add-slot error:",e);}
      return;
    }
    var sd=e.target.closest(".set-slot-del");
    if(sd){
      var slot=sd.closest(".set-slot");
      if(slot)slot.remove();
      return;
    }
    var tb=e.target.closest(".set-ti-btn");
    if(tb){
      var inp=tb.parentElement.querySelector('input[data-f="'+tb.dataset.f+'"]');
      if(inp){
        var parts=inp.value.split(":").map(Number);
        if(parts.length===2&&!isNaN(parts[0])&&!isNaN(parts[1])){
          var total=parts[0]*60+parts[1]+parseInt(tb.dataset.d);
          if(total<0)total=0;
          if(total>=1440)total=1430;
          var hh=String(Math.floor(total/60)).padStart(2,"0");
          var mm=String(Math.floor(total%60/30)*30).padStart(2,"0");
          inp.value=hh+":"+mm;
        }
      }
      return;
    }
  });
document.querySelectorAll(".fb").forEach(b => {
  b.onclick = function() { R = this.dataset.r; document.querySelectorAll(".fb").forEach(x => x.classList.toggle("act", x.dataset.r === R)); _selAgent=""; _selModel=""; _selProvider=""; syncDateInputs(); load(); };
});

// ── 右侧抽屉：订阅余量与消费明细（点头部订阅余量卡片打开，独立时间选择，不受主区查询条件影响）──
var DDrawer=null, DDrawerRange="all";
var DRAWER_RANGES=[["all","全部"],["year","今年"],["month","本月"],["week","本周"],["yesterday","昨日"],["today","今日"]];
function renderDrawerTimes(){
  var c=$("drawer-times");if(!c)return;
  var h="";
  for(var i=0;i<DRAWER_RANGES.length;i++){
    var r=DRAWER_RANGES[i];
    h+='<button class="dr-tm'+(DDrawerRange===r[0]?" act":"")+'" data-dr="'+r[0]+'">'+r[1]+'</button>';
  }
  c.innerHTML=h;
  var btns=c.querySelectorAll(".dr-tm");
  for(var i=0;i<btns.length;i++){
    btns[i].onclick=function(){DDrawerRange=this.dataset.dr;renderDrawerTimes();refreshDrawer(DDrawerRange);};
  }
}
function refreshDrawer(range){
  var qs=window.location.search;
  var sep=qs?"&":"?";
  fetch(window.location.pathname+"/data"+qs+sep+"range="+encodeURIComponent(range)).then(function(r){return r.json();}).then(function(d){
    if(!d||d.error)return;
    DDrawer=d;
    renderDrawer();
  }).catch(function(){});
}
function renderDrawer(){
  if(!DDrawer)return;
  var savedD=D;
  D=DDrawer;
  try{
    renderSubscriptionQuotas();
    renderConsumption();
  }catch(e){}
  D=savedD;
}
function openDrawer(){
  var sh=$("drawer-shade"),dr=$("drawer");
  if(!dr)return;
  if(!DDrawer)DDrawerRange="all";
  if(sh)sh.style.display="";
  dr.classList.add("open");
  document.body.classList.add("drawer-lock");
  renderDrawerTimes();
  refreshDrawer(DDrawerRange);
}
function closeDrawer(){
  var sh=$("drawer-shade"),dr=$("drawer");
  if(!dr)return;
  dr.classList.remove("open");
  if(sh)sh.style.display="none";
  document.body.classList.remove("drawer-lock");
}
(function(){
  var dsh=$("drawer-shade");if(dsh)dsh.onclick=closeDrawer;
  var dcl=$("drawer-close");if(dcl)dcl.onclick=closeDrawer;
  document.addEventListener("keydown",function(e){if(e.key==="Escape")closeDrawer();});
})();
// ── 侧边栏余量查询导航按钮：OpenCodeGo → 打开订阅余量抽屉；商汤待接入 ──
(function(){
  var og=$("btn-og-quota");
  if(og){og.onclick=function(){openDrawer();};
    og.title="打开订阅余量与消费明细";}
  var sn=$("btn-sensenova-quota");
  if(sn){sn.onclick=function(){openDrawer();};
    sn.title="商汤余量查询（自动登录）";}
})();

(function(){
  function sel(n,id,name){
    if(name==="stype"){
      _selType=id;
      var tx=$("stype")?.querySelector(".cs-txt");
      if(tx){if(id==="")tx.textContent="类型";else tx.textContent=id==="desktop"?"聊天":"频道";}
      load();return;
    }
    if(name==="sp"){
      _selProvider=id;
      _selModel="";
      load();return;
    }
    if(name==="sb-picker"){
      _selBalance=id;
      renderBalance();
      return;
    }
    _selAgent=name==="sa"?id:_selAgent;
    _selModel=name==="sm"?id:_selModel;
    load();
  }
  document.addEventListener("click",function(e){
    var cs=e.target.closest(".cs");
    document.querySelectorAll(".cs.open").forEach(function(c){if(c!==cs)c.classList.remove("open")});
    if(!cs)return;
    e.stopPropagation();
    cs.classList.toggle("open");
    var opt=e.target.closest(".cs-opt");
    if(opt){
      cs.classList.remove("open");
      var v=opt.dataset.v||"",t=opt.textContent;
      cs.querySelector(".cs-txt").textContent=t;
      sel(t,v,cs.id);
    }
  });
})();

(function(){
  var cal=document.createElement("div");
  cal.className="cal";
  document.body.appendChild(cal);
  var curInp=null, curY=0, curM=0;
  var today=new Date();
  var tY=today.getFullYear(),tM=today.getMonth(),tD=today.getDate();

  function build(y,m){
    var d=new Date(y,m,1);
    var start=d.getDay();
    var days=new Date(y,m+1,0).getDate();
    var h='<div class="cal-hd"><button data-a="prev">◀</button><span>'+y+'年'+(m+1)+'月</span><button data-a="next">▶</button></div>';
    h+='<div class="cal-grid"><div class="wk">日</div><div class="wk">一</div><div class="wk">二</div><div class="wk">三</div><div class="wk">四</div><div class="wk">五</div><div class="wk">六</div>';
    for(var i=0;i<start;i++) h+='<div class="dim"></div>';
    for(var d=1;d<=days;d++){
      var cls=(y===tY&&m===tM&&d===tD)?' class="today"':'';
      h+='<div'+cls+' data-d="'+d+'">'+d+'</div>';
    }
    h+='</div>';
    cal.innerHTML=h;
    cal.querySelector('[data-a=prev]').onclick=function(e){e.stopPropagation();curM--;if(curM<0){curM=11;curY--;}build(curY,curM);};
    cal.querySelector('[data-a=next]').onclick=function(e){e.stopPropagation();curM++;if(curM>11){curM=0;curY++;}build(curY,curM);};
    cal.querySelectorAll('[data-d]').forEach(function(el){
      el.onclick=function(e){
        e.stopPropagation();
        var dd=String(this.dataset.d).padStart(2,'0');
        var mm=String(curM+1).padStart(2,'0');
        curInp.value=curY+'-'+mm+'-'+dd;
        var df=$("df"),dt=$("dt");
        if(df&&dt&&df.value&&dt.value){
          if(df.value>dt.value){var t=df.value;df.value=dt.value;dt.value=t;}
          cal.classList.remove('on');curInp=null;
          document.querySelectorAll(".fb").forEach(function(x){x.classList.toggle("act",false)});
          R=""; load();
          return;
        }
        cal.classList.remove('on');
        curInp=null;
      };
    });
  }

  function show(inp){
    curInp=inp;
    var v=inp.value||'';
    var p=v.match(/^(\d{4})-(\d{2})/);
    curY=p?parseInt(p[1]):tY; curM=p?parseInt(p[2])-1:tM;
    build(curY,curM);
    var r=inp.getBoundingClientRect();
    cal.style.top=(r.bottom+8)+'px';
    cal.style.left=r.left+'px';
    cal.classList.add('on');
  }

  document.addEventListener('click',function(e){
    if(cal.classList.contains('on')&&!cal.contains(e.target)&&e.target!==curInp) cal.classList.remove('on');
  });

  setTimeout(function(){
    var df=$("df"),dt=$("dt");
    if(df)df.addEventListener("click",function(e){e.stopPropagation();show(this);});
    if(dt)dt.addEventListener("click",function(e){e.stopPropagation();show(this);});
  },200);
})();

(function(){document.addEventListener("click",function(e){
  var sc=e.target.closest("#speed-card");if(sc){_showSpeed();return;}
  var it=e.target.closest(".cv-it");if(it){_showCv(parseInt(it.dataset.cv));}
  var mb=e.target.closest(".modal-bg");if(mb){var m=$("modal");if(m)m.style.display="none";}
  if(e.target.id==="uh"){
    var u=$("uh");if(!u)return;
    var t=u.getBoundingClientRect();
    var d=$("uh-tip");
    if(d){d.remove();return;}
    d=document.createElement("div");
    d.id="uh-tip";
    d.style.cssText="position:fixed;top:"+(t.bottom+6)+"px;right:"+(document.body.clientWidth-t.right)+"px;background:var(--bg-card);border:1px solid var(--card-border);border-radius:8px;padding:8px 12px;font-size:11px;color:var(--text-secondary);box-shadow:var(--shadow-lg);z-index:300;white-space:nowrap;";
    d.innerHTML="1k = 1,000 &nbsp;·&nbsp; 1M = 1,000,000 &nbsp;·&nbsp; 1亿 = 100,000,000";
    document.body.appendChild(d);
    setTimeout(function(){if(d.parentNode)d.remove();},3000);
  }
});})();

syncHanaTheme();
_dispCur = getDispCur();
syncCurBtn();
new MutationObserver(function(ms){
  for(var i=0;i<ms.length;i++){
    if(ms[i].attributeName==="data-hana-theme"){syncHanaTheme();if(D)render();}
  }
}).observe(document.body,{attributes:true,attributeFilter:["data-hana-theme"]});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change",function(){
  var ht=document.body.getAttribute("data-hana-theme")||"warm-paper";
  if(ht==="inherit"||ht==="system"){syncHanaTheme();if(D)render();}
});
document.addEventListener("change",function(e){
  if(e.target.id==="sd-chk"){
    _showDeleted=e.target.checked;
    if(D){updateFilterOpts();renderAgent();}
  }
});

// ── 订阅余量自动刷新：轻量拉取，只更新余量仪表，不重建图表（后端 5 分钟缓存天然节流） ──
function refreshQuota() {
  if (!D) return;
  const qs = window.location.search;
  const sep = qs ? '&' : '?';
  var p = "range=" + R + ($("df") && $("df").value ? "&from=" + $("df").value : "") + ($("dt") && $("dt").value ? "&to=" + $("dt").value : "");
  fetch(window.location.pathname + "/data" + qs + sep + p)
    .then(function(r){ if(!r.ok) throw Error(r.statusText); return r.json(); })
    .then(function(d){
      if (!d || d.error || !D) return;
      var nq = d._subscriptionQuotas || [];
      var oq = D._subscriptionQuotas || [];
      if (JSON.stringify(nq) === JSON.stringify(oq)) return;
      D._subscriptionQuotas = nq;
      renderHdrQuota();
      renderSubscriptionQuotas();
    })
    .catch(function(){});
}
setInterval(function(){ refreshQuota(); }, 60000);
document.addEventListener("visibilitychange", function(){
  if (!document.hidden) refreshQuota();
});

load(false);
})();
