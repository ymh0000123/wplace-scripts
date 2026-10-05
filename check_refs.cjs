// 静态一致性核查:v2.3.0/v2.5.0 新标识符的定义与引用应恰好配对(次数为人工核定值)
const fs = require('fs');
const src = fs.readFileSync('wplace-overlay-autocolor.user.js', 'utf8');
const pairs = [
  ['ST.ovGone', 8], ['ST.lastScrDraw', 4], ['ST.lastMapMove', 4],
  ['S.collapsed', 13], ['S.pos', 4], ['applyHudCollapsed', 5], ['checkOvAlive', 2],
  ['hudClampPos', 4], ['wpAC-fold', 4], ['wpAC-colorrow', 2], ['wpAC-close', 0], ['showToast', 2],
  // v2.5.0 对齐校准
  ['ST.calib', 65], ['ST.mapTiles', 12], ['ST.calibMsg', 15], ['ST.progRev', 5],
  ['runCalibrate', 2], ['fullScan', 4], ['scoreOffset', 3], ['canvasPixelAt', 6],
  ['applyCalibToStorage', 2], ['clearCalib', 3], ['refreshCalibStats', 2],
  ['parseTileUrl', 2], ['decodeTile', 2], ['storeMapTile', 2], ['patchFetch', 2],
  ['isPainted', 4], ['sameColor', 4], ['texPxMerc', 3],
  ['wpAC-cal', 3], ['wpAC-apply', 4], ['FREE_COLOR_IDX', 3], ['WORLD_PX', 22],
  // v2.5.1 编辑中模板（live 虚拟 bounds）
  ['rpUnproject', 3], ['syncLiveTemplates', 3], ['scheduleLiveSync', 2],
  ['isLiveId', 7], ['buildTplList', 3], ['ST.liveTpls', 2], ['attachUnbound', 3]
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
