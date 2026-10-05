// 静态一致性核查:v2.3.0 新标识符的定义与引用应恰好配对(次数为人工核定值)
const fs = require('fs');
const src = fs.readFileSync('wplace-overlay-autocolor.user.js', 'utf8');
const pairs = [
  ['ST.ovGone', 8], ['ST.lastScrDraw', 4], ['ST.lastMapMove', 4],
  ['S.collapsed', 13], ['S.pos', 4], ['applyHudCollapsed', 5], ['checkOvAlive', 2],
  ['hudClampPos', 4], ['wpAC-fold', 4], ['wpAC-colorrow', 2], ['wpAC-close', 0], ['showToast', 2]
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
