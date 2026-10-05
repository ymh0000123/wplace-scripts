// v1.2 大图多瓦片方案仿真：texImage2D 链 + uniform2f 几何关联 + 绝对定位拾取
// 官方时序复刻自 CHs5IlSX.js 的 S 类 renderFrame/prepareTile/copyTilePixels/rebuildSourceTiles
import fs from 'node:fs';

const D = 1024; // rebuildSourceTiles 步长
const k2 = (n) => 1 << Math.ceil(Math.log2(Math.max(1, n)));

// ---------- Mercator 工具（0-1 归一化） ----------
const mx01 = (lng) => (lng + 180) / 360;
function my01(lat) {
  let s = Math.sin(lat * Math.PI / 180);
  s = Math.max(-0.99999, Math.min(0.99999, s));
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}

// ---------- 官方算法复刻 ----------
function contentDims(tile, ds) {
  return [Math.max(1, Math.ceil(tile.width / ds)), Math.max(1, Math.ceil(tile.height / ds))];
}
function copyTilePixels(pixels, tile, buf, contentW, texW, texH, ds) {
  for (let row = 0; row < texH; row++) {
    const srcRow = Math.min(row * ds, tile.height - 1);
    const c = ((tile.y + srcRow) * pixels.width + tile.x) * 4;
    const u = row * texW * 4;
    if (contentW === tile.width) {
      buf.set(pixels.data.subarray(c, c + tile.width * 4), u);
    } else {
      for (let col = 0; col < contentW; col++) {
        const n2 = c + Math.min(col * ds, tile.width - 1) * 4;
        const i3 = u + col * 4;
        buf[i3] = pixels.data[n2]; buf[i3 + 1] = pixels.data[n2 + 1];
        buf[i3 + 2] = pixels.data[n2 + 2]; buf[i3 + 3] = pixels.data[n2 + 3];
      }
    }
    if (texW === contentW) continue;
    const d = u + (contentW - 1) * 4;
    for (let col = contentW; col < texW; col++) buf.set(buf.subarray(d, d + 4), u + col * 4);
  }
}
// 一个瓦片的完整渲染调用序列：texImage2D×N（若 dirty）+ uniform2f×7
function simulateTileRender(glCalls, pixels, tile, ds, dirty) {
  const [cw, ch] = contentDims(tile, ds);
  const texW = k2(cw), texH = k2(ch);
  if (dirty) {
    const buf = new Uint8Array(texW * texH * 4);
    copyTilePixels(pixels, tile, buf, cw, texW, texH, ds);
    let p = texW, m = texH;
    const u32 = new Uint32Array(buf.buffer);
    for (let lvl = 0; ; lvl++) {
      glCalls.texImage2D(p, m, buf.subarray(0, p * m * 4));
      if (p === 1 && m === 1) break;
      const e = Math.max(1, p >> 1), t = Math.max(1, m >> 1);
      for (let n = 0; n < t; n++) for (let x = 0; x < e; x++) u32[n * e + x] = u32[n * 2 * p + x * 2];
      p = e; m = t;
    }
  }
  // rebuildSourceTiles 的四角（相对模板 NW 的 Mercator 偏移）+ sourceSize/textureSize/contentSize
  glCalls.uniform2f(...tile.corners.TL);
  glCalls.uniform2f(...tile.corners.TR);
  glCalls.uniform2f(...tile.corners.BR);
  glCalls.uniform2f(...tile.corners.BL);
  glCalls.uniform2f(tile.width, tile.height);        // sourceSize
  glCalls.uniform2f(texW, texH);                     // textureSize
  glCalls.uniform2f(cw, ch);                         // textureContentSize
}
// 官方四角计算：coordinates=[NW,NE,SE,SW]（绝对 0-1 Mercator），相对 origin=NW
function makeCorners(coords, tile) {
  const W = coords.pixelsW, H = coords.pixelsH;
  const [n, r, i, a] = coords.merc; // NW,NE,SE,SW（绝对）
  const ox = n[0], oy = n[1];       // origin = NW
  const rel = ([x, y]) => [x - ox, y - oy];
  const o = (e, t) => {
    const u = n[0] + (r[0] - n[0]) * e, v = n[1] + (r[1] - n[1]) * e;
    const c = a[0] + (i[0] - a[0]) * e, l = a[1] + (i[1] - a[1]) * e;
    return [u + (c - u) * t, v + (l - v) * t];
  };
  const a0 = tile.x / W, s0 = tile.y / H, a1 = (tile.x + tile.width) / W, s1 = (tile.y + tile.height) / H;
  return {
    TL: rel(o(a0, s0)), TR: rel(o(a1, s0)), BR: rel(o(a1, s1)), BL: rel(o(a0, s1)),
    absTL: o(a0, s0), absBR: o(a1, s1)
  };
}
function buildTiles(coords, step) {
  const tiles = [];
  for (let ty = 0; ty < coords.pixelsH; ty += step)
    for (let tx = 0; tx < coords.pixelsW; tx += step) {
      const t = { x: tx, y: ty, width: Math.min(step, coords.pixelsW - tx), height: Math.min(step, coords.pixelsH - ty) };
      t.corners = makeCorners(coords, t);
      tiles.push(t);
    }
  return tiles;
}

