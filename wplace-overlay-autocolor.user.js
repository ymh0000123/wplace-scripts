// ==UserScript==
// @name         Wplace Overlay 自动选色
// @name:en      Wplace Overlay Auto Color
// @namespace    https://wplace.live/
// @version      2.7.3
// @description  在 wplace.live 打开覆盖图(Overlay)作画时，鼠标所指的覆盖图像素自动匹配官方调色板并选中对应颜色（悬停即换 / 点击换色两种模式）。参照层自动贴合官方覆盖图：劫持官方渲染 uniform 用官方矩阵重放屏幕几何，缩放/拖动全程像素级跟随，无需手动定位。「对齐校准」：别人已把图案画在画布上时，hook 官方地图瓦片像素与模板逐像素比对，自动算出位置偏移并平移参照层预览，一键写入官方模板 bounds（刷新后官方覆盖图精确对齐已画内容），同时统计已画对/画错/未画并叠加高亮，取色时直接给出改正颜色。校准命中后自动识别画手的颜色风格：逐组合实测官方颜色设置（色板×颜色模式×抖动）下模板渲染与已画内容的精确吻合率，自动切到最吻合的组合，让后续补画与已有画风一致。「🖌 补画」：框选任意范围自动把模板要求的颜色画进官方草稿——按官方绘画交互逆向出的安全注入链路（Space+鼠标移动连画，绕开官方的合成事件检测），拟人节奏（随机步幅/间隔/停顿/换色等待），颜料耗尽自动等待恢复后继续，没有库存的颜色自动跳过，画完只进官方草稿，提交永远由你手动点击官方 Paint 按钮。跳过锁定色块（避免 Unlock 弹窗引发地图重排）与当前已选中色块（避免官方 onColorReselect 的 flyTo 导航造成画面飞移）。官方覆盖图停止渲染（退出覆盖模式/隐藏模板）时参照层自动收起，重新显示后自动恢复；状态窗可折叠（Ctrl+Shift+H 随时找回），折叠状态与位置跨刷新记忆；状态窗与地图拖动均已适配移动端触摸（单指拖地图同口径累计视图位移，校准照常可用）。
// @description:en  Auto-matches the overlay pixel under your cursor on wplace.live to the official palette. The reference layer auto-aligns with the official overlay by replaying its render uniforms through the official matrix, tracking zoom/pan pixel-perfectly. "Align & Calibrate": when others already painted the artwork on the canvas, hooks official map tile pixels and compares them with the template to compute the offset — shifts the reference layer for instant preview, writes the official template bounds on demand (refresh to snap the official overlay onto the painted content), and overlays done/wrong/missing status so each color fix is one glance away. After a successful alignment it auto-detects the painter's color style by measuring the template render against the painted pixels across official color settings (palette × color mode × dithering) and switches to the best-matching combo. "🖌 Box Paint": drag-select any region and the script paints the template's required colors into the official draft automatically — using the safe injection path reverse-engineered from the official painting interaction (Space + mouse-move chain painting, bypassing the official synthetic-event detection), with human-like pacing (random strides/pauses/color-switch delays), auto-waiting when charges run out (resumes on its own) and auto-skipping colors that can't be painted (per-color stock depleted); painted pixels only enter the official draft and submission is always a manual click on the official Paint button. Skips locked swatches (their click opens the Unlock paywall dialog, which reflows/resizes the map) and the currently-selected swatch (re-clicking it triggers the official template-build "relocate to color" flyTo, making the map jump around). Auto-hides the reference layer when the official overlay stops rendering (leaving overlay mode / hiding templates) and restores it when rendering resumes; the HUD panel is collapsible (Ctrl+Shift+H to toggle), and its collapsed state and position persist across reloads; both the HUD panel and map panning are touch-ready for mobile (single-finger map drag feeds the same view-delta tracker, calibration works there too).
// @author       you
// @match        https://wplace.live/*
// @run-at       document-start
// @grant        none
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
  'use strict';

  var uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // ---------------- 设置（localStorage 持久化） ----------------
  var SET_KEY = 'wpAC-settings';
  function loadSettings() {
    try {
      var raw = localStorage.getItem(SET_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        return {
          enabled: o.enabled !== false,
          hoverMode: o.hoverMode !== false, // true=悬停即选色；false=仅悬停显示、点击才换色
          showToast: true,                  // 隐藏功能已废弃（@grant none 下无法恢复）：旧残留状态强制作废
          collapsed: !!o.collapsed,         // 状态窗折叠为一行小胶囊
          pos: o.pos && isFinite(o.pos.x) && isFinite(o.pos.y) // 状态窗位置（视口左上角像素；null=默认右下角）
            ? { x: +o.pos.x, y: +o.pos.y } : null,
          overlay: [0, 0.3, 0.5, 0.7].indexOf(o.overlay) >= 0 ? o.overlay : 0.5 // 自绘参照层透明度；0=关
        };
      }
    } catch (e) {}
    return { enabled: true, hoverMode: true, showToast: true, collapsed: false, pos: null, overlay: 0.5 };
  }
  function saveSettings() {
    try { localStorage.setItem(SET_KEY, JSON.stringify(S)); } catch (e) {}
  }
  var S = loadSettings();

  // ---------------- 官方调色板（索引 0 = Transparent，不可选） ----------------
  var PALETTE = [
    ['Transparent', 0, 0, 0],
    ['Black', 0, 0, 0], ['Dark Gray', 60, 60, 60], ['Gray', 120, 120, 120],
    ['Light Gray', 210, 210, 210], ['White', 255, 255, 255],
    ['Deep Red', 96, 0, 24], ['Red', 237, 28, 36], ['Orange', 255, 127, 39],
    ['Gold', 246, 170, 9], ['Yellow', 249, 221, 59], ['Light Yellow', 255, 250, 188],
    ['Dark Green', 14, 185, 104], ['Green', 19, 230, 123], ['Light Green', 135, 255, 94],
    ['Dark Teal', 12, 129, 110], ['Teal', 16, 174, 166], ['Light Teal', 19, 225, 190],
    ['Dark Blue', 40, 80, 158], ['Blue', 64, 147, 228], ['Cyan', 96, 247, 242],
    ['Indigo', 107, 80, 246], ['Light Indigo', 153, 177, 251],
    ['Dark Purple', 120, 12, 153], ['Purple', 170, 56, 185], ['Light Purple', 224, 159, 249],
    ['Dark Pink', 203, 0, 122], ['Pink', 236, 31, 128], ['Light Pink', 243, 141, 169],
    ['Dark Brown', 104, 70, 52], ['Brown', 149, 104, 42], ['Beige', 248, 178, 119],
    ['Medium Gray', 170, 170, 170], ['Dark Red', 165, 14, 30], ['Light Red', 250, 128, 114],
    ['Dark Orange', 228, 92, 26], ['Light Tan', 214, 181, 148],
    ['Dark Goldenrod', 156, 132, 49], ['Goldenrod', 197, 173, 49], ['Light Goldenrod', 232, 212, 95],
    ['Dark Olive', 74, 107, 58], ['Olive', 90, 148, 74], ['Light Olive', 132, 197, 115],
    ['Dark Cyan', 15, 121, 159], ['Light Cyan', 187, 250, 242], ['Light Blue', 125, 199, 255],
    ['Dark Indigo', 77, 49, 184], ['Dark Slate Blue', 74, 66, 132], ['Slate Blue', 122, 113, 196],
    ['Light Slate Blue', 181, 174, 241], ['Light Brown', 219, 164, 99],
    ['Dark Beige', 209, 128, 81], ['Light Beige', 255, 197, 165],
    ['Dark Peach', 155, 82, 73], ['Peach', 209, 128, 120], ['Light Peach', 250, 182, 164],
    ['Dark Tan', 123, 99, 82], ['Tan', 156, 132, 107],
    ['Dark Slate', 51, 57, 65], ['Slate', 109, 117, 141], ['Light Slate', 179, 185, 209],
    ['Dark Stone', 109, 100, 63], ['Stone', 148, 140, 107], ['Light Stone', 205, 197, 158]
  ];

  // ---------------- LAB 最近色（与官方默认 colorMetric=lab 对齐） ----------------
  function rgbToLab(r, g, b) {
    function f(c) { c /= 255; return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92; }
    var R = f(r), G = f(g), B = f(b);
    var x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
    var y = R * 0.2126 + G * 0.7152 + B * 0.0722;
    var z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
    function k(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
    x = k(x); y = k(y); z = k(z);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }
  var PAL_LAB = PALETTE.map(function (c, i) {
    return i === 0 ? null : rgbToLab(c[1], c[2], c[3]);
  });
  function nearestPaletteIdx(r, g, b) {
    var lab = rgbToLab(r, g, b);
    var best = 1, bd = Infinity;
    for (var i = 1; i < PAL_LAB.length; i++) {
      var L = PAL_LAB[i];
      var dr = lab[0] - L[0], dg = lab[1] - L[1], db = lab[2] - L[2];
      var d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ---------------- Web Mercator（MapLibre 默认 tileSize=512，CSS px 世界） ----------------
  function lngToWX(lng, wS) { return (lng + 180) / 360 * wS; }
  function latToWY(lat, wS) {
    var s = Math.sin(lat * Math.PI / 180);
    s = Math.max(-0.99999, Math.min(0.99999, s));
    return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * wS;
  }
  function mx01(lng) { return (lng + 180) / 360; }
  function my01(lat) {
    var s = Math.sin(lat * Math.PI / 180);
    s = Math.max(-0.99999, Math.min(0.99999, s));
    return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  }
  function k2(n) { return 1 << Math.ceil(Math.log(Math.max(1, n)) / Math.LN2); }

  var TILE_BYTES_BUDGET = 96 * 1024 * 1024; // 瓦片像素内存上限

  // ---------------- v2.5.0 画布瓦片校准常量 ----------------
  // 官方 season 配置（逆向 chunk_CL7mF02H.js）：{tileSize:1000, zoom:11}；
  // 世界像素网格 = 1000 × 2^11 = 2048000（官方放置编辑器 zc(): g.tileSize*2**g.tileZoom）。
  // 官方拉取画布像素（Bc()）：`${files}/s${season}/tiles/${x}/${y}.png`，tile(x,y) 覆盖
  // 世界像素 [x*1000,(x+1)*1000)，从西北角 (0,0) 起——与 Mercator [0,1] 线性对应。
  var TILE_PX = 1000, WORLD_PX = 2048000;
  var MAP_BYTES_BUDGET = 96 * 1024 * 1024; // 地图瓦片像素内存上限
  var CALIB_MIN_MATCH = 0.12;              // 低于此匹配率拒绝应用（已画内容不足/未对上）
  // 官方免费色板索引（逆向 rev_templates.js u 数组，= 脚本 PALETTE 索引）
  var FREE_COLOR_IDX = {};
  (function () {
    var u = [7, 8, 9, 12, 15, 18, 19, 21, 23, 24, 26, 27, 30, 31, 34, 39, 42, 43, 45, 48, 50, 52, 54, 55, 57, 59, 62];
    for (var i = 0; i < u.length; i++) FREE_COLOR_IDX[u[i]] = 1;
  })();

  // ---------------- 运行状态 ----------------
  var ST = {
    templates: [],     // 模板元数据（order 降序，预计算 Mercator 端点）
    tplRaw: '',
    tiles: [],         // 捕获的覆盖图瓦片 [{key,TL,TR,BR,BL,tileW,tileH,cw,ch,ds,rgba,tplId,t}]
    tileBytes: 0,
    upChain: null,     // 当前 mipmap 链的前一帧尺寸
    uPending: null,    // 链首捕获后等待 uniform2f 几何关联 {corners[],rgba,w,h}
    texCalls: 0,
    startTime: Date.now(),
    anchor: null,      // {x, y, lat, lng, zoom, kind}
    viewDX: 0, viewDY: 0,
    suspect: false,
    dragging: false, dragLast: null,
    mouse: null,
    lastSelect: null,   // 最近一次自动选色结果 {ok, msg, t}（HUD 诊断用）
    lastMapClick: null,
    pendingLoc: null,
    swatchCache: null, swatchTime: 0, swatchDirty: false,
    pickPending: false,
    tilesRev: 0,        // 瓦片集合版本号（自绘参照层重绘信号）
    scrRev: 0,          // 官方屏幕几何版本号（uniform 重放更新信号）
    lastScrDraw: 0,     // 最近一次官方覆盖图渲染重放成功时间（0=从未渲染）
    lastMapMove: 0,     // 最近一次用户物理视图交互（拖动/滚轮/键盘）时间
    ovGone: false,      // 官方覆盖图已停止渲染（退出覆盖模式）→ 参照层收起
    mapTiles: {},       // 画布瓦片缓存 {"x,y": {x,y,w,h,data(Uint8ClampedArray),t}}（别人已画的真实像素）
    mapTileBytes: 0,
    shard: 's0',        // 官方瓦片 shard（从实际请求 URL 学习）
    calib: null,        // 校准结果 {tplId,dwx,dwy,dmx,dmy,match,total,done,wrong,missing,baseColors,t,stale}
    calibBusy: false,
    calibMsg: null,     // 校准结果文案（HUD 显示）
    calibForce: null,   // 守门拒绝时缓存的最高候选 {t,tplId,best,stat,mFull,editMode}——2 分钟内再点「🎯 校准」= 强制采纳
    styleBusy: false,   // v2.6.0 颜色风格识别进行中（逐组合切换官方颜色设置并实测，期间禁点校准/暂停周期重快照）
    progRev: 0,         // 校准状态图版本号
    tileFetching: {},   // 主动补抓去重 {"x,y": true}
    liveTpls: [],       // 编辑中模板的虚拟条目（syncLiveTemplates/syncEditOverlay 维护，不写 localStorage）
    liveT: 0,           // live 同步节流定时器
    editTile: null,     // 放置编辑会话的 DOM overlay 捕获瓦片（key 'edit-live'）
    persistT: 0,        // 官方 persist（template-overlays 写入）最近时刻
    calibScreenScale: 0, // 编辑会话 δ 世界像素 → 屏幕像素比例（rect 宽 / 渲染世界宽）
    paintGrid: null     // 校准快查网格缓存 {key, G}（G: {gx0,gy0,gw,gh,grid,painted}）
  };

  // ---------------- hook texImage2D：捕获覆盖图像素上传 ----------------
  // 官方渲染器把模板量化像素按 ≤1024px 源瓦片切块，以 9 参 texImage2D(RGBA,UNSIGNED_BYTE,Uint8Array)
  // 上传并逐级手工生成 mipmap（尺寸逐级减半到 1x1）。链首帧 = 全分辨率瓦片内容。
  function onTexUpload(w, h, src) {
    var prev = ST.upChain;
    if (prev && w === Math.max(1, prev.w >> 1) && h === Math.max(1, prev.h >> 1)) {
      ST.upChain = { w: w, h: h };
      return; // mipmap 中间帧
    }
    ST.upChain = { w: w, h: h };
    var len = Math.min(src.byteLength, w * h * 4);
    var copy = new Uint8Array(w * h * 4);
    copy.set(new Uint8Array(src.buffer, src.byteOffset, len));
    // 链首后等待紧随的 7 次 uniform2f（四角 + 源尺寸 + 纹理尺寸 + 内容尺寸）
    ST.uPending = { corners: [], rgba: copy, w: w, h: h };
  }
  function patchTexImage2D(proto) {
    if (!proto) return;
    var orig = proto.texImage2D;
    if (!orig || orig.__wpAC) return;
    var hooked = function () {
      try {
        ST.texCalls++;
        if (arguments.length === 9) {
          var src = arguments[8];
          if (src && ArrayBuffer.isView(src)) {
            var ifmt = arguments[2], fmt = arguments[6], type = arguments[7];
            var w = arguments[3] | 0, h = arguments[4] | 0;
            if (ifmt === 6408 && fmt === 6408 && type === 5121 && w >= 8 && h >= 8 && w * h <= 2048 * 2048) {
              onTexUpload(w, h, src);
            } else {
              ST.upChain = null; // 其他格式（如 R8 标注蒙版）打断链
            }
          }
        }
      } catch (e) {}
      try { return orig.apply(this, arguments); } catch (e) { return undefined; }
    };
    try { hooked.__wpAC = true; } catch (e) { Object.defineProperty(hooked, '__wpAC', { value: true }); }
    proto.texImage2D = hooked;
  }

  // ---------------- hook uniform2f：关联瓦片几何（四角世界坐标 + 内容尺寸） ----------------
  // prepareTile 返回后渲染循环立即下发：topLeft/topRight/bottomRight/bottomLeft（相对模板
  // 西北角的 Mercator 偏移）、sourceSize(原始宽高)、textureSize(2^n 对齐)、textureContentSize。
  function onUniform2f(x, y) {
    var p = ST.uPending;
    if (!p) return;
    p.corners.push(x, y);
    if (p.corners.length >= 14) {
      ST.uPending = null;
      finalizeTile(p);
    }
  }
  function patchUniform2f(proto) {
    if (!proto) return;
    var orig = proto.uniform2f;
    if (!orig || orig.__wpAC) return;
    var hooked = function (location, x, y) {
      if (ST.uPending !== null) {
        try { onUniform2f(x, y); } catch (e) {}
      }
      try {
        var ov = RP.cur;
        if (ov !== null && ov !== undefined && ov.__wpACIsOv) {
          RP.seq.push([x, y]);
          if (RP.seq.length > 40) RP.seq.shift();
        }
      } catch (e) {}
      try { return orig.call(this, location, x, y); } catch (e) { return undefined; }
    };
    try { hooked.__wpAC = true; } catch (e) { Object.defineProperty(hooked, '__wpAC', { value: true }); }
    proto.uniform2f = hooked;
  }

  // ---------------- 官方渲染几何重放（自动贴合的核心） ----------------
  // 逆向官方覆盖图渲染器（maplibre custom layer，shader: gl_Position = u_matrix *
  // vec4(corner * u_world_size, 0, 1)）：每帧每瓦片 draw 前依次
  //   uniformMatrix4fv(u_matrix，已含 origin*worldSize 平移与全部视图变换)
  //   → uniform1f(u_world_size) → uniform2f ×4(相对 origin 的四角 Mercator) → drawArrays
  // 用官方自己传入的 M/ws 重放四角 → 像素级精确的屏幕四边形，缩放/拖动/旋转全程同步，
  // 不依赖 location 写入时机，也无需任何手动校准。program 指纹：ACTIVE_UNIFORMS 含 u_top_left。
  var RP = { cur: null, M: null, ws: 0, gotWs: false, seq: [] };
  function rpIsOvProg(gl, prog) {
    if (prog.__wpACIsOv !== undefined) return prog.__wpACIsOv;
    var isOv = false;
    try {
      var n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
      for (var i = 0; i < n; i++) {
        var inf = gl.getActiveUniform(prog, i);
        if (inf && (inf.name === 'u_top_left' || inf.name === 'u_world_size')) { isOv = true; break; }
      }
    } catch (e) {}
    try { prog.__wpACIsOv = isOv; } catch (e) {}
    return isOv;
  }
  function rpReset() { RP.M = null; RP.ws = 0; RP.gotWs = false; RP.seq = []; }
  function rpProject(M, corners, ws, cvw, cvh) {
    var out = [];
    for (var i = 0; i < 4; i++) {
      var wx = corners[i][0] * ws, wy = corners[i][1] * ws;
      var cx = M[0] * wx + M[4] * wy + M[12];
      var cy = M[1] * wx + M[5] * wy + M[13];
      var cw = M[3] * wx + M[7] * wy + M[15];
      if (!isFinite(cw) || cw <= 0) return null;
      out.push([(cx / cw + 1) / 2 * cvw, (1 - (cy / cw + 1) / 2) * cvh]); // NDC → CSS 像素（Y 翻转）
    }
    return out;
  }
  function rpUnproject(M, ws, sx, sy, cvw, cvh) {
    // rpProject 的逆：屏幕 CSS 像素 → Mercator(0-1)。z=0 平面上 cx/cw=nx、cy/cw=ny，
    // 展开为 wx,wy 的 2x2 线性方程组（含透视项 M3/M7/M15，倾斜/旋转视图同样精确）。
    var nx = sx / cvw * 2 - 1, ny = 1 - sy / cvh * 2;
    var a11 = M[0] - nx * M[3], a12 = M[4] - nx * M[7];
    var a21 = M[1] - ny * M[3], a22 = M[5] - ny * M[7];
    var b1 = nx * M[15] - M[12], b2 = ny * M[15] - M[13];
    var det = a11 * a22 - a12 * a21;
    if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
    return [((b1 * a22 - a12 * b2) / det) / ws, ((a11 * b2 - b1 * a21) / det) / ws];
  }
  function rpMatchTile(seq) {
    // 官方每瓦片 draw 前 7 次 uniform2f：TL/TR/BR/BL + sourceSize + textureSize + textureContentSize；
    // 四角值与 finalizeTile 捕获的相对坐标精确匹配（同一组数字）
    for (var i = 0; i + 3 < seq.length; i++) {
      for (var j = 0; j < ST.tiles.length; j++) {
        var t = ST.tiles[j];
        if (Math.abs(seq[i][0] - t.TL[0]) < 1e-9 && Math.abs(seq[i][1] - t.TL[1]) < 1e-9 &&
            Math.abs(seq[i + 1][0] - t.TR[0]) < 1e-9 && Math.abs(seq[i + 1][1] - t.TR[1]) < 1e-9 &&
            Math.abs(seq[i + 2][0] - t.BR[0]) < 1e-9 && Math.abs(seq[i + 2][1] - t.BR[1]) < 1e-9 &&
            Math.abs(seq[i + 3][0] - t.BL[0]) < 1e-9 && Math.abs(seq[i + 3][1] - t.BL[1]) < 1e-9) return t;
      }
    }
    return null;
  }
  function patchUseProgram(proto) {
    if (!proto) return;
    var orig = proto.useProgram;
    if (!orig || orig.__wpAC) return;
    var hooked = function (prog) {
      try {
        if (prog !== RP.cur) { RP.cur = prog; rpReset(); if (prog) rpIsOvProg(this, prog); }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    try { hooked.__wpAC = true; } catch (e) { Object.defineProperty(hooked, '__wpAC', { value: true }); }
    proto.useProgram = hooked;
  }
  function patchUniformMatrix4fv(proto) {
    if (!proto) return;
    var orig = proto.uniformMatrix4fv;
    if (!orig || orig.__wpAC) return;
    var hooked = function (location, transpose, data) {
      try {
        var ov = RP.cur;
        if (ov !== null && ov !== undefined && ov.__wpACIsOv && data && data.length === 16) {
          RP.M = Array.prototype.slice.call(data);
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    try { hooked.__wpAC = true; } catch (e) { Object.defineProperty(hooked, '__wpAC', { value: true }); }
    proto.uniformMatrix4fv = hooked;
  }
  function patchUniform1f(proto) {
    if (!proto) return;
    var orig = proto.uniform1f;
    if (!orig || orig.__wpAC) return;
    var hooked = function (location, x) {
      try {
        var ov = RP.cur;
        // u_world_size 是覆盖图 program 激活后的第一个 uniform1f（renderFrame 顺序），值 = 512*2^zoom
        if (ov !== null && ov !== undefined && ov.__wpACIsOv && !RP.gotWs && x >= 512 && x <= 1e9) {
          RP.ws = x; RP.gotWs = true;
        }
      } catch (e) {}
      try { return orig.call(this, location, x); } catch (e) { return undefined; }
    };
    try { hooked.__wpAC = true; } catch (e) { Object.defineProperty(hooked, '__wpAC', { value: true }); }
    proto.uniform1f = hooked;
  }
  function patchDrawArrays(proto) {
    if (!proto) return;
    var orig = proto.drawArrays;
    if (!orig || orig.__wpAC) return;
    var hooked = function (mode, first, count) {
      try {
        var ov = RP.cur;
        if (ov !== null && ov !== undefined && ov.__wpACIsOv) {
            if (mode === 4 && count === 6 && RP.M && RP.gotWs && RP.seq.length >= 4) {
              var tile = rpMatchTile(RP.seq);
              if (tile) {
                var cv = this.canvas;
                if (cv && cv.clientWidth > 0) {
                  tile.rpM = RP.M; tile.rpWs = RP.ws; // 校准偏移重放需要（参照层平移 δ 时重投影）
                  var q = rpProject(RP.M, [tile.TL, tile.TR, tile.BR, tile.BL], RP.ws, cv.clientWidth, cv.clientHeight);
                if (q) {
                  tile.scrQuad = q; tile.scrW = cv.clientWidth; tile.scrH = cv.clientHeight; tile.scrT = Date.now();
                  ST.scrRev = (ST.scrRev || 0) + 1;
                  ST.lastScrDraw = Date.now(); ST.ovGone = false; // 官方覆盖图仍在渲染
                  if (!tile.tplId) scheduleLiveSync(); // 未归属 → 可能是尚未 persist 的编辑中模板
                }
              }
            }
          }
          RP.seq = [];
        }
      } catch (e) {}
      return orig.apply(this, arguments);
    };
    try { hooked.__wpAC = true; } catch (e) { Object.defineProperty(hooked, '__wpAC', { value: true }); }
    proto.drawArrays = hooked;
  }
  function finalizeTile(p) {
    var TL = [p.corners[0], p.corners[1]], TR = [p.corners[2], p.corners[3]];
    var BR = [p.corners[4], p.corners[5]], BL = [p.corners[6], p.corners[7]];
    var tileW = p.corners[8], tileH = p.corners[9];
    var cw = Math.round(p.corners[12]), ch = Math.round(p.corners[13]);
    if (!(cw >= 1) || !(ch >= 1) || k2(cw) !== p.w || k2(ch) !== p.h) return; // 尺寸不吻合 → 非覆盖图上传
    if (ST.tileBytes + cw * ch * 4 > TILE_BYTES_BUDGET) return; // 内存预算
    var rgba = new Uint8Array(cw * ch * 4);
    for (var y = 0; y < ch; y++) {
      rgba.set(p.rgba.subarray(y * p.w * 4, y * p.w * 4 + cw * 4), y * cw * 4);
    }
    var ds = tileW > 0 ? tileW / cw : 1;
    var key = TL[0].toFixed(12) + ',' + TL[1].toFixed(12) + ',' + BR[0].toFixed(12) + ',' + BR[1].toFixed(12);
    // 同瓦片（同位置）→ 保留更优档；同档视为进度更新直接替换
    for (var i = 0; i < ST.tiles.length; i++) {
      var t = ST.tiles[i];
      if (t.key === key) {
        if (ds < t.ds || Math.abs(ds - t.ds) < 1e-6) {
          ST.tileBytes -= t.cw * t.ch * 4;
          t.cw = cw; t.ch = ch; t.ds = ds; t.rgba = rgba; t.tileW = tileW; t.tileH = tileH; t.t = Date.now();
          t.cv = null; // 2D 画布缓存失效，自绘层下次重建
          t.stData = null; t.stCv = null; // 校准状态图随纹理失效
          if (ST.calib) ST.calib.stale = true;
          ST.tileBytes += cw * ch * 4;
          ST.tilesRev++;
        }
        return;
      }
    }
    var tile = { key: key, TL: TL, TR: TR, BR: BR, BL: BL, tileW: tileW, tileH: tileH, cw: cw, ch: ch, ds: ds, rgba: rgba, tplId: null, t: Date.now() };
    ST.tiles.push(tile);
    ST.tileBytes += cw * ch * 4;
    ST.tilesRev++;
    attachTile(tile);
    updateHud();
  }

  // ---------------- 瓦片归属模板（相对四角 + 模板西北角 origin → 绝对矩形） ----------------
  // 归属策略：bounds 包含 + 官方约束（源块渲染宽 ≤1024）+ 面积最小包含。
  // 注意不能用 originalWidth 做比例校验：bounds 按渲染分辨率定义（如 100×100），
  // 而非源图尺寸（如 3762²）；单瓦片模板相对角恒为 (0,0)，多模板包含时靠面积最小裁决。
  function attachTile(tile) {
    var best = null;
    var tileW = tile.tileW > 0 ? tile.tileW : tile.cw;
    for (var i = 0; i < ST.templates.length; i++) {
      var t = ST.templates[i];
      var x0 = tile.TL[0] + t.mx0, x1 = tile.TR[0] + t.mx0;
      var y0 = tile.TL[1] + t.my0, y1 = tile.BL[1] + t.my0;
      var eps = 1e-9;
      if (x0 < t.mx0 - eps || x1 > t.mx1 + eps || y0 < t.my0 - eps || y1 > t.my1 + eps) continue;
      // 官方 rebuildSourceTiles 按 1024 步长切块：瓦片渲染宽必须 ≤1024
      if (tileW > 1024 + 1e-6) continue;
      // 弱比例约束：由瓦片占模板比例反推渲染总宽，须在 [tileW, 8192] 内
      var ratioW = (x1 - x0) / (t.mx1 - t.mx0);
      if (ratioW <= 0) continue;
      var renderW = tileW / ratioW;
      if (renderW < tileW - 1e-6 || renderW > 8192 + 1e-6) continue;
      var area = (t.mx1 - t.mx0) * (t.my1 - t.my0);
      if (!best || area < best.area) best = { id: t.id, area: area }; // 最精确包含
    }
    if (best) tile.tplId = best.id;
  }
  function attachUnbound() {
    for (var i = 0; i < ST.tiles.length; i++) {
      if (!ST.tiles[i].tplId) attachTile(ST.tiles[i]);
    }
  }

  // ================= v2.5.0 对齐校准：别人已画内容 ↔ 官方模板 =================
  // 逆向依据（DfWPNImQ_pretty.js 官方放置编辑器）：官方 auto-paint 的画布像素来自
  // Bc(region)：按 `${files}/s${season}/tiles/{x}/{y}.png` 逐瓦片 fetch+解码，region 世界
  // 像素 [px0,px0+width)×[py0,py0+height) 与瓦片 [x*1000,(x+1)*1000) 求交集拷贝。
  // 校准 = 同官方 auto-paint 的比对思路：模板量化像素 vs 画布真实像素逐点比对，
  // 暴力搜索偏移 δ（世界像素）使匹配率最大 → 参照层即时平移预览 + 可选写回官方 bounds。

  // ---------------- Mercator ↔ 经纬度（含逆变换） ----------------
  function mercYToLat(my) {
    // my01 的逆：atanh(sin lat) = 2π(0.5-my) → lat = asin(tanh(π(1-2my)))
    var s = Math.tanh(Math.PI * (1 - 2 * my));
    return Math.asin(Math.max(-1, Math.min(1, s))) * 180 / Math.PI;
  }
  function lngAt(wx) { return wx / WORLD_PX * 360 - 180; }

  // ---------------- hook fetch：捕获官方画布瓦片 ----------------
  // 官方地图(maplibre raster)与放置编辑器(Bc)都用 fetch 拉瓦片；克隆响应异步解码，
  // 不阻塞官方请求、零额外网络开销。视口滚到哪，画布真实像素就缓存到哪。
  function parseTileUrl(url) {
    var m = /\/files\/(s\d+)\/tiles\/(-?\d+)\/(-?\d+)\.png/.exec(url || '');
    return m ? { shard: m[1], x: +m[2], y: +m[3] } : null;
  }
  function patchFetch() {
    var orig = uw.fetch;
    if (!orig || orig.__wpAC) return;
    var hooked = function (input) {
      var url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
      var tp = parseTileUrl(url);
      if (tp) {
        try {
          var p = orig.apply(this, arguments);
          p.then(function (resp) {
            try {
              resp.clone().arrayBuffer().then(function (ab) { decodeTile(ab, tp); }).catch(function () {});
            } catch (e) {}
          }).catch(function () {});
          return p;
        } catch (e) {}
      }
      return orig.apply(this, arguments);
    };
    try { hooked.__wpAC = true; } catch (e) { Object.defineProperty(hooked, '__wpAC', { value: true }); }
    uw.fetch = hooked;
  }
  function decodeTile(ab, tp) {
    ST.shard = tp.shard;
    var key = tp.x + ',' + tp.y;
    if (ST.mapTiles[key]) { ST.mapTiles[key].t = Date.now(); return; }
    var blob = new Blob([ab], { type: 'image/png' });
    var done = function (src, w, h) {
      try {
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        var ctx = cv.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(src, 0, 0);
        storeMapTile(tp.x, tp.y, ctx.getImageData(0, 0, w, h));
      } catch (e) {}
    };
    var fallback = function () {
      var im = new Image();
      im.onload = function () { done(im, im.naturalWidth, im.naturalHeight); };
      im.onerror = function () {};
      im.src = URL.createObjectURL(blob);
    };
    if (uw.createImageBitmap) {
      uw.createImageBitmap(blob).then(function (bmp) {
        done(bmp, bmp.width, bmp.height);
        try { if (bmp.close) bmp.close(); } catch (e) {}
      }).catch(fallback);
    } else fallback();
  }
  function storeMapTile(x, y, img) {
    var key = x + ',' + y, old = ST.mapTiles[key];
    if (old) ST.mapTileBytes -= old.data.length;
    if (ST.mapTileBytes + img.data.length > MAP_BYTES_BUDGET) evictMapTiles(img.data.length);
    ST.mapTiles[key] = { x: x, y: y, w: img.width, h: img.height, data: img.data, t: Date.now() };
    ST.mapTileBytes += img.data.length;
    if (ST.calib) ST.calib.stale = true; // 有新画布数据 → 进度统计可刷新
    ST.progRev++;
  }
  // 主动补抓画布瓦片：fetch hook 在 ScriptCat 沙箱下不穿透（window 实例属性）、
  // maplibre 瓦片又在 Worker 里加载，主线程拦截不到 —— 校准需要的画布数据一律
  // 按范围主动拉取（backend.wplace.live 返回 ACAO: wplace.live，实测可直连；
  // 海洋/未开放区域返回 1×1 占位 PNG，解码后自然无已画像素）。
  function ensureMapTiles(wx0, wy0, wx1, wy1, cb) {
    var tx0 = Math.floor(wx0 / TILE_PX), ty0 = Math.floor(wy0 / TILE_PX);
    var tx1 = Math.floor(wx1 / TILE_PX), ty1 = Math.floor(wy1 / TILE_PX);
    if (tx0 < 0) tx0 = 0; if (ty0 < 0) ty0 = 0;
    if (tx1 > 2047) tx1 = 2047; if (ty1 > 2047) ty1 = 2047;
    var need = [];
    for (var ty = ty0; ty <= ty1; ty++) {
      for (var tx = tx0; tx <= tx1; tx++) {
        if (!ST.mapTiles[tx + ',' + ty]) need.push([tx, ty]);
      }
    }
    if (!need.length) { if (cb) setTimeout(cb, 0); return; }
    var base = 'https://backend.wplace.live/files/' + ST.shard + '/tiles/';
    var idx = 0, finished = 0, got = 0;
    var workers = Math.min(4, need.length);
    var worker = function () {
      if (idx >= need.length) {
        finished++;
        if (finished >= workers && cb) setTimeout(cb, 400); // 留出异步解码时间
        return;
      }
      var p = need[idx++];
      fetch(base + p[0] + '/' + p[1] + '.png', { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.arrayBuffer() : null; })
        .then(function (ab) {
          if (ab && ab.byteLength) { decodeTile(ab, { shard: ST.shard, x: p[0], y: p[1] }); got++; }
          worker();
        })
        .catch(function () { worker(); });
    };
    for (var k = 0; k < workers; k++) worker();
  }
  function evictMapTiles(need) {
    var keys = Object.keys(ST.mapTiles);
    keys.sort(function (a, b) { return ST.mapTiles[a].t - ST.mapTiles[b].t; });
    for (var i = 0; i < keys.length && ST.mapTileBytes + need > MAP_BYTES_BUDGET; i++) {
      ST.mapTileBytes -= ST.mapTiles[keys[i]].data.length;
      delete ST.mapTiles[keys[i]];
    }
  }
  // 画布真实像素查询：归一化 Mercator → 世界像素 → 瓦片。无数据返回 null。
  function canvasPixelAt(mx, my) {
    if (!(mx >= 0 && mx <= 1 && my >= 0 && my <= 1)) return null;
    var wx = mx * WORLD_PX, wy = my * WORLD_PX;
    var tx = Math.floor(wx / TILE_PX), ty = Math.floor(wy / TILE_PX);
    var t = ST.mapTiles[tx + ',' + ty];
    if (!t) return null;
    var px = wx - tx * TILE_PX, py = wy - ty * TILE_PX;
    if (px < 0 || py < 0 || px >= t.w || py >= t.h) return null;
    var o = ((py | 0) * t.w + (px | 0)) * 4;
    return [t.data[o], t.data[o + 1], t.data[o + 2], t.data[o + 3]];
  }

  // ---------------- 校准快查网格（v2.5.3 性能） ----------------
  // 大范围偏移搜索要查画布色数千万次，canvasPixelAt 每次字符串 key 找瓦片 + 分配
  // RGBA 数组，实测冻结主线程 30 秒+。改为把搜索涉及范围一次性栅格化成
  // Uint8Array（每世界像素 1 字节：0=未涂/无数据，1..64=调色板色索引+1，255=已涂异色），
  // 查询退化为一次下标读取，构建按瓦片分片让出主线程。
  var PAINT_KEY_MAP = null;
  function paintIdxMap() {
    if (PAINT_KEY_MAP) return PAINT_KEY_MAP;
    var m = new Map();
    for (var i = 1; i < PALETTE.length; i++) {
      var c = PALETTE[i];
      m.set((c[1] << 16) | (c[2] << 8) | c[3], i);
    }
    PAINT_KEY_MAP = m;
    return m;
  }
  function gridAt(G, wx, wy) {
    var x = wx - G.gx0, y = wy - G.gy0;
    if (x < 0 || y < 0 || x >= G.gw || y >= G.gh) return 0;
    return G.grid[y * G.gw + x];
  }
  // 网格编码：0=未涂/无数据；1..63=已涂且精确=调色板色；129..191=已涂非调色板色
  // （128+最近调色板索引）；255=预留兜底。近似编码让「画手用了相邻色/画布压缩伪影」
  // 不再被逐字节精确比较打成画错——实测用户场景真峰仅 40% 全因近似色拉低。
  var NEAREST_MAP = null;
  function nearestPaletteCached(r, g, b) {
    if (!NEAREST_MAP) NEAREST_MAP = new Map();
    var k = (r << 16) | (g << 8) | b, v = NEAREST_MAP.get(k);
    if (v) return v;
    v = nearestPaletteIdx(r, g, b);
    NEAREST_MAP.set(k, v);
    return v;
  }
  function fillGridTile(G, t, im) {
    var bx = t.x * TILE_PX - G.gx0, by = t.y * TILE_PX - G.gy0, painted = 0;
    for (var y = 0; y < t.h; y++) {
      var ro = y * t.w * 4, gi = (by + y) * G.gw + bx;
      for (var x = 0; x < t.w; x++) {
        var o = ro + x * 4;
        if (t.data[o + 3] < 128) continue;
        G.grid[gi + x] = im.get((t.data[o] << 16) | (t.data[o + 1] << 8) | t.data[o + 2]) ||
          (128 + nearestPaletteCached(t.data[o], t.data[o + 1], t.data[o + 2]));
        painted++;
      }
    }
    G.painted += painted;
  }
  // 颜色容差表（64×64）：调色板色对 RGB 距离² ≤1600（40²）视为近似。近似命中参与
  // 匹配率（真峰分数实打实提升；随机背景的近似命中率涨幅远小于真峰）。
  var PAL_TOL = null;
  function palTolHit(a, b) {
    if (!PAL_TOL) {
      PAL_TOL = new Uint8Array(64 * 64);
      for (var i = 1; i < PALETTE.length; i++) {
        for (var j = 1; j < PALETTE.length; j++) {
          if (i === j) { PAL_TOL[i * 64 + j] = 1; continue; }
          var c1 = PALETTE[i], c2 = PALETTE[j];
          var dr = c1[1] - c2[1], dg = c1[2] - c2[2], db = c1[3] - c2[3];
          if (dr * dr + dg * dg + db * db <= 1600) PAL_TOL[i * 64 + j] = 1;
        }
      }
    }
    return a < 64 && PAL_TOL[a * 64 + b];
  }
  function gridRangeSig(wx0, wy0, wx1, wy1) {
    var keys = [];
    var tx0 = Math.floor(wx0 / TILE_PX), ty0 = Math.floor(wy0 / TILE_PX);
    var tx1 = Math.floor(wx1 / TILE_PX), ty1 = Math.floor(wy1 / TILE_PX);
    for (var ty = ty0; ty <= ty1; ty++) for (var tx = tx0; tx <= tx1; tx++) keys.push(tx + ',' + ty);
    return keys.join(';');
  }
  // 范围内瓦片 → 网格。缓存命中同步回调；未命中分片构建（noBuild 时直接回调 null）。
  function ensurePaintGrid(wx0, wy0, wx1, wy1, noBuild, cb) {
    var tx0 = Math.floor(wx0 / TILE_PX), ty0 = Math.floor(wy0 / TILE_PX);
    var tx1 = Math.floor(wx1 / TILE_PX), ty1 = Math.floor(wy1 / TILE_PX);
    var gx0 = tx0 * TILE_PX, gy0 = ty0 * TILE_PX;
    var gw = (tx1 - tx0 + 1) * TILE_PX, gh = (ty1 - ty0 + 1) * TILE_PX;
    var sig = gx0 + ',' + gy0 + ',' + gw + ',' + gh + '|' + gridRangeSig(wx0, wy0, wx1, wy1);
    if (ST.paintGrid && ST.paintGrid.key === sig) { cb(ST.paintGrid.G); return; }
    if (noBuild) { cb(null); return; }
    var G = { gx0: gx0, gy0: gy0, gw: gw, gh: gh, grid: new Uint8Array(gw * gh), painted: 0 };
    var keys = sig.split('|')[1] ? sig.split('|')[1].split(';') : [];
    var im = paintIdxMap(), k = 0;
    (function step() {
      var t0 = Date.now();
      while (k < keys.length && Date.now() - t0 < 40) {
        var t = ST.mapTiles[keys[k]];
        if (t) fillGridTile(G, t, im);
        k++;
      }
      if (k < keys.length) {
        ST.calibMsg = { ok: null, msg: '⏳ 校准中…（索引画布像素 ' + Math.round(k / keys.length * 100) + '%）', t: Date.now() };
        updateHud();
        setTimeout(step, 0);
      } else {
        ST.paintGrid = { key: sig, G: G };
        cb(G);
      }
    })();
  }

  // ---------------- 已画/画错判定（与官方 auto-paint 比对完全一致） ----------------
  // 实测官方瓦片 PNG（64 色调色板索引图，tRNS 仅索引0=alpha 0）：未涂像素 alpha=0，
  // 已画像素 alpha=255 且 RGB 精确等于调色板色（官方 $r(): 逐字节比较 data[a..a+2]）。
  function isPainted(c) { return c[3] >= 128; }
  function sameColor(c, r, g, b) { return c[0] === r && c[1] === g && c[2] === b; }

  // ---------------- 模板采样点（纹理像素 ↔ Mercator/画布） ----------------
  // 模板纹理瓦片四角是"相对模板 bounds 西北角"的 Mercator 偏移，加 tpl.mx0/my0 即绝对
  // Mercator（轴对齐 bounds 下双线性退化为线性）。status: 1=done 2=wrong 0=missing/无数据
  function texPxMerc(tile, tpl, px, py) {
    return [
      tpl.mx0 + tile.TL[0] + (tile.TR[0] - tile.TL[0]) * (px + 0.5) / tile.cw,
      tpl.my0 + tile.TL[1] + (tile.BL[1] - tile.TL[1]) * (py + 0.5) / tile.ch
    ];
  }
  function collectTplTiles(tplId) {
    var out = [];
    for (var i = 0; i < ST.tiles.length; i++) {
      var t = ST.tiles[i];
      if (t.tplId === tplId) out.push(t);
    }
    return out;
  }

  // ---------------- 编辑中模板（未 persist）的虚拟 bounds ----------------
  // 官方放置编辑会话期间 suppressPersist，模板不在 localStorage['template-overlays']，
  // attachTile/pickCalibTemplate 因此全部落空（v2.5.0 只支持已保存模板的教训）。
  // 官方编辑器预览层（template-build-overlay-layer）复用同一 overlay 渲染器类（同 shader、
  // 同 uniform 序列），drawArrays 捕获照常工作 → 用 rpUnproject 把瓦片屏幕四边形反解为
  // 绝对 Mercator，再由「瓦片绝对角 − 瓦片相对角」恢复模板 origin；同 origin 瓦片归为一组
  // （= 一个模板），动态构造虚拟模板条目（virtual:true，不写 localStorage）。
  // 用户在编辑器里拖动/缩放模板时每帧重解，虚拟 bounds 实时跟随；官方「应用」persist 后
  // 瓦片转归真实模板，live 组自动消失并把校准引用迁移过去。
  var LIVE_EPS = 1e-7; // Mercator 0-1 尺度 ≈ 0.2 世界像素；同帧同模板共享同一 bounds 数值
  function isLiveId(id) { return String(id || '').indexOf('wpAC-live') === 0; }
  function scheduleLiveSync() {
    if (ST.liveT) return;
    ST.liveT = setTimeout(function () { ST.liveT = 0; syncLiveTemplates(); }, 250);
  }
  function syncLiveTemplates() {
    if (ST.editTile) return; // 编辑会话由 syncEditOverlay 独占 live 维护（DOM 来源无 rpM，反解不适用）
    var i, j, t;
    var groups = [];
    for (i = 0; i < ST.tiles.length; i++) {
      t = ST.tiles[i];
      if (!t.scrQuad || !t.rpM || !t.rpWs || !t.scrW) continue;
      if (t.tplId && !isLiveId(t.tplId)) continue; // 已归属真实模板：官方已 persist，无需 live
      var abs = rpUnproject(t.rpM, t.rpWs, t.scrQuad[0][0], t.scrQuad[0][1], t.scrW, t.scrH); // TL 屏幕角
      if (!abs) continue;
      var ox = abs[0] - t.TL[0], oy = abs[1] - t.TL[1];
      var g = null;
      for (j = 0; j < groups.length; j++) {
        if (Math.abs(groups[j].ox - ox) < LIVE_EPS && Math.abs(groups[j].oy - oy) < LIVE_EPS) { g = groups[j]; break; }
      }
      if (!g) { g = { ox: ox, oy: oy, mx1: -Infinity, my1: -Infinity }; groups.push(g); }
      if (t.BR[0] > g.mx1) g.mx1 = t.BR[0]; // 模板右下界 = 已见瓦片最大相对角（mx0/mx1 同源，包含判定误差相消）
      if (t.BR[1] > g.my1) g.my1 = t.BR[1];
    }
    groups.sort(function (a, b) { return a.oy - b.oy || a.ox - b.ox; });
    var live = [];
    for (i = 0; i < groups.length; i++) {
      if (!isFinite(groups[i].mx1)) continue;
      live.push({
        id: 'wpAC-live' + (groups.length > 1 ? ':' + i : ''),
        name: '✏️ 编辑中的模板',
        mx0: groups[i].ox, my0: groups[i].oy,
        mx1: groups[i].ox + groups[i].mx1, my1: groups[i].oy + groups[i].my1,
        w: 0, h: 0, visible: true, order: 1e9, virtual: true
      });
    }
    // 归属到已消失 live 条目的瓦片重新置为未归属（组重排/官方 persist 后）
    for (i = 0; i < ST.tiles.length; i++) {
      t = ST.tiles[i];
      if (t.tplId && isLiveId(t.tplId)) {
        var found = false;
        for (j = 0; j < live.length; j++) if (live[j].id === t.tplId) { found = true; break; }
        if (!found) t.tplId = null;
      }
    }
    ST.liveTpls = live;
    ST.templates = buildTplList().concat(live);
    // 校准引用迁移：live 组消失 = 官方「应用」persist 完成 → 按 live 最后 bounds 匹配真实模板
    if (ST.calib && isLiveId(ST.calib.tplId)) {
      var still = null;
      for (i = 0; i < live.length; i++) if (live[i].id === ST.calib.tplId) still = live[i];
      if (still) {
        ST.calib.liveBounds = { mx0: still.mx0, my0: still.my0, mx1: still.mx1, my1: still.my1 };
      } else {
        var lb = ST.calib.liveBounds, moved = false;
        if (lb) {
          for (i = 0; i < ST.templates.length; i++) {
            var tt = ST.templates[i];
            if (tt.virtual) continue;
            if (Math.abs(tt.mx0 - lb.mx0) < 2e-7 && Math.abs(tt.my0 - lb.my0) < 2e-7 &&
                Math.abs(tt.mx1 - lb.mx1) < 2e-7 && Math.abs(tt.my1 - lb.my1) < 2e-7) {
              ST.calib.tplId = tt.id; ST.calib.tplName = tt.name; moved = true;
              break;
            }
          }
        }
        // 迁移失败（覆盖图收起/滚出视口导致 live 暂时消失）：保留校准，等渲染恢复后
        // live 重建（id 不变）自动接上；persist 但 bounds 对不上时由「应用对齐」提示重跑
      }
    }
    attachUnbound();
    updateHud();
  }

  // ---------------- 放置编辑会话（DOM overlay）捕获 ----------------
  // 逆向实锤（DfWPNImQ + 页面实测）：官方编辑器的模板预览是 DOM 2D canvas
  // （div.overlay.active > canvas.pixelated，尺寸=模板原始像素）叠在地图上，不经过
  // WebGL → texImage2D/drawArrays 都捕获不到，v2.5.1 的屏幕反解在此场景失效。
  // 另实测：ScriptCat 沙箱对 window.fetch（实例属性）赋值不穿透，但 prototype 属性
  // 穿透；maplibre 瓦片在 Worker 里加载主线程 hook 不到 —— 画布数据一律改用
  // 主动 fetch（backend CORS: ACAO=wplace.live，实测 200）。
  // 编辑会话数据链：模板纹理 = 编辑器 canvas 快照（内容已是量化+色板+抖动+翻转
  // 的最终像素）；模板基准位置 = localStorage['location']（官方地图中心，编辑器
  // 内不再更新，偏差交给大范围 δ 搜索吸收）；模板屏幕位置 = overlay rect。
  var LIVE_ID = 'wpAC-live';
  function editOverlayEl() {
    try {
      var cv = document.querySelector('div.overlay.active canvas');
      // canvas 尺寸=模板原始像素：小模板可低至几十 px（实测 100×100 被旧 >256
      // 门槛挡住导致整个编辑会话失效），≥16 只挡图标/占位
      return cv && cv.width >= 16 && cv.height >= 16 ? cv : null;
    } catch (e) { return null; }
  }
  function readEditScalePct() {
    // 尺寸面板的缩放档位（25/50/100/200%）；识别不到默认 100%
    try {
      var btns = document.querySelectorAll('div.overlay.active button, .template-build-panel button');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i], txt = (b.textContent || '').trim();
        if (b.getAttribute('aria-pressed') === 'true' || b.className.indexOf('active') >= 0) {
          if (txt === '25%' || txt === '50%' || txt === '100%' || txt === '200%') return parseInt(txt, 10) / 100;
        }
      }
    } catch (e) {}
    return 1;
  }
  function editBaseLoc() {
    try {
      var loc = JSON.parse(localStorage.getItem('location') || 'null');
      if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number' && typeof loc.zoom === 'number') return loc;
    } catch (e) {}
    return null;
  }
  var editSnapT = 0;
  function syncEditOverlay() {
    var cv = editOverlayEl();
    if (!cv) {
      if (ST.editTile) {
        // 退出编辑会话：拆除编辑瓦片；校准结果迁移到 persist 的真实模板（若有）
        for (var i = ST.tiles.length - 1; i >= 0; i--) if (ST.tiles[i].key === 'edit-live') ST.tiles.splice(i, 1);
        ST.editTile = null;
        if (ST.liveTpls.length) {
          ST.liveTpls = [];
          ST.templates = buildTplList();
          ST.tilesRev++;
          if (ST.calib && isLiveId(ST.calib.tplId)) {
            // 编辑场景 liveBounds 是构造基准（非官方旧位置），bounds 匹配无意义 →
            // 官方「应用」后的 persist（30s 内）视为目标模板；无 persist 则保留引用，
            // 用户重开编辑器时 live 重建（同 id）自动接上
            var mig = null, bestT = -1;
            if (ST.persistT && Date.now() - ST.persistT < 30000) {
              for (var m = 0; m < ST.templates.length; m++) {
                var mt = ST.templates[m];
                if (mt.virtual || !mt.visible) continue;
                var ut = mt.updatedAt || 0;
                if (ut >= bestT) { bestT = ut; mig = mt; }
              }
            }
            if (mig) {
              ST.calib.tplId = mig.id; ST.calib.tplName = mig.name;
              var ar = applyCalibToStorage();
              ST.calibMsg = {
                ok: !!ar,
                msg: ar ? '✅ 官方已保存放置，校准偏移已自动写入模板位置——按 F5 刷新后官方覆盖图精确对齐已画内容'
                        : '校准已接上真实模板，点「应用对齐」写入位置',
                t: Date.now()
              };
            }
          }
        }
        updateHud();
      }
      return;
    }
    var now = Date.now();
    var r = cv.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;
    // 编辑瓦片：相对四角用 Mercator 单位（与 WebGL 捕获瓦片同语义，全链路公式通用）
    var pct = readEditScalePct();
    var Wrender = cv.width * pct, Hrender = cv.height * pct;
    var t = ST.editTile;
    if (!t || t.cw !== cv.width || t.ch !== cv.height) {
      t = ST.editTile = {
        key: 'edit-live',
        TL: [0, 0], TR: [Wrender / WORLD_PX, 0], BR: [Wrender / WORLD_PX, Hrender / WORLD_PX], BL: [0, Hrender / WORLD_PX],
        tileW: Wrender, cw: cv.width, ch: cv.height, ds: 1,
        rgba: null, cv: null, tplId: LIVE_ID, t: now
      };
      ST.tiles.push(t);
      ST.tilesRev++;
      editSnapT = 0; // 新会话强制快照
    }
    t.tileW = Wrender;
    t.TL = [0, 0]; t.TR = [Wrender / WORLD_PX, 0]; t.BR = [Wrender / WORLD_PX, Hrender / WORLD_PX]; t.BL = [0, Hrender / WORLD_PX];
    // 模板纹理快照：进入会话 / 尺寸变化 / 每 3s 内容可能变化（改色板/抖动/翻转）时刷新
    // 风格识别中跳过：识别流程自己管理快照，周期快照会把中间候选的渲染写进 t.rgba
    if ((!t.rgba || now - editSnapT > 3000) && !ST.styleBusy) {
      editSnapT = now;
      try {
        var snap = document.createElement('canvas');
        snap.width = cv.width; snap.height = cv.height;
        var sctx = snap.getContext('2d', { willReadFrequently: true });
        sctx.drawImage(cv, 0, 0);
        var img = sctx.getImageData(0, 0, snap.width, snap.height);
        var sig = img.data[0] + ',' + img.data[1] + ',' + img.data[img.data.length >> 1] + ',' + img.data[img.data.length - 4];
        if (t.snapSig !== sig || !t.rgba) {
          t.rgba = img.data;
          t.cv = snap; // 直接作为参照层绘制源
          t.stData = null; t.stCv = null;
          if (ST.calib && ST.calib.tplId === LIVE_ID) ST.calib.stale = true;
          ST.tilesRev++;
        }
      } catch (e) {}
    }
    // live 条目：基准 bounds 优先用 localStorage 同尺寸模板的位置（= 用户实际放置处，
    // 校准目标也是写回它）；无匹配再用 location 中心。基准越准，阶梯搜索越早命中。
    var base = null;
    try {
      var rawOv = JSON.parse(localStorage.getItem('template-overlays') || '[]');
      var arrOv = Array.isArray(rawOv) ? rawOv : (rawOv && Array.isArray(rawOv.templates) ? rawOv.templates : []);
      var bestB = null, bestU = -1;
      for (var oi = 0; oi < arrOv.length; oi++) {
        var ot = arrOv[oi], ob = ot && ot.bounds;
        if (!ob || typeof ob.north !== 'number' || !ot.visible) continue;
        if (ot.originalWidth !== cv.width || ot.originalHeight !== cv.height) continue;
        var ut2 = ot.updatedAt || 0;
        if (ut2 >= bestU) { bestU = ut2; bestB = ob; }
      }
      if (bestB &&
          Math.abs((mx01(bestB.east) - mx01(bestB.west)) * WORLD_PX - cv.width) < 2 &&
          Math.abs((my01(bestB.south) - my01(bestB.north)) * WORLD_PX - cv.height) < 2) {
        // 宽高与模板渲染尺寸吻合（≤2 世界像素）才采用：形状不符（翻转/裁剪）会带偏基准
        base = { lng: (bestB.west + bestB.east) / 2, lat: (bestB.north + bestB.south) / 2 };
      }
    } catch (e) {}
    if (!base) base = editBaseLoc();
    if (!base) return; // 无基准（极罕见：官方启动必写 location）
    var cmx = mx01(base.lng), cmy = my01(base.lat);
    var halfW = Wrender / WORLD_PX / 2, halfH = Hrender / WORLD_PX / 2;
    var live = {
      id: LIVE_ID, name: '✏️ 编辑中的模板', virtual: true, visible: true, order: 1e9,
      mx0: cmx - halfW, mx1: cmx + halfW, my0: cmy - halfH, my1: cmy + halfH,
      w: cv.width, h: cv.height
    };
    var oldLive = ST.liveTpls.length ? ST.liveTpls[0] : null;
    ST.liveTpls = [live];
    if (!oldLive || oldLive.mx0 !== live.mx0 || oldLive.my0 !== live.my0 ||
        oldLive.mx1 !== live.mx1 || oldLive.my1 !== live.my1) {
      ST.templates = buildTplList().concat(ST.liveTpls);
      ST.tilesRev++;
    }
    // 屏幕四边形（viewport 坐标）= overlay rect：参照层/取色/存活检测直接复用
    var q = [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]];
    var qSig = Math.round(r.left * 4) + ',' + Math.round(r.top * 4) + ',' + Math.round(r.right * 4) + ',' + Math.round(r.bottom * 4);
    if (t.qSig !== qSig) {
      t.qSig = qSig;
      t.scrQuad = q; t.scrW = uw.innerWidth; t.scrH = uw.innerHeight;
      t.rpM = null; t.rpWs = 0; // DOM 来源：无官方矩阵，δ 平移走 screenScale 分支
      t.scrT = now;
      ST.scrRev = (ST.scrRev || 0) + 1;
      ST.lastScrDraw = now; ST.ovGone = false;
      ST.calibScreenScale = r.width / Wrender; // δ 世界像素 → 屏幕像素
      ST.tilesRev++;
    } else if (ST.calib && ST.calib.screen) {
      ST.calibScreenScale = r.width / Wrender;
    }
  }

  // ---------------- 校准主流程 ----------------
  function pickCalibTemplate() {
    var i, j;
    // 编辑中的模板（虚拟 bounds）优先：用户在放置面板里点校准，意图就是对齐当前编辑的这个
    for (i = 0; i < ST.templates.length; i++) {
      var v = ST.templates[i];
      if (!v.virtual || !v.visible) continue;
      for (j = 0; j < ST.tiles.length; j++) {
        if (ST.tiles[j].tplId === v.id) return v;
      }
    }
    for (i = 0; i < ST.templates.length; i++) {
      var t = ST.templates[i];
      if (!t.visible) continue;
      var has = false;
      for (j = 0; j < ST.tiles.length; j++) {
        if (ST.tiles[j].tplId === t.id) { has = true; break; }
      }
      if (has) return t;
    }
    return null;
  }
  function runCalibrate() {
    if (ST.calibBusy || ST.styleBusy) return; // 风格识别中切换官方控件，重入会打乱实测序列
    // 强制采纳：拒绝后 2 分钟内再点 = 采纳缓存的最高候选（跳过守门，目视核对兜底）
    var f = ST.calibForce;
    if (f && f.best && Date.now() - f.t < 120000) {
      ST.calibForce = null;
      var tplF = tplById(f.tplId);
      var tTilesF = tplF ? collectTplTiles(f.tplId) : [];
      if (tplF && tTilesF.length) { acceptCalib(tplF, f.best, f.stat, f.mFull, f.editMode, true, null); return; }
    }
    if (ST.editTile) { editSnapT = 0; syncEditOverlay(); } // 校准前重快照：色板/抖动/翻转改动立即生效
    var tpl = pickCalibTemplate();
    if (!tpl) { ST.calibMsg = { ok: false, msg: '未找到可校准的模板瓦片（先让官方覆盖图渲染出现）', t: Date.now() }; updateHud(); return; }
    var tTiles = collectTplTiles(tpl.id);
    if (!tTiles.length) { ST.calibMsg = { ok: false, msg: '模板无纹理数据', t: Date.now() }; updateHud(); return; }
    ST.calibBusy = true;
    ST.calibMsg = { ok: null, msg: '⏳ 校准中…（对比画布已画内容）', t: Date.now() };
    updateHud();
    // 异步起步：让 HUD 先渲染。全流程异步（补瓦片 → 索引网格 → 分级搜索），
    // calibBusy 在各终点（finishCalib）释放，中途连点直接忽略
    setTimeout(function () {
      try { doCalibrate(tpl, tTiles); }
      catch (e) {
        ST.calibMsg = { ok: false, msg: '校准失败：' + (e && e.message || e), t: Date.now() };
        finishCalib();
      }
    }, 30);
  }
  function finishCalib() { ST.calibBusy = false; updateHud(); }
  function doCalibrate(tpl, tTiles) {
    var editMode = !!(ST.editTile && tpl.id === LIVE_ID);
    // 1) 采样点：不透明模板像素 → 世界像素偏移范围。
    //    ≤25000 像素全采样（1 像素错位在纯色区也必被踩到）；更大模板步长 2 且
    //    奇偶行交错起点（避免均匀采样恰好跳过某列/行造成平移自相似假峰）。
    var samples = [], step = 1;
    var totalPx = 0;
    for (var i = 0; i < tTiles.length; i++) totalPx += tTiles[i].cw * tTiles[i].ch;
    if (totalPx > 25000) step = 2;
    for (i = 0; i < tTiles.length; i++) {
      var tt = tTiles[i];
      for (var y = 0; y < tt.ch; y += step) {
        for (var x = (step === 2 && (y & 1) ? 1 : 0); x < tt.cw; x += step) {
          var o = (y * tt.cw + x) * 4;
          if (tt.rgba[o + 3] < 200) continue;
          samples.push({ t: tt, x: x, y: y, r: tt.rgba[o], g: tt.rgba[o + 1], b: tt.rgba[o + 2] });
        }
      }
    }
    if (!samples.length) { ST.calibMsg = { ok: false, msg: '模板纹理全透明，无可比对内容', t: Date.now() }; return; }
    // 2) 采样点基准世界坐标（δ=0）。世界坐标取像素格子左上（floor），与 canvasPixelAt
    //    的 floor 语义一致；若用 round(中心) 会使全体采样系统性偏移 1 像素。
    for (i = 0; i < samples.length; i++) {
      var s = samples[i], m = texPxMerc(s.t, tpl, s.x, s.y);
      s.mx = m[0]; s.my = m[1];
      s.wx = Math.floor(m[0] * WORLD_PX); s.wy = Math.floor(m[1] * WORLD_PX);
    }
    // 3) 补抓画布瓦片（fetch hook 在沙箱/Worker 下不可靠 → 按基准范围主动拉取；
    //    已缓存的跳过）。编辑会话基准（location 中心）偏差大 → 半径放大到 ±1400。
    var halfW = (tpl.mx1 - tpl.mx0) * WORLD_PX / 2, halfH = (tpl.my1 - tpl.my0) * WORLD_PX / 2;
    var pad = editMode ? 1400 : 300;
    var cx = (tpl.mx0 + tpl.mx1) / 2 * WORLD_PX, cy = (tpl.my0 + tpl.my1) / 2 * WORLD_PX;
    ensureMapTiles(cx - halfW - pad, cy - halfH - pad, cx + halfW + pad, cy + halfH + pad, function () {
      doCalibrateSearch(tpl, tTiles, samples, editMode);
    });
  }
  function doCalibrateSearch(tpl, tTiles, samples, editMode) {
    var i;
    // 样本调色板索引（预计算一次；调色板外 → 255，与任何网格值不等 = 永按画错）
    var keyMap = paintIdxMap();
    for (i = 0; i < samples.length; i++) {
      var s0 = samples[i];
      s0.pi = keyMap.get((s0.r << 16) | (s0.g << 8) | s0.b) || 255;
    }
    // 快查网格范围：模板 bounds ± 搜索半径（δ 平移后样本仍落在网格内）
    var bbox = mapTilesBBoxForTpl(tpl);
    var rng = editMode ? 1120 : Math.min(48, Math.max(bbox.maxDx, bbox.maxDy, 0));
    var pad = rng + 8;
    var halfW = (tpl.mx1 - tpl.mx0) * WORLD_PX / 2, halfH = (tpl.my1 - tpl.my0) * WORLD_PX / 2;
    var cx = (tpl.mx0 + tpl.mx1) / 2 * WORLD_PX, cy = (tpl.my0 + tpl.my1) / 2 * WORLD_PX;
    ensurePaintGrid(Math.floor(cx - halfW - pad), Math.floor(cy - halfH - pad),
      Math.ceil(cx + halfW + pad), Math.ceil(cy + halfH + pad), false, function (G) {
        if (!G || G.painted < 24) {
          ST.calibMsg = { ok: false, msg: '画布瓦片数据不足：校准区域整体是海洋/未开放，或网络拉取失败——先把模板放到已画图案附近再校准', t: Date.now() };
          if (editMode) clearCalib();
          finishCalib();
          return;
        }
        calibSearchPhases(tpl, tTiles, samples, editMode, G, rng);
      });
  }
  // 评分平局规则：匹配率相同（±0.005）取 |δ| 小者——纯色区平移自相似会造出同分假峰，
  // 真解 |δ| 通常最小；同时避免画错像素的轻微惩罚让错位峰反超
  function calibSort(a, b) {
    var d = b.m - a.m;
    if (d > 0.005) return 1;
    if (d < -0.005) return -1;
    return (Math.abs(a.dx) + Math.abs(a.dy)) - (Math.abs(b.dx) + Math.abs(b.dy));
  }
  // 一批 δ 的评分（单批 ≤ 约 40 万次网格读，批间 setTimeout 让出主线程）
  function scoreBatch(valid, pts, subStep, G, cb) {
    var res = [], i = 0;
    (function step() {
      var t0 = Date.now();
      while (i < pts.length && Date.now() - t0 < 40) {
        var p = pts[i++];
        res.push({ dx: p[0], dy: p[1], m: scoreOffset(valid, p[0], p[1], subStep, G) });
      }
      if (i < pts.length) setTimeout(step, 0);
      else cb(res);
    })();
  }
  // 显著性守门三档（v2.5.5 放宽：容差匹配后真峰上移，但「成品大量近似色/部分未画」
  // 场景真峰绝对值仍不高，靠与背景的区分度分档接受；拒绝后仍有强制采纳兜底）：
  // 高分突出（m≥0.4 差 0.12）/ 中分较突出（m≥0.3 差 0.22）/ 低分较突出（m≥0.25 差 0.18，
  // 档内 d 上限 = m（bg≥0），第三档参数必须满足 d 上限 < m 才可能触发）
  function calibSignificant(m, bg) {
    return (m >= 0.4 && m - bg >= 0.12) || (m >= 0.3 && m - bg >= 0.22) || (m >= 0.25 && m - bg >= 0.18);
  }
  // 阶梯搜索：峰宽由模板细节密度决定（高细节图案错位 4px+ 匹配率即崩到噪声水平），
  // 粗步长网格踩不到窄峰 → 半径从近到远分级、步长逐级放大，每级做显著性判断，命中即停。
  // 真实场景（模板拖到已画内容附近）绝大多数停在第 1 级（<0.15s）；全级失败才拒绝。
  var CALIB_STAGES = [
    { r: 96, s: 4, sub: 3000 },
    { r: 288, s: 8, sub: 3000 },
    { r: 1120, s: 16, sub: 4000, refine: 12 } // refine：topN 邻域 ±16 步长 8 细化（粗网格错位 ≤8px 可收口）
  ];
  function calibSearchPhases(tpl, tTiles, samples, editMode, G, rng) {
    var stages = editMode ? CALIB_STAGES : [{ r: Math.min(rng, 48), s: 4, sub: 6000 }];
    var si = 0;
    (function runStage() {
      if (si >= stages.length) { calibFinish(tpl, tTiles, samples, editMode, G, null, 0); return; }
      var st = stages[si++];
      var span = Math.ceil(st.r / st.s);
      var pts = [];
      for (var dy = -span; dy <= span; dy++) for (var dx = -span; dx <= span; dx++) pts.push([dx * st.s, dy * st.s]);
      pts.push([0, 0]);
      ST.calibMsg = { ok: null, msg: '⏳ 校准中…（搜索半径 ±' + st.r + '，' + pts.length + ' 个候选位置）', t: Date.now() };
      updateHud();
      scoreBatch(samples, pts, Math.max(1, Math.floor(samples.length / st.sub)), G, function (res) {
        res.sort(calibSort);
        // 背景噪声：距本级最优 >96 世界像素的点最高分（假峰守门用）
        var bg = 0;
        if (res.length) {
          for (var bi = 0; bi < res.length; bi++) {
            var r = res[bi];
            if (Math.abs(r.dx - res[0].dx) > 96 || Math.abs(r.dy - res[0].dy) > 96) { if (r.m > bg) bg = r.m; }
          }
        }
        var cand = res[0];
        var significant = !!cand && calibSignificant(cand.m, bg);
        if (significant || si >= stages.length) {
          // 显著（命中即停）或已到最后一级（用最高分走守门）→ 精搜收口后终点判断
          refineAndFinish(tpl, tTiles, samples, editMode, G, cand, function (best) {
            calibFinish(tpl, tTiles, samples, editMode, G, best, bg);
          });
          return;
        }
        setTimeout(runStage, 0);
      });
    })();
  }
  // 精搜收口：编辑大半径级先做邻域细化（±16 步长 8），再两级精搜（step4 ±8 → step1 ±3）
  function refineAndFinish(tpl, tTiles, samples, editMode, G, seed, cb) {
    if (!seed) { cb(null); return; }
    var subF = Math.max(1, Math.floor(samples.length / 20000));
    var runFine = function (center) {
      var fineA = [];
      for (var fy = -8; fy <= 8; fy += 4) for (var fx = -8; fx <= 8; fx += 4) fineA.push([center.dx + fx, center.dy + fy]);
      ST.calibMsg = { ok: null, msg: '⏳ 校准中…（精搜候选邻域）', t: Date.now() };
      updateHud();
      scoreBatch(samples, fineA, subF, G, function (resA) {
        resA.sort(calibSort);
        var fineB = [];
        for (var fj = 0; fj < Math.min(3, resA.length); fj++) {
          for (var gy = -3; gy <= 3; gy++) for (var gx = -3; gx <= 3; gx++) fineB.push([resA[fj].dx + gx, resA[fj].dy + gy]);
        }
        scoreBatch(samples, fineB, subF, G, function (res3) {
          res3.sort(calibSort);
          cb(res3[0] && res3[0].m >= seed.m - 0.005 ? res3[0] : seed);
        });
      });
    };
    if (!editMode) { runFine(seed); return; }
    var pts = [], seen = {};
    for (var my = -2; my <= 2; my++) for (var mx = -2; mx <= 2; mx++) {
      var px = seed.dx + mx * 8, py = seed.dy + my * 8, k = px + ',' + py;
      if (!seen[k]) { seen[k] = 1; pts.push([px, py]); }
    }
    scoreBatch(samples, pts, subF, G, function (res) {
      res.sort(calibSort);
      runFine(res[0] && res[0].m >= seed.m - 0.005 ? res[0] : seed);
    });
  }
  // 终点：全量统计（fullScan 口径）→ 显著性守门 → 写入校准结果。
  // 拒绝时缓存候选到 ST.calibForce（2 分钟内再点「🎯 校准」= 强制采纳此结果，
  // 用户要求的低门槛兜底；不点「应用对齐」无持久副作用，点「清校准」即可撤销）
  function calibFinish(tpl, tTiles, samples, editMode, G, best, bg) {
    var mFull = 0, stat = null;
    if (best) {
      stat = fullScan(tpl, tTiles, best.dx, best.dy, G);
      mFull = stat.done + stat.wrong > 0 ? stat.done / (stat.done + stat.wrong) : 0;
    }
    // 假峰守门：编辑会话搜索范围大（阶梯至 ±1120），海洋/他人涂鸦的噪声峰可达 30%+
    // （实测 36% 假峰）。接受条件 = 匹配率够高且显著高于背景噪声；普通模式半径小保持原门槛。
    var accept = !!best && (editMode ? calibSignificant(mFull, bg) : mFull >= CALIB_MIN_MATCH);
    if (!accept) {
      if (editMode) clearCalib();
      ST.calibForce = best && editMode ? { t: Date.now(), tplId: tpl.id, best: best, stat: stat, mFull: mFull, editMode: true } : null;
      ST.calibMsg = {
        ok: false,
        msg: '未找到可靠对齐（最高匹配 ' + Math.round(mFull * 100) + '%）：画布上该区域没有与模板对应的已画内容——确认别人已画的部分在模板附近（先在地图上找到它，把模板拖过去）再校准；若参照层实际已对上、只是颜色差异大，再点一次「🎯 校准」强制采纳此结果',
        t: Date.now()
      };
      finishCalib();
      return;
    }
    acceptCalib(tpl, best, stat, mFull, editMode, false, G);
  }
  // 写入校准结果（正常接受与强制采纳共用）
  function acceptCalib(tpl, best, stat, mFull, editMode, forced, G) {
    var lb = editMode && ST.liveTpls.length ? ST.liveTpls[0] : null;
    ST.calib = {
      tplId: tpl.id, tplName: tpl.name,
      dwx: best.dx, dwy: best.dy,
      dmx: best.dx / WORLD_PX, dmy: best.dy / WORLD_PX,
      match: mFull, total: stat.total, done: stat.done, wrong: stat.wrong, missing: stat.missing,
      freeOnly: stat.freeOnly, t: Date.now(), stale: false,
      screen: editMode, // 编辑会话：δ 由大范围搜索得出，参照层平移走 screenScale 分支
      liveBounds: lb ? { mx0: lb.mx0, my0: lb.my0, mx1: lb.mx1, my1: lb.my1 } : null
    };
    ST.progRev++;
    var pct = Math.round(mFull * 100);
    ST.calibMsg = {
      ok: true,
      msg: (forced ? '⚠️ 已强制采纳（低置信）' : '🎯 对齐') + ' δ(' + best.dx + ',' + best.dy + ') 匹配 ' + pct + '% · 已画对 ' + stat.done + ' · 画错 ' + stat.wrong + ' · 未画 ' + stat.missing +
        (stat.freeOnly ? ' · 💡画错像素全部为免费色，色板建议用「免费颜色」' : '') +
        (isLiveId(tpl.id) ? ' · ✏️参照层已平移到对齐位置（移出视野时拖动地图查看）；点官方「应用」保存后自动写入最终位置' : '') +
        (forced ? '——请目视核对参照层位置，不对就点「清校准」' : ''),
      t: Date.now()
    };
    finishCalib();
    // v2.6.0：对齐命中后按已画内容实测官方颜色设置组合，自动切到画手风格
    // （强制采纳不跑：对齐本身未核实，分数不可信；G 为 null 同样跳过）
    if (editMode && !forced && G) detectColorStyle(tpl, best, G, ST.calibMsg ? ST.calibMsg.msg : '');
  }
  // 匹配率评分：模板量化色（预转调色板索引）vs 网格索引（δ 平移后），与官方 auto-paint
  // 一致逐字节精确比较。网格 0 = 画布未涂/无数据 → 不算分母
  // （匹配率 = 已涂像素中的颜色正确率，对齐信号来自已画部分）。
  function scoreOffset(valid, dx, dy, subStep, G) {
    var hit = 0, n = 0;
    for (var i = 0; i < valid.length; i += subStep) {
      var s = valid[i];
      var v = gridAt(G, s.wx + dx, s.wy + dy);
      if (!v) continue;
      n++;
      if (v === s.pi) hit++;
      else if (v >= 129) { if (palTolHit(s.pi, v - 128)) hit++; }
      else if (v < 64) { if (palTolHit(s.pi, v)) hit++; } // 画手用调色板相邻色画（精确是另一索引）
    }
    return n >= 8 ? hit / n : 0;
  }
  function mapTilesBBoxForTpl(tpl) {
    // 已捕获瓦片包围盒（世界像素）与模板 bounds 的最大对称偏移
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var k in ST.mapTiles) {
      var t = ST.mapTiles[k];
      var x0 = t.x * TILE_PX, y0 = t.y * TILE_PX, x1 = x0 + t.w, y1 = y0 + t.h;
      if (x0 < minX) minX = x0; if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1; if (y1 > maxY) maxY = y1;
    }
    if (minX === Infinity) return { maxDx: 0, maxDy: 0 };
    var tx0 = tpl.mx0 * WORLD_PX, ty0 = tpl.my0 * WORLD_PX;
    var tx1 = tpl.mx1 * WORLD_PX, ty1 = tpl.my1 * WORLD_PX;
    return {
      maxDx: Math.round(Math.max(tx0 - minX, maxX - tx1, 0)),
      maxDy: Math.round(Math.max(ty0 - minY, maxY - ty1, 0))
    };
  }
  // 最优 δ 下的全量状态统计 + per 瓦片状态图（Uint8Array: 0=无 1=done 2=wrong 3=missing）
  // G 可省（refreshCalibStats 重算路径）：退回 canvasPixelAt 逐像素查询（有 2s 节流）
  function fullScan(tpl, tTiles, dx, dy, G) {
    var total = 0, done = 0, wrong = 0, missing = 0, wrongFree = 0, wrongN = 0;
    var keyMap = paintIdxMap();
    var fdx = dx / WORLD_PX, fdy = dy / WORLD_PX;
    for (var i = 0; i < tTiles.length; i++) {
      var tt = tTiles[i];
      var st = new Uint8Array(tt.cw * tt.ch);
      tt.stData = st; tt.stT = Date.now();
      // 行内展开 texPxMerc（轴对齐线性映射），220 万像素省去函数调用与数组分配
      var mxBase = tpl.mx0 + tt.TL[0], mxStep = (tt.TR[0] - tt.TL[0]) / tt.cw;
      var myBase = tpl.my0 + tt.TL[1], myStep = (tt.BL[1] - tt.TL[1]) / tt.ch;
      for (var y = 0; y < tt.ch; y++) {
        var my = myBase + (y + 0.5) * myStep + fdy;
        var rowO = y * tt.cw;
        for (var x = 0; x < tt.cw; x++) {
          var o = (rowO + x) * 4;
          if (tt.rgba[o + 3] < 200) continue;
          total++;
          var v, pi = keyMap.get((tt.rgba[o] << 16) | (tt.rgba[o + 1] << 8) | tt.rgba[o + 2]) || 255;
          if (G) {
            // 网格路径：0 = 未涂/无数据/网格外 → 一律按未画（补瓦片已保证范围内有数据）
            v = gridAt(G, Math.floor((mxBase + (x + 0.5) * mxStep + fdx) * WORLD_PX), Math.floor(my * WORLD_PX));
          } else {
            var c = canvasPixelAt(mxBase + (x + 0.5) * mxStep + fdx, my);
            v = c && isPainted(c) ? (keyMap.get((c[0] << 16) | (c[1] << 8) | c[2]) || 255) : 0;
          }
          var stv = 0;
          if (v) {
            if (v === pi) { stv = 1; done++; }
            else if ((v >= 129 && palTolHit(pi, v - 128)) || (v < 64 && palTolHit(pi, v))) { stv = 1; done++; }
            else {
              stv = 2; wrong++;
              wrongN++;
              var vIdx = v === 255 ? nearestPaletteIdx(tt.rgba[o], tt.rgba[o + 1], tt.rgba[o + 2]) : (v >= 129 ? v - 128 : v);
              if (FREE_COLOR_IDX[vIdx]) wrongFree++;
            }
          } else if (G || canvasPixelAt(mxBase + (x + 0.5) * mxStep + fdx, my)) {
            stv = 3; missing++;
          }
          st[rowO + x] = stv;
        }
      }
      tt.stCv = null; // 状态 canvas 惰性重建（drawOverlay）
    }
    return { total: total, done: done, wrong: wrong, missing: missing, freeOnly: wrongN > 0 && wrongFree === wrongN };
  }
  // 校准状态 canvas（叠加在参照层上：done 淡绿 / wrong 红 / missing 淡蓝）
  function statusCanvas(tile) {
    if (tile.stCv && tile.stCvW === tile.cw && tile.stCvH === tile.ch) return tile.stCv;
    if (!tile.stData) return null;
    try {
      var cv = document.createElement('canvas');
      cv.width = tile.cw; cv.height = tile.ch;
      var ctx = cv.getContext('2d');
      var img = ctx.createImageData(tile.cw, tile.ch);
      var d = img.data, s = tile.stData;
      for (var i = 0; i < s.length; i++) {
        var v = s[i], o = i * 4;
        if (v === 1) { d[o] = 36; d[o + 1] = 230; d[o + 2] = 118; d[o + 3] = 70; }
        else if (v === 2) { d[o] = 255; d[o + 1] = 64; d[o + 2] = 64; d[o + 3] = 150; }
        else if (v === 3) { d[o] = 80; d[o + 1] = 140; d[o + 2] = 255; d[o + 3] = 44; }
      }
      ctx.putImageData(img, 0, 0);
      tile.stCv = cv; tile.stCvW = tile.cw; tile.stCvH = tile.ch;
      return cv;
    } catch (e) { return null; }
  }

  // ---------------- 应用对齐：写回官方 template-overlays bounds ----------------
  // 官方 overlay store 启动时读 localStorage（placementSession 期间内存态由官方保存写回），
  // 脚本平移 bounds 后提示刷新页面即可让官方覆盖图精确落到已画内容上。
  function applyCalibToStorage() {
    var c = ST.calib;
    if (!c || !(c.match >= CALIB_MIN_MATCH)) return null;
    var raw = '';
    try { raw = localStorage.getItem('template-overlays') || ''; } catch (e) {}
    if (!raw) return null;
    var arr;
    try { arr = JSON.parse(raw); } catch (e) { return null; }
    if (!Array.isArray(arr)) return null;
    var hit = false;
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      if (!t || t.id !== c.tplId || !t.bounds) continue;
      var b = t.bounds;
      if (c.liveBounds) {
        // 编辑会话校准：基准（liveBounds）是构造值而非官方旧位置 → 直接设置最终位置
        // （已画内容的真实世界范围 = liveBounds + δ），不能在官方 persist 旧值上平移。
        b.west = lngAt((c.liveBounds.mx0 + c.dmx) * WORLD_PX);
        b.east = lngAt((c.liveBounds.mx1 + c.dmx) * WORLD_PX);
        b.north = mercYToLat(c.liveBounds.my0 + c.dmy);
        b.south = mercYToLat(c.liveBounds.my1 + c.dmy);
      } else {
        var wx0 = mx01(b.west) * WORLD_PX + c.dwx, wx1 = mx01(b.east) * WORLD_PX + c.dwx;
        var wy0 = my01(b.north) * WORLD_PX + c.dwy, wy1 = my01(b.south) * WORLD_PX + c.dwy;
        b.west = lngAt(wx0); b.east = lngAt(wx1);
        b.north = mercYToLat(wy0 / WORLD_PX); b.south = mercYToLat(wy1 / WORLD_PX);
      }
      hit = true;
    }
    if (!hit) return null;
    try { localStorage.setItem('template-overlays', JSON.stringify(arr)); } catch (e) { return null; }
    ST.calib.applied = true;
    return true;
  }
  function clearCalib() {
    ST.calib = null; ST.calibMsg = null; ST.calibForce = null; ST.progRev++;
    for (var i = 0; i < ST.tiles.length; i++) { ST.tiles[i].stData = null; ST.tiles[i].stCv = null; }
  }
  // 新画布瓦片到达 / 模板纹理更新后重算统计与状态图（不重跑偏移搜索）。
  // 节流 2s：滚动地图时瓦片接连到达，fullScan 全像素遍历不能每帧跑；
  // 节流期间保留 stale 标记（签名含 |cal' 持续重绘，代价仅为 drawImage）。
  var calibStatT = 0;
  function refreshCalibStats() {
    var c = ST.calib;
    if (!c) return;
    var now = Date.now();
    if (now - calibStatT < 2000) return;
    calibStatT = now;
    var tpl = tplById(c.tplId);
    var tTiles = tpl ? collectTplTiles(c.tplId) : [];
    if (!tpl || !tTiles.length) {
      // live（编辑中模板）随覆盖图收起暂时消失：保留校准结果，等官方恢复渲染后自动接上
      if (!isLiveId(c.tplId)) clearCalib();
      return;
    }
    // 网格范围与校准主流程一致（模板 ± 搜索半径）→ 复用主流程建好的网格；
    // 未命中不现建（拖图路径避免 30MB 重建卡顿），保留 stale 下次再试
    var bbox = mapTilesBBoxForTpl(tpl);
    var rng = c.screen ? 1120 : Math.min(48, Math.max(bbox.maxDx, bbox.maxDy, 0));
    var pad = rng + 8;
    var halfW = (tpl.mx1 - tpl.mx0) * WORLD_PX / 2, halfH = (tpl.my1 - tpl.my0) * WORLD_PX / 2;
    var cx = (tpl.mx0 + tpl.mx1) / 2 * WORLD_PX, cy = (tpl.my0 + tpl.my1) / 2 * WORLD_PX;
    ensurePaintGrid(Math.floor(cx - halfW - pad), Math.floor(cy - halfH - pad),
      Math.ceil(cx + halfW + pad), Math.ceil(cy + halfH + pad), true, function (G) {
        if (!G) { c.stale = true; return; }
        c.stale = false;
        var stat = fullScan(tpl, tTiles, c.dwx, c.dwy, G);
        c.total = stat.total; c.done = stat.done; c.wrong = stat.wrong; c.missing = stat.missing; c.freeOnly = stat.freeOnly;
        // match 一并刷新：风格识别切换颜色设置后 done/wrong 变化，match 门槛管着「应用对齐」按钮
        c.match = stat.done + stat.wrong > 0 ? stat.done / (stat.done + stat.wrong) : 0;
        ST.progRev++;
      });
  }

  // ---------------- v2.6.0 颜色风格自动识别（编辑会话） ----------------
  // 已画内容隐含画手使用的官方颜色设置（Color palette × Color Mode × Dithering）。
  // 不逆向官方量化算法：对齐命中后逐组合切换官方控件 → 等编辑器 canvas 重渲染 →
  // 快照 → 与已画网格比对精确吻合率，实测择优。切组合只改模板预览渲染（δ 对齐不受
  // 影响）；最终保留最优组合（可能= 原组合），官方「应用」保存时随模板一起写入。
  var STYLE_MIN_PAINTED = 30; // 已画采样低于此不识别（噪声主导，择优无意义）
  var STYLE_SKIP_RATE = 0.92; // 当前设置下已画吻合率 ≥ 此值：已是画手风格，不动 UI
  var STYLE_MARGIN = 0.04;    // 候选须比当前最优高至少此值才切换（小样本防抖动）
  function styleFindTriggers() {
    // 官方编辑器一对下拉 = button.select-trigger + 同 fieldset 内 ul.select-menu。
    // aria-label 随界面语言本地化 → 先按 label 匹配（Mode/palette），退化按面板顺序
    //（Color Mode 在前、Color palette 在后，实测全页仅这两个 select-trigger）
    var list = [], mode = null, pal = null;
    try {
      var btns = document.querySelectorAll('button.select-trigger[aria-haspopup="menu"]');
      for (var i = 0; i < btns.length; i++) {
        var b = btns[i];
        if (b.offsetWidth > 0 && b.offsetHeight > 0) list.push(b);
      }
      for (var j = 0; j < list.length; j++) {
        var lb = (list[j].getAttribute('aria-label') || '').toLowerCase();
        if (lb.indexOf('mode') >= 0) mode = list[j];
        else if (lb.indexOf('palette') >= 0) pal = list[j];
      }
      if (!mode && list.length >= 2) { mode = list[0]; pal = list[1]; }
    } catch (e) {}
    return mode && pal ? { mode: mode, pal: pal } : null;
  }
  function styleMenuItems(trig) {
    try {
      var fs = trig.closest('fieldset');
      return (fs || document).querySelectorAll('button[role="menuitemradio"]');
    } catch (e) { return []; }
  }
  // 打开菜单读取项文案与当前选中索引（文案随语言本地化，索引与 aria-checked 与语言无关）
  function styleOpenMenu(trig, cb) {
    try {
      if (trig.getAttribute('aria-expanded') !== 'true') trig.click();
    } catch (e) { cb(false, [], -1); return; }
    var t0 = Date.now();
    (function poll() {
      var items = styleMenuItems(trig), texts = [], cur = -1, vis = false;
      try { vis = items.length > 0 && items[0].offsetWidth > 0; } catch (e) {}
      if (vis) {
        for (var i = 0; i < items.length; i++) {
          texts.push((items[i].textContent || '').trim());
          if (items[i].getAttribute('aria-checked') === 'true') cur = i;
        }
        if (cur >= 0) { cb(true, texts, cur); return; }
      }
      if (Date.now() - t0 > 1200) { cb(false, [], -1); return; }
      setTimeout(poll, 70);
    })();
  }
  // 切下拉到第 idx 项；已是目标项则只收起菜单。cb(ok)
  function styleSetSelect(trig, idx, cb) {
    styleOpenMenu(trig, function (ok, texts, cur) {
      if (!ok) { cb(false); return; }
      if (cur === idx) { try { trig.click(); } catch (e) {} cb(true); return; }
      var it = styleMenuItems(trig)[idx];
      try { it.click(); } catch (e) { try { trig.click(); } catch (e2) {} cb(false); return; }
      var t0 = Date.now();
      (function waitClose() {
        var open = false;
        try { open = trig.getAttribute('aria-expanded') === 'true'; } catch (e) {}
        if (!open) { cb(true); return; }
        if (Date.now() - t0 > 1200) { try { trig.click(); } catch (e) {} cb(false); return; }
        setTimeout(waitClose, 60);
      })();
    });
  }
  function styleCanvasSig() {
    var cv = editOverlayEl();
    if (!cv) return null;
    try {
      var ctx = cv.getContext('2d');
      if (!ctx) return null;
      var d = ctx.getImageData(0, 0, cv.width, cv.height).data;
      var h = 0;
      for (var i = 0; i < d.length; i += 64) h = (h * 33 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0;
      return h + '#' + d.length;
    } catch (e) { return null; }
  }
  // 等官方编辑器按新设置重渲染：canvas 签名变化或超时（等价组合不变化 → 走满超时），
  // 之后统一留 150ms 收尾（Svelte 重渲染到像素写入可能跨帧）
  function styleWaitRender(prevSig, cb) {
    var t0 = Date.now();
    (function poll() {
      var sig = styleCanvasSig();
      if ((sig && sig !== prevSig) || Date.now() - t0 > 1000) { setTimeout(cb, 150); return; }
      setTimeout(poll, 90);
    })();
  }
  function styleSnapshot() {
    var cv = editOverlayEl();
    if (!cv) return null;
    try {
      var cv2 = document.createElement('canvas');
      cv2.width = cv.width; cv2.height = cv.height;
      var ctx = cv2.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(cv, 0, 0);
      return ctx.getImageData(0, 0, cv2.width, cv2.height).data;
    } catch (e) { return null; }
  }
  // 精确吻合率（区别于 fullScan 的容差命中）：风格择优要求判别力——画手设置的正确
  // 组合会让模板渲染与已画像素逐字节相等，错误组合只会偶合。ov = 候选组合的快照
  //（省则用 tTiles 现有纹理）。网格 v≥129/255 为非精确编码，必不算命中
  function styleScan(tpl, tTiles, dx, dy, G, ov) {
    var keyMap = paintIdxMap(), painted = 0, exact = 0;
    var fdx = dx / WORLD_PX, fdy = dy / WORLD_PX;
    for (var i = 0; i < tTiles.length; i++) {
      var tt = tTiles[i], src = ov || tt.rgba;
      if (!tt.cw || !src) continue;
      var mxBase = tpl.mx0 + tt.TL[0], mxStep = (tt.TR[0] - tt.TL[0]) / tt.cw;
      var myBase = tpl.my0 + tt.TL[1], myStep = (tt.BL[1] - tt.TL[1]) / tt.ch;
      var step = Math.max(1, Math.round(Math.sqrt(tt.cw * tt.ch / 12000)));
      for (var y = 0; y < tt.ch; y += step) {
        var wy = Math.floor((myBase + (y + 0.5) * myStep + fdy) * WORLD_PX);
        for (var x = 0; x < tt.cw; x += step) {
          var o = (y * tt.cw + x) * 4;
          if (src[o + 3] < 200) continue;
          var v = gridAt(G, Math.floor((mxBase + (x + 0.5) * mxStep + fdx) * WORLD_PX), wy);
          if (!v) continue;
          painted++;
          var pi = keyMap.get((src[o] << 16) | (src[o + 1] << 8) | src[o + 2]) || 255;
          if (v < 64 && v === pi) exact++;
        }
      }
    }
    return { painted: painted, exact: exact, rate: painted ? exact / painted : 0 };
  }
  function detectColorStyle(tpl, best, G, baseMsg) {
    if (ST.styleBusy) return;
    var tTiles = collectTplTiles(LIVE_ID);
    var trigs = styleFindTriggers();
    if (!G || !tTiles.length || !trigs) return; // 非编辑会话/面板控件缺失：静默跳过
    var baseRgba = styleSnapshot();
    var base = baseRgba ? styleScan(tpl, tTiles, best.dx, best.dy, G, baseRgba) : { painted: 0, rate: 0 };
    if (base.painted < STYLE_MIN_PAINTED || base.rate >= STYLE_SKIP_RATE) return;
    ST.styleBusy = true;
    var aborted = function () { return !ST.calib || !ST.editTile || !editOverlayEl(); };
    function say(txt) {
      // calibMsg 仍以 acceptCalib 文案开头才追加（用户清校准/强制流程后不误写）
      if (ST.calibMsg && baseMsg && ST.calibMsg.msg.indexOf(baseMsg) === 0) {
        ST.calibMsg.msg = baseMsg + ' · ' + txt;
        ST.calibMsg.t = Date.now();
        updateHud();
      }
    }
    // 读当前组合（菜单项文案本地化，用索引）；任一失败 → 放弃不动 UI
    styleOpenMenu(trigs.pal, function (okP, palTexts, curP) {
      if (!okP || aborted()) { ST.styleBusy = false; return; }
      try { trigs.pal.click(); } catch (e) {} // 收起
      styleOpenMenu(trigs.mode, function (okM, modeTexts, curM) {
        if (!okM || aborted()) { ST.styleBusy = false; return; }
        try { trigs.mode.click(); } catch (e) {}
        var combos = [], p, m;
        for (p = 0; p < palTexts.length && p < 3; p++)
          for (m = 0; m < modeTexts.length && m < 3; m++)
            if (!(p === curP && m === curM)) combos.push([p, m]);
        var bestR = { rate: base.rate, p: curP, m: curM, isBase: true, ditherOn: null };
        var dither0 = null;
        try {
          var inp0 = document.querySelector('label.dithering input[type="checkbox"]');
          dither0 = inp0 ? !!inp0.checked : null;
        } catch (e) {}
        bestR.ditherOn = dither0;
        var i = 0, t0 = Date.now();
        function stepCombo() {
          if (aborted() || Date.now() - t0 > 45000) { wrapup(); return; }
          if (i >= combos.length) {
            // 终门：候选须比原设置高 STYLE_MARGIN 才值得动 UI（扫描期 0.005 只用于追踪最高分，
            // 已画样本少时 1 个像素就是几个百分点，防把噪声当改善）
            if (!bestR.isBase && bestR.rate < base.rate + STYLE_MARGIN)
              bestR = { rate: base.rate, p: curP, m: curM, isBase: true, ditherOn: dither0 };
            return ditherPhase();
          }
          var c = combos[i++];
          say('🎨 识别画手颜色设置中（' + i + '/' + combos.length + '）…');
          var preSig = styleCanvasSig();
          styleSetSelect(trigs.pal, c[0], function (ok1) {
            styleSetSelect(trigs.mode, c[1], function (ok2) {
              if (!ok1 || !ok2 || aborted()) return stepCombo(); // 切换失败：该组合不计分
              styleWaitRender(preSig, function () {
                var rgba = styleSnapshot();
                if (rgba && !aborted()) {
                  var r = styleScan(tpl, tTiles, best.dx, best.dy, G, rgba);
                  if (r.rate > bestR.rate + 0.005) bestR = { rate: r.rate, p: c[0], m: c[1], isBase: false, ditherOn: bestR.ditherOn };
                }
                setTimeout(stepCombo, 30);
              });
            });
          });
        }
        // 抖动开关（label.dithering > input[type=checkbox]）：在当前最优组合上试切一次
        function ditherPhase() {
          var inp = null;
          try { inp = document.querySelector('label.dithering input[type="checkbox"]'); } catch (e) {}
          if (!inp || aborted()) return wrapup();
          var want = !inp.checked;
          say('🎨 识别画手颜色设置中：试抖动' + (want ? '开' : '关') + '…');
          var preSig = styleCanvasSig();
          try { inp.click(); } catch (e) { return wrapup(); }
          styleWaitRender(preSig, function () {
            var rgba = styleSnapshot();
            var keep = false;
            if (rgba && !aborted()) {
              var r = styleScan(tpl, tTiles, best.dx, best.dy, G, rgba);
              keep = r.rate > bestR.rate + STYLE_MARGIN;
              if (keep) bestR = { rate: r.rate, p: bestR.p, m: bestR.m, isBase: false, ditherOn: want };
            }
            if (!keep) { try { inp.click(); } catch (e) {} } // 切回
            setTimeout(wrapup, 200);
          });
        }
        function setDither(val, cb) {
          var inp = null;
          try { inp = document.querySelector('label.dithering input[type="checkbox"]'); } catch (e) {}
          if (!inp || inp.checked === val) return cb();
          var preSig = styleCanvasSig();
          try { inp.click(); } catch (e) { return cb(); }
          styleWaitRender(preSig, cb);
        }
        function wrapup() {
          if (aborted()) { ST.styleBusy = false; return; }
          function finishMsg(improved) {
            if (improved) {
              say('🎨 已按已画内容自动匹配官方颜色设置：色板「' + (palTexts[bestR.p] || '?') +
                '」· 模式「' + (modeTexts[bestR.m] || '?') + '」' +
                (dither0 !== null && bestR.ditherOn !== dither0 ? '· 抖动' + (bestR.ditherOn ? '开' : '关') + ' ' : '') +
                '（已画吻合 ' + Math.round(base.rate * 100) + '%→' + Math.round(bestR.rate * 100) +
                '%）——官方「应用」会随模板保存');
            } else {
              say('🎨 已实测 ' + (combos.length + 1) + ' 种颜色设置组合：当前设置与已画内容最吻合（' +
                Math.round(base.rate * 100) + '%）');
            }
          }
          if (!bestR.isBase) {
            // 收口到最优组合：切换后等重渲染，再强制重快照刷新参照层与统计。
            // 须先释放 styleBusy 再 syncEditOverlay（周期快照守卫会跳过识别中的快照）
            var preSig = styleCanvasSig();
            styleSetSelect(trigs.pal, bestR.p, function () {
              styleSetSelect(trigs.mode, bestR.m, function () {
                setDither(bestR.ditherOn === true, function () {
                  if (aborted()) { ST.styleBusy = false; return; }
                  styleWaitRender(preSig, function () {
                    ST.styleBusy = false;
                    var t = ST.editTile;
                    if (t) { t.snapSig = null; editSnapT = 0; syncEditOverlay(); }
                    finishMsg(true);
                  });
                });
              });
            });
          } else {
            // 无更优组合：测试把 canvas 留在最后一个候选（或试开的抖动）上，切回原组合
            styleSetSelect(trigs.pal, curP, function () {
              styleSetSelect(trigs.mode, curM, function () {
                setDither(dither0 === true, function () {
                  ST.styleBusy = false;
                  finishMsg(false);
                });
              });
            });
          }
        }
        stepCombo();
      });
    });
  }

  // ---------------- 模板元数据（localStorage['template-overlays']） ----------------
  function buildTplList() {
    var raw = '';
    try { raw = localStorage.getItem('template-overlays') || ''; } catch (e) {}
    var tpls = [];
    try {
      if (raw) {
        var o = JSON.parse(raw);
        var arr = Array.isArray(o) ? o : (o && Array.isArray(o.templates) ? o.templates : []);
        for (var i = 0; i < arr.length; i++) {
          var t = arr[i], b = t && t.bounds;
          if (!b || typeof b.north !== 'number' || typeof b.south !== 'number' ||
              typeof b.west !== 'number' || typeof b.east !== 'number') continue;
          if (typeof t.originalWidth !== 'number' || typeof t.originalHeight !== 'number') continue;
          if (!(b.east > b.west) || !(b.north > b.south)) continue;
          tpls.push({
            id: t.id, name: t.name || '覆盖图',
            west: b.west, north: b.north, south: b.south, east: b.east,
            mx0: mx01(b.west), mx1: mx01(b.east),
            my0: my01(b.north), my1: my01(b.south),
            w: t.originalWidth, h: t.originalHeight,
            visible: t.visible !== false,
            order: typeof t.order === 'number' ? t.order : 0,
            updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : 0
          });
        }
      }
    } catch (e) {}
    tpls.sort(function (a, b) { return b.order - a.order; });
    return tpls;
  }
  function loadTemplates() {
    var raw = '';
    try { raw = localStorage.getItem('template-overlays') || ''; } catch (e) {}
    if (raw === ST.tplRaw) return;
    ST.tplRaw = raw;
    ST.templates = buildTplList().concat(ST.liveTpls || []); // live 条目（编辑中模板）始终保留
    ST.tilesRev++;
    attachUnbound();
    updateHud();
  }

  // ---------------- hook localStorage.setItem：捕获 location 写入（校准数据源） ----------------
  function hookSetItem() {
    try {
      var storage = uw.localStorage;
      var origSetItem = storage.setItem.bind(storage);
      var patched = function (k, v) {
        try {
          if (k === 'location') {
            var loc = null;
            try { loc = JSON.parse(v); } catch (e) {}
            if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number' && typeof loc.zoom === 'number') {
              ST.pendingLoc = { loc: loc, t: Date.now() };
              consumeLocation();
            }
          } else if (k === 'template-overlays') {
            // 官方 persist（放置「应用」/设置变更）→ 立即重读，live 虚拟模板得以迁移到真实 id
            if (v !== ST.tplRaw) {
              ST.persistT = Date.now();
              loadTemplates();
            }
          }
        } catch (e) {}
        return origSetItem(k, v);
      };
      var proto = uw.Storage.prototype;
      var orig = proto.setItem;
      if (!orig.__wpAC) {
        patched.__wpAC = true;
        proto.setItem = patched;
      }
    } catch (e) {}
  }
  function consumeLocation() {
    var p = ST.pendingLoc;
    if (!p) return;
    var el = mapContainerRect();
    if (!el) return; // 容器未就绪：保留 pendingLoc，由重试定时器消费
    ST.pendingLoc = null; // 一次性消费
    // location 永远是地图中心（官方语义）→ 锚点必须用画布中心与它配对。
    // 早期版本曾把中心经纬安到点击点坐标上（点击锚），导致取色恒定偏移。
    ST.anchor = { x: el.cx, y: el.cy, lat: p.loc.lat, lng: p.loc.lng, zoom: p.loc.zoom, kind: 'center' };
    ST.viewDX = 0; ST.viewDY = 0;
    ST.suspect = false;
    updateHud();
  }

  // ---------------- 地图容器识别 ----------------
  function mapContainerRect() {
    var el = document.querySelector('.maplibregl-canvas-container') || document.querySelector('.maplibregl-map');
    if (!el) return null;
    var r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, el: el };
  }
  function insideMap(el) {
    while (el) {
      if (el.classList && (el.classList.contains('maplibregl-canvas-container') || el.classList.contains('maplibregl-map'))) return true;
      el = el.parentElement;
    }
    return false;
  }

  // ---------------- 事件：点击校准 / 拖动跟踪 / 视图突变 / 点击换色 / 参照层操控 ----------------
  document.addEventListener('click', function (e) {
    if (e.ctrlKey) { e.stopPropagation(); return; } // Ctrl+点击 = 参照层定位，不放像素、不换色
    if (!insideMap(e.target)) return;
    // 点击换色模式：必须在官方处理该点击（用当前色放像素）之前完成换色，
    // 因此挂捕获阶段，且只在非拖动点击时触发（校准门槛在 pickColorAt 内统一处理）
    if (!S.hoverMode && S.enabled && ST.tiles.length &&
        ST.press && Math.abs(ST.press.x - e.clientX) + Math.abs(ST.press.y - e.clientY) < 6) {
      var hit = pickColorAt(e.clientX, e.clientY);
      if (hit && hit.status !== 1) { // 已画对的像素不换色（校准状态才有 status）
        var idx = nearestPaletteIdx(hit.rgb[0], hit.rgb[1], hit.rgb[2]);
        selectColor(idx);
        updateHudColor(idx, hit.rgb, hit);
      }
    }
    ST.lastMapClick = { x: e.clientX, y: e.clientY, t: Date.now() };
    setTimeout(consumeLocation, 60);
  }, true);

  // Ctrl+拖拽移动参照层：在地图上按住 Ctrl 左键拖动；未定位时首次按下即定位（点击点 = 参照层左上角）。
  // 拦截挂在 pointerdown/pointerup/mousedown/mouseup/click 五类事件上：官方可能监听其中任意一类放像素。
  var ovDrag = null;
  function startOvDrag(e) {
    ensureOverlayCanvas();
    ST.ovGone = false; // 手动定位即恢复参照层（用户主动操作）
    var r = ovCanvas && ovCanvas.isConnected ? ovCanvas.getBoundingClientRect() : null;
    if (!r) return;
    if (!OV.placed) {
      OV.placed = true;
      OV.x = e.clientX - r.left; OV.y = e.clientY - r.top;
      ovSig = '';
      updateHud(); // 立即反馈定位成功，不等 4s 定时刷新
    }
    ovDrag = { sx: e.clientX, sy: e.clientY, ox: OV.x, oy: OV.y };
    e.preventDefault();
    e.stopImmediatePropagation(); // 不触发地图拖动/放像素
  }
  document.addEventListener('pointerdown', function (e) {
    if (e.button !== 0 || e.pointerType === 'touch' || !e.ctrlKey || !insideMap(e.target)) return;
    if (S.overlay && ST.tiles.length) startOvDrag(e);
  }, true);
  document.addEventListener('pointerup', function (e) {
    if (ovDrag && e.button === 0) { e.preventDefault(); e.stopImmediatePropagation(); ovDrag = null; }
  }, true);
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0 || !insideMap(e.target)) return;
    if (ovDrag) return;
    if (e.ctrlKey && S.overlay && ST.tiles.length) { startOvDrag(e); return; }
    ST.dragging = true; ST.dragLast = { x: e.clientX, y: e.clientY };
    ST.press = { x: e.clientX, y: e.clientY };
  }, true);
  document.addEventListener('mousemove', function (e) {
    ST.mouse = { x: e.clientX, y: e.clientY };
    if (ovDrag) {
      OV.x = ovDrag.ox + (e.clientX - ovDrag.sx);
      OV.y = ovDrag.oy + (e.clientY - ovDrag.sy);
      ovSig = '';
      schedulePick();
      return;
    }
    if (ST.dragging && ST.dragLast) {
      ST.viewDX += e.clientX - ST.dragLast.x;
      ST.viewDY += e.clientY - ST.dragLast.y;
      ST.dragLast = { x: e.clientX, y: e.clientY };
      ST.lastMapMove = Date.now(); // 拖动地图：交互信号（滚动/键盘在 markSuspect 里记）
    }
    schedulePick();
  }, true);
  document.addEventListener('mouseup', function (e) {
    if (e.button !== 0) return;
    if (ovDrag) { ovDrag = null; return; }
    if (ST.dragging) { ST.dragging = false; ST.dragLast = null; }
  }, true);

  // 触摸（移动端）：单指拖动地图与鼠标拖动同口径累计视图位移——校准的 viewDX/viewDY 在触摸端全靠它；
  // passive 不拦截（官方地图要跟手），tap 无位移时合成 click 仍走点击换色/定位链路。
  // 参照层手动拖动（桌面 Ctrl+拖）无对应触摸手势，移动端定位靠 location 自动校准
  document.addEventListener('touchstart', function (e) {
    if (!e.touches || !e.touches.length || !insideMap(e.target)) return;
    if (e.touches.length > 1) { ST.dragging = false; ST.dragLast = null; return; } // 双指=官方捏合缩放，不跟踪
    var t = e.touches[0];
    ST.dragging = true; ST.dragLast = { x: t.clientX, y: t.clientY };
    ST.press = { x: t.clientX, y: t.clientY };
  }, { capture: true, passive: true });
  document.addEventListener('touchmove', function (e) {
    if (!e.touches || !e.touches.length || !insideMap(e.target)) return;
    if (ST.dragging && ST.dragLast && e.touches.length === 1) {
      var t = e.touches[0];
      ST.viewDX += t.clientX - ST.dragLast.x;
      ST.viewDY += t.clientY - ST.dragLast.y;
      ST.dragLast = { x: t.clientX, y: t.clientY };
      ST.lastMapMove = Date.now(); // 拖动地图：交互信号（与鼠标拖动同口径）
    }
    if (e.touches.length >= 2) markSuspect(); // 双指捏合缩放：视图即将重绘
  }, { capture: true, passive: true });
  document.addEventListener('touchend', function () {
    if (ST.dragging) { ST.dragging = false; ST.dragLast = null; }
  }, { capture: true, passive: true });

  function markSuspect() {
    ST.lastMapMove = Date.now(); // 视图交互：地图即将重绘，用作覆盖图存活检测的交互信号
    if (!ST.suspect) { ST.suspect = true; updateHud(); }
  }
  document.addEventListener('wheel', function (e) {
    // Alt+滚轮：绕鼠标位置缩放参照层（拦截，官方地图不缩放）
    if (e.altKey && S.overlay && OV.placed && insideMap(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      ovZoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.1 : 1 / 1.1);
      return;
    }
    if (insideMap(e.target)) markSuspect();
  }, { capture: true, passive: false });
  document.addEventListener('keydown', function (e) {
    if (e.key && e.key.indexOf('Arrow') === 0) markSuspect();
  }, true);
  // Ctrl+Shift+H：折叠/展开状态窗——界面无论被折叠成多小、拖到哪里，一键找回
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
      S.collapsed = !S.collapsed; saveSettings(); applyHudCollapsed(); updateHud();
    }
    // Esc：退出框选/停止补画（官方绘画模式下 Esc 无其他绑定）
    if (e.key === 'Escape' && BP) {
      if (BP.phase === 'box') { bpBoxCleanup(); bpAbort(); }
      else if (BP.phase === 'run' || BP.phase === 'confirm') bpSecondary();
    }
  }, true);

  // ---------------- 取色 + 自动选色 ----------------
  // 屏幕坐标 → 模板像素 → RGB。优先级：
  //   1) 官方渲染几何重放（与官方覆盖图逐帧同步，最精确）
  //   2) 手动参照层几何（官方层未渲染时的兜底）
  //   3) location 自动校准链路（屏幕 → 世界像素 → 归一化 Mercator → 模板 → 瓦片 → 像素）
  function pickColorAt(mxx, myy) {
    if (ST.ovGone) return null; // 官方覆盖图已停止渲染：无参照意义，禁止自动换色
    var hit = pickColorAtOfficial(mxx, myy);
    if (hit) return hit;
    if (OV.placed && OV.tiles.length) return pickColorAtManual(mxx, myy);
    if (!ST.anchor || ST.suspect) return null;
    var wS = 512 * Math.pow(2, ST.anchor.zoom);
    var ax = lngToWX(ST.anchor.lng, wS);
    var ay = latToWY(ST.anchor.lat, wS);
    // 拖动时地图内容跟手位移 +viewDX：屏幕 mxx 处的内容 = 校准时 (mxx - viewDX) 处的内容
    var wx = (ax + (mxx - ST.viewDX - ST.anchor.x)) / wS; // 归一化 Mercator
    var wy = (ay + (myy - ST.viewDY - ST.anchor.y)) / wS;
    for (var i = 0; i < ST.templates.length; i++) {
      var t = ST.templates[i];
      if (!t.visible) continue;
      for (var j = 0; j < ST.tiles.length; j++) {
        var tile = ST.tiles[j];
        if (tile.tplId !== t.id) continue;
        var x0 = tile.TL[0] + t.mx0, x1 = tile.TR[0] + t.mx0;
        var y0 = tile.TL[1] + t.my0, y1 = tile.BL[1] + t.my0;
        if (wx < x0 || wx > x1 || wy < y0 || wy > y1) continue;
        var u = (wx - x0) / (x1 - x0);
        var v = (wy - y0) / (y1 - y0);
        var cpx = Math.min(tile.cw - 1, Math.max(0, Math.floor(u * tile.cw)));
        var cpy = Math.min(tile.ch - 1, Math.max(0, Math.floor(v * tile.ch)));
        var o = (cpy * tile.cw + cpx) * 4;
        if (tile.rgba[o + 3] < 8) continue; // 透明 → 下一瓦片/层
        return { rgb: [tile.rgba[o], tile.rgba[o + 1], tile.rgba[o + 2]], name: t.name };
      }
    }
    return null;
  }
  // 官方几何取色：屏幕点经官方屏幕四边形仿射反解 → 源像素（与 drawOverlay 的正变换互逆）。
  // 校准生效时：参照层把源像素 s' 画在官方 (u,v)+δ 处，因此反解 s'=(u,v)-δ_src；
  // 同时用鼠标点的真实世界位置查画布已有色，返回 done/wrong/missing 状态（改正颜色的依据）。
  function pickColorAtOfficial(mxx, myy) {
    for (var i = ST.tiles.length - 1; i >= 0; i--) { // 后绘制者在上层
      var t = ST.tiles[i];
      if (!t.scrQuad) continue;
      var q = t.scrQuad;
      var ax = (q[1][0] - q[0][0]) / t.cw, ay = (q[1][1] - q[0][1]) / t.cw;
      var bx = (q[3][0] - q[0][0]) / t.ch, by = (q[3][1] - q[0][1]) / t.ch;
      var det = ax * by - ay * bx;
      if (Math.abs(det) < 1e-12) continue;
      var dx = mxx - q[0][0], dy = myy - q[0][1];
      var u = (dx * by - dy * bx) / det, v = (dy * ax - dx * ay) / det;
      if (u < 0 || v < 0 || u >= t.cw || v >= t.ch) continue;
      var calibHit = ST.calib && t.tplId === ST.calib.tplId;
      if (calibHit) {
        var dux = ST.calib.dmx / (t.TR[0] - t.TL[0]) * t.cw; // δ(Mercator) → 本瓦片源像素
        var dvy = ST.calib.dmy / (t.BL[1] - t.TL[1]) * t.ch;
        u -= dux; v -= dvy;
        if (u < 0 || v < 0 || u >= t.cw || v >= t.ch) continue;
      }
      var p = ((v | 0) * t.cw + (u | 0)) * 4;
      if (t.rgba[p + 3] < 8) continue; // 透明 → 下一瓦片/层
      var name = '覆盖图';
      if (t.tplId !== null) {
        var tpl = tplById(t.tplId);
        if (tpl) name = tpl.name;
      }
      var status = 0, canvasRgb = null;
      if (calibHit && tpl) {
        // 鼠标屏幕点的真实画布位置 = 官方几何下源像素的 Mercator（u/v 已减 δ，加回即官方坐标）
        var dux2 = ST.calib.dmx / (t.TR[0] - t.TL[0]) * t.cw;
        var dvy2 = ST.calib.dmy / (t.BL[1] - t.TL[1]) * t.ch;
        var mmx = tpl.mx0 + t.TL[0] + (t.TR[0] - t.TL[0]) * (u + dux2 + 0.5) / t.cw;
        var mmy = tpl.my0 + t.TL[1] + (t.BL[1] - t.TL[1]) * (v + dvy2 + 0.5) / t.ch;
        canvasRgb = canvasPixelAt(mmx, mmy);
        if (canvasRgb) {
          if (!isPainted(canvasRgb)) status = 3; // 未画（alpha=0）
          else if (sameColor(canvasRgb, t.rgba[p], t.rgba[p + 1], t.rgba[p + 2])) status = 1; // 已画对（与官方逐字节一致）
          else status = 2; // 画错 → 改正
        }
      }
      return { rgb: [t.rgba[p], t.rgba[p + 1], t.rgba[p + 2]], name: name, status: status, canvasRgb: canvasRgb };
    }
    return null;
  }

  function schedulePick() {
    if (ST.pickPending) return;
    if (BP && (BP.phase === 'run' || BP.phase === 'pause' || BP.phase === 'wait')) return; // 补画引擎的合成 mousemove 不做悬停换色
    ST.pickPending = true;
    requestAnimationFrame(function () {
      ST.pickPending = false;
      if (!S.enabled || ST.dragging || !ST.mouse) return;
      var under = document.elementFromPoint(ST.mouse.x, ST.mouse.y);
      if (!under || !insideMap(under)) { updateHudColor(0); return; }
      if (!ST.tiles.length) return;
      if (!scrQuadCount() && !OV.placed && (!ST.anchor || ST.suspect)) return; // 官方几何/手动模式不受校准状态限制
      var hit = pickColorAt(ST.mouse.x, ST.mouse.y);
      if (hit) {
        var idx = nearestPaletteIdx(hit.rgb[0], hit.rgb[1], hit.rgb[2]);
        // 校准状态下：已画对的像素不再换色（别人已画好/自己已画过，避免无意义切换）；
        // 画错的像素正常选目标色（指哪改哪），HUD 显示画布色对比。
        var skip = hit.status === 1;
        if (S.hoverMode && !skip) selectColor(idx);
        updateHudColor(idx, hit.rgb, hit);
      } else {
        updateHudColor(0);
      }
    });
  }
  function scrQuadCount() {
    var n = 0;
    for (var i = 0; i < ST.tiles.length; i++) if (ST.tiles[i].scrQuad) n++;
    return n;
  }

  // ---------------- 手动参照层（Ctrl+点击定位 / Ctrl+拖动移动 / Alt+滚轮缩放） ----------------
  // 拼合显示已捕获的模板纹理块：同模板瓦片共享 origin，相对几何（四角偏移差）恒正确，
  // 因此不依赖自动校准；定位后取色直接按参照层几何计算，与显示完全一致。
  var ovCanvas = null, ovCtx = null, ovSig = '';
  var OV = { placed: false, x: 0, y: 0, scale: 0, tiles: [], rev: -1, name: '覆盖图', spanX: 0, spanY: 0 };
  function ensureOverlayCanvas() {
    if (ovCanvas && ovCanvas.isConnected) return true;
    var host = document.querySelector('.maplibregl-canvas-container') || document.querySelector('.maplibregl-map');
    if (!host) return false;
    ovCanvas = document.createElement('canvas');
    ovCanvas.id = 'wpAC-overlay';
    // position:fixed —— 官方 maplibregl-canvas-container 在部分页面高度塌陷为 0，
    // absolute+100% 会得到 0 尺寸画布导致永远画不出；fixed 直接对齐视口，坐标即 clientX/Y 系
    ovCanvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:1;';
    ovCtx = ovCanvas.getContext('2d');
    host.appendChild(ovCanvas);
    return true;
  }
  function tileCanvas(tile) {
    if (tile.cv) return tile.cv;
    try {
      var cv = document.createElement('canvas');
      cv.width = tile.cw; cv.height = tile.ch;
      var ctx = cv.getContext('2d');
      var img = ctx.createImageData(tile.cw, tile.ch);
      img.data.set(tile.rgba);
      ctx.putImageData(img, 0, 0);
      tile.cv = cv;
      return cv;
    } catch (e) { return null; }
  }
  function tplById(id) {
    for (var i = 0; i < ST.templates.length; i++) if (ST.templates[i].id === id) return ST.templates[i];
    return null;
  }
  function buildOvTiles() {
    OV.rev = ST.tilesRev;
    var gTiles = [], gName = '覆盖图', useAbs = false;
    // 优先显示第一个（order 最高）可见且可归属的模板组；否则用未归属瓦片（相对偏移当坐标）
    for (var i = 0; i < ST.templates.length && !gTiles.length; i++) {
      var t = ST.templates[i];
      if (!t.visible) continue;
      for (var j = 0; j < ST.tiles.length; j++) if (ST.tiles[j].tplId === t.id) gTiles.push(ST.tiles[j]);
      if (gTiles.length) { gName = t.name; useAbs = true; }
    }
    if (!gTiles.length) {
      for (var j2 = 0; j2 < ST.tiles.length; j2++) if (!ST.tiles[j2].tplId) gTiles.push(ST.tiles[j2]);
    }
    if (!gTiles.length) { OV.tiles = []; return; }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    var rects = [];
    for (var k = 0; k < gTiles.length; k++) {
      var tile = gTiles[k], x0, y0, x1, y1;
      if (useAbs) {
        var t2 = tplById(tile.tplId);
        if (!t2) continue;
        x0 = tile.TL[0] + t2.mx0; x1 = tile.TR[0] + t2.mx0;
        y0 = tile.TL[1] + t2.my0; y1 = tile.BL[1] + t2.my0;
      } else {
        x0 = tile.TL[0]; x1 = tile.TR[0]; y0 = tile.TL[1]; y1 = tile.BL[1];
      }
      rects.push({ x0: x0, y0: y0, x1: x1, y1: y1, src: tile });
      if (x0 < minX) minX = x0; if (y0 < minY) minY = y0;
      if (x1 > maxX) maxX = x1; if (y1 > maxY) maxY = y1;
    }
    if (!rects.length) { OV.tiles = []; return; } // 模板元数据丢失等异常：不显示
    OV.tiles = [];
    for (var k2 = 0; k2 < rects.length; k2++) {
      var r = rects[k2], cv = tileCanvas(r.src);
      if (!cv) continue;
      OV.tiles.push({
        px: r.x0 - minX, py: r.y0 - minY, pw: r.x1 - r.x0, ph: r.y1 - r.y0,
        cw: r.src.cw, ch: r.src.ch, data: r.src.rgba, cv: cv, src: r.src
      });
    }
    OV.spanX = maxX - minX; OV.spanY = maxY - minY;
    OV.name = gName;
    if (!OV.scale) OV.scale = 300 / Math.max(OV.spanX, OV.spanY, 1e-12); // 初始：包围盒约 300px
  }
  function drawOverlay() {
    if (!S.overlay || !ST.tiles.length || !ensureOverlayCanvas()) {
      if (ovCanvas && ovSig !== 'off') { ovCtx.clearRect(0, 0, ovCanvas.width, ovCanvas.height); ovSig = 'off'; }
      return;
    }
    if (ST.ovGone) {
      // 官方覆盖图已停止渲染（退出覆盖模式/隐藏模板）：参照层与手动层一并收起，
      // 避免残留在最后已知位置与真实画面脱节。官方重新渲染后自动恢复。
      if (ovSig !== 'gone') { ovCtx.clearRect(0, 0, ovCanvas.width, ovCanvas.height); ovSig = 'gone'; }
      return;
    }
    if (OV.rev !== ST.tilesRev) buildOvTiles();
    if (!OV.tiles.length) {
      if (ovSig !== 'noplace') { ovCtx.clearRect(0, 0, ovCanvas.width, ovCanvas.height); ovSig = 'noplace'; }
      return;
    }
    var rect = ovCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var dpr = uw.devicePixelRatio || 1;
    var W = Math.round(rect.width * dpr), H = Math.round(rect.height * dpr);
    // 优先官方渲染几何（uniform 重放）：位置大小与官方覆盖图逐帧同步，无需任何手动操作
    var auto = 0, sigParts = [W, H, S.overlay, ST.scrRev, OV.rev, ST.progRev]; // progRev：状态图版本（清校准/重算后强制重绘）
    for (var ai = 0; ai < OV.tiles.length; ai++) {
      var sq = OV.tiles[ai].src && OV.tiles[ai].src.scrQuad;
      if (sq) {
        auto++;
        for (var qi = 0; qi < 4; qi++) sigParts.push(Math.round(sq[qi][0] * 10), Math.round(sq[qi][1] * 10));
      }
    }
    if (auto) {
      var sig = sigParts.join('|');
      if (ST.calib && ST.calib.stale) { sig += '|cal'; } // 校准统计过期 → 强制重绘（重算状态图）
      if (sig === ovSig) return;
      ovSig = sig;
      if (ST.calib && ST.calib.stale) refreshCalibStats();
      if (ovCanvas.width !== W || ovCanvas.height !== H) { ovCanvas.width = W; ovCanvas.height = H; }
      ovCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ovCtx.clearRect(0, 0, rect.width, rect.height);
      ovCtx.imageSmoothingEnabled = false; // 像素风锐利放大
      ovCtx.globalAlpha = S.overlay;
      for (var bi = 0; bi < OV.tiles.length; bi++) {
        var o = OV.tiles[bi], q = o.src && o.src.scrQuad;
        if (!q) continue;
        // 仿射重放官方 shader：TL 为原点，X 向量=(TR-TL)/cw，Y 向量=(BL-TL)/ch，每单位=1 源像素
        var ax = (q[1][0] - q[0][0]) / o.cw, ay = (q[1][1] - q[0][1]) / o.cw;
        var bx = (q[3][0] - q[0][0]) / o.ch, by = (q[3][1] - q[0][1]) / o.ch;
        // 对齐校准：δ 平移参照层（官方矩阵重放 TL/TR/BR/BL + Mercator 偏移），官方覆盖图不动
        var drawQuad = q, calibTile = ST.calib && o.src.tplId === ST.calib.tplId;
        if (calibTile && o.src.rpM) {
          var cq = rpProject(o.src.rpM,
            [[o.src.TL[0] + ST.calib.dmx, o.src.TL[1] + ST.calib.dmy],
             [o.src.TR[0] + ST.calib.dmx, o.src.TR[1] + ST.calib.dmy],
             [o.src.BR[0] + ST.calib.dmx, o.src.BR[1] + ST.calib.dmy],
             [o.src.BL[0] + ST.calib.dmx, o.src.BL[1] + ST.calib.dmy]],
            o.src.rpWs, ovCanvas.clientWidth || rect.width, ovCanvas.clientHeight || rect.height);
          if (cq) {
            drawQuad = cq;
            ax = (cq[1][0] - cq[0][0]) / o.cw; ay = (cq[1][1] - cq[0][1]) / o.cw;
            bx = (cq[3][0] - cq[0][0]) / o.ch; by = (cq[3][1] - cq[0][1]) / o.ch;
          }
        } else if (calibTile && ST.calib.screen) {
          // 编辑会话（DOM overlay，无官方矩阵）：δ 世界像素 × screenScale 直接平移屏幕四边形
          var ss = ST.calibScreenScale || 0;
          if (ss > 0) {
            var sox = ST.calib.dwx * ss, soy = ST.calib.dwy * ss;
            drawQuad = [[q[0][0] + sox, q[0][1] + soy], [q[1][0] + sox, q[1][1] + soy],
                        [q[2][0] + sox, q[2][1] + soy], [q[3][0] + sox, q[3][1] + soy]];
          }
        }
        ovCtx.setTransform(dpr * ax, dpr * ay, dpr * bx, dpr * by, dpr * drawQuad[0][0], dpr * drawQuad[0][1]);
        ovCtx.drawImage(o.cv, 0, 0);
        if (calibTile) {
          var scv = statusCanvas(o.src);
          if (scv) ovCtx.drawImage(scv, 0, 0);
        }
      }
      ovCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawAutoMarks();
      ovCtx.globalAlpha = 1;
      return;
    }
    // 手动模式 fallback（官方覆盖图尚未渲染时的兜底）
    if (!OV.placed) {
      if (ovSig !== 'noplace') { ovCtx.clearRect(0, 0, ovCanvas.width, ovCanvas.height); ovSig = 'noplace'; }
      return;
    }
    var sig2 = [W, H, Math.round(OV.x * 100), Math.round(OV.y * 100),
      OV.scale.toPrecision(9), OV.rev, S.overlay].join('|');
    if (sig2 === ovSig) return;
    ovSig = sig2;
    if (ovCanvas.width !== W || ovCanvas.height !== H) { ovCanvas.width = W; ovCanvas.height = H; }
    ovCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ovCtx.clearRect(0, 0, rect.width, rect.height);
    ovCtx.imageSmoothingEnabled = false; // 像素风锐利放大
    ovCtx.globalAlpha = S.overlay;
    for (var i = 0; i < OV.tiles.length; i++) {
      var t = OV.tiles[i];
      ovCtx.drawImage(t.cv, OV.x + t.px * OV.scale, OV.y + t.py * OV.scale,
        t.pw * OV.scale, t.ph * OV.scale);
    }
    drawAlignMarks();
    ovCtx.globalAlpha = 1;
  }
  // 自动贴合模式对齐标记：沿每瓦片官方屏幕四边形描边（地图移动时跟随官方矩阵）
  function drawAutoMarks() {
    ovCtx.globalAlpha = 0.85;
    ovCtx.strokeStyle = '#ff00ff';
    ovCtx.lineWidth = 1.5;
    for (var i = 0; i < OV.tiles.length; i++) {
      var o = OV.tiles[i], q = o.src && o.src.scrQuad;
      if (!q) continue;
      ovCtx.beginPath();
      ovCtx.moveTo(q[0][0], q[0][1]);
      ovCtx.lineTo(q[1][0], q[1][1]);
      ovCtx.lineTo(q[2][0], q[2][1]);
      ovCtx.lineTo(q[3][0], q[3][1]);
      ovCtx.closePath();
      ovCtx.stroke();
    }
    ovCtx.globalAlpha = 1;
  }
  // 对齐参照线：外框 + 四角角标 + 渲染像素网格（品红，锐利，错位一眼可见）
  function drawAlignMarks() {
    ovCtx.globalAlpha = 0.85; // 参照线固定高亮，不随填充透明度变淡
    ovCtx.lineCap = 'butt';
    var bw = OV.spanX * OV.scale, bh = OV.spanY * OV.scale;
    if (bw < 4 || bh < 4) return;
    ovCtx.strokeStyle = '#ff00ff';
    ovCtx.lineWidth = 1;
    ovCtx.strokeRect(OV.x, OV.y, bw, bh);
    var L = Math.max(6, Math.min(18, bw / 4, bh / 4));
    ovCtx.lineWidth = 2;
    drawCorner(OV.x, OV.y, 1, 1, L); drawCorner(OV.x + bw, OV.y, -1, 1, L);
    drawCorner(OV.x, OV.y + bh, 1, -1, L); drawCorner(OV.x + bw, OV.y + bh, -1, -1, L);
    for (var k = 0; k < OV.tiles.length; k++) {
      var o = OV.tiles[k];
      var tx = OV.x + o.px * OV.scale, ty = OV.y + o.py * OV.scale;
      var tw = o.pw * OV.scale, th = o.ph * OV.scale;
      if (tw < 12 || th < 12) continue;
      var pxW = tw / o.cw, pxH = th / o.ch, step = 1;
      if (pxW < 6 || pxH < 6) { step = 10; pxW *= 10; pxH *= 10; if (pxW < 5 || pxH < 5) continue; }
      if (o.cw / step + o.ch / step > 500) continue; // 线条数量保护
      ovCtx.lineWidth = 1;
      ovCtx.strokeStyle = 'rgba(255,0,255,0.55)';
      ovCtx.beginPath();
      for (var gx = step; gx < o.cw; gx += step) {
        var lx = Math.round(tx + gx * pxW) + 0.5;
        ovCtx.moveTo(lx, ty); ovCtx.lineTo(lx, ty + th);
      }
      for (var gy = step; gy < o.ch; gy += step) {
        var ly = Math.round(ty + gy * pxH) + 0.5;
        ovCtx.moveTo(tx, ly); ovCtx.lineTo(tx + tw, ly);
      }
      ovCtx.stroke();
    }
  }
  function drawCorner(x, y, dx, dy, len) {
    ovCtx.beginPath();
    ovCtx.moveTo(x + dx * len, y);
    ovCtx.lineTo(x, y);
    ovCtx.lineTo(x, y + dy * len);
    ovCtx.stroke();
  }
  // 按参照层几何取色：屏幕坐标 → 拼合坐标 → 瓦片 → 像素（与显示共用同一组数字，所见即所得）
  function pickColorAtManual(mxx, myy) {
    if (!ovCanvas || !ovCanvas.isConnected) return null;
    var r = ovCanvas.getBoundingClientRect();
    var mxr = (mxx - r.left - OV.x) / OV.scale, myr = (myy - r.top - OV.y) / OV.scale;
    for (var i = OV.tiles.length - 1; i >= 0; i--) { // 后绘制者在上层
      var o = OV.tiles[i];
      if (mxr < o.px || mxr > o.px + o.pw || myr < o.py || myr > o.py + o.ph) continue;
      var u = (mxr - o.px) / o.pw, v = (myr - o.py) / o.ph;
      var cpx = Math.min(o.cw - 1, Math.max(0, Math.floor(u * o.cw)));
      var cpy = Math.min(o.ch - 1, Math.max(0, Math.floor(v * o.ch)));
      var p = (cpy * o.cw + cpx) * 4;
      if (o.data[p + 3] < 8) continue; // 透明 → 下一块
      return { rgb: [o.data[p], o.data[p + 1], o.data[p + 2]], name: OV.name };
    }
    return null;
  }
  // 缩放参照层：绕 client 坐标 (cx,cy) 缩放 k 倍（鼠标不动处的内容保持不动）
  function ovZoomAt(cx, cy, k) {
    var r = ovCanvas && ovCanvas.isConnected ? ovCanvas.getBoundingClientRect() : null;
    if (!r || !OV.placed) return;
    var mx = cx - r.left, my = cy - r.top;
    var ns = Math.max(100, Math.min(1e10, OV.scale * k));
    k = ns / OV.scale;
    OV.x = mx - (mx - OV.x) * k;
    OV.y = my - (my - OV.y) * k;
    OV.scale = ns;
    ovSig = '';
    updateHud();
  }
  function ovZoomCenter(k) {
    if (!OV.placed || !OV.tiles.length || !ovCanvas || !ovCanvas.isConnected) return;
    var r = ovCanvas.getBoundingClientRect();
    ovZoomAt(r.left + OV.x + OV.spanX * OV.scale / 2, r.top + OV.y + OV.spanY * OV.scale / 2, k);
  }
  // ---------------- 覆盖图存活检测（退出覆盖模式自动收起参照层） ----------------
  // 官方覆盖图每帧渲染都会走 uniform 重放（更新 lastScrDraw）；用户的物理视图交互
  // （拖动/滚轮/键盘，记 lastMapMove）必然触发 maplibre 重绘。若交互后 600ms 仍无任何
  // 覆盖图重放，说明官方已停止渲染（退出覆盖模式/隐藏模板/覆盖图移出视野）→ 收起参照
  // 层，避免残影停留在最后已知位置。官方 flyTo 等程序化移动不算物理交互（只写 location），
  // 不会误判；覆盖图恢复渲染时 drawArrays 重放自动清 ovGone 并重现。
  function checkOvAlive() {
    if (ST.ovGone || !ST.lastScrDraw) return;
    if (ST.lastMapMove > ST.lastScrDraw && Date.now() - ST.lastMapMove > 600) {
      ST.ovGone = true;
      ST.lastScrDraw = 0;
      var n = 0;
      for (var i = 0; i < ST.tiles.length; i++) {
        if (ST.tiles[i].scrQuad) { ST.tiles[i].scrQuad = null; n++; }
      }
      if (n) ST.scrRev++;
      updateHud();
    }
  }
  function overlayLoop() {
    try { checkOvAlive(); drawOverlay(); } catch (e) {}
    if (uw.requestAnimationFrame) uw.requestAnimationFrame(overlayLoop);
    else setTimeout(overlayLoop, 66);
  }

  // ---------------- 调色板 swatch 识别与点击 ----------------
  // 官方调色板结构（DOM 实证）：.paint-palette > div.paint-swatch(tooltip) > button#color-N
  //   id="color-N" 的 N 即官方调色板索引（与 PALETTE 完全一致，1..63）
  //   aria-label="颜色名：剩余 N"（随界面语言本地化），aria-pressed="true" 表示当前选中
  function parseBg(str) {
    var m = /rgba?\(\s*(\d+)\s*[,\s]\s*(\d+)\s*[,\s]\s*(\d+)/.exec(str || '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  function paletteRoot() {
    try { return document.querySelector('.paint-palette'); } catch (e) { return null; }
  }
  function swatchButtonById(idx) {
    var el = null;
    try { el = document.getElementById('color-' + idx); } catch (e) { return null; }
    if (!el || el.tagName !== 'BUTTON') return null;
    var host = null;
    try { host = el.closest('.paint-palette, .paint-swatch'); } catch (e) {}
    if (!host) return null; // 防其他页面出现同名 id
    return el;
  }
  // 锁定（付费未解锁）色块内含锁形 svg 图标；已解锁色块只有文字余量、无 svg。
  // 官方对锁定色块的点击不是选色而是弹出 Unlock 弹窗，弹窗会移除底部 paint 提示条
  // （布局高度变化 → maplibre resize → 地图内容重排移动）——必须跳过。
  function isLockedSwatch(el) {
    try { return !!el.querySelector('svg'); } catch (e) { return false; }
  }
  function swatchNameOf(el) {
    var label = '';
    try { label = (el.getAttribute('aria-label') || el.title || '').trim(); } catch (e) {}
    return label ? label.split(/[：:]/)[0].trim() : '';
  }
  function swatchIndexOf(el) {
    // aria-label 形如 "名字：剩余 N"（任意语言），截取分隔符前的名字与英文表比对
    var label = (el.getAttribute('aria-label') || el.title || '').trim();
    var base = label.split(/[：:]/)[0].trim().toLowerCase();
    if (base) {
      for (var i = 1; i < PALETTE.length; i++) {
        if (PALETTE[i][0].toLowerCase() === base) return i;
      }
    }
    // 背景色匹配（语言无关）
    var cs;
    try { cs = getComputedStyle(el); } catch (e) { return -1; }
    var bg = parseBg(cs.backgroundColor);
    if (!bg) return -1;
    for (var j = 1; j < PALETTE.length; j++) {
      var p = PALETTE[j];
      if (Math.abs(bg[0] - p[1]) <= 2 && Math.abs(bg[1] - p[2]) <= 2 && Math.abs(bg[2] - p[3]) <= 2) return j;
    }
    return -1;
  }
  function findSwatches() {
    var now = Date.now();
    if (ST.swatchCache && !ST.swatchDirty && now - ST.swatchTime < 3000) return ST.swatchCache;
    var map = new Map();
    var root = paletteRoot();
    var nodes = root
      ? root.querySelectorAll('button')
      : document.querySelectorAll('button, [role="button"], [class*="swatch"], [class*="color"]');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width === 0 || r.height === 0) continue;
      if (!root && (r.width < 8 || r.width > 90 || r.height < 8 || r.height > 90)) continue;
      if (!root && Math.abs(r.width - r.height) > Math.max(8, r.width * 0.6)) continue;
      var idx = swatchIndexOf(el);
      if (idx > 0 && !map.has(idx)) map.set(idx, el);
    }
    ST.swatchCache = map; ST.swatchTime = now; ST.swatchDirty = false;
    return map;
  }
  var swDirtyTimer = 0;
  try {
    new MutationObserver(function () {
      if (swDirtyTimer) return;
      swDirtyTimer = setTimeout(function () { swDirtyTimer = 0; ST.swatchDirty = true; }, 500);
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  } catch (e) {}

  function dispatchTap(el, r) {
    var opts = {
      bubbles: true, cancelable: true, view: uw,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2
    };
    el.dispatchEvent(new MouseEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }
  function selectColor(idx) {
    if (!idx || idx < 1) return;
    var el = swatchButtonById(idx);
    var how = 'id';
    if (!el) { el = findSwatches().get(idx); how = 'scan'; }
    if (!el) {
      ST.lastSelect = { ok: false, msg: '未找到色块 #' + idx, t: Date.now() };
      return;
    }
    if (isLockedSwatch(el)) {
      // 不点击锁定色块：点了会弹 Unlock 弹窗并引发地图重排（画面自己移动）
      ST.lastSelect = { ok: false, msg: '🔒 #' + idx + ' ' + (swatchNameOf(el) || '') + '未解锁，跳过', t: Date.now() };
      return;
    }
    // 不点击"当前已选中"的色块：官方模板构建模式对"再次点击当前色"有特殊语义
    // （onColorReselect：在模板中定位该颜色像素并 flyTo 过去），自动换色点到已选中
    // 色会让画面反复飞移。此时官方本来就在该色上，无需任何点击。
    if (el.getAttribute('aria-pressed') === 'true') {
      selectColor._lastEl = el; selectColor._lastT = Date.now();
      ST.lastSelect = { ok: true, msg: '✓ #' + idx + ' 已是当前色', t: Date.now() };
      return;
    }
    var now = Date.now();
    // 同一色块 1 秒内不重复点击（悬停采样频率高）
    if (selectColor._lastEl === el && now - (selectColor._lastT || 0) < 1000) return;
    selectColor._lastEl = el; selectColor._lastT = now;
    var r = el.getBoundingClientRect();
    try { dispatchTap(el, r); } catch (e) {}
    ST.lastSelect = { ok: true, msg: '→ #' + idx + '（' + how + '）', t: Date.now() };
    // 点击后校验 aria-pressed；未选中则补发原生 click
    setTimeout(function () {
      try {
        if (el.isConnected && el.getAttribute('aria-pressed') !== 'true') el.click();
      } catch (e) {}
    }, 120);
  }

  // ================= 框选自动补画（v2.7.0）拟人节奏 · 手动提交 =================
  // 官方绘画交互逆向（2026-10 bundle + 实机实证）：
  //  - 绘画模式下单击画布 = 涂 1 像素，但官方在 map 的 click/pointerdown/touchstart 三个
  //    入口都检查 isTrusted：合成事件会把全局 automatedClicks 置 true 并写入后续 /paint
  //    请求的 pawtect token（服务端可见的自动化信号）——此路径禁用；
  //  - 官方「按住 Space + 移动鼠标」连画链路：document keydown(Space) 置内部连画标志并涂下
  //    当前点 → window mousemove 把上一点到当前点的线段逐像素写入官方草稿（这条链路
  //    不检查 isTrusted）→ keyup(Space) 收束撤销合并。合成事件全程绕开 isTrusted 检查点；
  //  - 草稿 = 官方 Paint 按钮上的待提交像素（颜料在提交时才真正扣减），提交由用户手动点击
  //    官方 Paint 按钮（POST /paint 携带 pawtect token/设备密钥/CF 盾）——脚本不触碰提交流程；
  //  - 颜料按颜色分库存：色板 tooltip = overlay_build_select_color({color, count:
  //    remainingColorCounts[idx]})，库存 0 的色能选中但放置被拒（草稿不涨）——正常情况，
  //    引擎自动跳过该色继续画，不算异常（v2.7.1）；
  //  - charges/草稿数在新版官方 UI（版本 1791132058022）里画在 canvas 上：主按钮数字在
  //    .paint-button-balance canvas（66×14，恒画 "N/max"，0 也画）、草稿数在面板标题
  //    h2[aria-label=Paint pixel] 的 canvas（40×12）——textContent 只剩 "Paint" +
  //    "(m:ss)"，且该倒计时条件是 charges<max（满了不显示）≠ 颜料 0：旧「只剩倒计时
  //    =颜料 0」判定全错（v2.7.1 的「颜料耗尽」空转即此；v2.7.2 归因「Paint pixel 标题
  //    是 button」是误诊——实机实锤标题是 h2）。v2.7.3：草稿增长改用标题 canvas 像素
  //    指纹 hash 检测，每色库存改读色块 aria-label（"名称: N left"，实锤可读）画前预判，
  //    连续多色涂不上先按恢复倒计时等恢复点重试（charges 追平草稿配额的场景可自愈）；
  //  - 色板按钮 click 无 isTrusted 检查（selectColor 自 v2.5.0 起长期使用）；
  //  - 移动端 touch 路径有 isTrusted 检查 → 自动补画仅桌面精确指针可用。

  var BP = null; // {phase, runs, ri, painted, missed, lastDraftFp, waitRounds, msg, box, plan}
  var BP_STEP_PX = 4;         // 每次合成 mousemove 最多推进的世界像素（拟人步幅）
  var BP_STEP_MS = 55;        // 步进基础间隔（实际 ±40ms 随机）
  var BP_STROKE_MS = 260;     // 两笔之间基础间隔（±380ms 随机，偶发长停顿）
  function bpSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 模板源像素 → 屏幕坐标（官方 scrQuad 仿射正变换 + 校准 δ；与 pickColorAtOfficial 互逆）
  function bpSrcToScreen(t, px, py) {
    var q = t.scrQuad;
    if (!q) return null;
    var u = px, v = py;
    if (ST.calib && t.tplId === ST.calib.tplId) {
      u += ST.calib.dmx / (t.TR[0] - t.TL[0]) * t.cw;
      v += ST.calib.dmy / (t.BL[1] - t.TL[1]) * t.ch;
    }
    return [
      q[0][0] + (q[1][0] - q[0][0]) * u / t.cw + (q[3][0] - q[0][0]) * v / t.ch,
      q[0][1] + (q[1][1] - q[0][1]) * u / t.cw + (q[3][1] - q[0][1]) * v / t.ch
    ];
  }
  // 模板源像素 → 画布世界像素（texPxMerc + 校准 δ；官方覆盖图偏离已画内容 δ，真实内容在 +δ 处）
  function bpSrcToWorld(t, tpl, px, py) {
    var m = texPxMerc(t, tpl, px, py);
    if (ST.calib && t.tplId === ST.calib.tplId) { m[0] += ST.calib.dmx; m[1] += ST.calib.dmy; }
    return [Math.floor(m[0] * WORLD_PX), Math.floor(m[1] * WORLD_PX)];
  }
  // 待画像素 → 同色同行连续线段（run）。分组键 = tile+行+色：同一模板瓦片的同一像素行内
  // 连续 px 才合成一笔（跨瓦片不合并——各自 scrQuad 投影独立，边界处多一两笔更稳）。
  // pixels: [{tplId, px, py, c}]；返回 [{tplId, c, py, px0, px1}]（行序蛇形：偶数行左→右）
  function bpRunsFromPixels(pixels) {
    var byKey = {};
    for (var i = 0; i < pixels.length; i++) {
      var k = pixels[i].tplId + '/' + pixels[i].py + '/' + pixels[i].c;
      (byKey[k] = byKey[k] || []).push(pixels[i].px);
    }
    var runs = [];
    for (var k2 in byKey) {
      var parts = k2.split('/');
      var xs = byKey[k2].sort(function (a, b) { return a - b; });
      var s = xs[0], prev = xs[0];
      for (var j = 1; j <= xs.length; j++) {
        if (j < xs.length && xs[j] === prev + 1) { prev = xs[j]; continue; }
        runs.push({ tplId: parts[0], c: Number(parts[2]), py: Number(parts[1]), px0: s, px1: prev });
        if (j < xs.length) { s = prev = xs[j]; }
      }
    }
    // 同瓦片内按 py 行序蛇形：奇数行反转段顺序并交换端点，路径来回更像手绘
    var rows = {};
    for (var r = 0; r < runs.length; r++) {
      var rk = runs[r].tplId + '/' + runs[r].c;
      (rows[rk] = rows[rk] || {})[runs[r].py] = (rows[rk][runs[r].py] || []).concat([runs[r]]);
    }
    var out = [];
    Object.keys(rows).forEach(function (rk) {
      var ys = Object.keys(rows[rk]).map(Number).sort(function (a, b) { return a - b; });
      for (var yi = 0; yi < ys.length; yi++) {
        var list = rows[rk][ys[yi]];
        if (yi % 2 === 1) {
          list.reverse();
          for (var q = 0; q < list.length; q++) { var t2 = list[q].px0; list[q].px0 = list[q].px1; list[q].px1 = t2; }
        }
        for (var w = 0; w < list.length; w++) out.push(list[w]);
      }
    });
    return out;
  }
  // 解析官方状态（v2.7.3 实机 + chunk 双实锤）：新版官方 UI 把 charges 数字画在主按钮的
  // .paint-button-balance canvas（恒画 "N/max"，0 也画），草稿数画面板标题 h2 的 canvas——
  // textContent 只剩「Paint」+「(m:ss)」，且该倒计时条件是 charges<max（满了不显示）≠ 颜料 0。
  // charges 数值从 DOM 读不到 → 草稿增长改用标题 canvas 像素指纹（内容变 = 草稿变），
  // 恢复倒计时秒数用于「涂不上时等恢复点重试」。按钮纯「Paint」（无倒计时）= charges 满
  function bpChargesInfo() {
    var btns = document.querySelectorAll('button');
    var out = null;
    for (var i = 0; i < btns.length; i++) {
      var txt = (btns[i].textContent || '').trim();
      if (txt.indexOf('Paint') !== 0) continue;
      if (txt.indexOf('Paint pixel') === 0) continue; // 面板标题不是颜料按钮（防御；实锤它是 h2 非 button）
      var m = /^\((\d+):(\d+)\)$/.exec(txt.slice(5).trim()); // "(m:ss)" = charges<max 正在恢复
      out = { cooldownSec: m ? Number(m[1]) * 60 + Number(m[2]) : null };
      break;
    }
    if (!out) return null;
    // 草稿数 canvas：绘画面板标题 h2[aria-label="Paint pixel"] 内（40×12），草稿变→重绘→像素指纹变
    out.draftFp = null;
    try {
      var cv = document.querySelector('h2[aria-label="Paint pixel"] canvas') ||
               document.querySelector('.paint-summary canvas');
      if (cv && cv.width > 0 && cv.height > 0) {
        var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        var h = 0;
        for (var k = 0; k < d.length; k += 4) h = (h * 31 + d[k] + d[k + 3]) | 0; // r+alpha 通道足够（文本字形）
        out.draftFp = h;
      }
    } catch (e) { out.draftFp = null; }
    return out;
  }
  // 每色库存：色块 aria-label =「颜色名: N left」（官方把 remainingColorCounts 写进可访问名，实锤）
  // 返回 null = 读不到（不预判）
  function bpColorStock(idx) {
    try {
      var el = document.getElementById('color-' + idx);
      var m = el && /: ([\d,]+) left$/.exec(el.getAttribute('aria-label') || '');
      return m ? Number(m[1].replace(/,/g, '')) : null;
    } catch (e) { return null; }
  }
  function bpInjectMove(x, y) {
    document.body.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, view: uw, clientX: x, clientY: y, buttons: 1
    }));
  }
  function bpInjectSpace(down) {
    document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
      code: 'Space', key: ' ', bubbles: true, cancelable: true
    }));
  }
  function bpCurSelIdx() {
    try {
      var pr = paletteRoot();
      var el = pr && pr.querySelector('button[aria-pressed="true"]');
      var m = el && /^color-(\d+)$/.exec(el.id);
      return m ? Number(m[1]) : 0;
    } catch (e) { return 0; }
  }
  async function bpEnsureColor(idx) {
    for (var k = 0; k < 3; k++) {
      if (bpCurSelIdx() === idx) return true;
      selectColor(idx);
      await bpSleep(420 + Math.random() * 380);
    }
    return bpCurSelIdx() === idx;
  }
  // 跳过颜色 c 的全部线段（runs 按色连续分组：byColor 大色先画，同色线段必然相邻）
  function bpSkipColor(c) {
    var n = 0;
    while (BP && BP.ri < BP.runs.length && BP.runs[BP.ri].c === c) { BP.ri++; n++; }
    return n;
  }
  // 画一条线段：先无键移动把官方「上一落点」带到起点（不涂），再按 Space 涂起点、
  // 分步移动逐段涂到终点，松开 Space 收束。步幅与间隔带随机，笔间偶发长停顿。
  async function bpStroke(run) {
    var t = null, tpl = null;
    for (var i = 0; i < ST.tiles.length; i++) {
      if (ST.tiles[i].tplId === run.tplId) { t = ST.tiles[i]; break; }
    }
    tpl = tplById(run.tplId);
    if (!t || !t.scrQuad || !tpl) return false;
    var p0 = bpSrcToScreen(t, run.px0, run.py);
    var p1 = bpSrcToScreen(t, run.px1, run.py);
    if (!p0 || !p1) return false;
    bpInjectMove(p0[0], p0[1]);          // 更新官方上一落点（Space 未按，不涂）
    await bpSleep(30 + Math.random() * 60);
    bpInjectSpace(true);                  // 按下：涂起点 1 像素
    var dx = p1[0] - p0[0], dy = p1[1] - p0[1];
    var steps = Math.max(1, Math.ceil(Math.max(Math.abs(run.px1 - run.px0), 1) / BP_STEP_PX));
    for (var s = 1; s <= steps; s++) {
      var f = s / steps;
      bpInjectMove(p0[0] + dx * f + (Math.random() - 0.5) * 0.6, p0[1] + dy * f + (Math.random() - 0.5) * 0.6);
      await bpSleep(Math.max(20, BP_STEP_MS + (Math.random() - 0.5) * 80));
    }
    bpInjectSpace(false);                 // 松开：撤销栈收束
    await bpSleep(60 + Math.random() * 80);
    return true;
  }
  // 引擎主循环：逐色逐段执行；视图交互中暂缓 / 颜料耗尽等待 / 涂不上的颜色自动跳过；
  // 完成后交由用户手动提交
  async function bpEngine() {
    while (BP && BP.ri < BP.runs.length) {
      if (!BP || BP.phase === 'stop') return;
      if (BP.phase === 'pause' || BP.phase === 'wait') { await bpSleep(300); if (!BP) return; continue; }
      var run = BP.runs[BP.ri];
      // 视图正在被拖动/缩放：scrQuad 在动，涂了会错位 → 等静止
      if (ST.lastMapMove && Date.now() - ST.lastMapMove < 800) {
        BP.msg = '⏳ 等待视图静止…';
        updateHud();
        await bpSleep(400);
        if (!BP) return;
        continue;
      }
      var stock = bpColorStock(run.c);
      if (stock === 0) {
        // 色块 aria-label 报库存 0：官方放置必拒（remainingColorCounts），画前直接跳过该色
        var ns0 = bpSkipColor(run.c);
        BP.skippedRuns += ns0;
        BP.msg = '⏭ 色 #' + run.c + ' 库存 0（色板可访问名），跳过 ' + ns0 + ' 笔继续下一色';
        updateHud();
        await bpSleep(150);
        if (!BP) return;
        continue;
      }
      if (!(await bpEnsureColor(run.c))) {
        BP.msg = '⚠ 无法选中色 #' + run.c + '（未解锁？）——该色线段已跳过';
        BP.skipped++;
        updateHud();
        BP.ri++;
        continue;
      }
      var ok = await bpStroke(run);
      if (!BP) return;
      if (!ok) { BP.ri++; continue; }
      var info = bpChargesInfo();
      if (info && info.draftFp !== null && info.draftFp !== BP.lastDraftFp) {
        BP.lastDraftFp = info.draftFp;
        BP.painted += (run.px1 - run.px0 + 1);
        BP.missed = 0;
        BP.streakSkips = 0;
        BP.waitRounds = 0;
      } else {
        BP.missed++;
        if (BP.missed >= 2) {
          // 草稿指纹两笔不变：库存 0 已画前预判跳过，剩下原因是画图点数（charges）不足或异常
          var ns = bpSkipColor(run.c);
          BP.skippedRuns += ns;
          BP.streakSkips++;
          BP.missed = 0;
          if (BP.streakSkips >= 3) {
            // 连续 3 色涂不上且无一笔成功：要么 charges 耗尽/被草稿配额追平（可恢复），
            // 要么真异常（视图偏移/官方交互变了）。按钮有恢复倒计时（=charges<max）时先等
            // 恢复点重试——charges 每周期恢复 1 点即可画上；等满 3 个恢复点仍无一笔才暂停
            if (info && info.cooldownSec !== null && BP.waitRounds < 3) {
              BP.waitRounds++;
              BP.msg = '⏳ 已连续 ' + BP.streakSkips + ' 色涂不上（画图点数可能用完，色块库存仍够）——等恢复点后重试（第 ' + BP.waitRounds + '/3 轮）';
              updateHud();
              await bpSleep((info.cooldownSec + 2) * 1000);
              if (!BP) return;
              continue;
            }
            BP.phase = 'pause';
            BP.msg = '⏸ 连续多色涂不上，等了 3 个恢复点仍无一笔进草稿（视图偏移或官方交互变了）——检查后点「▶ 继续」';
            syncBpBtns();
            updateHud();
            continue;
          }
          BP.msg = '⏭ 色 #' + run.c + ' 涂不上（库存不足？），已跳过 ' + ns + ' 笔，继续下一色';
          updateHud();
          await bpSleep(300);
          if (!BP) return;
          continue;
        }
      }
      BP.ri++;
      BP.msg = '🖌 补画中 ' + BP.ri + '/' + BP.runs.length + ' 段 · 已涂约 ' + BP.painted + ' 像素';
      updateHud();
      // 拟人间隔：基础抖动，每 6-14 笔插入一次 0.6-1.6s 的「思考停顿」
      var gap = BP_STROKE_MS + Math.random() * 380;
      if (Math.random() < 0.12) gap += 600 + Math.random() * 1000;
      await bpSleep(gap);
      if (!BP) return;
    }
    if (BP && BP.phase !== 'stop') {
      BP.phase = 'done';
      BP.msg = '✅ 补画完成：约 ' + BP.painted + ' 像素进入官方草稿' +
        (BP.skippedRuns ? '（另有 ' + BP.skippedRuns + ' 笔颜色涂不上已跳过，恢复后重新框选可补）' : '') +
        '——请检查后手动点击官方 Paint 按钮提交';
      syncBpBtns();
      updateHud();
    }
  }
  function bpAbort(msg) {
    if (BP && BP.phase === 'box') bpBoxCleanup();
    BP = null;
    if (msg) { ST.calibMsg = { ok: false, msg: msg, t: Date.now() }; }
    syncBpBtns();
    updateHud();
  }
  // 主按钮（phase 分发）：进入框选 / 取消 / 开始 / 暂停 / 继续 / 复位
  function bpPrimary() {
    if (!BP) { bpStartBox(); return; }
    switch (BP.phase) {
      case 'box': bpAbort(); break;
      case 'confirm':
        BP.phase = 'run'; BP.msg = '';
        syncBpBtns(); updateHud();
        bpEngine();
        break;
      case 'run':
        BP.phase = 'pause'; BP.msg = '⏸ 已暂停';
        syncBpBtns(); updateHud();
        break;
      case 'pause': case 'wait':
        BP.phase = 'run'; BP.msg = ''; BP.missed = 0; BP.streakSkips = 0; BP.waitRounds = 0;
        syncBpBtns(); updateHud();
        break;
      case 'done':
        BP = null; syncBpBtns(); updateHud();
        break;
    }
  }
  // 次按钮：停止（已涂部分保留在官方草稿，可手动提交或 Ctrl+Z 逐笔撤销）
  function bpSecondary() {
    if (!BP) return;
    if (BP.phase === 'box') { bpAbort(); return; }
    var painted = BP.painted;
    BP = null;
    bpBoxCleanup();
    ST.calibMsg = { ok: false, msg: '■ 已停止补画（本次约 ' + painted + ' 像素保留在官方草稿，可手动提交）', t: Date.now() };
    syncBpBtns();
    updateHud();
  }
  function syncBpBtns() {
    if (!hud) return;
    var a = hud.querySelector('#wpAC-bp'), b = hud.querySelector('#wpAC-bpx');
    if (!a) return;
    var ph = BP && BP.phase || 'idle';
    var main = { idle: '🖌 补画', box: '✕ 取消框选', confirm: '▶ 开始补画', run: '⏸ 暂停', pause: '▶ 继续', wait: '▶ 继续', done: '🖌 补画' }[ph] || '🖌 补画';
    a.textContent = main;
    a.style.background = ph === 'run' ? '#7a5a1e' : (ph === 'confirm' || ph === 'pause' ? '#2d6a4f' : '');
    if (b) {
      var showSec = BP && (ph === 'confirm' || ph === 'run' || ph === 'pause' || ph === 'wait');
      b.style.display = showSec ? '' : 'none';
      if (showSec) b.textContent = '■ 停止';
    }
  }
  // 前置检查：桌面精确指针 + 官方绘画模式（色板在）+ 参照层已对齐（校准）
  function bpPreflight() {
    try {
      if (!matchMedia('(pointer: fine)').matches) return '⚠ 自动补画需要桌面鼠标（移动端触摸路径官方有合成事件检测）';
    } catch (e) {}
    if (!paletteRoot()) return '⚠ 请先进入官方绘画模式：点击画布像素 → 面板 → Paint 按钮，让色板出现';
    if (!ST.tiles.length) return '⚠ 未检测到覆盖图（先在 Overlay 上传模板）';
    if (!ST.calib || ST.calib.match < CALIB_MIN_MATCH) return '⚠ 请先用「🎯 校准」对齐参照层（补画坐标以校准为准）';
    if (!scrQuadCount()) return '⚠ 官方覆盖图未渲染：放大到覆盖图清晰可见后再试';
    return null;
  }
  // ---------------- 框选（真实鼠标拖矩形，overlay 层接管输入不碰官方画布） ----------------
  var bpBoxEl = null;
  function bpBoxCleanup() {
    if (bpBoxEl) { try { bpBoxEl.remove(); } catch (e) {} bpBoxEl = null; }
  }
  function bpStartBox() {
    var err = bpPreflight();
    if (err) { bpAbort(err); return; }
    bpBoxCleanup();
    BP = { phase: 'box', msg: '🖱 在画布上拖出要补画的矩形（Esc 取消）' };
    syncBpBtns();
    updateHud();
    var el = document.createElement('div');
    el.id = 'wpAC-bpbox';
    el.style.cssText = 'position:fixed;inset:0;z-index:2147482999;cursor:crosshair;background:rgba(20,40,80,.08);';
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;display:none;border:1px solid #4f8cff;background:rgba(79,140,255,.15);pointer-events:none;';
    var tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:rgba(15,18,25,.92);color:#dfe6f3;' +
      'font:12px/1.6 system-ui,sans-serif;padding:5px 14px;border-radius:8px;pointer-events:none;';
    tip.textContent = '拖动框选要补画的范围 · Esc 取消';
    el.appendChild(box); el.appendChild(tip);
    document.body.appendChild(el);
    bpBoxEl = el;
    var start = null;
    function rectOf(a, b) {
      return { x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]) };
    }
    el.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      start = [e.clientX, e.clientY];
      e.preventDefault();
    });
    el.addEventListener('mousemove', function (e) {
      if (!start) return;
      var r = rectOf(start, [e.clientX, e.clientY]);
      box.style.display = '';
      box.style.left = r.x0 + 'px'; box.style.top = r.y0 + 'px';
      box.style.width = (r.x1 - r.x0) + 'px'; box.style.height = (r.y1 - r.y0) + 'px';
    });
    el.addEventListener('mouseup', function (e) {
      if (!start) return;
      var r = rectOf(start, [e.clientX, e.clientY]);
      bpBoxCleanup();
      if (r.x1 - r.x0 < 8 || r.y1 - r.y0 < 8) { bpAbort('框选太小（至少 8×8 像素）'); return; }
      bpBuildPlan(r);
    });
  }
  // 屏幕矩形 → 待画清单：模板像素（上层优先）→ 世界像素画布比对 → 分色分线段
  function bpBuildPlan(rect) {
    var pxs = [];
    var locked = {};
    var skippedLocked = 0;
    for (var i = ST.tiles.length - 1; i >= 0; i--) { // 后绘制者在上层（与 pickColorAtOfficial 同序）
      var t = ST.tiles[i];
      if (!t.scrQuad || !t.rgba) continue;
      var tpl = tplById(t.tplId);
      if (!tpl) continue;
      // 瓦片四边形 bbox 与框选矩形粗交
      var bx0 = Math.min(q0(t), Math.min(q1(t), Math.min(q2(t), q3(t)))) - 2;
      var bx1 = Math.max(q0(t), Math.max(q1(t), Math.max(q2(t), q3(t)))) + 2;
      var by0 = Math.min(q0y(t), Math.min(q1y(t), Math.min(q2y(t), q3y(t)))) - 2;
      var by1 = Math.max(q0y(t), Math.max(q1y(t), Math.max(q2y(t), q3y(t)))) + 2;
      if (bx1 < rect.x0 || bx0 > rect.x1 || by1 < rect.y0 || by0 > rect.y1) continue;
      for (var py = 0; py < t.ch; py++) {
        for (var px = 0; px < t.cw; px++) {
          var o = (py * t.cw + px) * 4;
          if (t.rgba[o + 3] < 8) continue;
          var sc = bpSrcToScreen(t, px, py);
          if (!sc || sc[0] < rect.x0 || sc[0] > rect.x1 || sc[1] < rect.y0 || sc[1] > rect.y1) continue;
          var w = bpSrcToWorld(t, tpl, px, py);
          var cIdx = nearestPaletteCached(t.rgba[o], t.rgba[o + 1], t.rgba[o + 2]);
          if (!cIdx) continue;
          if (locked[cIdx] === undefined) {
            var sw = swatchButtonById(cIdx);
            locked[cIdx] = !sw || isLockedSwatch(sw);
          }
          if (locked[cIdx]) { skippedLocked++; continue; }
          pxs.push({ tplId: t.tplId, px: px, py: py, wx: w[0], wy: w[1], c: cIdx });
        }
      }
    }
    // 上层优先去重（同世界像素保留先入=更上层）
    var seen = {};
    var uniq = [];
    for (var u = 0; u < pxs.length; u++) {
      var key = pxs[u].wx + '/' + pxs[u].wy;
      if (seen[key]) continue;
      seen[key] = 1;
      uniq.push(pxs[u]);
    }
    if (!uniq.length) { bpAbort('框选范围内没有模板像素'); return; }
    var wxs = uniq.map(function (p) { return p.wx; }), wys = uniq.map(function (p) { return p.wy; });
    ensurePaintGrid(
      Math.min.apply(null, wxs) - 2,
      Math.min.apply(null, wys) - 2,
      Math.max.apply(null, wxs) + 2,
      Math.max.apply(null, wys) + 2,
      false,
      function (G) { bpPlanReady(uniq, G, skippedLocked); }
    );
  }
  function q0(t) { return t.scrQuad[0][0]; } function q1(t) { return t.scrQuad[1][0]; }
  function q2(t) { return t.scrQuad[2][0]; } function q3(t) { return t.scrQuad[3][0]; }
  function q0y(t) { return t.scrQuad[0][1]; } function q1y(t) { return t.scrQuad[1][1]; }
  function q2y(t) { return t.scrQuad[2][1]; } function q3y(t) { return t.scrQuad[3][1]; }
  function bpPlanReady(pixels, G, skippedLocked) {
    var need = [];
    var undone = 0, wrong = 0;
    for (var i = 0; i < pixels.length; i++) {
      var p = pixels[i];
      var cur = G ? gridAt(G, p.wx, p.wy) : 0;
      if (cur === 0) { need.push(p); undone++; }
      else if (cur < 64 && cur !== p.c) { need.push(p); wrong++; }
      // 129..191（近似色已涂）视为已画：尊重画手的相邻色选择，不重涂
    }
    if (!need.length) {
      bpAbort(skippedLocked ? '框选范围内无需补画（' + skippedLocked + ' 像素因颜色未解锁跳过）' : '框选范围内无需补画');
      return;
    }
    // 分色分组（大色先画，减少换色次数更像人），色内按行蛇形分段
    var byColor = {};
    for (var j = 0; j < need.length; j++) (byColor[need[j].c] = byColor[need[j].c] || []).push(need[j]);
    var colors = Object.keys(byColor).map(Number).sort(function (a, b) { return byColor[b].length - byColor[a].length; });
    var runs = [];
    for (var c = 0; c < colors.length; c++) {
      var rr = bpRunsFromPixels(byColor[colors[c]]);
      for (var k = 0; k < rr.length; k++) runs.push(rr[k]);
    }
    var totalPx = 0;
    for (var m = 0; m < runs.length; m++) totalPx += runs[m].px1 - runs[m].px0 + 1;
    BP = {
      phase: 'confirm', runs: runs, ri: 0, painted: 0, skipped: skippedLocked,
      missed: 0, skippedRuns: 0, streakSkips: 0, waitRounds: 0,
      lastDraftFp: (bpChargesInfo() || { draftFp: 0 }).draftFp,
      msg: '框选完成：需补画 ' + need.length + ' 像素（未涂 ' + undone + ' · 画错 ' + wrong + '）· ' +
        runs.length + ' 笔 · ' + colors.length + ' 色' + (skippedLocked ? ' · 跳过锁定 ' + skippedLocked : '')
    };
    syncBpBtns();
    updateHud();
  }

  // ---------------- HUD ----------------
  var hud = null, hudInfo = null, hudDot = null, hudColorName = null;
  function ensureHud() {
    if (hud || !document.body) return;
    if (!document.getElementById('wpAC-style')) {
      var st = document.createElement('style');
      st.id = 'wpAC-style';
      st.textContent = '.wpAC-btn{font-size:11px;padding:1px 8px;border-radius:8px;background:#2a3242;color:#cfe0ff;' +
        'cursor:pointer;user-select:none;white-space:nowrap;line-height:1.6;}' +
        '.wpAC-btn:hover{background:#3a4b66;}' +
        '.wpAC-btn.on{background:#2d6a4f;}' +
        '.wpAC-btn.warn{background:#7a5a1e;}';
      (document.head || document.documentElement).appendChild(st);
    }
    hud = document.createElement('div');
    hud.id = 'wpAC-hud';
    hud.style.cssText = 'position:fixed;right:12px;bottom:64px;z-index:2147483000;background:rgba(15,18,25,.9);color:#dfe6f3;' +
      'font:12px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif;padding:8px 12px;border-radius:10px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.35);user-select:none;min-width:220px;max-width:320px;cursor:move;touch-action:none;';
    hud.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;font-weight:600;">覆盖图自动选色' +
      '<span id="wpAC-onoff" style="font-weight:400;cursor:pointer;font-size:11px;padding:0 8px;border-radius:8px;background:#2d6a4f;">开</span>' +
      '<span id="wpAC-fold" style="cursor:pointer;opacity:.7;margin-left:auto;font-size:13px;line-height:1;padding:2px 6px;">—</span></div>' +
      '<div id="wpAC-btns" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;">' +
      '<span class="wpAC-btn" id="wpAC-mode"></span>' +
      '<span class="wpAC-btn" id="wpAC-layer"></span>' +
      '<span class="wpAC-btn" id="wpAC-zin">＋</span>' +
      '<span class="wpAC-btn" id="wpAC-zout">－</span>' +
      '<span class="wpAC-btn" id="wpAC-cal">🎯 校准</span>' +
      '<span class="wpAC-btn" id="wpAC-apply" style="display:none;">✅ 应用对齐</span>' +
      '<span class="wpAC-btn" id="wpAC-ccal"></span>' +
      '<span class="wpAC-btn" id="wpAC-bp">🖌 补画</span>' +
      '<span class="wpAC-btn" id="wpAC-bpx" style="display:none;">■ 停止</span>' +
      '</div>' +
      '<div id="wpAC-info" style="white-space:pre-line;margin-top:3px;">初始化…</div>' +
      '<div id="wpAC-colorrow" style="display:flex;align-items:center;gap:6px;">' +
      '<span id="wpAC-dot" style="width:14px;height:14px;border-radius:3px;border:1px solid #fff4;display:inline-block;"></span>' +
      '<span id="wpAC-color" style="opacity:.85;">—</span></div>';
    document.body.appendChild(hud);
    hudInfo = hud.querySelector('#wpAC-info');
    hudDot = hud.querySelector('#wpAC-dot');
    hudColorName = hud.querySelector('#wpAC-color');
    // 快捷按钮（与油猴菜单等效，状态实时显示在按钮文字上）
    hud.querySelector('#wpAC-mode').addEventListener('click', function () {
      S.hoverMode = !S.hoverMode; saveSettings(); updateHud();
    });
    hud.querySelector('#wpAC-layer').addEventListener('click', function () {
      S.overlay = S.overlay === 0 ? 0.3 : (S.overlay === 0.3 ? 0.5 : (S.overlay === 0.5 ? 0.7 : 0));
      saveSettings(); updateHud();
    });
    hud.querySelector('#wpAC-zin').addEventListener('click', function () { ovZoomCenter(1.15); });
    hud.querySelector('#wpAC-zout').addEventListener('click', function () { ovZoomCenter(1 / 1.15); });
    hud.querySelector('#wpAC-cal').addEventListener('click', function () { runCalibrate(); });
    hud.querySelector('#wpAC-apply').addEventListener('click', function () {
      if (ST.calib && isLiveId(ST.calib.tplId)) {
        ST.calibMsg = { ok: false, msg: '✏️ 编辑中的模板还没保存：先点官方面板右下角「应用」保存放置，脚本接上真实模板后再点「应用对齐」', t: Date.now() };
        updateHud();
        return;
      }
      var r = applyCalibToStorage();
      if (r) {
        ST.calibMsg = { ok: true, msg: '✅ 已写入官方模板位置（偏移已应用）——按 F5 刷新页面后官方覆盖图即对齐到已画内容', t: Date.now() };
        var b = hud.querySelector('#wpAC-apply');
        if (b) b.style.display = 'none';
      } else {
        ST.calibMsg = { ok: false, msg: '写入失败：localStorage 中找不到该模板（联盟共享模板不受支持）', t: Date.now() };
      }
      updateHud();
    });
    hud.querySelector('#wpAC-ccal').addEventListener('click', function () {
      ST.anchor = null; ST.suspect = false; ST.viewDX = 0; ST.viewDY = 0; clearCalib(); updateHud();
    });
    hud.querySelector('#wpAC-bp').addEventListener('click', function () { bpPrimary(); });
    hud.querySelector('#wpAC-bpx').addEventListener('click', function () { bpSecondary(); });
    hud.querySelector('#wpAC-onoff').addEventListener('click', function () {
      S.enabled = !S.enabled; saveSettings(); syncHudOnOff(); updateHud();
    });
    hud.querySelector('#wpAC-fold').addEventListener('click', function () {
      S.collapsed = !S.collapsed; saveSettings(); applyHudCollapsed();
    });
    var dragHud = null;
    function hudDragPos(x, y) {
      var p = hudClampPos(x, y);
      hud.style.left = p.x + 'px';
      hud.style.top = p.y + 'px';
      hud.style.right = 'auto'; hud.style.bottom = 'auto';
    }
    function hudDragStart(cx, cy, target) {
      if (target && target.closest && target.closest('#wpAC-onoff,#wpAC-fold,#wpAC-btns')) return;
      var r = hud.getBoundingClientRect();
      dragHud = { dx: cx - r.left, dy: cy - r.top };
    }
    function hudDragEnd() {
      if (!dragHud) return;
      dragHud = null;
      // 记住松手位置：下次刷新/重开恢复（跨会话记忆）
      try {
        var r = hud.getBoundingClientRect();
        var p = hudClampPos(r.left, r.top);
        S.pos = { x: Math.round(p.x), y: Math.round(p.y) };
        saveSettings();
      } catch (e) {}
    }
    hud.addEventListener('mousedown', function (e) {
      hudDragStart(e.clientX, e.clientY, e.target);
      if (dragHud) e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragHud) return;
      hudDragPos(e.clientX - dragHud.dx, e.clientY - dragHud.dy);
    });
    document.addEventListener('mouseup', hudDragEnd);
    // 触摸拖动（移动端）：面板 touch-action:none 已挡掉浏览器滚动手势，touchmove 再 preventDefault 兜底旧浏览器；
    // 按钮/折叠区照常 tap（touchstart 不 preventDefault，click 正常合成）
    hud.addEventListener('touchstart', function (e) {
      if (!e.touches || e.touches.length !== 1) return;
      var t = e.touches[0];
      hudDragStart(t.clientX, t.clientY, t.target);
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!dragHud || !e.touches || e.touches.length !== 1) return;
      e.preventDefault();
      var t = e.touches[0];
      hudDragPos(t.clientX - dragHud.dx, t.clientY - dragHud.dy);
    }, { capture: true, passive: false });
    document.addEventListener('touchend', hudDragEnd, { capture: true, passive: true });
    document.addEventListener('touchcancel', hudDragEnd, { capture: true, passive: true });
    // 恢复上次位置（无记录则保持默认右下角）
    if (S.pos) {
      var p0 = hudClampPos(S.pos.x, S.pos.y);
      hud.style.left = p0.x + 'px';
      hud.style.top = p0.y + 'px';
      hud.style.right = 'auto'; hud.style.bottom = 'auto';
    }
    syncHudOnOff();
    applyHudCollapsed();
  }
  // 状态窗位置 clamp：至少保留 48px 在视口内，防止拖丢/分辨率变化后看不到
  function hudClampPos(x, y) {
    return {
      x: Math.min(Math.max(0, x), (uw.innerWidth || 1280) - 48),
      y: Math.min(Math.max(0, y), (uw.innerHeight || 720) - 48)
    };
  }
  // 折叠态：只保留标题行（含 开/关 与展开按钮），收成一枚小胶囊，不遮挡作画区
  function applyHudCollapsed() {
    if (!hud) return;
    var ids = ['wpAC-btns', 'wpAC-info', 'wpAC-colorrow'];
    for (var i = 0; i < ids.length; i++) {
      var el = hud.querySelector('#' + ids[i]);
      if (el) el.style.display = S.collapsed ? 'none' : '';
    }
    var b = hud.querySelector('#wpAC-fold');
    if (b) { b.textContent = S.collapsed ? '▸' : '—'; b.style.opacity = S.collapsed ? '1' : '.7'; }
    hud.style.minWidth = S.collapsed ? '0' : '220px';
    hud.style.opacity = S.collapsed ? '0.85' : '1';
    hud.style.padding = S.collapsed ? '4px 10px' : '8px 12px';
  }
  function syncHudOnOff() {
    var b = hud && hud.querySelector('#wpAC-onoff');
    if (b) {
      b.textContent = S.enabled ? '开' : '关';
      b.style.background = S.enabled ? '#2d6a4f' : '#6b2737';
    }
  }
  function syncHudBtns() {
    if (!hud) return;
    var b = hud.querySelector('#wpAC-mode');
    if (b) b.textContent = S.hoverMode ? '悬停换色' : '点击换色';
    b = hud.querySelector('#wpAC-layer');
    if (b) {
      b.textContent = S.overlay ? '图层 ' + Math.round(S.overlay * 100) + '%' : '图层 关';
      b.className = 'wpAC-btn' + (S.overlay ? ' on' : '');
    }
    b = hud.querySelector('#wpAC-ccal');
    if (b) b.textContent = '清校准';
    b = hud.querySelector('#wpAC-cal');
    if (b) {
      b.textContent = ST.styleBusy ? '⏳ 识别中' : (ST.calibBusy ? '⏳ 校准中' : '🎯 校准');
      b.className = 'wpAC-btn' + (ST.calib && ST.calib.match >= CALIB_MIN_MATCH ? ' on' : '');
    }
    b = hud.querySelector('#wpAC-apply');
    if (b) {
      // 有可用校准结果且尚未写入 → 显示「应用对齐」；写入成功后收起
      var show = !!(ST.calib && ST.calib.match >= CALIB_MIN_MATCH && !ST.calib.applied);
      b.style.display = show ? '' : 'none';
    }
  }
  function updateHud() {
    if (!document.body) return;
    ensureHud();
    if (!hud) return;
    hud.style.display = '';
    var lines = [];
    if (scrQuadCount()) lines.push('🟢 已锁定官方覆盖图渲染几何' + (S.hoverMode ? ' · 悬停换色' : ' · 点击换色'));
    else if (ST.ovGone) lines.push('⚪ 官方覆盖图未渲染（已退出覆盖模式或已隐藏模板）');
    else if (!ST.anchor) lines.push('⚪ 未校准：拖动/点击地图后自动校准（或点一次像素）');
    else if (ST.suspect) lines.push('🟡 视图已缩放：点击任意像素即自动重新校准');
    else lines.push('🟢 自动校准 zoom=' + ST.anchor.zoom.toFixed(2) +
      (S.hoverMode ? ' · 悬停换色' : ' · 点击换色'));
    // 参照层状态行（自诊断 + 操作指引）
    var sqN = scrQuadCount();
    if (!S.overlay) lines.push('参照层：关（点上方「图层 关」按钮开启）');
    else if (!ST.tiles.length) lines.push('参照层：待纹理——放大到覆盖图像素清晰，等 1-2 秒');
    else if (ST.ovGone) lines.push('参照层：已随覆盖模式退出自动收起 · 重新显示官方覆盖图后自动恢复');
    else if (sqN) lines.push('参照层：已自动贴合官方渲染（' + sqN + '/' + ST.tiles.length + ' 瓦片）· 缩放拖动全程跟随');
    else if (!OV.placed) lines.push('参照层：等待官方渲染几何（让覆盖图出现在画面中）· 也可 Ctrl+点击官方覆盖图左上角手动定位');
    else lines.push('参照层：已手动定位 · Ctrl+拖动 移动 · Alt+滚轮 缩放');
    // 数据行
    var unbound = 0, layers = {};
    for (var i = 0; i < ST.tiles.length; i++) {
      if (ST.tiles[i].tplId) layers[ST.tiles[i].tplId] = 1; else unbound++;
    }
    var layerCount = 0;
    for (var k in layers) layerCount++;
    var swN = -1;
    try {
      var pr = paletteRoot();
      swN = pr ? pr.querySelectorAll('button').length : findSwatches().size;
    } catch (e) {}
    lines.push('模板 ' + ST.templates.length + ' · 瓦片 ' + ST.tiles.length +
      (unbound ? '（未归属 ' + unbound + '）' : '') + ' · 层 ' + layerCount +
      ' · 色板 ' + (swN < 0 ? '?' : swN) +
      (ST.texCalls === 0 && Date.now() - ST.startTime > 8000 ? ' · ⚠钩子未生效' : ''));
    // 提示行
    if (ST.editTile) lines.push('✏️ 放置编辑中：模板已捕获（DOM 预览层）· 点「🎯 校准」自动对齐已画内容');
    if (ST.texCalls === 0 && Date.now() - ST.startTime > 8000) {
      lines.push('⚠ 钩子未生效：请确认脚本已启用后刷新页面');
    } else if (!ST.tiles.length) {
      lines.push(ST.templates.length ? '⏳ 等待覆盖图上传：让覆盖图出现在画面中' : '未检测到覆盖图（先在 Overlay 上传模板）');
    } else if (unbound && !layerCount) {
      lines.push('覆盖图暂无法定位（联盟共享覆盖图不受支持）');
    } else if (layerCount && swN === 0) {
      lines.push('⚠ 未找到调色板色块：请打开绘画面板（地图下方）');
    } else if (layerCount) {
      var first = null;
      for (var j = 0; j < ST.templates.length; j++) {
        if (layers[ST.templates[j].id]) { first = ST.templates[j]; break; }
      }
      lines.push('覆盖图: ' + (first ? first.name : '?') + (layerCount > 1 ? ' 等 ' + layerCount + ' 层' : ''));
    }
    // 校准状态行（对齐校准 + 颜色改正进度）
    if (ST.calibMsg && Date.now() - ST.calibMsg.t < 120000) {
      lines.push(ST.calibMsg.msg);
    }
    // 补画状态行（框选/执行进度）
    if (BP && BP.msg) lines.push(BP.msg);
    if (ST.calib && ST.calib.match >= CALIB_MIN_MATCH && !ST.calib.applied) {
      lines.push('提示：对齐尚未写入——点「✅ 应用对齐」后刷新页面，官方覆盖图即落到已画内容上');
    }
    hudInfo.textContent = lines.join('\n');
    syncHudBtns();
  }
  function updateHudColor(idx, rgb, hit) {
    if (!hudDot) return;
    if (idx) {
      hudDot.style.background = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
      var p = PALETTE[idx];
      var tail = '';
      if (hit && hit.status === 1) tail = '  ✓ 已画对，无需处理';
      else if (hit && hit.status === 2 && hit.canvasRgb) {
        var ci = nearestPaletteIdx(hit.canvasRgb[0], hit.canvasRgb[1], hit.canvasRgb[2]);
        var cn = PALETTE[ci] ? PALETTE[ci][0] : '?';
        tail = '  ⚠画布=' + cn + '（画错），指哪改哪';
      } else if (hit && hit.status === 3) tail = '  · 未画';
      else if (!S.hoverMode) tail = '（点击换色：点像素即换）';
      else if (ST.lastSelect && Date.now() - ST.lastSelect.t < 4000) {
        tail = ST.lastSelect.ok ? '  ' + ST.lastSelect.msg : '  ⚠' + ST.lastSelect.msg;
      }
      hudColorName.textContent = p[0] + '  #' + h2(p[1]) + h2(p[2]) + h2(p[3]) + tail;
    } else {
      hudDot.style.background = 'transparent';
      hudColorName.textContent = '—';
    }
  }
  function h2(n) { var s = n.toString(16); return s.length < 2 ? '0' + s : s; }

  // ---------------- 油猴菜单 ----------------
  function refreshMenu() {
    if (typeof GM_registerMenuCommand !== 'function') return; // @grant none 页面环境下无 GM 菜单，功能都在 HUD
    try {
      GM_registerMenuCommand(S.enabled ? '⏸ 暂停自动选色' : '▶ 启用自动选色', function () {
        S.enabled = !S.enabled; saveSettings(); syncHudOnOff(); updateHud();
      });
      GM_registerMenuCommand(S.hoverMode ? '换色模式：悬停即换（点此改为点击像素时换）' : '换色模式：点击像素时换（点此改为悬停即换）', function () {
        S.hoverMode = !S.hoverMode; saveSettings(); updateHud();
      });
      GM_registerMenuCommand('半透明参照层：' + (S.overlay ? Math.round(S.overlay * 100) + '%' : '关') + '（点击切换 关→30%→50%→70%）', function () {
        S.overlay = S.overlay === 0 ? 0.3 : (S.overlay === 0.3 ? 0.5 : (S.overlay === 0.5 ? 0.7 : 0));
        saveSettings(); updateHud();
      });
      GM_registerMenuCommand('🔄 清除校准（下次点击重新校准）', function () {
        ST.anchor = null; ST.suspect = false; ST.viewDX = 0; ST.viewDY = 0; updateHud();
      });
      GM_registerMenuCommand(S.collapsed ? '展开状态悬浮窗' : '折叠状态悬浮窗', function () {
        S.collapsed = !S.collapsed; saveSettings(); applyHudCollapsed();
      });
    } catch (e) {}
  }

  // ---------------- 启动 ----------------
  var protos = [];
  if (uw.WebGL2RenderingContext && uw.WebGL2RenderingContext.prototype) protos.push(uw.WebGL2RenderingContext.prototype);
  if (uw.WebGLRenderingContext && uw.WebGLRenderingContext.prototype) protos.push(uw.WebGLRenderingContext.prototype);
  for (var pi = 0; pi < protos.length; pi++) {
    patchTexImage2D(protos[pi]);
    patchUseProgram(protos[pi]);
    patchUniformMatrix4fv(protos[pi]);
    patchUniform1f(protos[pi]);
    patchUniform2f(protos[pi]);
    patchDrawArrays(protos[pi]);
  }

  function start() {
    hookSetItem();
    patchFetch();
    loadTemplates();
    // 启动读一次 location：官方启动时的写入早于脚本 hook，anchor 需要初始值
    try {
      var loc0 = editBaseLoc();
      if (loc0) { ST.pendingLoc = { loc: loc0, t: Date.now() }; consumeLocation(); }
    } catch (e) {}
    refreshMenu();
    updateHud();
    setInterval(loadTemplates, 3000);
    setInterval(function () { ST.swatchDirty = true; }, 10000);
    setInterval(updateHud, 4000); // 钩子诊断状态定期刷新
    setInterval(syncEditOverlay, 500); // 放置编辑会话（DOM overlay）捕获与屏幕四边形跟踪
    // 自动定位：官方启动早期写入 location 时容器可能尚未就绪，定期重试消费
    setInterval(function () {
      if (ST.pendingLoc) consumeLocation();
    }, 500);
    overlayLoop(); // 自绘半透明参照层（rAF 循环，带签名去重）
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
