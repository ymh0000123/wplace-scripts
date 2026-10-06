// v2.5.0 对齐校准仿真：画布瓦片捕获换算 + 偏移搜索 + done/wrong/missing 统计 + bounds 写回
// 算法复刻自 wplace-overlay-autocolor.user.js；关键常量从源码断言防止测试与实现漂移。
// 场景：别人已把模板图案画在画布上（偏移 (7,3)、其中 4 像素画错色），校准应找回偏移。
import fs from 'node:fs';

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}
const SRC = fs.readFileSync(new URL('./wplace-overlay-autocolor.user.js', import.meta.url), 'utf8');

// ---------- 源码一致性断言（防测试复刻与实现漂移） ----------
console.log('== C0: 源码常量一致 ==');
check('WORLD_PX=2048000 (tileSize 1000 × 2^11)', SRC.includes('var TILE_PX = 1000, WORLD_PX = 2048000;'));
check('官方 auto-paint 式逐字节匹配', SRC.includes('function sameColor(c, r, g, b)') && SRC.includes('function isPainted(c)'));
check('搜索半径 ±48', SRC.includes('Math.min(48, Math.max(bbox.maxDx, bbox.maxDy, 0))'));
check('免费色表来自官方 u 数组', SRC.includes('[7, 8, 9, 12, 15, 18, 19, 21, 23, 24, 26, 27, 30, 31, 34, 39, 42, 43, 45, 48, 50, 52, 54, 55, 57, 59, 62]'));
check('瓦片 URL 正则与官方一致(/files/sN/tiles/x/y.png)', SRC.includes('/\\/files\\/(s\\d+)\\/tiles\\/(-?\\d+)\\/(-?\\d+)\\.png/'));
check('最低匹配率门槛 0.12', SRC.includes('var CALIB_MIN_MATCH = 0.12;'));

// ---------- 与脚本一致的 Mercator/换算 ----------
const WORLD_PX = 2048000, TILE_PX = 1000;
const mx01 = (lng) => (lng + 180) / 360;
function my01(lat) {
  let s = Math.sin(lat * Math.PI / 180);
  s = Math.max(-0.99999, Math.min(0.99999, s));
  return 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
}
function mercYToLat(my) {
  const s = Math.tanh(Math.PI * (1 - 2 * my));
  return Math.asin(Math.max(-1, Math.min(1, s))) * 180 / Math.PI;
}
const lngAt = (wx) => wx / WORLD_PX * 360 - 180;

// ---------- Lab（与脚本同式） ----------
function rgbToLab(r, g, b) {
  const f = c => { c /= 255; return c > 0.04045 ? Math.pow((c + 0.055) / 1.055, 2.4) : c / 12.92; };
  const R = f(r), G = f(g), B = f(b);
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const k = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  x = k(x); y = k(y); z = k(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}
function labDist2(rgb, lab) {
  const l = rgbToLab(rgb[0], rgb[1], rgb[2]);
  const d1 = l[0] - lab[0], d2 = l[1] - lab[1], d3 = l[2] - lab[2];
  return d1 * d1 + d2 * d2 + d3 * d3;
}

console.log('== C1: Mercator 逆变换 round-trip ==');
for (const lat of [85.0511, 60, 35.6762, 0, -33.8688, -80]) {
  const back = mercYToLat(my01(lat));
  check(`lat ${lat} → my → lat 误差 < 1e-9`, Math.abs(back - lat) < 1e-9, `got ${back}`);
}
check('lngAt round-trip', Math.abs(lngAt(mx01(139.69) * WORLD_PX) - 139.69) < 1e-9);

// ---------- 画布瓦片存储与查询（复刻 canvasPixelAt/storeMapTile 查表逻辑） ----------
const mapTiles = {};
let mapTileBytes = 0;
function storeMapTile(x, y, img) {
  const key = x + ',' + y, old = mapTiles[key];
  if (old) mapTileBytes -= old.data.length;
  mapTiles[key] = { x, y, w: img.w, h: img.h, data: img.data, t: Date.now() };
  mapTileBytes += img.data.length;
}
function canvasPixelAt(mx, my) {
  if (!(mx >= 0 && mx <= 1 && my >= 0 && my <= 1)) return null;
  const wx = mx * WORLD_PX, wy = my * WORLD_PX;
  const tx = Math.floor(wx / TILE_PX), ty = Math.floor(wy / TILE_PX);
  const t = mapTiles[tx + ',' + ty];
  if (!t) return null;
  const px = wx - tx * TILE_PX, py = wy - ty * TILE_PX;
  if (px < 0 || py < 0 || px >= t.w || py >= t.h) return null;
  const o = ((py | 0) * t.w + (px | 0)) * 4;
  return [t.data[o], t.data[o + 1], t.data[o + 2], t.data[o + 3]];
}

console.log('== C2: 世界像素 → 瓦片查询 ==');
{
  const w = TILE_PX, h = TILE_PX;
  const data = new Uint8ClampedArray(w * h * 4);
  data[(123 * w + 456) * 4] = 250; data[(123 * w + 456) * 4 + 1] = 120; data[(123 * w + 456) * 4 + 2] = 30;
  storeMapTile(2000, 1000, { w, h, data });
  // tile(2000,1000) 西北角世界像素 = (2000000, 1000000)
  const mx = (2000000 + 456.5) / WORLD_PX, my = (1000000 + 123.5) / WORLD_PX;
  const c = canvasPixelAt(mx, my);
  check('456,123 处取色正确', c && c[0] === 250 && c[1] === 120 && c[2] === 30, JSON.stringify(c));
  check('瓦片外返回 null', canvasPixelAt((1999999.5) / WORLD_PX, my) === null);
  check('Mercator 越界 null', canvasPixelAt(1.5, 0.5) === null);
}

// ---------- 官方调色板节选 + 免费色表 ----------
const PALETTE = { 7: [237, 28, 36], 19: [64, 147, 228], 33: [165, 14, 30], 34: [250, 128, 114], 5: [255, 255, 255] };
const FREE = new Set([7, 8, 9, 12, 15, 18, 19, 21, 23, 24, 26, 27, 30, 31, 34, 39, 42, 43, 45, 48, 50, 52, 54, 55, 57, 59, 62]);
// 官方瓦片实测：未涂像素 alpha=0（tRNS 索引0），已画 alpha=255 且为精确调色板色

// ---------- 场景构造：模板 100×100（红蓝各半），画布上偏移 (7,3) 已画，4 像素画错 ----------
const TPL_W = 100, TPL_H = 100, DX = 7, DY = 3;
// 模板 bounds：世界像素 [2000000,2000100)×[1000000,1000100)，即瓦片 (2000,1000) 内
const tpl = {
  id: 't1', name: '测试模板', w: TPL_W, h: TPL_H,
  mx0: 2000000 / WORLD_PX, mx1: (2000000 + TPL_W) / WORLD_PX,
  my0: 1000000 / WORLD_PX, my1: (1000000 + TPL_H) / WORLD_PX
};
// 模板纹理 tile：四角 = 相对 bounds 西北角的 Mercator 偏移
const wfrac = TPL_W / WORLD_PX, hfrac = TPL_H / WORLD_PX;
const tex = {
  TL: [0, 0], TR: [wfrac, 0], BR: [wfrac, hfrac], BL: [0, hfrac],
  cw: TPL_W, ch: TPL_H, rgba: new Uint8Array(TPL_W * TPL_H * 4), tplId: 't1'
};
const quad = (x, y) => ((x < 50) !== (y < 40)) ? PALETTE[19] : PALETTE[7]; // 四象限：破坏单一方向平移自相似
for (let y = 0; y < TPL_H; y++) for (let x = 0; x < TPL_W; x++) {
  const c = quad(x, y);
  const o = (y * TPL_W + x) * 4;
  tex.rgba[o] = c[0]; tex.rgba[o + 1] = c[1]; tex.rgba[o + 2] = c[2]; tex.rgba[o + 3] = 255;
}
// 画布瓦片：未涂=透明（alpha 0）+ 图案偏移 (DX,DY)，其中 4 像素画错（2 非免费 Dark Red + 2 免费 Light Red）
{
  const w = TILE_PX, h = TILE_PX;
  const data = new Uint8ClampedArray(w * h * 4); // 默认全 0 = 未涂（官方瓦片实测：未涂像素 alpha=0）
  const put = (x, y, c) => { const o = (y * w + x) * 4; data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255; };
  for (let y = 0; y < TPL_H; y++) for (let x = 0; x < TPL_W; x++) {
    const c = quad(x, y);
    put(x + DX, y + DY, c); // 瓦片内局部坐标（瓦片原点=模板 bounds 西北角，见下）
  }
  // wrong：模板像素 (10,10)/(12,10) 画成 Dark Red（非免费）；(60,20)/(62,20) 画成 Light Red（免费）
  put(10 + DX, 10 + DY, PALETTE[33]); put(12 + DX, 10 + DY, PALETTE[33]);
  put(60 + DX, 20 + DY, PALETTE[34]); put(62 + DX, 20 + DY, PALETTE[34]);
  storeMapTile(2000, 1000, { w, h, data });
}
// 注：模板 bounds 西北角=世界(2000000,1000000)=瓦片(2000,1000)西北角 → 瓦片内局部坐标=相对 bounds 的偏移

// ---------- texPxMerc（复刻）：纹理像素 → 绝对 Mercator ----------
function texPxMerc(tile, t, px, py) {
  return [
    t.mx0 + tile.TL[0] + (tile.TR[0] - tile.TL[0]) * (px + 0.5) / tile.cw,
    t.my0 + tile.TL[1] + (tile.BL[1] - tile.TL[1]) * (py + 0.5) / tile.ch
  ];
}

console.log('== C3: 模板纹理像素 ↔ 画布位置 ==');
{
  const m = texPxMerc(tex, tpl, 0, 0);
  const wx = m[0] * WORLD_PX, wy = m[1] * WORLD_PX;
  check('模板 (0,0) 中心 ≈ 世界 (2000000.5, 1000000.5)',
    Math.abs(wx - 2000000.5) < 1e-6 && Math.abs(wy - 1000000.5) < 1e-6, `${wx},${wy}`);
}

// ---------- 判定函数（与脚本/官方 auto-paint 一致） ----------
const isPainted = (c) => c[3] >= 128;
const sameColor = (c, r, g, b) => c[0] === r && c[1] === g && c[2] === b;
function scoreOffset(samples, dx, dy) {
  let hit = 0, n = 0;
  for (const s of samples) {
    const c = canvasPixelAt((s.wx + dx) / WORLD_PX, (s.wy + dy) / WORLD_PX);
    if (!c || !isPainted(c)) continue;
    n++;
    if (sameColor(c, s.r, s.g, s.b)) hit++;
  }
  return n >= 8 ? hit / n : 0;
}

console.log('== C5: 偏移搜索找到 (7,3) ==');
// 采样点构造（复刻 doCalibrate 步骤 1-2：不透明模板像素 → 世界像素 → 画布色）
const samples = [];
for (let y = 0; y < TPL_H; y += 1) for (let x = 0; x < TPL_W; x += 1) {
  const o = (y * TPL_W + x) * 4;
  const m = texPxMerc(tex, tpl, x, y);
  samples.push({
    t: tex, x, y,
    r: tex.rgba[o], g: tex.rgba[o + 1], b: tex.rgba[o + 2],
    wx: Math.floor(m[0] * WORLD_PX), wy: Math.floor(m[1] * WORLD_PX),
    cv: canvasPixelAt(m[0], m[1])
  });
}
const valid = samples.filter(s => s.cv);
{
  const mTrue = scoreOffset(valid, DX, DY);
  const mZero = scoreOffset(valid, 0, 0);
  const mFar = scoreOffset(valid, -20, -20);
  check(`真实偏移 (${DX},${DY}) 匹配率 > 0.98`, mTrue > 0.98, mTrue.toFixed(3));
  check(`零偏移匹配率较低 (${mZero.toFixed(3)})`, mZero < mTrue - 0.01);
  check(`远离偏移 (-20,-20) 显著更低 (${mFar.toFixed(3)})`, mFar < mTrue - 0.3, mFar.toFixed(3));
  // 全局搜索：-48..48 步长 4（与脚本一致，平局取 |δ| 小），top3 + 精搜 ±3 步长 1
  const coarse = [];
  for (let dy = -12; dy <= 12; dy++) for (let dx = -12; dx <= 12; dx++) coarse.push([dx * 4, dy * 4]);
  coarse.push([0, 0]);
  const top = coarse.map(([dx, dy]) => ({ dx, dy, m: scoreOffset(valid, dx, dy) }));
  top.sort((a, b) => {
    const d = b.m - a.m;
    if (d > 0.005) return 1;
    if (d < -0.005) return -1;
    return (Math.abs(a.dx) + Math.abs(a.dy)) - (Math.abs(b.dx) + Math.abs(b.dy));
  });
  check('粗搜 top1 落在真解 ±4 内', Math.abs(top[0].dx - DX) <= 4 && Math.abs(top[0].dy - DY) <= 4, JSON.stringify(top[0]));
  let fine = null;
  for (const seed of top.slice(0, 3)) {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const fx = seed.dx + dx, fy = seed.dy + dy, m = scoreOffset(valid, fx, fy);
      const better = !fine || m > fine.m + 0.005 ||
        (m > fine.m - 0.005 && Math.abs(fx) + Math.abs(fy) < Math.abs(fine.dx) + Math.abs(fine.dy));
      if (better) fine = { dx: fx, dy: fy, m };
    }
  }
  check('精搜精确命中 (7,3)', fine.dx === DX && fine.dy === DY, JSON.stringify(fine));
  check('精搜匹配率 > 0.99', fine.m > 0.99, fine.m.toFixed(4));
}