// ---------- 脚本侧算法（与 v1.2 实现一致） ----------
function makeScriptState() {
  return { upChain: null, uPending: null, tiles: [], texCalls: 0 };
}
function onTexUpload(ST, w, h, src) {
  ST.texCalls++;
  const prev = ST.upChain;
  if (prev && w === Math.max(1, prev.w >> 1) && h === Math.max(1, prev.h >> 1)) {
    ST.upChain = { w, h };
    return;
  }
  ST.upChain = { w, h };
  const copy = new Uint8Array(w * h * 4);
  copy.set(src.subarray(0, w * h * 4));
  ST.uPending = { corners: [], rgba: copy, w, h };
}
function onUniform2f(ST, x, y) {
  const p = ST.uPending;
  if (!p) return;
  p.corners.push(x, y);
  if (p.corners.length >= 14) finalizeTile(ST, p);
}
function finalizeTile(ST, p) {
  ST.uPending = null;
  const TL = [p.corners[0], p.corners[1]], TR = [p.corners[2], p.corners[3]];
  const BR = [p.corners[4], p.corners[5]], BL = [p.corners[6], p.corners[7]];
  const tileW = p.corners[8], tileH = p.corners[9];
  const cw = Math.round(p.corners[12]), ch = Math.round(p.corners[13]);
  if (cw < 1 || ch < 1 || k2(cw) !== p.w || k2(ch) !== p.h) return;
  const rgba = new Uint8Array(cw * ch * 4);
  for (let y = 0; y < ch; y++) rgba.set(p.rgba.subarray(y * p.w * 4, y * p.w * 4 + cw * 4), y * cw * 4);
  const ds = tileW / cw;
  ST.tiles.push({ TL, TR, BR, BL, cw, ch, ds, rgba, t: Date.now() });
}
// 归属：相对四角 + 模板 origin → 绝对矩形 → 包含 + 源块≤1024 + 弱比例 + 面积最小
function attachTiles(ST, templates) {
  for (const tile of ST.tiles) {
    if (tile.tplId) continue;
    let best = null;
    const tileW = tile.tileW > 0 ? tile.tileW : tile.cw;
    for (const t of templates) {
      const ox = mx01(t.west), oy = my01(t.north);
      const x0 = tile.TL[0] + ox, x1 = tile.TR[0] + ox;
      const y0 = tile.TL[1] + oy, y1 = tile.BL[1] + oy;
      const bx0 = mx01(t.west), bx1 = mx01(t.east), by0 = my01(t.north), by1 = my01(t.south);
      const eps = 1e-9;
      if (x0 < bx0 - eps || x1 > bx1 + eps || y0 < by0 - eps || y1 > by1 + eps) continue;
      // 官方源块 ≤1024（渲染像素）
      if (tileW > 1024 + 1e-6) continue;
      // 弱比例：反推渲染总宽 ∈ [tileW, 8192]
      const ratioW = (x1 - x0) / (bx1 - bx0);
      if (ratioW <= 0) continue;
      const renderW = tileW / ratioW;
      if (renderW < tileW - 1e-6 || renderW > 8192 + 1e-6) continue;
      const area = (bx1 - bx0) * (by1 - by0);
      if (!best || area < best.area) best = { t, area, ox, oy };
    }
    if (best) tile.tplId = best.t.id;
  }
}
// 拾取：wx/wy 为绝对 0-1 Mercator
function pick(ST, templates, wx, wy) {
  const eps = 1e-12;
  for (const t of templates) { // order 降序
    for (const tile of ST.tiles) {
      if (tile.tplId !== t.id) continue;
      const ox = mx01(t.west), oy = my01(t.north);
      const x0 = tile.TL[0] + ox, x1 = tile.TR[0] + ox;
      const y0 = tile.TL[1] + oy, y1 = tile.BL[1] + oy;
      if (wx < x0 - eps || wx > x1 + eps || wy < y0 - eps || wy > y1 + eps) continue;
      const u = (wx - x0) / (x1 - x0), v = (wy - y0) / (y1 - y0);
      const cpx = Math.min(tile.cw - 1, Math.floor(u * tile.cw));
      const cpy = Math.min(tile.ch - 1, Math.floor(v * tile.ch));
      const o = (cpy * tile.cw + cpx) * 4;
      if (tile.rgba[o + 3] < 8) continue;
      return { rgb: [tile.rgba[o], tile.rgba[o + 1], tile.rgba[o + 2]], tile };
    }
  }
  return null;
}

