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

console.log('\nRESULT: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