// ---------- fullScan 统计（复刻） ----------
console.log('== C6: done/wrong/missing 统计 + 免费色检测 ==');
function fullScan(dx, dy) {
  let total = 0, done = 0, wrong = 0, missing = 0, wrongFree = 0, wrongN = 0;
  const st = new Uint8Array(tex.cw * tex.ch);
  for (let y = 0; y < tex.ch; y++) for (let x = 0; x < tex.cw; x++) {
    const o = (y * tex.cw + x) * 4;
    if (tex.rgba[o + 3] < 200) continue;
    total++;
    const m = texPxMerc(tex, tpl, x, y);
    const c = canvasPixelAt(m[0] + dx / WORLD_PX, m[1] + dy / WORLD_PX);
    let stv = 0;
    if (c) {
      if (!isPainted(c)) { stv = 3; missing++; }
      else if (sameColor(c, tex.rgba[o], tex.rgba[o + 1], tex.rgba[o + 2])) { stv = 1; done++; }
      else {
        stv = 2; wrong++; wrongN++;
        if (FREE.has(nearestIdx(c))) wrongFree++;
      }
    }
    st[y * tex.cw + x] = stv;
  }
  return { total, done, wrong, missing, freeOnly: wrongN > 0 && wrongFree === wrongN, st };
}
function nearestIdx(c) { // 测试场景只有 5 种可能色
  let best = 0, bd = Infinity;
  for (const k in PALETTE) {
    const p = PALETTE[k];
    const d = labDist2(c, rgbToLab(p[0], p[1], p[2]));
    if (d < bd) { bd = d; best = +k; }
  }
  return best;
}
{
  const r = fullScan(DX, DY);
  check('total = 10000（全不透明）', r.total === 10000, String(r.total));
  check('done = 9996（4 像素画错）', r.done === 9996, String(r.done));
  check('wrong = 4', r.wrong === 4, String(r.wrong));
  check('missing = 0（图案完全覆盖模板范围）', r.missing === 0, String(r.missing));
  check('wrong 混含免费/非免费 → freeOnly=false', r.freeOnly === false);
  check('状态图：wrong 位置标记 2（模板像素索引）', r.st[10 * 100 + 10] === 2 && r.st[20 * 100 + 60] === 2, `st[1010]=${r.st[10*100+10]} st[2060]=${r.st[20*100+60]}`);
  check('状态图：done 位置标记 1（模板像素索引）', r.st[30 * 100 + 30] === 1);
}

console.log('== C7: 全免费色 wrong → freeOnly=true ==');
{
  // 把 4 个 wrong 像素都改成 Light Red（免费 34）
  const t = mapTiles['2000,1000'];
  const put = (x, y, c) => { const o = (y * t.w + x) * 4; t.data[o] = c[0]; t.data[o + 1] = c[1]; t.data[o + 2] = c[2]; };
  put(10 + DX, 10 + DY, PALETTE[34]); put(12 + DX, 10 + DY, PALETTE[34]);
  const r = fullScan(DX, DY);
  check('wrong=4 且全部免费色', r.wrong === 4 && r.freeOnly === true, JSON.stringify({ wrong: r.wrong, freeOnly: r.freeOnly }));
}

console.log('== C8: 底色区域 → missing ==');
{
  // 把图案右上角区域涂回透明（模拟未画：官方瓦片未涂=alpha 0）
  const t = mapTiles['2000,1000'];
  for (let y = 80; y < 90; y++) for (let x = 80; x < 90; x++) {
    const o = ((y + DY) * t.w + (x + DX)) * 4;
    t.data[o] = 0; t.data[o + 1] = 0; t.data[o + 2] = 0; t.data[o + 3] = 0;
  }
  const r = fullScan(DX, DY);
  check('missing = 100（涂回底色的区域）', r.missing === 100, String(r.missing));
  check('done = 10000 - 4 - 100', r.done === 9896, String(r.done));
}

console.log('== C9: 应用对齐——bounds 平移写回 ==');
{
  // 复刻 applyCalibToStorage 的 bounds 平移
  const bounds = {
    west: lngAt(2000000), east: lngAt(2000100),
    north: mercYToLat(1000000 / WORLD_PX), south: mercYToLat(1000100 / WORLD_PX)
  };
  const dwx = DX, dwy = DY;
  const wx0 = mx01(bounds.west) * WORLD_PX + dwx, wx1 = mx01(bounds.east) * WORLD_PX + dwx;
  const wy0 = my01(bounds.north) * WORLD_PX + dwy, wy1 = my01(bounds.south) * WORLD_PX + dwy;
  const nb = { west: lngAt(wx0), east: lngAt(wx1), north: mercYToLat(wy0 / WORLD_PX), south: mercYToLat(wy1 / WORLD_PX) };
  const px = (b) => ({
    x0: Math.round(mx01(b.west) * WORLD_PX), x1: Math.round(mx01(b.east) * WORLD_PX),
    y0: Math.round(my01(b.north) * WORLD_PX), y1: Math.round(my01(b.south) * WORLD_PX)
  });
  const a = px(bounds), b2 = px(nb);
  check('west 世界像素 +7', b2.x0 === a.x0 + DX, `${a.x0}→${b2.x0}`);
  check('east 世界像素 +7', b2.x1 === a.x1 + DX);
  check('north 世界像素 +3', b2.y0 === a.y0 + DY, `${a.y0}→${b2.y0}`);
  check('south 世界像素 +3', b2.y1 === a.y1 + DY);
  check('尺寸不变（纯平移）', (b2.x1 - b2.x0) === (a.x1 - a.x0) && (b2.y1 - b2.y0) === (a.y1 - a.y0));
  // JSON 往返（官方 E()/T() 解析容忍数字格式变化）
  const arr = [{ id: 't1', name: 'x', bounds: nb, originalWidth: 100, originalHeight: 100, opacity: 1, visible: true, order: 0 }];
  const rt = JSON.parse(JSON.stringify(arr));
  check('JSON 往返后 bounds 仍在 ±0.001 世界像素', Math.abs(mx01(rt[0].bounds.west) * WORLD_PX - wx0) < 1e-3);
}

console.log('== C10: fetch hook URL 解析 ==');
{
  const re = /\/files\/(s\d+)\/tiles\/(-?\d+)\/(-?\d+)\.png/;
  const m1 = re.exec('https://backend.wplace.live/files/s0/tiles/123/456.png');
  const m2 = re.exec('https://backend.wplace.live/files/s2/tiles/-3/-7.png?x=1');
  const m3 = re.exec('https://backend.wplace.live/api/me');
  check('标准 URL 解析', m1 && m1[1] === 's0' && m1[2] === '123' && m1[3] === '456');
  check('负坐标 + 查询串解析', m2 && m2[2] === '-3' && m2[3] === '-7');
  check('非瓦片 URL 不匹配', !m3);
}

// ================= v2.5.1 编辑中模板（live 虚拟 bounds） =================
// 场景：官方放置编辑会话 suppressPersist → 模板不在 localStorage。脚本用 drawArrays
// 捕获的屏幕四边形反解绝对 Mercator，恢复模板 origin，动态构造虚拟模板条目供校准。

console.log('== L0: v2.5.1 源码一致 ==');
check('rpUnproject 反解函数存在', SRC.includes('function rpUnproject(M, ws, sx, sy, cvw, cvh)'));
check('drawArrays 记录视口尺寸 scrW/scrH', SRC.includes('tile.scrW = cv.clientWidth; tile.scrH = cv.clientHeight;'));
check('未归属瓦片触发 live 同步', SRC.includes('if (!tile.tplId) scheduleLiveSync();'));
check('live 同步节流 250ms', SRC.includes("setTimeout(function () { ST.liveT = 0; syncLiveTemplates(); }, 250)"));
check('loadTemplates 合并 live 条目', SRC.includes('buildTplList().concat(ST.liveTpls || [])'));
check('syncLive 用 buildTplList 重建', SRC.includes('buildTplList().concat(live)'));
check('hookSetItem 监听官方 persist', SRC.includes("k === 'template-overlays'"));
check('pickCalibTemplate 编辑中模板优先', SRC.includes('if (!v.virtual || !v.visible) continue;'));
check('应用对齐拦截未保存的编辑中模板', SRC.includes('isLiveId(ST.calib.tplId)'));
check('live 暂时消失不销毁校准（refreshCalibStats 保护）', SRC.includes('if (!isLiveId(c.tplId)) clearCalib();'));
check('live 归属的瓦片已归属真实模板时跳过分组', SRC.includes('if (t.tplId && !isLiveId(t.tplId)) continue;'));

// ---------- rpProject/rpUnproject 复刻 ----------
function rpProject(M, corners, ws, cvw, cvh) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const wx = corners[i][0] * ws, wy = corners[i][1] * ws;
    const cx = M[0] * wx + M[4] * wy + M[12];
    const cy = M[1] * wx + M[5] * wy + M[13];
    const cw = M[3] * wx + M[7] * wy + M[15];
    if (!isFinite(cw) || cw <= 0) return null;
    out.push([(cx / cw + 1) / 2 * cvw, (1 - (cy / cw + 1) / 2) * cvh]);
  }
  return out;
}
function rpUnproject(M, ws, sx, sy, cvw, cvh) {
  const nx = sx / cvw * 2 - 1, ny = 1 - sy / cvh * 2;
  const a11 = M[0] - nx * M[3], a12 = M[4] - nx * M[7];
  const a21 = M[1] - ny * M[3], a22 = M[5] - ny * M[7];
  const b1 = nx * M[15] - M[12], b2 = ny * M[15] - M[13];
  const det = a11 * a22 - a12 * a21;
  if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [((b1 * a22 - a12 * b2) / det) / ws, ((a11 * b2 - b1 * a21) / det) / ws];
}

console.log('== L1: rpUnproject round-trip（正交 + 透视） ==');
{
  const WS = 2048000, CVW = 1000, CVH = 800;
  // 正交（俯视）：屏幕 = scale + translate
  const ortho = [0.002, 0, 0, 0, 0, 0.002, 0, 0, 0, 0, 1, 0, -4000.4, -1999.5, 0, 1];
  // 透视（倾斜）：w 分量随 wx/wy 线性变化 + 轻微旋转
  const persp = [0.0019, 0.0003, 0, 2e-7, -0.0004, 0.0021, 0, 1.5e-7, 0, 0, 1, 0, -3700, -2100, 0, 1];
  for (const [label, M] of [['正交', ortho], ['透视', persp]]) {
    let worst = 0;
    for (const [mx, my] of [[0.9765625, 0.48828125], [0.5, 0.5], [0.3, 0.7], [0.9, 0.1]]) {
      const pt = [[mx, my], [mx, my], [mx, my], [mx, my]]; // rpProject 固定处理 4 角
      const q = rpProject(M, pt, WS, CVW, CVH);
      const back = q && rpUnproject(M, WS, q[0][0], q[0][1], CVW, CVH);
      if (!q || !back) { worst = Infinity; break; }
      worst = Math.max(worst, Math.abs(back[0] - mx), Math.abs(back[1] - my));
    }
    check(`${label}矩阵 round-trip 误差 < 1e-9`, worst < 1e-9, `worst=${worst}`);
  }
  const q0 = rpProject(ortho, [[0.9765625, 0.48828125], [0.9765625, 0.48828125], [0.9765625, 0.48828125], [0.9765625, 0.48828125]], WS, CVW, CVH);
  check('模板 NW 投影到预期屏幕点 (300,200)', Math.abs(q0[0][0] - 300) < 1e-6 && Math.abs(q0[0][1] - 200) < 1e-6, JSON.stringify(q0[0]));
}