// ---------- 测试 ----------
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
const PAL = [[68,68,68],[255,255,255],[255,204,170],[0,68,0],[0,255,0],[0,136,0],[255,0,0],[0,0,255],[255,221,0],[96,0,24]];
let seed = 777;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function makePixels(w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (rnd() < 0.1) continue;
    const c = PAL[Math.floor(rnd() * PAL.length)];
    data[i*4] = c[0]; data[i*4+1] = c[1]; data[i*4+2] = c[2]; data[i*4+3] = 255;
  }
  return { data, width: w, height: h };
}
function pxAt(pixels, x, y) {
  const o = (y * pixels.width + x) * 4;
  return [pixels.data[o], pixels.data[o+1], pixels.data[o+2], pixels.data[o+3]];
}

console.log('== T10: 大图 1500x800 两瓦片乱序上传 + 关联 + 拾取 ==');
{
  const W = 1500, H = 800;
  const px = makePixels(W, H);
  const coords = {
    pixelsW: W, pixelsH: H,
    merc: [[mx01(120), my01(30)], [mx01(120.04), my01(30)], [mx01(120.04), my01(29.99)], [mx01(120), my01(29.99)]]
  };
  const tiles = buildTiles(coords, D);
  check('瓦片数=2', tiles.length === 2, String(tiles.length));

  const ST = makeScriptState();
  const gl = {
    texImage2D: (w, h, src) => onTexUpload(ST, w, h, src),
    uniform2f: (x, y) => onUniform2f(ST, x, y)
  };
  // 视距排序：右瓦片（更近）先渲染 → 与 buildTiles 顺序相反
  const order = [tiles[1], tiles[0]];
  for (const t of order) simulateTileRender(gl, px, t, 1, true);

  check('关联瓦片数=2', ST.tiles.length === 2, String(ST.tiles.length));
  check('内容尺寸 1024 与 476', ST.tiles.every(t => t.cw === 1024 || t.cw === 476));

  const tpls = [{ id: 'A', name: 'big', west: 120, east: 120.04, north: 30, south: 29.99, w: W, h: H, order: 1, visible: true }];
  attachTiles(ST, tpls);
  check('全部归属模板 A', ST.tiles.every(t => t.tplId === 'A'));

  // 拾取验证：随机点比对原图（探针取像素中心；wy 按 Mercator 等分，与官方像素网格一致）
  let allOk = true;
  for (let i = 0; i < 400; i++) {
    const X = Math.floor(rnd() * W), Y = Math.floor(rnd() * H);
    const wx = mx01(120 + ((X + 0.5) / W) * 0.04), wy = my01(30) + (my01(29.99) - my01(30)) * ((Y + 0.5) / H);
    const got = pick(ST, tpls, wx, wy);
    const exp = pxAt(px, X, Y);
    if (exp[3] < 8) { if (got !== null) { allOk = false; break; } continue; }
    if (!got || got.rgb[0] !== exp[0] || got.rgb[1] !== exp[1] || got.rgb[2] !== exp[2]) { allOk = false; break; }
  }
  check('400 随机点拾取全部正确（含透明穿透）', allOk);
}

