// 静态一致性核查:v2.3.0/v2.5.0 新标识符的定义与引用应恰好配对(次数为人工核定值)
const fs = require('fs');
const src = fs.readFileSync('wplace-overlay-autocolor.user.js', 'utf8');
const pairs = [
  ['ST.ovGone', 9], ['ST.lastScrDraw', 5], ['ST.lastMapMove', 7],
  ['S.collapsed', 13], ['S.pos', 4], ['applyHudCollapsed', 5], ['checkOvAlive', 2],
  ['hudClampPos', 4], ['wpAC-fold', 4], ['wpAC-colorrow', 2], ['wpAC-close', 0], ['showToast', 2],
  // v2.5.0 对齐校准
  ['ST.calib', 108], ['ST.mapTiles', 14], ['ST.calibMsg', 27], ['ST.progRev', 5],
  ['runCalibrate', 2], ['fullScan', 6], ['scoreOffset', 2], ['canvasPixelAt', 7],
  ['applyCalibToStorage', 3], ['clearCalib', 5], ['refreshCalibStats', 3],
  ['parseTileUrl', 2], ['decodeTile', 3], ['storeMapTile', 2], ['patchFetch', 2],
  ['isPainted', 3], ['sameColor', 2], ['texPxMerc', 5],
  ['wpAC-cal', 3], ['wpAC-apply', 4], ['FREE_COLOR_IDX', 3], ['WORLD_PX', 54],
  // v2.5.5 容差匹配 + 三档守门 + 强制采纳
  ['palTolHit', 5], ['nearestPaletteCached', 3], ['calibSignificant', 3],
  ['acceptCalib', 4], ['ST.calibForce', 5], ['NEAREST_MAP', 5], ['PAL_TOL', 6],
  // v2.5.3 快查网格 + 阶梯搜索 + 假峰守门
  ['paintIdxMap', 5], ['gridAt', 5], ['fillGridTile', 2], ['ensurePaintGrid', 4],
  ['scoreBatch', 5], ['calibSearchPhases', 2], ['refineAndFinish', 2],
  ['calibFinish', 3], ['calibSort', 5], ['finishCalib', 6], ['CALIB_STAGES', 2],
  // v2.5.1 编辑中模板（live 虚拟 bounds）
  ['rpUnproject', 3], ['syncLiveTemplates', 3], ['scheduleLiveSync', 2],
  ['isLiveId', 8], ['buildTplList', 5], ['ST.liveTpls', 10], ['attachUnbound', 3],
  // v2.5.2 放置编辑会话（DOM overlay）+ 主动补抓
  ['syncEditOverlay', 7], ['ensureMapTiles', 2], ['editOverlayEl', 5],
  ['LIVE_ID', 6], ['ST.editTile', 10], ['editBaseLoc', 3], ['ST.persistT', 3],
  ['ST.calibScreenScale', 3], ['editSnapT', 6], ['readEditScalePct', 2],
  // v2.6.0 颜色风格自动识别（实测官方颜色设置组合择优）
  ['detectColorStyle', 2], ['ST.styleBusy', 11], ['styleFindTriggers', 2],
  ['styleMenuItems', 3], ['styleOpenMenu', 4], ['styleSetSelect', 7],
  ['styleCanvasSig', 6], ['styleWaitRender', 5], ['styleSnapshot', 4],
  ['styleScan', 4], ['STYLE_MIN_PAINTED', 2], ['STYLE_SKIP_RATE', 2],
  ['STYLE_MARGIN', 4], ['label.dithering', 4],
  // v2.6.1 移动端触摸拖动（HUD 面板 + 地图视图位移跟踪）
  ['hudDragPos', 3], ['hudDragStart', 3], ['hudDragEnd', 4], ['dragHud', 11],
  ['touchstart', 4], ['touchmove', 3], ['touchend', 2], ['touchcancel', 1],
  ['touch-action', 2], ['ST.press', 5], ['ST.viewDX', 6], ['ST.viewDY', 6],
  // v2.7.0 框选自动补画（拟人化 · 手动提交）
  ['bpSrcToScreen', 4], ['bpSrcToWorld', 2], ['bpRunsFromPixels', 2],
  ['bpChargesInfo', 3], ['bpInjectMove', 3], ['bpInjectSpace', 3],
  ['bpCurSelIdx', 3], ['bpEnsureColor', 2], ['bpStroke', 2], ['bpEngine', 2],
  ['bpAbort', 8], ['bpPrimary', 2], ['bpSecondary', 3], ['syncBpBtns', 11],
  ['bpStartBox', 2], ['bpBoxCleanup', 6], ['bpBuildPlan', 2], ['bpPlanReady', 2],
  ['bpPreflight', 2], ['BP_STEP_PX', 2], ['BP_STEP_MS', 2],
  ['BP_STROKE_MS', 2], ['wpAC-bp', 7], ['wpAC-bpx', 3], ['bpBoxEl', 5],
  ['BP.phase', 19], ['BP.msg', 12], ['BP.ri', 9], ['BP.painted', 4],
  ['BP.missed', 5], ['BP.lastDraft', 2], ['ST.lastMapMove', 7],
  // v2.7.1 涂不上自动跳色（颜料按色分库存 remainingColorCounts）
  ['bpSkipColor', 2], ['BP.skippedRuns', 3], ['BP.streakSkips', 4], ['bpSleep', 10]
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