// ---------- live 分组仿真（复刻 syncLiveTemplates 核心） ----------
const isLiveId = (id) => String(id || '').indexOf('wpAC-live') === 0;
function syncLiveSim(tiles) {
  const groups = [];
  for (const t of tiles) {
    if (!t.scrQuad || !t.rpM || !t.rpWs || !t.scrW) continue;
    if (t.tplId && !isLiveId(t.tplId)) continue;
    const abs = rpUnproject(t.rpM, t.rpWs, t.scrQuad[0][0], t.scrQuad[0][1], t.scrW, t.scrH);
    if (!abs) continue;
    const ox = abs[0] - t.TL[0], oy = abs[1] - t.TL[1];
    let g = groups.find(g => Math.abs(g.ox - ox) < 1e-7 && Math.abs(g.oy - oy) < 1e-7);
    if (!g) { g = { ox, oy, mx1: -Infinity, my1: -Infinity }; groups.push(g); }
    if (t.BR[0] > g.mx1) g.mx1 = t.BR[0];
    if (t.BR[1] > g.my1) g.my1 = t.BR[1];
  }
  groups.sort((a, b) => a.oy - b.oy || a.ox - b.ox);
  return groups.map((g, i) => ({
    id: 'wpAC-live' + (groups.length > 1 ? ':' + i : ''),
    mx0: g.ox, my0: g.oy, mx1: g.ox + g.mx1, my1: g.oy + g.my1,
    visible: true, virtual: true
  }));
}
const ORTHO = [0.002, 0, 0, 0, 0, 0.002, 0, 0, 0, 0, 1, 0, -4000.4, -1999.5, 0, 1];
const WS = 2048000, CVW = 1000, CVH = 800;
// 模拟一块编辑中模板瓦片：absOrigin=模板绝对 NW（编辑位置），rel=该瓦片相对模板 NW 的偏移
function fakeTile(absOrigin, relTL, relBR, tplId) {
  const aTL = [absOrigin[0] + relTL[0], absOrigin[1] + relTL[1]];
  const aBR = [absOrigin[0] + relBR[0], absOrigin[1] + relBR[1]];
  const q = rpProject(ORTHO, [aTL, [aBR[0], aTL[1]], aBR, [aTL[0], aBR[1]]], WS, CVW, CVH);
  return { TL: relTL, TR: [relBR[0], relTL[1]], BR: relBR, BL: [relTL[0], relBR[1]], tileW: 100,
    scrQuad: q, scrW: CVW, scrH: CVH, rpM: ORTHO, rpWs: WS, tplId: tplId || null };
}
const REL100 = { TL: [0, 0], BR: [TPL_W / WORLD_PX, TPL_H / WORLD_PX] }; // 单瓦片覆盖整个 100×100 模板

console.log('== L2: 同 origin 瓦片归一组 → live bounds 恢复模板矩形 ==');
{
  // 编辑位置 = 模板 bounds 本身（tpl）以及偏移 (30,-20) 世界像素两种
  const live = syncLiveSim([fakeTile([tpl.mx0, tpl.my0], REL100.TL, REL100.BR)]);
  check('恰好一组 → 单 live 条目（无 :idx 后缀）', live.length === 1 && live[0].id === 'wpAC-live', JSON.stringify(live));
  check('live mx0 恢复模板 bounds 西界', Math.abs(live[0].mx0 - tpl.mx0) < 1e-12, `${live[0].mx0} vs ${tpl.mx0}`);
  check('live my0 恢复模板 bounds 北界', Math.abs(live[0].my0 - tpl.my0) < 1e-12);
  check('live mx1/my1 = origin + 最大相对角', Math.abs(live[0].mx1 - tpl.mx1) < 1e-12 && Math.abs(live[0].my1 - tpl.my1) < 1e-12);
  // 用户手放的编辑位置偏移 (30,-20) 世界像素 → live bounds 跟随编辑位置
  const dMx = 30 / WORLD_PX, dMy = -20 / WORLD_PX;
  const live2 = syncLiveSim([fakeTile([tpl.mx0 + dMx, tpl.my0 + dMy], REL100.TL, REL100.BR)]);
  check('编辑位置偏移 → live bounds 跟随', Math.abs(live2[0].mx0 - (tpl.mx0 + dMx)) < 1e-12 && Math.abs(live2[0].my0 - (tpl.my0 + dMy)) < 1e-12);
}
console.log('== L3: 不同 origin → 分组为两个 live（含 :idx 后缀） ==');
{
  const A = fakeTile([0.40, 0.30], [0, 0], [50 / WORLD_PX, 50 / WORLD_PX]);
  const B = fakeTile([0.60, 0.50], [0, 0], [50 / WORLD_PX, 50 / WORLD_PX]);
  const live = syncLiveSim([A, B]);
  check('两组 → 两个 live 条目', live.length === 2, JSON.stringify(live.map(l => l.id)));
  check('id 带 :idx 后缀', live.every(l => /^wpAC-live:\d$/.test(l.id)));
  check('按 oy 排序（北先行）', live[0].my0 < live[1].my0);
}
console.log('== L4: live 加入模板列表后 attachTile 归属 ==');
{
  // 复刻 attachTile 包含判定 + 官方约束
  function attachTileSim(tile, templates) {
    let best = null;
    const tileW = tile.tileW > 0 ? tile.tileW : 100;
    for (const t of templates) {
      const x0 = tile.TL[0] + t.mx0, x1 = tile.TR[0] + t.mx0;
      const y0 = tile.TL[1] + t.my0, y1 = tile.BL[1] + t.my0;
      const eps = 1e-9;
      if (x0 < t.mx0 - eps || x1 > t.mx1 + eps || y0 < t.my0 - eps || y1 > t.my1 + eps) continue;
      if (tileW > 1024 + 1e-6) continue;
      const ratioW = (x1 - x0) / (t.mx1 - t.mx0);
      if (ratioW <= 0) continue;
      const renderW = tileW / ratioW;
      if (renderW < tileW - 1e-6 || renderW > 8192 + 1e-6) continue;
      const area = (t.mx1 - t.mx0) * (t.my1 - t.my0);
      if (!best || area < best.area) best = { id: t.id, area };
    }
    return best ? best.id : null;
  }
  const tile = fakeTile([tpl.mx0, tpl.my0], REL100.TL, REL100.BR);
  const live = syncLiveSim([tile]);
  check('无 live 时未归属', attachTileSim(tile, []) === null);
  check('live 条目使瓦片归属成功', attachTileSim(tile, live) === live[0].id, attachTileSim(tile, live));
  // 已 persist 的真实模板渲染中 + 编辑中模板：编辑瓦片只归 live（真实模板 bounds 不含它）
  const real = { id: 'real1', mx0: 0.10, mx1: 0.10005, my0: 0.20, my1: 0.20005 };
  const t2 = fakeTile([tpl.mx0, tpl.my0], REL100.TL, REL100.BR);
  check('编辑瓦片在真实模板 bounds 外 → 归 live', attachTileSim(t2, [real, ...syncLiveSim([t2])]) === 'wpAC-live');
}

console.log('== L5: 官方 persist 后 live→真实模板迁移 ==');
{
  // 复刻迁移逻辑：live 组消失（瓦片已归属真实模板被跳过分组）→ 按 liveBounds 匹配
  const tile = fakeTile([tpl.mx0, tpl.my0], REL100.TL, REL100.BR);
  const live = syncLiveSim([tile]);
  const calib = { tplId: live[0].id, liveBounds: { mx0: live[0].mx0, my0: live[0].my0, mx1: live[0].mx1, my1: live[0].my1 } };
  // persist 后：真实模板 bounds 与 live 一致（官方把编辑位置写入 localStorage）
  const realTpl = { id: 'real-abc', mx0: live[0].mx0, mx1: live[0].mx1, my0: live[0].my0, my1: live[0].my1, visible: true };
  let moved = false;
  const lb = calib.liveBounds;
  for (const tt of [realTpl]) {
    if (tt.virtual) continue;
    if (Math.abs(tt.mx0 - lb.mx0) < 2e-7 && Math.abs(tt.my0 - lb.my0) < 2e-7 &&
        Math.abs(tt.mx1 - lb.mx1) < 2e-7 && Math.abs(tt.my1 - lb.my1) < 2e-7) {
      calib.tplId = tt.id; moved = true; break;
    }
  }
  check('calib 迁移到真实模板 id', moved && calib.tplId === 'real-abc', calib.tplId);
  // persist 后瓦片归属真实模板 → syncLive 跳过 → live 组消失
  const tileAfter = fakeTile([tpl.mx0, tpl.my0], REL100.TL, REL100.BR, 'real-abc');
  check('已归属真实模板的瓦片不再参与分组', syncLiveSim([tileAfter]).length === 0);
  // 官方应用时用户又挪了位置 → bounds 匹配失败 → 保留校准不清除（等重跑）
  const shifted = { id: 'real-xyz', mx0: live[0].mx0 + 1e-5, mx1: live[0].mx1 + 1e-5, my0: live[0].my0, my1: live[0].my1, visible: true };
  let moved2 = false;
  for (const tt of [shifted]) {
    if (Math.abs(tt.mx0 - lb.mx0) < 2e-7 && Math.abs(tt.my0 - lb.my0) < 2e-7 &&
        Math.abs(tt.mx1 - lb.mx1) < 2e-7 && Math.abs(tt.my1 - lb.my1) < 2e-7) { moved2 = true; break; }
  }
  check('bounds 对不上不迁移（保留 calib 等待重跑）', moved2 === false);
}

console.log('== L6: pickCalibTemplate 编辑中模板优先 ==');
{
  function pickSim(templates, tiles) {
    for (const v of templates) {
      if (!v.virtual || !v.visible) continue;
      if (tiles.some(t => t.tplId === v.id)) return v;
    }
    for (const t of templates) {
      if (!t.visible) continue;
      if (tiles.some(x => x.tplId === t.id)) return t;
    }
    return null;
  }
  const liveTpl = syncLiveSim([fakeTile([tpl.mx0, tpl.my0], REL100.TL, REL100.BR)])[0];
  const realTpl = { id: 'real1', visible: true };
  const liveTile = { tplId: 'wpAC-live' }, realTile = { tplId: 'real1' };
  check('编辑中 + 已保存同时存在 → 选中编辑中', pickSim([realTpl, liveTpl], [realTile, liveTile]).virtual === true);
  check('只有已保存 → 选中已保存', pickSim([realTpl], [realTile]) === realTpl);
  check('编辑中不可见 → 落回已保存', pickSim([{ ...liveTpl, visible: false }, realTpl], [liveTile, realTile]) === realTpl);
}

// ================= v2.5.2 放置编辑会话（DOM overlay） =================
// 场景：编辑器预览 = DOM 2D canvas（不走 WebGL）；fetch hook 不穿透 → 画布数据主动
// fetch；live 基准 = location 中心；δ 由大范围搜索得出；应用 = set bounds = liveBounds+δ。