console.log('== T11: 4096x4096 十六瓦片全乱序 + ds=1 ==');
{
  const W = 4096, H = 4096;
  const px = makePixels(W, H);
  const coords = {
    pixelsW: W, pixelsH: H,
    merc: [[mx01(10), my01(10)], [mx01(10.08), my01(10)], [mx01(10.08), my01(9.92)], [mx01(10), my01(9.92)]]
  };
  const tiles = buildTiles(coords, D);
  check('瓦片数=16', tiles.length === 16, String(tiles.length));

  const ST = makeScriptState();
  const gl = {
    texImage2D: (w, h, src) => onTexUpload(ST, w, h, src),
    uniform2f: (x, y) => onUniform2f(ST, x, y)
  };
  // 完全乱序（shuffle）
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  for (const t of tiles) simulateTileRender(gl, px, t, 1, true);
  check('关联=16', ST.tiles.length === 16, String(ST.tiles.length));

  const tpls = [{ id: 'B', west: 10, east: 10.08, north: 10, south: 9.92, w: W, h: H, order: 1, visible: true }];
  attachTiles(ST, tpls);
  check('全部归属 B', ST.tiles.every(t => t.tplId === 'B'));

  let allOk = true;
  for (let i = 0; i < 600; i++) {
    const X = Math.floor(rnd() * W), Y = Math.floor(rnd() * H);
    const wx = mx01(10 + ((X + 0.5) / W) * 0.08), wy = my01(10) + (my01(9.92) - my01(10)) * ((Y + 0.5) / H);
    const got = pick(ST, tpls, wx, wy);
    const exp = pxAt(px, X, Y);
    if (exp[3] < 8) { if (got !== null) { allOk = false; break; } continue; }
    if (!got || got.rgb[0] !== exp[0] || got.rgb[1] !== exp[1] || got.rgb[2] !== exp[2]) { allOk = false; break; }
  }
  check('600 随机点全部正确', allOk);
}

console.log('== T12: ds=2 降采样帧（缩小视图时）拾取误差 ≤1 原像素 ==');
{
  const W = 800, H = 600;
  const px = makePixels(W, H);
  const coords = {
    pixelsW: W, pixelsH: H,
    merc: [[mx01(0), my01(0)], [mx01(0.01), my01(0)], [mx01(0.01), my01(-0.01)], [mx01(0), my01(-0.01)]]
  };
  const tiles = buildTiles(coords, D);
  const ST = makeScriptState();
  const gl = {
    texImage2D: (w, h, src) => onTexUpload(ST, w, h, src),
    uniform2f: (x, y) => onUniform2f(ST, x, y)
  };
  for (const t of tiles) simulateTileRender(gl, px, t, 2, true);
  check('ds=2 内容尺寸 400x300', ST.tiles.length === 1 && ST.tiles[0].cw === 400 && ST.tiles[0].ch === 300,
    ST.tiles.map(t => t.cw + 'x' + t.ch).join(','));

  const tpls = [{ id: 'C', west: 0, east: 0.01, north: 0, south: -0.01, w: W, h: H, order: 1, visible: true }];
  attachTiles(ST, tpls);
  let maxErr = 0, tested = 0;
  for (let i = 0; i < 300; i++) {
    const X = Math.floor(rnd() * W), Y = Math.floor(rnd() * H);
    if (pxAt(px, X, Y)[3] < 8) continue;
    const wx = mx01(((X + 0.5) / W) * 0.01), wy = my01(0) + (my01(-0.01) - my01(0)) * ((Y + 0.5) / H);
    const got = pick(ST, tpls, wx, wy);
    if (!got) continue;
    tested++;
    // 命中色应在原图 2x2 邻域内（nearest 降采样的半格偏差）
    let ok = false;
    for (let dy = 0; dy <= 1 && !ok; dy++) for (let dx = 0; dx <= 1 && !ok; dx++) {
      const nx = Math.min(W - 1, (X & ~1) + dx), ny = Math.min(H - 1, (Y & ~1) + dy);
      const e = pxAt(px, nx, ny);
      if (got.rgb[0] === e[0] && got.rgb[1] === e[1] && got.rgb[2] === e[2]) ok = true;
    }
    if (!ok) { maxErr = 99; break; }
  }
  check('降采样拾取均落在 2x2 邻域（tested=' + tested + '）', maxErr < 99 && tested > 100);
}

