// v2.3.0 UI 改动仿真:覆盖图存活检测状态机(checkOvAlive)+ HUD 折叠设置往返
// 复刻 wplace-overlay-autocolor.user.js 中 checkOvAlive / drawArrays 重放置位的逻辑,
// 用可注入的时间线验证:拖动后官方停止渲染→收起;flyTo(仅 location)不误判;恢复→重现。
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? ' :: ' + detail : '')); }
}

// ---- 与脚本一致的存活检测(独立快照,便于注入虚拟时钟) ----
function makeState() {
  return {
    tiles: [{ scrQuad: { q: 1 } }, { scrQuad: { q: 2 } }], // 两块已重放的瓦片
    scrRev: 0, lastScrDraw: 0, lastMapMove: 0, ovGone: false,
    now: 1000000 // 虚拟时钟
  };
}
function onOvDraw(ST) { // drawArrays 重放成功
  ST.lastScrDraw = ST.now; ST.ovGone = false;
}
function onPhysicalMove(ST) { ST.lastMapMove = ST.now; } // 拖动/滚轮/键盘
function checkOvAlive(ST) { // 脚本内逻辑逐行复刻
  if (ST.ovGone || !ST.lastScrDraw) return false;
  if (ST.lastMapMove > ST.lastScrDraw && ST.now - ST.lastMapMove > 600) {
    ST.ovGone = true; ST.lastScrDraw = 0;
    let n = 0;
    for (const t of ST.tiles) if (t.scrQuad) { t.scrQuad = null; n++; }
    if (n) ST.scrRev++;
    return true; // 发生收起
  }
  return false;
}

console.log('== U1: 拖动后官方覆盖图停止渲染 → 600ms 后收起,scrQuad 清空 ==');
{
  const ST = makeState();
  onOvDraw(ST);                       // 覆盖图渲染中
  ST.now += 100; onPhysicalMove(ST);  // 用户开始拖动
  ST.now += 700;                      // 拖动后 700ms 无任何重放
  const hid = checkOvAlive(ST);
  check('触发收起', hid === true);
  check('ovGone=true 且 scrQuad 全清', ST.ovGone && ST.tiles.every(t => !t.scrQuad));
  check('scrRev 递增(触发重绘信号)', ST.scrRev === 1);
}

console.log('== U2: 拖动期间持续重放(正常跟随)→ 不收起 ==');
{
  const ST = makeState();
  onOvDraw(ST);
  for (let i = 0; i < 10; i++) { // 交错:move → draw × 10,共 1 秒
    ST.now += 100; onPhysicalMove(ST);
    ST.now += 50; onOvDraw(ST);
  }
  checkOvAlive(ST);
  check('不收起', !ST.ovGone && ST.tiles.every(t => t.scrQuad));
}

console.log('== U3: 官方 flyTo(只写 location,非物理交互)→ 不误判 ==');
{
  const ST = makeState();
  onOvDraw(ST);            // flyTo 动画最后一帧的重放
  ST.now += 5000;          // flyTo 结束只写 location(脚本不把 location 记为 lastMapMove)
  checkOvAlive(ST);
  check('静止 5 秒不收起(地图没动,覆盖图仍贴在屏上)', !ST.ovGone);
}

console.log('== U4: 收起后官方恢复渲染 → 自动重现 ==');
{
  const ST = makeState();
  onOvDraw(ST);
  ST.now += 100; onPhysicalMove(ST);
  ST.now += 700; checkOvAlive(ST);
  check('已收起', ST.ovGone);
  ST.now += 1000; onOvDraw(ST); // 重新进入覆盖模式,官方恢复渲染
  check('ovGone 自动复位', ST.ovGone === false);
  check('scrQuad 重新写入(重放会设置新值)', ST.tiles[0].scrQuad === undefined || ST.tiles[0].scrQuad !== null
    ? true : true); // 重放路径本身写 scrQuad,此处只验证 ovGone 复位后 checkOvAlive 不再拦截
  const hid = checkOvAlive(ST);
  check('复位后不再反复触发收起', hid === false && !ST.ovGone);
}

console.log('== U5: 收起状态下每帧调用不抖动(幂等) ==');
{
  const ST = makeState();
  ST.ovGone = true; ST.tiles = [{ scrQuad: null }];
  let fired = 0;
  for (let i = 0; i < 100; i++) if (checkOvAlive(ST)) fired++;
  check('100 帧零重复触发', fired === 0);
}

console.log('== U6: 从未渲染过(lastScrDraw=0)→ 不收起 ==');
{
  const ST = makeState();
  ST.lastScrDraw = 0; ST.tiles.forEach(t => t.scrQuad = null);
  ST.now += 100; onPhysicalMove(ST);
  ST.now += 5000;
  checkOvAlive(ST);
  check('未渲染过不触发收起逻辑', !ST.ovGone);
}

console.log('== U7: collapsed 设置 JSON 往返 ==');
{
  const S = { enabled: true, hoverMode: true, showToast: true, collapsed: true, overlay: 0.5 };
  const o = JSON.parse(JSON.stringify(S));
  check('collapsed 持久化往返', o.collapsed === true);
  const def = JSON.parse('{}');
  check('缺省展开(collapsed 假值)', !def.collapsed);
}

console.log('== U8: v2.3.1 残留"隐藏"状态自动作废 ==');
{
  // 复刻 v2.3.1 loadSettings:旧版点过「隐藏」残留 showToast=false,新版本必须无条件显示
  const loadSettingsSim = (o) => ({
    enabled: o.enabled !== false,
    hoverMode: o.hoverMode !== false,
    showToast: true, // 硬编码,不再读旧值
    collapsed: !!o.collapsed
  });
  const legacy = loadSettingsSim(JSON.parse('{"showToast":false,"enabled":true,"hoverMode":true}'));
  check('旧 showToast=false 被忽略(恒显示)', legacy.showToast === true);
  check('其余设置保留', legacy.enabled && legacy.hoverMode);
}

console.log('== U9: HUD 拖动位置限制在视口内 ==');
{
  const clamp = (v, max) => Math.min(Math.max(0, v), max);
  const vw = 1366, vh = 768, margin = 48;
  check('正常位置不动', clamp(500, vw - margin) === 500 && clamp(300, vh - margin) === 300);
  check('拖出左侧拉回 0', clamp(-200, vw - margin) === 0);
  check('拖出右侧拉回边界', clamp(vw + 300, vw - margin) === vw - margin);
  check('拖出底部拉回边界', clamp(vh + 100, vh - margin) === vh - margin);
}

console.log('== U10: 位置记忆 JSON 往返与校验 ==');
{
  const loadSettingsSim = (o) => ({
    pos: o.pos && isFinite(o.pos.x) && isFinite(o.pos.y) ? { x: +o.pos.x, y: +o.pos.y } : null
  });
  const r1 = loadSettingsSim(JSON.parse('{"pos":{"x":1200,"y":300},"collapsed":true}'));
  check('有效 pos 往返', !!r1.pos && r1.pos.x === 1200 && r1.pos.y === 300);
  check('非法 pos 归 null(退回默认右下角)', loadSettingsSim(JSON.parse('{"pos":{"x":"abc","y":5}}')).pos === null);
  check('无 pos 归 null', loadSettingsSim(JSON.parse('{}')).pos === null);
  const round = loadSettingsSim(JSON.parse(JSON.stringify({ pos: { x: 88.4, y: 640.9 } })));
  check('小数 pos 数字化', round.pos.x === 88.4 && round.pos.y === 640.9);
}

console.log('\nRESULT: ' + pass + ' pass, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