console.log('== E0: v2.5.2 源码一致 ==');
check('编辑会话捕获函数存在', SRC.includes('function syncEditOverlay()') && SRC.includes('function editOverlayEl()'));
check('DOM overlay 选择器（div.overlay.active canvas）', SRC.includes("'div.overlay.active canvas'"));
check('主动补抓走官方 files 端点', SRC.includes("'https://backend.wplace.live/files/' + ST.shard + '/tiles/'"));
check('编辑 tile 相对角用 Mercator 单位（非归一化）', SRC.includes('TR: [Wrender / WORLD_PX, 0]'));
check('live 基准 = location 中心', SRC.includes('mx0: cmx - halfW, mx1: cmx + halfW'));
check('δ 屏幕平移分支（screenScale）', SRC.includes('calibTile && ST.calib.screen'));
check('应用对齐 liveBounds 为 set 语义', SRC.includes('b.west = lngAt((c.liveBounds.mx0 + c.dmx) * WORLD_PX)'));
check('启动读一次 location 建初始 anchor', SRC.includes('var loc0 = editBaseLoc();'));
check('编辑会话 500ms 跟踪定时器', SRC.includes('setInterval(syncEditOverlay, 500)'));
check('persist 后自动写入最终位置', SRC.includes('applyCalibToStorage();') && SRC.includes('ST.persistT = Date.now();'));
check('校准前强制重快照编辑器内容', SRC.includes('if (ST.editTile) { editSnapT = 0; syncEditOverlay(); }'));
check('syncLiveTemplates 编辑会话互斥', SRC.includes('if (ST.editTile) return; // 编辑会话由 syncEditOverlay 独占 live 维护'));
check('小模板门槛 ≥16（100×100 必须能过；>256 曾致编辑会话失效）',
  SRC.includes('cv.width >= 16 && cv.height >= 16') && !SRC.includes('cv.width > 256'));

console.log('== E1: 编辑 tile 构造 + live bounds（location 中心基准） ==');
{
  const loc = { lng: 120.70441, lat: 27.81327, zoom: 14.5 }; // 页面实测值
  const CW = 1227, CH = 1792;
  const Wrender = CW, Hrender = CH; // 100% 缩放
  const cmx = mx01(loc.lng), cmy = my01(loc.lat);
  const halfW = Wrender / WORLD_PX / 2, halfH = Hrender / WORLD_PX / 2;
  const live = { mx0: cmx - halfW, mx1: cmx + halfW, my0: cmy - halfH, my1: cmy + halfH };
  // 编辑 tile：相对四角 = Mercator 单位（与 WebGL 捕获瓦片同语义）
  const etile = { TL: [0, 0], TR: [Wrender / WORLD_PX, 0], BR: [Wrender / WORLD_PX, Hrender / WORLD_PX], BL: [0, Hrender / WORLD_PX], cw: CW, ch: CH };
  check('相对角宽 = live bounds 宽（自洽）', Math.abs((etile.TR[0] - etile.TL[0]) - (live.mx1 - live.mx0)) < 1e-15);
  // texPxMerc 语义：像素 (0,0) 中心 = live 西北角 + 半像素
  const m00 = [live.mx0 + etile.TL[0] + (etile.TR[0] - etile.TL[0]) * 0.5 / etile.cw,
               live.my0 + etile.TL[1] + (etile.BL[1] - etile.TL[1]) * 0.5 / etile.ch];
  check('像素 (0,0) 中心 = 基准西北角 + 半像素', Math.abs(m00[0] - (live.mx0 + 0.5 / WORLD_PX)) < 1e-15);
  check('live bounds 宽 = 模板渲染世界宽', Math.round((live.mx1 - live.mx0) * WORLD_PX) === Wrender);
  // δ屏幕 ↔ δ世界：scale = rect.width / Wrender（实测 rect 423.140625）
  const scale = 423.140625 / Wrender;
  const dwx = 100, dwy = -50;
  check('δ世界 → δ屏幕 round-trip（±0.01 屏幕 px）',
    Math.abs((dwx * scale) / scale - dwx) < 0.01 && Math.abs((dwy * scale) / scale - dwy) < 0.01,
    `scale=${scale.toFixed(6)}`);
  // pickColorAtOfficial 的 dux 公式兼容性：dux = dmx/(TR-TL)*cw 应等于 δ世界像素
  const dmx = dwx / WORLD_PX;
  const dux = dmx / (etile.TR[0] - etile.TL[0]) * etile.cw;
  check('δ 校正 dux = δ世界像素（编辑 tile 语义）', Math.abs(dux - dwx) < 1e-9, `dux=${dux}`);
}

console.log('== E2: ensureMapTiles 主动补抓（mock fetch） ==');
{
  const mapTiles2 = { '2000,1000': { t: 1 } }; // 已缓存 1 片
  let fetched = [];
  const store2 = (x, y) => { mapTiles2[x + ',' + y] = { x, y, t: Date.now() }; };
  // 复刻 worker 并发结构（同步 fetch mock，cb 延迟压到 0）
  function ensureSim(tx0, ty0, tx1, ty1, cb) {
    const need = [];
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      if (!mapTiles2[tx + ',' + ty]) need.push([tx, ty]);
    }
    if (!need.length) { setTimeout(cb, 0); return; }
    let idx = 0, finished = 0, got = 0;
    const workers = Math.min(4, need.length);
    const worker = () => {
      if (idx >= need.length) { finished++; if (finished >= workers) setTimeout(cb, 0); return; }
      const p = need[idx++];
      fetched.push(p);
      store2(p[0], p[1]); got++;
      worker();
    };
    for (let k = 0; k < workers; k++) worker();
  }
  ensureSim(2000, 1000, 2001, 1001, () => {});
  await new Promise(r => setTimeout(r, 10));
  check('范围 4 瓦片、已缓存 1 → 补抓 3 片', fetched.length === 3, JSON.stringify(fetched));
  check('补抓后全部命中缓存', ['2000,1000', '2000,1001', '2001,1000', '2001,1001'].every(k => mapTiles2[k]));
  fetched = [];
  ensureSim(2000, 1000, 2001, 1001, () => {});
  await new Promise(r => setTimeout(r, 10));
  check('二次调用零请求（已缓存跳过）', fetched.length === 0);
}

console.log('== E3: 应用对齐——liveBounds set 语义 ==');
{
  // 复刻 applyCalibToStorage 的 liveBounds 分支
  const loc = { lng: 120.70441, lat: 27.81327 };
  const CW = 1227, CH = 1792;
  const cmx = mx01(loc.lng), cmy = my01(loc.lat);
  const liveBounds = {
    mx0: cmx - CW / WORLD_PX / 2, mx1: cmx + CW / WORLD_PX / 2,
    my0: cmy - CH / WORLD_PX / 2, my1: cmy + CH / WORLD_PX / 2
  };
  const dwx = 37, dwy = -11;
  const dmx = dwx / WORLD_PX, dmy = dwy / WORLD_PX;
  const b = {
    west: lngAt((liveBounds.mx0 + dmx) * WORLD_PX), east: lngAt((liveBounds.mx1 + dmx) * WORLD_PX),
    north: mercYToLat(liveBounds.my0 + dmy), south: mercYToLat(liveBounds.my1 + dmy)
  };
  const px = (mx) => mx * WORLD_PX;
  check('west = liveBounds 西界 + δ', Math.round(px(mx01(b.west))) === Math.round(px(liveBounds.mx0) + dwx));
  check('east = liveBounds 东界 + δ', Math.round(px(mx01(b.east))) === Math.round(px(liveBounds.mx1) + dwx));
  check('north = liveBounds 北界 + δ', Math.abs(px(my01(b.north)) - (px(liveBounds.my0) + dwy)) < 1e-6);
  check('south = liveBounds 南界 + δ', Math.abs(px(my01(b.south)) - (px(liveBounds.my1) + dwy)) < 1e-6);
  check('宽高不变（纯平移 set）', Math.round(px(mx01(b.east)) - px(mx01(b.west))) === CW &&
    Math.round(px(my01(b.south)) - px(my01(b.north))) === CH);
}

console.log('== E4: persist 后迁移兜底（30s 窗口取最新 updatedAt） ==');
{
  // 复刻 syncEditOverlay 拆除路径的迁移
  const calib = { tplId: 'wpAC-live' };
  const tpls = [
    { id: 'old-a', visible: true, updatedAt: 1000 },
    { id: 'new-b', visible: true, updatedAt: 9000 }, // 官方「应用」persist 的那条
    { id: 'hid-c', visible: false, updatedAt: 99999 } // 不可见不参与
  ];
  let mig = null, bestT = -1;
  const persistT = Date.now() - 5000; // 5s 前 persist
  if (persistT && Date.now() - persistT < 30000) {
    for (const mt of tpls) {
      if (mt.virtual || !mt.visible) continue;
      if ((mt.updatedAt || 0) >= bestT) { bestT = mt.updatedAt || 0; mig = mt; }
    }
  }
  check('迁移到最近 persist 的可见模板', mig && mig.id === 'new-b', mig && mig.id);
  // 超过 30s 窗口（用户手动关编辑器，无 persist）→ 不迁移，保留引用等待重开编辑器
  let mig2 = null, bestT2 = -1;
  const persistT2 = Date.now() - 60000;
  if (persistT2 && Date.now() - persistT2 < 30000) {
    for (const mt of tpls) { if (!mt.virtual && mt.visible && (mt.updatedAt || 0) >= bestT2) { bestT2 = mt.updatedAt || 0; mig2 = mt; } }
  }
  check('无 persist → 不迁移（live id 保留，重开编辑器自动接上）', mig2 === null && calib.tplId === 'wpAC-live');
}

// ================= v2.5.3 快查网格 + 金字塔搜索 + 假峰守门 =================
// 实测教训（v2.5.2）：编辑会话大范围搜索 5000 万次 canvasPixelAt 冻结主线程 30s+；
// 且 ±1120 搜索下海洋/涂鸦噪声峰 36% 轻松越过 0.12 阈值（参照层被平移到假峰/屏幕外）。

console.log('== E5: v2.5.3 源码一致 ==');
check('版本 2.7.0', SRC.includes('// @version      2.7.0'));
check('网格缓存字段 ST.paintGrid', SRC.includes('paintGrid: null'));
check('调色板索引表 paintIdxMap', SRC.includes('function paintIdxMap()'));
check('网格查询 gridAt', SRC.includes('function gridAt(G, wx, wy)'));
check('网格构建 fillGridTile', SRC.includes('function fillGridTile(G, t, im)'));
check('网格按需构建+缓存 ensurePaintGrid', SRC.includes('function ensurePaintGrid(wx0, wy0, wx1, wy1, noBuild, cb)'));
check('scoreOffset 走网格索引比较', SRC.includes('gridAt(G, s.wx + dx, s.wy + dy)') && SRC.includes('v === s.pi'));
check('样本调色板索引预计算', SRC.includes('s0.pi = keyMap.get((s0.r << 16) | (s0.g << 8) | s0.b) || 255;'));
check('scoreBatch 分片让出主线程', (SRC.match(/setTimeout\(step, 0\)/g) || []).length >= 2);
check('金字塔搜索 calibSearchPhases', SRC.includes('function calibSearchPhases(tpl, tTiles, samples, editMode, G, rng)'));
check('阶梯搜索半径表（±96/±288/±1120）', SRC.includes('{ r: 96, s: 4, sub: 3000 },') && SRC.includes('{ r: 288, s: 8, sub: 3000 },') && SRC.includes('{ r: 1120, s: 16, sub: 4000, refine: 12 }'));
check('编辑基准优先 localStorage 同尺寸模板 bounds', SRC.includes('ot.originalWidth !== cv.width || ot.originalHeight !== cv.height'));
check('精搜两级（step4 ±8 → step1 ±3）', SRC.includes('fy += 4') && SRC.includes('var fineB'));
check('终点守门 calibFinish', SRC.includes('function calibFinish(tpl, tTiles, samples, editMode, G, best, bg)'));
check('fullScan 走网格', SRC.includes('function fullScan(tpl, tTiles, dx, dy, G)'));
check('假峰显著性守门三档 calibSignificant', SRC.includes('function calibSignificant(m, bg)') && SRC.includes('m >= 0.4 && m - bg >= 0.12') && SRC.includes('m >= 0.25 && m - bg >= 0.18') && SRC.includes('editMode ? calibSignificant(mFull, bg)'));
check('拒绝缓存强制采纳 ST.calibForce', SRC.includes('ST.calibForce = best && editMode') && SRC.includes("Date.now() - f.t < 120000") && SRC.includes('acceptCalib(tplF, f.best, f.stat, f.mFull, f.editMode, true, null)'));
check('clearCalib 清强制采纳缓存', SRC.includes('ST.calib = null; ST.calibMsg = null; ST.calibForce = null;'));
check('颜色容差匹配（网格 129..191 编码 + palTol 表）', SRC.includes('128 + nearestPaletteCached') && SRC.includes('function palTolHit(a, b)') && SRC.includes('palTolHit(s.pi, v - 128)') && SRC.includes('palTolHit(s.pi, v)') && SRC.includes('palTolHit(pi, v - 128)') && SRC.includes('palTolHit(pi, v)'));
check('编辑模式失败清校准（拆掉旧假峰平移）', SRC.includes('if (editMode) clearCalib();'));
check('calibBusy 在终点释放', SRC.includes('function finishCalib() { ST.calibBusy = false; updateHud(); }'));
check('refreshCalibStats 复用网格不现建', SRC.includes('Math.ceil(cy + halfH + pad), true, function (G)'));

