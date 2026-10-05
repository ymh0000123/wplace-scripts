// ==UserScript==
// @name         Wplace Overlay 自动选色
// @name:en      Wplace Overlay Auto Color
// @namespace    https://wplace.live/
// @version      2.4.0
// @description  在 wplace.live 打开覆盖图(Overlay)作画时，鼠标所指的覆盖图像素自动匹配官方调色板并选中对应颜色（悬停即换 / 点击换色两种模式）。参照层自动贴合官方覆盖图：劫持官方渲染 uniform 用官方矩阵重放屏幕几何，缩放/拖动全程像素级跟随，无需手动定位。跳过锁定色块（避免 Unlock 弹窗引发地图重排）与当前已选中色块（避免官方 onColorReselect 的 flyTo 导航造成画面飞移）。官方覆盖图停止渲染（退出覆盖模式/隐藏模板）时参照层自动收起，重新显示后自动恢复；状态窗可折叠（Ctrl+Shift+H 随时找回），折叠状态与位置跨刷新记忆。
// @description:en  Auto-matches the overlay pixel under your cursor on wplace.live to the official palette. The reference layer auto-aligns with the official overlay by replaying its render uniforms through the official matrix, tracking zoom/pan pixel-perfectly. Skips locked swatches (their click opens the Unlock paywall dialog, which reflows/resizes the map) and the currently-selected swatch (re-clicking it triggers the official template-build "relocate to color" flyTo, making the map jump around). Auto-hides the reference layer when the official overlay stops rendering (leaving overlay mode / hiding templates) and restores it when rendering resumes; the HUD panel is collapsible (Ctrl+Shift+H to toggle), and its collapsed state and position persist across reloads.
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
    ovGone: false       // 官方覆盖图已停止渲染（退出覆盖模式）→ 参照层收起
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
                var q = rpProject(RP.M, [tile.TL, tile.TR, tile.BR, tile.BL], RP.ws, cv.clientWidth, cv.clientHeight);
                if (q) {
                  tile.scrQuad = q; tile.scrT = Date.now();
                  ST.scrRev = (ST.scrRev || 0) + 1;
                  ST.lastScrDraw = Date.now(); ST.ovGone = false; // 官方覆盖图仍在渲染
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

  // ---------------- 模板元数据（localStorage['template-overlays']） ----------------
  function loadTemplates() {
    var raw = '';
    try { raw = localStorage.getItem('template-overlays') || ''; } catch (e) {}
    if (raw === ST.tplRaw) return;
    ST.tplRaw = raw;
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
            order: typeof t.order === 'number' ? t.order : 0
          });
        }
      }
    } catch (e) {}
    tpls.sort(function (a, b) { return b.order - a.order; });
    ST.templates = tpls;
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
      if (hit) {
        var idx = nearestPaletteIdx(hit.rgb[0], hit.rgb[1], hit.rgb[2]);
        selectColor(idx);
        updateHudColor(idx, hit.rgb);
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
  document.addEventListener('touchmove', function (e) {
    if (e.touches && e.touches.length >= 2 && insideMap(e.target)) markSuspect();
  }, { capture: true, passive: true });
  document.addEventListener('keydown', function (e) {
    if (e.key && e.key.indexOf('Arrow') === 0) markSuspect();
  }, true);
  // Ctrl+Shift+H：折叠/展开状态窗——界面无论被折叠成多小、拖到哪里，一键找回
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && e.shiftKey && (e.key === 'H' || e.key === 'h')) {
      S.collapsed = !S.collapsed; saveSettings(); applyHudCollapsed(); updateHud();
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
  // 官方几何取色：屏幕点经官方屏幕四边形仿射反解 → 源像素（与 drawOverlay 的正变换互逆，所见即所得）
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
      var p = ((v | 0) * t.cw + (u | 0)) * 4;
      if (t.rgba[p + 3] < 8) continue; // 透明 → 下一瓦片/层
      var name = '覆盖图';
      if (t.tplId !== null) {
        var tpl = tplById(t.tplId);
        if (tpl) name = tpl.name;
      }
      return { rgb: [t.rgba[p], t.rgba[p + 1], t.rgba[p + 2]], name: name };
    }
    return null;
  }

  function schedulePick() {
    if (ST.pickPending) return;
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
        if (S.hoverMode) selectColor(idx);
        updateHudColor(idx, hit.rgb);
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
    var auto = 0, sigParts = [W, H, S.overlay, ST.scrRev, OV.rev];
    for (var ai = 0; ai < OV.tiles.length; ai++) {
      var sq = OV.tiles[ai].src && OV.tiles[ai].src.scrQuad;
      if (sq) {
        auto++;
        for (var qi = 0; qi < 4; qi++) sigParts.push(Math.round(sq[qi][0] * 10), Math.round(sq[qi][1] * 10));
      }
    }
    if (auto) {
      var sig = sigParts.join('|');
      if (sig === ovSig) return;
      ovSig = sig;
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
        ovCtx.setTransform(dpr * ax, dpr * ay, dpr * bx, dpr * by, dpr * q[0][0], dpr * q[0][1]);
        ovCtx.drawImage(o.cv, 0, 0);
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
      'box-shadow:0 4px 16px rgba(0,0,0,.35);user-select:none;min-width:220px;max-width:320px;cursor:move;';
    hud.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;font-weight:600;">覆盖图自动选色' +
      '<span id="wpAC-onoff" style="font-weight:400;cursor:pointer;font-size:11px;padding:0 8px;border-radius:8px;background:#2d6a4f;">开</span>' +
      '<span id="wpAC-fold" style="cursor:pointer;opacity:.7;margin-left:auto;font-size:13px;line-height:1;padding:2px 6px;">—</span></div>' +
      '<div id="wpAC-btns" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;">' +
      '<span class="wpAC-btn" id="wpAC-mode"></span>' +
      '<span class="wpAC-btn" id="wpAC-layer"></span>' +
      '<span class="wpAC-btn" id="wpAC-zin">＋</span>' +
      '<span class="wpAC-btn" id="wpAC-zout">－</span>' +
      '<span class="wpAC-btn" id="wpAC-ccal"></span>' +
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
    hud.querySelector('#wpAC-ccal').addEventListener('click', function () {
      ST.anchor = null; ST.suspect = false; ST.viewDX = 0; ST.viewDY = 0; updateHud();
    });
    hud.querySelector('#wpAC-onoff').addEventListener('click', function () {
      S.enabled = !S.enabled; saveSettings(); syncHudOnOff(); updateHud();
    });
    hud.querySelector('#wpAC-fold').addEventListener('click', function () {
      S.collapsed = !S.collapsed; saveSettings(); applyHudCollapsed();
    });
    var dragHud = null;
    hud.addEventListener('mousedown', function (e) {
      if (e.target.closest && e.target.closest('#wpAC-onoff,#wpAC-fold,#wpAC-btns')) return;
      var r = hud.getBoundingClientRect();
      dragHud = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragHud) return;
      var p = hudClampPos(e.clientX - dragHud.dx, e.clientY - dragHud.dy);
      hud.style.left = p.x + 'px';
      hud.style.top = p.y + 'px';
      hud.style.right = 'auto'; hud.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', function () {
      if (!dragHud) return;
      dragHud = null;
      // 记住松手位置：下次刷新/重开恢复（跨会话记忆）
      try {
        var r = hud.getBoundingClientRect();
        var p = hudClampPos(r.left, r.top);
        S.pos = { x: Math.round(p.x), y: Math.round(p.y) };
        saveSettings();
      } catch (e) {}
    });
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
    hudInfo.textContent = lines.join('\n');
    syncHudBtns();
  }
  function updateHudColor(idx, rgb) {
    if (!hudDot) return;
    if (idx) {
      hudDot.style.background = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
      var p = PALETTE[idx];
      var tail = '';
      if (!S.hoverMode) tail = '（点击换色：点像素即换）';
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
    loadTemplates();
    refreshMenu();
    updateHud();
    setInterval(loadTemplates, 3000);
    setInterval(function () { ST.swatchDirty = true; }, 10000);
    setInterval(updateHud, 4000); // 钩子诊断状态定期刷新
    // 自动定位：官方启动早期写入 location 时容器可能尚未就绪，定期重试消费
    setInterval(function () {
      if (ST.pendingLoc) consumeLocation();
    }, 500);
    overlayLoop(); // 自绘半透明参照层（rAF 循环，带签名去重）
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