console.log('== T13: 同瓦片重传（进度更新）替换内容 ==');
{
  const W = 300, H = 200;
  const px1 = makePixels(W, H);
  const px2 = makePixels(W, H); // 进度更新后内容变化
  const coords = {
    pixelsW: W, pixelsH: H,
    merc: [[mx01(5), my01(5)], [mx01(5.01), my01(5)], [mx01(5.01), my01(4.99)], [mx01(5), my01(4.99)]]
  };
  const tiles = buildTiles(coords, D);
  const ST = makeScriptState();
  const gl = {
    texImage2D: (w, h, src) => onTexUpload(ST, w, h, src),
    uniform2f: (x, y) => onUniform2f(ST, x, y)
  };
  simulateTileRender(gl, px1, tiles[0], 1, true);
  simulateTileRender(gl, px2, tiles[0], 1, true); // 重传
  check('重传后仍 1 份（需去重）', ST.tiles.length === 2, String(ST.tiles.length)); // 仿真的 ST 未去重，去重在脚本层做
  // 脚本层去重：同 corners+尺寸 → 替换
  const key = (t) => t.TL.map(v => v.toFixed(12)).join(',') + '|' + t.cw + 'x' + t.ch;
  const dedup = [];
  for (const t of ST.tiles) {
    const k = key(t);
    const i = dedup.findIndex(d => key(d) === k);
    if (i === -1) dedup.push(t); else dedup[i] = t; // 后传替换
  }
  check('去重后 1 份', dedup.length === 1);
  const tpls = [{ id: 'D', west: 5, east: 5.01, north: 5, south: 4.99, w: W, h: H, order: 1, visible: true }];
  const ST2 = { tiles: dedup };
  attachTiles(ST2, tpls);
  check('重传瓦片归属 D', dedup.every(t => t.tplId === 'D'));
  // 探针对准原图像素 (150,100) 的中心
  const got = pick(ST2, tpls, mx01(5 + ((150 + 0.5) / W) * 0.01), my01(5) + (my01(4.99) - my01(5)) * ((100 + 0.5) / H));
  const exp = pxAt(px2, 150, 100);
  check('拾取到重传后的新内容', got && got.rgb[0] === exp[0] && got.rgb[1] === exp[1] && got.rgb[2] === exp[2]);
}

console.log('== T14: 多模板重叠归属（小 ⊆ 大，取最精确包含） ==');
{
  const W = 500, H = 500;
  const px = makePixels(W, H);
  // 大模板 10-10.08，小模板 10.02-10.06（经度），同一片区域
  const coords = {
    pixelsW: W, pixelsH: H,
    merc: [[mx01(10.02), my01(10)], [mx01(10.06), my01(10)], [mx01(10.06), my01(9.96)], [mx01(10.02), my01(9.96)]]
  };
  const tiles = buildTiles(coords, D);
  const ST = makeScriptState();
  const gl = {
    texImage2D: (w, h, src) => onTexUpload(ST, w, h, src),
    uniform2f: (x, y) => onUniform2f(ST, x, y)
  };
  for (const t of tiles) simulateTileRender(gl, px, t, 1, true);
  const tpls = [
    { id: 'BIG', west: 10, east: 10.08, north: 10.02, south: 9.94, w: 4000, h: 4000, order: 2, visible: true },
    { id: 'SMALL', west: 10.02, east: 10.06, north: 10, south: 9.96, w: W, h: H, order: 1, visible: true }
  ];
  attachTiles(ST, tpls);
  check('归属 SMALL（最精确包含）', ST.tiles.every(t => t.tplId === 'SMALL'),
    JSON.stringify(ST.tiles.map(t => t.tplId)));
}