// ---------- 复刻：调色板索引表 + 网格构建/查询 ----------
const PAL_SIM = { 1: [237, 28, 36], 2: [64, 147, 228], 3: [165, 14, 30], 4: [250, 128, 114], 5: [255, 255, 255] };
const paintKeyMap = new Map();
for (const k in PAL_SIM) { const c = PAL_SIM[k]; paintKeyMap.set((c[0] << 16) | (c[1] << 8) | c[2], +k); }
function gridAt(G, wx, wy) {
  const x = wx - G.gx0, y = wy - G.gy0;
  if (x < 0 || y < 0 || x >= G.gw || y >= G.gh) return 0;
  return G.grid[y * G.gw + x];
}
function nearestIdxSim(r, g, b) {
  let best = 1, bd = Infinity;
  for (const k in PAL_SIM) {
    const c = PAL_SIM[k], dr = r - c[0], dg = g - c[1], db = b - c[2], d = dr * dr + dg * dg + db * db;
    if (d < bd) { bd = d; best = +k; }
  }
  return best;
}
function fillGridTile(G, t, im) {
  const bx = t.x * TILE_PX - G.gx0, by = t.y * TILE_PX - G.gy0;
  let painted = 0;
  for (let y = 0; y < t.h; y++) {
    const ro = y * t.w * 4, gi = (by + y) * G.gw + bx;
    for (let x = 0; x < t.w; x++) {
      const o = ro + x * 4;
      if (t.data[o + 3] < 128) continue;
      G.grid[gi + x] = im.get((t.data[o] << 16) | (t.data[o + 1] << 8) | t.data[o + 2]) || (128 + nearestIdxSim(t.data[o], t.data[o + 1], t.data[o + 2]));
      painted++;
    }
  }
  G.painted += painted;
}

console.log('== E6: 快查网格构建与查询 ==');
{
  // 瓦片 (3000,2000)：3 个已涂像素（2 个调色板色 + 1 个调色板外）+ 1×1 占位瓦片
  const w = TILE_PX, h = TILE_PX, data = new Uint8ClampedArray(w * h * 4);
  const put = (x, y, c, a) => { const o = (y * w + x) * 4; data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = a; };
  put(456, 123, PAL_SIM[1], 255);
  put(457, 123, PAL_SIM[2], 255);
  put(458, 123, [12, 34, 56], 255);   // 调色板外 → 网格 128+最近索引（最近=3 → 131）
  put(459, 123, PAL_SIM[1], 64);      // alpha<128 → 未涂
  const gx0 = 3000 * TILE_PX, gy0 = 2000 * TILE_PX, gw = TILE_PX, gh = TILE_PX;
  const G = { gx0, gy0, gw, gh, grid: new Uint8Array(gw * gh), painted: 0 };
  fillGridTile(G, { x: 3000, y: 2000, w, h, data }, paintKeyMap);
  check('已涂调色板色 → 索引', gridAt(G, gx0 + 456, gy0 + 123) === 1);
  check('第二色 → 各自索引', gridAt(G, gx0 + 457, gy0 + 123) === 2);
  check('调色板外已涂 → 128+最近索引', gridAt(G, gx0 + 458, gy0 + 123) === 131,
    'val=' + gridAt(G, gx0 + 458, gy0 + 123));
  check('alpha<128 视为未涂 → 0', gridAt(G, gx0 + 459, gy0 + 123) === 0);
  check('未涂区域 → 0', gridAt(G, gx0 + 100, gy0 + 100) === 0);
  check('网格外 → 0', gridAt(G, gx0 - 1, gy0) === 0 && gridAt(G, gx0 + gw, gy0) === 0);
  check('painted 计数 = 3', G.painted === 3, G.painted);
  // 1×1 占位瓦片（海洋）不炸
  const G2 = { gx0: 0, gy0: 0, gw: TILE_PX, gh: TILE_PX, grid: new Uint8Array(TILE_PX * TILE_PX), painted: 0 };
  fillGridTile(G2, { x: 0, y: 0, w: 1, h: 1, data: new Uint8ClampedArray(4) }, paintKeyMap);
  check('1×1 占位瓦片安全', G2.painted === 0);
  // 相邻瓦片写入基址正确
  const G3 = { gx0: 3000 * TILE_PX, gy0: 2000 * TILE_PX, gw: 2 * TILE_PX, gh: TILE_PX, grid: new Uint8Array(2 * TILE_PX * TILE_PX), painted: 0 };
  const d2 = new Uint8ClampedArray(4); d2[0] = 237; d2[1] = 28; d2[2] = 36; d2[3] = 255;
  fillGridTile(G3, { x: 3001, y: 2000, w: 1, h: 1, data: d2 }, paintKeyMap);
  check('相邻瓦片落位正确（跨瓦片连续）', gridAt(G3, 3001 * TILE_PX, 2000 * TILE_PX) === 1,
    'val=' + gridAt(G3, 3001 * TILE_PX, 2000 * TILE_PX));
}

// ---------- 阶梯搜索复刻（v2.5.3：半径分级 × 步长放大 × 显著性命中即停） ----------
// v2.5.5 容差表复刻：PAL_SIM 5 色两两 RGB 距离²均 >1600，仅自身近似（保真口径）
const PAL_TOL_SIM = new Uint8Array(64 * 64);
for (const a in PAL_SIM) for (const b in PAL_SIM) {
  const c1 = PAL_SIM[a], c2 = PAL_SIM[b];
  const dr = c1[0] - c2[0], dg = c1[1] - c2[1], db = c1[2] - c2[2];
  if (+a === +b || dr * dr + dg * dg + db * db <= 1600) PAL_TOL_SIM[+a * 64 + +b] = 1;
}
const palTolHitSim = (a, b) => a < 64 && PAL_TOL_SIM[a * 64 + b];
function scoreOffsetG(valid, dx, dy, subStep, G, tolFn) {
  const tol = tolFn || palTolHitSim;
  let hit = 0, n = 0;
  for (let i = 0; i < valid.length; i += subStep) {
    const s = valid[i];
    const v = gridAt(G, s.wx + dx, s.wy + dy);
    if (!v) continue;
    n++;
    if (v === s.pi) hit++;
    else if (v >= 129) { if (tol(s.pi, v - 128)) hit++; }
    else if (v < 64) { if (tol(s.pi, v)) hit++; }
  }
  return n >= 8 ? hit / n : 0;
}
const calibSort = (a, b) => {
  const d = b.m - a.m;
  if (d > 0.005) return 1;
  if (d < -0.005) return -1;
  return (Math.abs(a.dx) + Math.abs(a.dy)) - (Math.abs(b.dx) + Math.abs(b.dy));
};
const STAGES = [
  { r: 96, s: 4, sub: 3000 },
  { r: 288, s: 8, sub: 3000 },
  { r: 1120, s: 16, sub: 4000, refine: 12 }
];
function stageSearch(samples, G, stages) {
  let si = 0;
  while (si < stages.length) {
    const st = stages[si++];
    const span = Math.ceil(st.r / st.s);
    const pts = [];
    for (let dy = -span; dy <= span; dy++) for (let dx = -span; dx <= span; dx++) pts.push([dx * st.s, dy * st.s]);
    pts.push([0, 0]);
    let res = pts.map(([dx, dy]) => ({ dx, dy, m: scoreOffsetG(samples, dx, dy, Math.max(1, Math.floor(samples.length / st.sub)), G) }));
    res.sort(calibSort);
    let bg = 0;
    for (const r of res) if (Math.abs(r.dx - res[0].dx) > 96 || Math.abs(r.dy - res[0].dy) > 96) { if (r.m > bg) bg = r.m; }
    const cand = res[0];
    const significant = !!cand && ((cand.m >= 0.4 && cand.m - bg >= 0.12) || (cand.m >= 0.3 && cand.m - bg >= 0.22) || (cand.m >= 0.25 && cand.m - bg >= 0.18));
    if (!significant && si < stages.length) continue; // 不显著 → 下一级
    // 精搜收口：编辑大半径级先邻域细化（±16 步长 8）→ step4 ±8 → step1 ±3
    let seed = cand;
    if (st.refine) {
      const seen = {}, rp = [];
      for (let my = -2; my <= 2; my++) for (let mx = -2; mx <= 2; mx++) {
        const px = seed.dx + mx * 8, py = seed.dy + my * 8, k = px + ',' + py;
        if (!seen[k]) { seen[k] = 1; rp.push([px, py]); }
      }
      let rr = rp.map(([dx, dy]) => ({ dx, dy, m: scoreOffsetG(samples, dx, dy, Math.max(1, Math.floor(samples.length / 20000)), G) }));
      rr.sort(calibSort);
      if (rr[0] && rr[0].m >= seed.m - 0.005) seed = rr[0];
    }
    const subF = Math.max(1, Math.floor(samples.length / 20000));
    const fineA = [];
    for (let fy = -8; fy <= 8; fy += 4) for (let fx = -8; fx <= 8; fx += 4) fineA.push([seed.dx + fx, seed.dy + fy]);
    let resA = fineA.map(([dx, dy]) => ({ dx, dy, m: scoreOffsetG(samples, dx, dy, subF, G) }));
    resA.sort(calibSort);
    const fineB = [];
    for (const t of resA.slice(0, 3)) for (let gy = -3; gy <= 3; gy++) for (let gx = -3; gx <= 3; gx++) fineB.push([t.dx + gx, t.dy + gy]);
    let res3 = fineB.map(([dx, dy]) => ({ dx, dy, m: scoreOffsetG(samples, dx, dy, subF, G) }));
    res3.sort(calibSort);
    const best = res3[0] && res3[0].m >= seed.m - 0.005 ? res3[0] : seed;
    return { best, bg };
  }
  return { best: null, bg: 0 };
}
function buildSamples(texT, tplT, step) {
  const out = [];
  for (let y = 0; y < texT.ch; y += step) for (let x = (step === 2 && (y & 1) ? 1 : 0); x < texT.cw; x += step) {
    const o = (y * texT.cw + x) * 4;
    if (texT.rgba[o + 3] < 200) continue;
    const m = texPxMerc(texT, tplT, x, y);
    const c = [texT.rgba[o], texT.rgba[o + 1], texT.rgba[o + 2]];
    out.push({ r: c[0], g: c[1], b: c[2], pi: paintKeyMap.get((c[0] << 16) | (c[1] << 8) | c[2]) || 255, wx: Math.floor(m[0] * WORLD_PX), wy: Math.floor(m[1] * WORLD_PX) });
  }
  return out;
}
function buildGrid(wx0, wy0, wx1, wy1) {
  const tx0 = Math.floor(wx0 / TILE_PX), ty0 = Math.floor(wy0 / TILE_PX);
  const gx0 = tx0 * TILE_PX, gy0 = ty0 * TILE_PX;
  const gw = (Math.floor(wx1 / TILE_PX) - tx0 + 1) * TILE_PX;
  const gh = (Math.floor(wy1 / TILE_PX) - ty0 + 1) * TILE_PX;
  const G = { gx0, gy0, gw, gh, grid: new Uint8Array(gw * gh), painted: 0 };
  for (const k in mapTiles) fillGridTile(G, mapTiles[k], paintKeyMap);
  return G;
}

