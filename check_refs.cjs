// 静态一致性核查:v2.3.0/v2.5.0 新标识符的定义与引用应恰好配对(次数为人工核定值)
const fs = require('fs');
const src = fs.readFileSync('wplace-overlay-autocolor.user.js', 'utf8');
const pairs = [
  ['ST.ovGone', 9], ['ST.lastScrDraw', 5], ['ST.lastMapMove', 4],
  ['S.collapsed', 13], ['S.pos', 4], ['applyHudCollapsed', 5], ['checkOvAlive', 2],
  ['hudClampPos', 4], ['wpAC-fold', 4], ['wpAC-colorrow', 2], ['wpAC-close', 0], ['showToast', 2],
  // v2.5.0 对齐校准
  ['ST.calib', 81], ['ST.mapTiles', 13], ['ST.calibMsg', 16], ['ST.progRev', 5],
  ['runCalibrate', 2], ['fullScan', 4], ['scoreOffset', 3], ['canvasPixelAt', 6],
  ['applyCalibToStorage', 3], ['clearCalib', 3], ['refreshCalibStats', 2],
  ['parseTileUrl', 2], ['decodeTile', 3], ['storeMapTile', 2], ['patchFetch', 2],
  ['isPainted', 4], ['sameColor', 4], ['texPxMerc', 3],
  ['wpAC-cal', 3], ['wpAC-apply', 4], ['FREE_COLOR_IDX', 3], ['WORLD_PX', 38],
  // v2.5.1 编辑中模板（live 虚拟 bounds）
  ['rpUnproject', 3], ['syncLiveTemplates', 3], ['scheduleLiveSync', 2],
  ['isLiveId', 8], ['buildTplList', 5], ['ST.liveTpls', 10], ['attachUnbound', 3],
  // v2.5.2 放置编辑会话（DOM overlay）+ 主动补抓
  ['syncEditOverlay', 5], ['ensureMapTiles', 2], ['editOverlayEl', 2],
  ['LIVE_ID', 5], ['ST.editTile', 8], ['editBaseLoc', 3], ['ST.persistT', 3],
  ['ST.calibScreenScale', 3], ['editSnapT', 5], ['readEditScalePct', 2]
];
let bad = 0;
for (const [k, want] of pairs) {
  const n = src.split(k).length - 1;
  const ok = n === want;
  if (!ok) bad++;
  console.log((ok ? '  ok  ' : 'FAIL  ') + k + ' 出现 ' + n + ' 次(期望 ' + want + ')');
}
console.log(bad ? 'FAIL: ' + bad : 'ALL CONSISTENT');
process.exit(bad ? 1 : 0);