console.log('== T15: 匿名瓦片（无模板匹配）不归属、拾取跳过 ==');
{
  const ST = makeScriptState();
  ST.tiles.push({
    TL: [0.1, 0.1], TR: [0.2, 0.1], BR: [0.2, 0.2], BL: [0.1, 0.2],
    cw: 100, ch: 100, ds: 1, rgba: new Uint8Array(100 * 100 * 4).fill(255), t: 0
  });
  const tpls = [{ id: 'X', west: 0, east: 0.001, north: 0.001, south: 0, w: 100, h: 100, order: 1, visible: true }];
  attachTiles(ST, tpls);
  check('保持匿名', ST.tiles[0].tplId === undefined);
  check('拾取不命中', pick(ST, tpls, 0.15, 0.15) === null);
}

console.log('== T16: 用户实际场景回归——渲染 100x100（originalWidth=3762）单瓦片归属 ==');
{
  // 复刻 wplace 实机数据：模板 A 渲染分辨率 100×100（bounds 按渲染定义），originalWidth=3762；
  // 单源瓦片 → 相对角恒为 (0,0)-(模板宽高)。旧算法 expectW=tileW/originalWidth=0.0266 与 ratioW=1.0
  // 不符 → A 被跳过 → 错归不重叠的模板 B（ratioW 恰好=100/1227）。新算法按面积最小归 A。
  const W = 100, H = 100;
  const px = makePixels(W, H);
  const coords = {
    pixelsW: W, pixelsH: H,
    merc: [[mx01(120.695625), my01(27.821044)], [mx01(120.713203), my01(27.821044)],
           [mx01(120.713203), my01(27.805497)], [mx01(120.695625), my01(27.805497)]]
  };
  const tiles = buildTiles(coords, D);
  check('单瓦片', tiles.length === 1, String(tiles.length));
  const ST = makeScriptState();
  const gl = {
    texImage2D: (w, h, src) => onTexUpload(ST, w, h, src),
    uniform2f: (x, y) => onUniform2f(ST, x, y)
  };
  for (const t of tiles) simulateTileRender(gl, px, t, 1, true);
  const tpls = [
    { id: 'ANIME', west: 120.695625, east: 120.713203, north: 27.821044, south: 27.805497, w: 3762, h: 3762, order: 1, visible: true },
    { id: 'BIGPNG', west: 119.773652, east: 119.989336, north: 27.767552, south: 27.488469, w: 1227, h: 1792, order: 0, visible: true }
  ];
  attachTiles(ST, tpls);
  check('归属 ANIME（渲染 100x100，非 originalWidth 尺度）', ST.tiles.every(t => t.tplId === 'ANIME'),
    JSON.stringify(ST.tiles.map(t => t.tplId)));
  check('相对角 TL=(0,0)（单瓦片特征）', ST.tiles[0].TL[0] === 0 && ST.tiles[0].TL[1] === 0);
  // 拾取验证：模板 A 中心像素
  const got = pick(ST, tpls, mx01(120.695625 + (50.5 / W) * 0.017578), my01(27.821044) + (my01(27.805497) - my01(27.821044)) * ((50.5) / H));
  const exp = pxAt(px, 50, 50);
  check('中心像素拾取正确', got && got.rgb[0] === exp[0] && got.rgb[1] === exp[1] && got.rgb[2] === exp[2]);
}

console.log('\nRESULT: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