console.log('== E7: 阶梯搜索——普通模式 (7,3) + 编辑模式大偏移 ==');
{
  // 普通模式：复用 C4 场景（模板 100×100，画布偏移 (7,3)）
  const smp = buildSamples(tex, tpl, 1);
  const pad = 56;
  const G = buildGrid(2000000 - pad, 1000000 - pad, 2000000 + 100 + pad, 1000000 + 100 + pad);
  const r = stageSearch(smp, G, [{ r: 48, s: 4, sub: 6000 }]);
  check('普通模式命中 (7,3)', r.best.dx === DX && r.best.dy === DY, JSON.stringify(r.best));
  check('普通模式匹配率 > 0.99', r.best.m > 0.99, r.best.m.toFixed(3));
}
// 中等细节模板（16×16 块同色、块间伪随机）：真实动漫模板由大色块+细节构成，
// 纯噪声图案峰宽 2-4px、任何粗步长都踩不到（信息论极限），16px 块图案峰宽 ~16px
const palVals = Object.values(PAL_SIM);
{
  let hs = 55555;
  const hsh = (a, b) => (((a * 73856093) ^ (b * 19349663) ^ (hs * 2654435761)) >>> 0) % 5; // 无状态：块颜色独立于调用顺序
  var tex2 = {
    TL: [0, 0], TR: [wfrac, 0], BR: [wfrac, hfrac], BL: [0, hfrac],
    cw: TPL_W, ch: TPL_H, rgba: new Uint8Array(TPL_W * TPL_H * 4), tplId: 'e7'
  };
  for (let y = 0; y < TPL_H; y++) for (let x = 0; x < TPL_W; x++) {
    const c = palVals[hsh(Math.floor(x / 16), Math.floor(y / 16))];
    const o = (y * TPL_W + x) * 4;
    tex2.rgba[o] = c[0]; tex2.rgba[o + 1] = c[1]; tex2.rgba[o + 2] = c[2]; tex2.rgba[o + 3] = 255;
  }
}
{
  // 编辑模式：中等细节图案画在基准以 (-1108, 900)（非步长倍数，考验逐级收口）
  delete mapTiles['2000,1000']; // 清掉 C4 成品瓦片：同图案两份是信息论歧义，不在本测范围
  const EDX = -1108, EDY = 900;
  const w = TILE_PX, h = TILE_PX, data = new Uint8ClampedArray(w * h * 4);
  const put = (x, y, c) => { const o = (y * w + x) * 4; data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255; };
  // 已画区 x∈[2000000-1108, +100) → 瓦片 1998 局部 x∈[892,992)；y∈[1000900,+1000) → 局部 y∈[900,1000)
  for (let y = 0; y < TPL_H; y++) for (let x = 0; x < TPL_W; x++) {
    const o = (y * TPL_W + x) * 4;
    put(892 + x, 900 + y, [tex2.rgba[o], tex2.rgba[o + 1], tex2.rgba[o + 2]]);
  }
  storeMapTile(1998, 1000, { w, h, data });
  const smp = buildSamples(tex2, tpl, 1);
  const pad = 1128;
  const G = buildGrid(2000000 - 50 - pad, 1000000 - 50 - pad, 2000000 + 50 + pad, 1000000 + 50 + pad);
  const t0 = Date.now();
  const r = stageSearch(smp, G, STAGES);
  const ms = Date.now() - t0;
  check('编辑模式大偏移命中 (-1108,900)', r.best.dx === EDX && r.best.dy === EDY, JSON.stringify(r.best));
  check('编辑模式匹配率 > 0.9', r.best.m > 0.9, r.best.m.toFixed(3));
  check('背景噪声显著低于峰（守门余量存在）', r.best.m - r.bg >= 0.3, `m=${r.best.m.toFixed(3)} bg=${r.bg.toFixed(3)}`);
  check('阶梯搜索纯计算 < 2s（1 万样本、三级全跑）', ms < 2000, ms + 'ms');
}

