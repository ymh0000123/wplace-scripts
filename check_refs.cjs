// 静态一致性核查:v2.3.0/v2.5.0 新标识符的定义与引用应恰好配对(次数为人工核定值)
const fs = require('fs');
const src = fs.readFileSync('wplace-overlay-autocolor.user.js', 'utf8');
const pairs = [
  ['ST.ovGone', 9], ['ST.lastScrDraw', 5], ['ST.lastMapMove', 4],
  ['S.collapsed', 13], ['S.pos', 4], ['applyHudCollapsed', 5], ['checkOvAlive', 2],
  ['hudClampPos', 4], ['wpAC-fold', 4], ['wpAC-colorrow', 2], ['wpAC-close', 0], ['showToast', 2],
  // v2.5.0 对齐校准
  ['ST.calib', 84], ['ST.mapTiles', 14], ['ST.calibMsg', 19], ['ST.progRev', 5],
  ['runCalibrate', 2], ['fullScan', 5], ['scoreOffset', 2], ['canvasPixelAt', 7],
  ['applyCalibToStorage', 3], ['clearCalib', 5], ['refreshCalibStats', 3],
  ['parseTileUrl', 2], ['decodeTile', 3], ['storeMapTile', 2], ['patchFetch', 2],
  ['isPainted', 3], ['sameColor', 2], ['texPxMerc', 3],
  ['wpAC-cal', 3], ['wpAC-apply', 4], ['FREE_COLOR_IDX', 4], ['WORLD_PX', 48],
  // v2.5.3 快查网格 + 阶梯搜索 + 假峰守门
  ['paintIdxMap', 4], ['gridAt', 3], ['fillGridTile', 2], ['ensurePaintGrid', 3],
  ['scoreBatch', 5], ['calibSearchPhases', 2], ['refineAndFinish', 2],
  ['calibFinish', 3], ['calibSort', 5], ['finishCalib', 6], ['CALIB_STAGES', 2],
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