console.log('== E8: 假峰显著性守门 ==');
{
  // 场景 A：纯噪声画布（30% 随机调色板涂鸦，无成品）→ LCG 确定性
  let seedN = 42;
  const rnd = () => (seedN = (seedN * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  const w = TILE_PX, h = TILE_PX, data = new Uint8ClampedArray(w * h * 4);
  const palVals = Object.values(PAL_SIM);
  for (let i = 0; i < w * h * 0.30; i++) {
    const c = palVals[Math.floor(rnd() * palVals.length)];
    const o = Math.floor(rnd() * w * h) * 4;
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  }
  delete mapTiles['1998,1000']; // 隔离上一场景
  storeMapTile(2000, 1000, { w, h, data });
  const smp = buildSamples(tex, tpl, 1);
  const rng = 1120, pad = rng + 8;
  const tx0 = Math.floor((2000000 - 50 - pad) / TILE_PX), ty0 = Math.floor((1000000 - 50 - pad) / TILE_PX);
  const gx0 = tx0 * TILE_PX, gy0 = ty0 * TILE_PX;
  const gw = (Math.floor((2000000 + 50 + pad) / TILE_PX) - tx0 + 1) * TILE_PX;
  const gh = (Math.floor((1000000 + 50 + pad) / TILE_PX) - ty0 + 1) * TILE_PX;
  const G = { gx0, gy0, gw, gh, grid: new Uint8Array(gw * gh), painted: 0 };
  for (const k in mapTiles) fillGridTile(G, mapTiles[k], paintKeyMap);
  const rA = stageSearch(smp, G, STAGES);
  const acceptA = (rA.best.m >= 0.5 && rA.best.m - rA.bg >= 0.15) || (rA.best.m >= 0.35 && rA.best.m - rA.bg >= 0.3);
  check('纯噪声画布 → 守门拒绝', !acceptA, `m=${rA.best.m.toFixed(3)} bg=${rA.bg.toFixed(3)}`);

  // 场景 B：真成品（中等细节图案）+ 70% 画错（手画差异大）→ 峰显著高于背景 → 命中
  const data2 = new Uint8ClampedArray(w * h * 4);
  const put2 = (x, y, c) => { const o = (y * w + x) * 4; data2[o] = c[0]; data2[o + 1] = c[1]; data2[o + 2] = c[2]; data2[o + 3] = 255; };
  seedN = 1234;
  for (let y = 0; y < TPL_H; y++) for (let x = 0; x < TPL_W; x++) {
    const wrong = rnd() < 0.70;
    const o = (y * TPL_W + x) * 4;
    const c = wrong ? palVals[Math.floor(rnd() * palVals.length)] : [tex2.rgba[o], tex2.rgba[o + 1], tex2.rgba[o + 2]];
    put2(x + DX, y + DY, c);
  }
  storeMapTile(2000, 1000, { w, h, data: data2 });
  const G2 = buildGrid(2000000 - 2048, 1000000 - 2048, 2000000 + 2048, 1000000 + 2048);
  const smpB = buildSamples(tex2, tpl, 1);
  const rB = stageSearch(smpB, G2, [{ r: 48, s: 4, sub: 6000 }]);
  const mB = rB.best.m;
  check('成品 + 70% 画错 → 搜索仍命中 (7,3)', rB.best.dx === DX && rB.best.dy === DY, JSON.stringify(rB.best));
  check('成品 + 70% 画错 → 匹配率 0.3-0.6（0.3 真色 + 0.7×1/5 撞色）', mB > 0.3 && mB < 0.6, mB.toFixed(3));
  check('普通模式门槛 0.12 放行', mB >= 0.12);

  // 场景 C：36% 假峰 + 30% 背景（实测 v2.5.2 案例）→ 两条件均不满足 → 拒绝
  const acceptC1 = 0.36 >= 0.5 && 0.36 - 0.30 >= 0.15;
  const acceptC2 = 0.36 >= 0.35 && 0.36 - 0.30 >= 0.3;
  check('实测案例（m=36% bg=30%）→ 拒绝', !acceptC1 && !acceptC2);
}

// ================= v2.5.5 颜色容差 + 三档守门 + 强制采纳 =================
console.log('== E9: 容差匹配与放宽守门 ==');
{
  // 近似色对：1[237,28,36] 与 2[220,50,60] 距离²=1349 ≤1600 → 互为近似；3[0,0,0] 与谁都远
  const P9 = { 1: [237, 28, 36], 2: [220, 50, 60], 3: [0, 0, 0] };
  const map9 = new Map();
  for (const k in P9) { const c = P9[k]; map9.set((c[0] << 16) | (c[1] << 8) | c[2], +k); }
  const tol9 = new Uint8Array(64 * 64);
  for (const a in P9) for (const b in P9) {
    const c1 = P9[a], c2 = P9[b];
    const dr = c1[0] - c2[0], dg = c1[1] - c2[1], db = c1[2] - c2[2];
    if (+a === +b || dr * dr + dg * dg + db * db <= 1600) tol9[+a * 64 + +b] = 1;
  }
  const hit9 = (a, b) => a < 64 && tol9[a * 64 + b];
  check('近似色对判定（1≈2、1≉3）', hit9(1, 2) === 1 && hit9(2, 1) === 1 && hit9(1, 3) === 0);
  // 网格：整片填近似色 2（画手用了相邻红）+ 一角填远色 3
  const w9 = 64, G9 = { gx0: 0, gy0: 0, gw: w9, gh: w9, grid: new Uint8Array(w9 * w9), painted: 0 };
  for (let i = 0; i < w9 * w9; i++) G9.grid[i] = 2;
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) G9.grid[y * w9 + x] = 3;
  const smp9 = [];
  for (let i = 0; i < 8; i++) smp9.push({ wx: 32 + (i % 3) * 2, wy: 32 + (i % 2) * 2, pi: 1 });
  const mExact = scoreOffsetG(smp9, 0, 0, 1, G9, hit9);
  check('近似色画布：容差口径 hit=1.0（画手用调色板相邻色）', mExact === 1.0, 'm=' + mExact);
  const smpFar = [{ wx: 4, wy: 4, pi: 1 }];
  check('远色像素仍算画错', scoreOffsetG([...smpFar, ...smpFar, ...smpFar, ...smpFar, ...smpFar, ...smpFar, ...smpFar, ...smpFar], 0, 0, 1, G9, hit9) === 0);
  // 最近色编码命中：画布填非调色板色 [228,39,48]（最近=1 → 网格 129），模板色=2（近似 1）→ hit
  const G10 = { gx0: 0, gy0: 0, gw: w9, gh: w9, grid: new Uint8Array(w9 * w9), painted: 0 };
  const cvData = new Uint8ClampedArray(w9 * w9 * 4);
  for (let i = 0; i < w9 * w9; i++) { cvData[i * 4] = 228; cvData[i * 4 + 1] = 39; cvData[i * 4 + 2] = 48; cvData[i * 4 + 3] = 255; }
  fillGridTile(G10, { x: 0, y: 0, w: w9, h: w9, data: cvData }, map9);
  check('非调色板色 → 网格 128+最近索引', gridAt(G10, 32, 32) === 129, 'val=' + gridAt(G10, 32, 32));
  const smp10 = [{ wx: 32, wy: 32, pi: 2 }, { wx: 33, wy: 32, pi: 2 }, { wx: 32, wy: 33, pi: 2 }, { wx: 33, wy: 33, pi: 2 },
                 { wx: 34, wy: 32, pi: 2 }, { wx: 32, wy: 34, pi: 2 }, { wx: 34, wy: 34, pi: 2 }, { wx: 35, wy: 32, pi: 2 }];
  check('最近色编码参与容差命中', scoreOffsetG(smp10, 0, 0, 1, G10, hit9) === 1.0);
  // 三档守门边界（d 上限 = m，第三档必须可触发）
  const sig = (m, bg) => (m >= 0.4 && m - bg >= 0.12) || (m >= 0.3 && m - bg >= 0.22) || (m >= 0.25 && m - bg >= 0.18);
  check('三档：0.40/0.28（差 0.12）过', sig(0.40, 0.28));
  check('三档：0.30/0.08（差 0.22）过', sig(0.30, 0.08));
  check('三档：0.26/0.07（差 0.19≥0.18）过', sig(0.26, 0.07));
  check('三档：0.39/0.28（差 0.11）拒', !sig(0.39, 0.28));
  check('三档：0.29/0.07（第三档差 0.22≥0.18）过', sig(0.29, 0.07));
  check('三档：0.24/0.00（m<0.25）拒', !sig(0.24, 0.00));
  check('旧案例 0.36/0.30 新档仍拒', !sig(0.36, 0.30));
  // 用户场景：40% 真峰 + 低背景 → 第一档放行（v2.5.4 拒 → v2.5.5 收）
  check('用户场景 0.40/0.15 → 放行', sig(0.40, 0.15));
  check('用户场景 0.40/0.25 → 放行（差 0.15≥0.12）', sig(0.40, 0.25));
}

// ================= v2.6.0 颜色风格自动识别（实测官方颜色设置组合择优） =================
console.log('== E10: 风格识别——精确吻合率评分与择优 ==');
// 源码断言：识别只在编辑会话、非强制采纳时启动；精确命中评分；双重阈值择优
check('版本 2.7.0', SRC.includes('// @version      2.7.0'));
check('识别入口仅编辑会话且非强制采纳（有 G）', SRC.includes('if (editMode && !forced && G) detectColorStyle(tpl, best, G,'));
check('强制采纳路径不识别（G=null）', SRC.includes('acceptCalib(tplF, f.best, f.stat, f.mFull, f.editMode, true, null)'));
check('styleScan 精确命中（v<64 且 v===pi；129+/255 编码必不算）', SRC.includes('if (v < 64 && v === pi) exact++;'));
check('已画样本门槛 30', SRC.includes('var STYLE_MIN_PAINTED = 30;'));
check('当前设置吻合率 ≥0.92 不动 UI', SRC.includes('var STYLE_SKIP_RATE = 0.92;'));
check('切换终门 STYLE_MARGIN=0.04', SRC.includes('var STYLE_MARGIN = 0.04;'));
check('扫描追踪 0.005 + 终门 0.04 双阈值', SRC.includes('r.rate > bestR.rate + 0.005') && SRC.includes('bestR.rate < base.rate + STYLE_MARGIN'));
check('识别中禁点校准（防重入打乱实测序列）', SRC.includes('if (ST.calibBusy || ST.styleBusy) return;'));
check('识别中暂停周期重快照（中间候选不写 t.rgba）', SRC.includes('&& !ST.styleBusy) {'));
check('refreshCalibStats 同步 match（「应用对齐」按钮门槛）', SRC.includes('c.match = stat.done + stat.wrong > 0 ? stat.done / (stat.done + stat.wrong) : 0;'));
check('抖动开关 class 锚点定位（语言无关）', SRC.includes('label.dithering input[type="checkbox"]'));
check('菜单项按 fieldset 配对（两组下拉互不串扰）', SRC.includes("trig.closest('fieldset')"));
check('当前选中项读 aria-checked（菜单文案本地化无关）', SRC.includes("getAttribute('aria-checked') === 'true'"));
check('无更优组合时还原原设置', SRC.includes('styleSetSelect(trigs.pal, curP, function () {'));
check('收口后强制重快照（snapSig 置空）', SRC.includes('t.snapSig = null; editSnapT = 0; syncEditOverlay();'));
check('识别完成先释放 styleBusy 再快照（否则被守卫跳过）', SRC.indexOf('ST.styleBusy = false;\n                    var t = ST.editTile;') > 0);
check('HUD 按钮识别中状态', SRC.includes("ST.styleBusy ? '⏳ 识别中'"));

// ---------- 复刻 styleScan：精确吻合率（逐行对照源码） ----------
function styleScanSim(tplS, tilesS, dx, dy, Gs, ov) {
  const fdx = dx / WORLD_PX, fdy = dy / WORLD_PX;
  let painted = 0, exact = 0;
  for (const tt of tilesS) {
    const src = ov || tt.rgba;
    if (!tt.cw || !src) continue;
    const mxBase = tplS.mx0 + tt.TL[0], mxStep = (tt.TR[0] - tt.TL[0]) / tt.cw;
    const myBase = tplS.my0 + tt.TL[1], myStep = (tt.BL[1] - tt.TL[1]) / tt.ch;
    const step = Math.max(1, Math.round(Math.sqrt(tt.cw * tt.ch / 12000)));
    for (let y = 0; y < tt.ch; y += step) {
      const wy = Math.floor((myBase + (y + 0.5) * myStep + fdy) * WORLD_PX);
      for (let x = 0; x < tt.cw; x += step) {
        const o = (y * tt.cw + x) * 4;
        if (src[o + 3] < 200) continue;
        const v = gridAt(Gs, Math.floor((mxBase + (x + 0.5) * mxStep + fdx) * WORLD_PX), wy);
        if (!v) continue;
        painted++;
        const pi = paintKeyMap.get((src[o] << 16) | (src[o + 1] << 8) | src[o + 2]) || 255;
        if (v < 64 && v === pi) exact++;
      }
    }
  }
  return { painted, exact, rate: painted ? exact / painted : 0 };
}
{
  // 场景：模板 100×100 在世界 (2500000,1500000)，画布同位置已画满（δ=0）。
  // 画手风格 = 红/蓝四象限（调色板 7/19）；用户当前设置渲染出 深红/鲑红（33/34）→ 基线 0%；
  // 正确组合渲染 红/蓝 → 100%。择优应选后者。
  const tplS = {
    id: 't10', w: 100, h: 100,
    mx0: 2500000 / WORLD_PX, mx1: (2500000 + 100) / WORLD_PX,
    my0: 1500000 / WORLD_PX, my1: (1500000 + 100) / WORLD_PX
  };
  const wf = 100 / WORLD_PX;
  const mkTex = (c0, c1) => {
    const t = { TL: [0, 0], TR: [wf, 0], BR: [wf, wf], BL: [0, wf], cw: 100, ch: 100, rgba: new Uint8Array(100 * 100 * 4), tplId: 't10' };
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
      const c = (x < 50) !== (y < 50) ? c0 : c1;
      const o = (y * 100 + x) * 4;
      t.rgba[o] = c[0]; t.rgba[o + 1] = c[1]; t.rgba[o + 2] = c[2]; t.rgba[o + 3] = 255;
    }
    return t;
  };
  const texA = mkTex(PALETTE[33], PALETTE[34]); // 用户当前（错）组合的渲染
  const texB = mkTex(PALETTE[7], PALETTE[19]);  // 画手（对）组合的渲染
  const w = TILE_PX, h = TILE_PX, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) {
    const c = (x < 50) !== (y < 50) ? PALETTE[7] : PALETTE[19]; // 已画 = 红/蓝
    const o = (y * w + x) * 4; // 瓦片 (2500,1500) 局部坐标 = 世界像素 - (2500000,1500000)
    data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
  }
  storeMapTile(2500, 1500, { w, h, data });
  const pad = 60;
  const G10 = buildGrid(2500000 - pad, 1500000 - pad, 2500000 + 100 + pad, 1500000 + 100 + pad);
  const rA = styleScanSim(tplS, [texA], 0, 0, G10);
  const rB = styleScanSim(tplS, [texB], 0, 0, G10);
  check('错误组合渲染 → 精确吻合 0%（10000 已画全不命中）', rA.painted === 10000 && rA.exact === 0 && rA.rate === 0, JSON.stringify(rA));
  check('正确组合渲染 → 精确吻合 100%', rB.painted === 10000 && rB.exact === 10000 && rB.rate === 1, JSON.stringify(rB));
  check('基线 0% < 0.92 → 触发识别', rA.rate < 0.92 && rA.painted >= 30);
  // 129+（非调色板已画）与 255 兜底编码必不算精确命中
  G10.grid[(1500000 + 3 - G10.gy0) * G10.gw + (2500000 + 3 - G10.gx0)] = 131;
  G10.grid[(1500000 + 4 - G10.gy0) * G10.gw + (2500000 + 4 - G10.gx0)] = 255;
  const rC = styleScanSim(tplS, [texB], 0, 0, G10);
  check('非调色板/兜底编码像素不计入精确命中', rC.exact === 9998 && rC.rate < 1, JSON.stringify(rC));
  // 择优决策：候选须比基线高 STYLE_MARGIN 才切换；0.005 只用于扫描期追踪最高分
  const pick = (baseRate, candRates) => {
    let best = { rate: baseRate, isBase: true };
    for (const r of candRates) if (r > best.rate + 0.005) best = { rate: r, isBase: false };
    if (!best.isBase && best.rate < baseRate + 0.04) best = { rate: baseRate, isBase: true };
    return best;
  };
  check('候选 0.9 vs 基线 0.0 → 切换', pick(0.0, [0.9]).isBase === false && pick(0.0, [0.9]).rate === 0.9);
  check('候选 0.53 vs 基线 0.50（差 0.03<0.04）→ 还原不动', pick(0.50, [0.53]).isBase === true);
  check('候选 0.55 vs 基线 0.50（差 0.05≥0.04）→ 切换', pick(0.50, [0.55]).isBase === false);
  check('多候选取最高分', pick(0.0, [0.4, 0.7, 0.6]).rate === 0.7);
}

console.log('== E11: 移动端触摸拖动——HUD 面板与地图视图 ==');
{
  check('版本 2.7.0', SRC.includes('// @version      2.7.0'));
  check('HUD 面板 touch-action:none（挡掉面板上的浏览器滚动手势）', SRC.includes('cursor:move;touch-action:none;'));
  check('HUD 拖动抽 hudDragPos（鼠标/触摸同一位置更新）', SRC.includes('function hudDragPos(x, y) {'));
  check('HUD 拖动抽 hudDragStart（按钮区排除共用）', SRC.includes('function hudDragStart(cx, cy, target) {'));
  check('HUD 松手保存位置抽 hudDragEnd（mouseup/touchend/touchcancel 共用）', SRC.includes('function hudDragEnd() {'));
  check('按钮/折叠区排除仍在 hudDragStart 内（触摸与鼠标同规则）',
    SRC.includes("if (target && target.closest && target.closest('#wpAC-onoff,#wpAC-fold,#wpAC-btns')) return;"));
  check('mouseup 挂 hudDragEnd', SRC.includes("document.addEventListener('mouseup', hudDragEnd);"));
  check('HUD touchstart 单指记录拖动起点（passive，不吞 click）',
    SRC.includes("hud.addEventListener('touchstart', function (e) {\n      if (!e.touches || e.touches.length !== 1) return;"));
  check('HUD touchmove 拖动面板 + preventDefault 阻止页面滚动（capture + passive:false）',
    SRC.includes("document.addEventListener('touchmove', function (e) {\n      if (!dragHud || !e.touches || e.touches.length !== 1) return;\n      e.preventDefault();"));
  check('HUD touchend/touchcancel 收尾（手指中断也保存位置）',
    SRC.includes("document.addEventListener('touchend', hudDragEnd, { capture: true, passive: true });") &&
    SRC.includes("document.addEventListener('touchcancel', hudDragEnd, { capture: true, passive: true });"));
  check('地图 touchstart 单指设置 dragging/press（tap 合成 click 走换色/定位链路）',
    SRC.includes("ST.dragging = true; ST.dragLast = { x: t.clientX, y: t.clientY };\n    ST.press = { x: t.clientX, y: t.clientY };"));
  check('地图双指落下撤销跟踪（官方捏合缩放不污染 viewDX）',
    SRC.includes('e.touches.length > 1) { ST.dragging = false; ST.dragLast = null; return; }'));
  check('地图 touchmove 累计 viewDX（与鼠标版同口径）',
    SRC.includes('ST.viewDX += t.clientX - ST.dragLast.x;') && SRC.includes('ST.viewDX += e.clientX - ST.dragLast.x;'));
  check('地图 touchmove passive:true 不拦截（官方地图要跟手），双指 markSuspect 已并入',
    SRC.includes('if (e.touches.length >= 2) markSuspect(); // 双指捏合缩放：视图即将重绘') &&
    SRC.indexOf('e.touches.length >= 2 && insideMap') < 0);
  check('地图 touchend 清 dragging', SRC.includes("document.addEventListener('touchend', function () {\n    if (ST.dragging) { ST.dragging = false; ST.dragLast = null; }"));
  // 触摸拖动 delta 累计 replica（与源码同口径的独立复算）
  const sim = (steps) => {
    let dragging = false, dragLast = null, viewDX = 0, viewDY = 0, press = null;
    for (const s of steps) {
      if (s.k === 'start') { if (s.n > 1) { dragging = false; dragLast = null; continue; } dragging = true; dragLast = { x: s.x, y: s.y }; press = { x: s.x, y: s.y }; }
      else if (s.k === 'move') { if (dragging && dragLast && s.n === 1) { viewDX += s.x - dragLast.x; viewDY += s.y - dragLast.y; dragLast = { x: s.x, y: s.y }; } }
      else if (s.k === 'end') { if (dragging) { dragging = false; dragLast = null; } }
    }
    return { viewDX, viewDY, press };
  };
  const r1 = sim([{ k: 'start', x: 100, y: 100, n: 1 }, { k: 'move', x: 110, y: 104, n: 1 }, { k: 'move', x: 120, y: 108, n: 1 }, { k: 'move', x: 130, y: 112, n: 1 }, { k: 'end' }]);
  check('单指拖动三步 → viewDX=30/viewDY=12（校准位移数据在触摸端可用）',
    r1.viewDX === 30 && r1.viewDY === 12, `dx=${r1.viewDX},dy=${r1.viewDY}`);
  const r2 = sim([{ k: 'start', x: 100, y: 100, n: 1 }, { k: 'end' }]);
  check('tap 无位移 → delta 为 0 但 press 已记录（点击换色门槛 |press-click|<6 可判定）',
    r2.viewDX === 0 && r2.viewDY === 0 && r2.press && r2.press.x === 100);
  const r3 = sim([{ k: 'start', x: 100, y: 100, n: 1 }, { k: 'move', x: 105, y: 102, n: 1 }, { k: 'start', x: 120, y: 110, n: 2 }, { k: 'move', x: 150, y: 140, n: 2 }, { k: 'end' }]);
  check('拖动中落双指 → 撤销跟踪，后续捏合移动不计入 delta',
    r3.viewDX === 5 && r3.viewDY === 2, `dx=${r3.viewDX},dy=${r3.viewDY}`);
}

console.log('== E12: 框选自动补画——安全注入链路 + 线段分段 + 拟人引擎 ==');
{
  check('版本 2.7.0', SRC.includes('// @version      2.7.0'));
  // ---- 安全链路（核心）：官方在 map 的 click/pointerdown/touchstart 检查 isTrusted，
  // 合成事件会置 automatedClicks 进 pawtect token。引擎只允许两条注入：window mousemove
  // （官方无 isTrusted 检查）+ document keydown/keyup(Space)（官方无 isTrusted 检查）。
  check('注入只有 mousemove 与 Space 键（不碰官方三个 isTrusted 检查点）',
    SRC.includes("document.body.dispatchEvent(new MouseEvent('mousemove', {") &&
    SRC.includes("document.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {"));
  check('注入 mousemove 带 buttons:1（官方右键检查 e.buttons&2 不误入擦除）',
    SRC.includes('bubbles: true, cancelable: true, view: uw, clientX: x, clientY: y, buttons: 1'));
  check('Space 键事件带 code/key（官方按 e.code===Space 分流）',
    SRC.includes("code: 'Space', key: ' ', bubbles: true, cancelable: true"));
  check('脚本没有在画布上合成 pointerdown（isTrusted 检查点；dispatchTap 的 pointerdown 仅色板 DOM）',
    SRC.indexOf("dispatchEvent(new PointerEvent('pointerdown'") < 0);
  check('Space 先落笔后移动再收束（官方连画状态机：down 涂起点 → move 涂线段 → up 收束撤销）',
    SRC.indexOf('bpInjectMove(p0[0], p0[1]);') < SRC.indexOf('bpInjectSpace(true);') &&
    SRC.indexOf('bpInjectSpace(true);') < SRC.indexOf('bpInjectSpace(false);'));
  check('完成提示明确要求手动提交（脚本永不触碰 /paint）',
    SRC.includes('请检查后手动点击官方 Paint 按钮提交'));
  check('暂停/等待后引擎循环判空（bpAbort 置 null 不崩）',
    SRC.includes("if (!BP || BP.phase === 'stop') return;") &&
    (SRC.match(/if \(!BP\) return;/g) || []).length >= 3);
  check('悬停换色在补画运行期间停用（引擎合成 mousemove 不触发换色循环）',
    SRC.includes("if (BP && (BP.phase === 'run' || BP.phase === 'pause' || BP.phase === 'wait')) return; // 补画引擎的合成 mousemove 不做悬停换色"));
  check('Esc：框选取消 / 运行中停止', SRC.includes("if (e.key === 'Escape' && BP) {"));
  check('官方状态解析：按钮 charges/上限 + 面板标题草稿数 + 倒计时态 = 颜料 0（实机实证格式）',
    SRC.includes("if (txt.indexOf('Paint') !== 0) continue;") &&
    SRC.includes("var pi = body.indexOf('Paint pixel');") &&
    SRC.includes('{ charges: 0, max: 0 }'));
  check('草稿计数 3 次不增长 → 暂停等人工（颜料不足/坐标偏移自检）',
    SRC.includes('BP.missed >= 3'));
  check('视图交互中暂缓涂色（lastMapMove 800ms 静默门槛，防 scrQuad 移动中涂错位）',
    SRC.includes('Date.now() - ST.lastMapMove < 800'));
  check('近似色已涂不重涂（129..191 视为已画，尊重画手相邻色）',
    SRC.includes('// 129..191（近似色已涂）视为已画：尊重画手的相邻色选择，不重涂'));
  check('桌面精确指针门槛（移动端 touch 有官方 isTrusted 检测，自动补画仅桌面）',
    SRC.includes("matchMedia('(pointer: fine)').matches"));
  check('前置检查：绘画模式 + 校准 + 官方几何齐备才可框选',
    SRC.includes('if (!paletteRoot()) return') && SRC.includes('if (!ST.calib || ST.calib.match < CALIB_MIN_MATCH) return'));
  // ---- bpRunsFromPixels 独立复刻对照（分组键 tplId+py+c，段内连续 px，行序蛇形）
  const bpRunsFromPixels = (pixels) => {
    const byKey = {};
    for (const p of pixels) {
      const k = p.tplId + '/' + p.py + '/' + p.c;
      (byKey[k] = byKey[k] || []).push(p.px);
    }
    const runs = [];
    for (const k2 in byKey) {
      const parts = k2.split('/');
      const xs = byKey[k2].sort((a, b) => a - b);
      let s = xs[0], prev = xs[0];
      for (let j = 1; j <= xs.length; j++) {
        if (j < xs.length && xs[j] === prev + 1) { prev = xs[j]; continue; }
        runs.push({ tplId: parts[0], c: Number(parts[2]), py: Number(parts[1]), px0: s, px1: prev });
        if (j < xs.length) { s = prev = xs[j]; }
      }
    }
    const rows = {};
    for (const r of runs) {
      const rk = r.tplId + '/' + r.c;
      (rows[rk] = rows[rk] || {})[r.py] = (rows[rk][r.py] || []).concat([r]);
    }
    const out = [];
    Object.keys(rows).forEach((rk) => {
      const ys = Object.keys(rows[rk]).map(Number).sort((a, b) => a - b);
      for (let yi = 0; yi < ys.length; yi++) {
        const list = rows[rk][ys[yi]];
        if (yi % 2 === 1) { list.reverse(); for (const q of list) { const t2 = q.px0; q.px0 = q.px1; q.px1 = t2; } }
        for (const w of list) out.push(w);
      }
    });
    return out;
  };
  const rr1 = bpRunsFromPixels([
    { tplId: 'A', px: 3, py: 5, c: 7 }, { tplId: 'A', px: 4, py: 5, c: 7 }, { tplId: 'A', px: 5, py: 5, c: 7 },
    { tplId: 'A', px: 2, py: 6, c: 7 }, { tplId: 'A', px: 9, py: 6, c: 7 }
  ]);
  check('同行连续像素合并一笔（px 3-5），断裂处拆笔（2 与 9 分两笔）',
    rr1.length === 3 && rr1.some(r => r.px0 === 3 && r.px1 === 5 && r.py === 5) &&
    rr1.filter(r => r.py === 6).length === 2, JSON.stringify(rr1));
  check('不同色/不同行/不同瓦片不合并',
    bpRunsFromPixels([{ tplId: 'A', px: 1, py: 1, c: 2 }, { tplId: 'A', px: 2, py: 1, c: 3 }, { tplId: 'B', px: 3, py: 1, c: 2 }]).length === 3);
  const rr3 = bpRunsFromPixels([
    { tplId: 'A', px: 1, py: 0, c: 4 }, { tplId: 'A', px: 2, py: 0, c: 4 }, { tplId: 'A', px: 3, py: 0, c: 4 },
    { tplId: 'A', px: 1, py: 1, c: 4 }, { tplId: 'A', px: 2, py: 1, c: 4 }, { tplId: 'A', px: 3, py: 1, c: 4 }
  ]);
  const row0 = rr3.filter(r => r.py === 0), row1 = rr3.filter(r => r.py === 1);
  check('行序蛇形：第 2 行（奇数行）段顺序反转且端点交换（来回路径更像手绘）',
    row0[0].px0 === 1 && row0[0].px1 === 3 && row1[0].px0 === 3 && row1[0].px1 === 1, JSON.stringify(rr3));
  // ---- bpStroke 注入序列 replica：复刻官方连画状态机（keydown Space 置 Rt 且涂当前点；
  // window mousemove 在 Rt 时涂上一点到当前点的线段；keyup 收束），断言草稿像素集合正确
  const strokeReplica = (p0, p1) => {
    const draft = new Set();
    let Rt = false, r = null;
    const line = (a, b) => {
      const out = [];
      const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]), 1);
      for (let i = 0; i <= n; i++) {
        out.push([a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n]);
      }
      return out;
    };
    const play = (ev) => {
      if (ev.k === 'move') {
        if (Rt && r) for (const [x, y] of line(r, ev.p)) draft.add(Math.round(x) + '/' + Math.round(y));
        r = ev.p;
      } else if (ev.k === 'down') {
        if (!Rt && r) draft.add(Math.round(r[0]) + '/' + Math.round(r[1]));
        Rt = true;
      } else if (ev.k === 'up') {
        Rt = false;
      }
    };
    play({ k: 'move', p: [p0[0], p0[1]] });
    play({ k: 'down' });
    const steps = Math.max(1, Math.ceil(Math.abs(p1[0] - p0[0]) / 4));
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      play({ k: 'move', p: [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f] });
    }
    play({ k: 'up' });
    return draft;
  };
  const d1 = strokeReplica([100, 200], [112, 200]); // 12 像素水平线（4 步）
  let ok1 = true;
  for (let x = 100; x <= 112; x++) if (!d1.has(x + '/200')) ok1 = false;
  check('一笔线段：官方连画状态机涂满起点到终点（13 像素连续）', ok1 && d1.size === 13, [...d1].join(','));
  const d2 = strokeReplica([50, 50], [50, 50]); // 单像素
  check('单像素笔：起点落下即涂 1 像素', d2.size === 1 && d2.has('50/50'));
  const d3 = strokeReplica([0, 0], [7, 0]); // 短线分 2 步（步幅>1 时官方线段插值补齐中间像素）
  let ok3 = true;
  for (let x = 0; x <= 7; x++) if (!d3.has(x + '/0')) ok3 = false;
  check('步幅小于线长：分步插值仍覆盖整条线（官方 t() 线段插值语义）', ok3 && d3.size === 8);
  // ---- 清单判定语义（与校准统计同口径）
  check('需涂 = 未涂(0) 或 精确画错(1..63 且 ≠ 目标)；近似色已涂(129..191) 跳过',
    SRC.includes('if (cur === 0) { need.push(p); undone++; }') &&
    SRC.includes('else if (cur < 64 && cur !== p.c) { need.push(p); wrong++; }'));
  check('换色验证：aria-pressed 读当前色，3 次重试后仍失败跳过该色',
    SRC.includes('return bpCurSelIdx() === idx;'));
  check('色分组大色先画（减少换色次数）',
    SRC.includes('sort(function (a, b) { return byColor[b].length - byColor[a].length; })'));
}

console.log('\nRESULT: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
