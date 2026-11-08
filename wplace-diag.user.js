// ==UserScript==
// @name         Wplace 脚本诊断助手
// @name:en      Wplace Script Diagnostics
// @namespace    https://wplace.live/
// @version      1.0.0
// @description  读取「覆盖图自动选色」脚本的运行现场（版本/设置/瓦片/校准/补画引擎/色板状态），通过 ScriptCat Agent 让 AI 就地分析报障：校准失败、补画暂停、画错色、涂不上等。需在 ScriptCat「设置 → Agent」中配置模型后使用；与主脚本（≥2.8.0）搭配安装。
// @description:en  Reads the runtime state of the "Wplace Overlay Auto Color" userscript (version/settings/tiles/calibration/box-paint engine/palette) and lets the ScriptCat Agent AI analyze issues on-site: calibration rejection, box-paint pause, mispainted colors, etc. Configure a model in ScriptCat settings first; install alongside the main script (>=2.8.0).
// @author       you
// @match        https://wplace.live/*
// @grant        CAT.agent.conversation
// @noframes
// @license      MIT
// ==/UserScript==

/*
 * 用法：
 *   1. 与主脚本 wplace-overlay-autocolor.user.js（≥2.8.0）一起安装；
 *   2. ScriptCat「设置 → Agent」配置好模型；
 *   3. 打开 wplace.live，ScriptCat 侧边栏出现「Wplace 诊断」对话，直接用中文描述问题即可
 *      （例：「补画暂停了，帮我看看」「校准一直失败」「刚才补画画错颜色」）——
 *      AI 会调用 get_diag / get_dom 工具读取现场后给出结论与建议。
 * 架构：
 *   主脚本 @grant none 运行在页面上下文，把只读快照挂到 window.__wpACDiag.dump()；
 *   本脚本在 ScriptCat 沙箱内，经 unsafeWindow 读取该快照——主脚本不被拖进沙箱，
 *   其 localStorage hook / fetch 捕获管线零风险。
 */

(function () {
  'use strict';

  var uw = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  var CONV_ID_KEY = 'wpACDiagConvId';

  // ---- 工具 1：主脚本运行现场快照 ----
  function mainDiag() {
    try {
      if (!uw.__wpACDiag || typeof uw.__wpACDiag.dump !== 'function') {
        return { error: '主脚本未运行或版本过旧：需要 wplace-overlay-autocolor.user.js >= 2.8.0' };
      }
      return uw.__wpACDiag.dump();
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }

  // ---- 工具 2：页面 DOM 探针（色板/按钮/官方面板任意选择器） ----
  function domProbe(selector) {
    try {
      var els = document.querySelectorAll(selector);
      var items = [];
      for (var i = 0; i < els.length && i < 30; i++) {
        var el = els[i];
        var item = {
          tag: el.tagName,
          id: el.id || undefined,
          cls: typeof el.className === 'string' ? el.className : undefined,
          text: (el.textContent || '').trim().slice(0, 160)
        };
        try {
          var label = el.getAttribute('aria-label');
          var pressed = el.getAttribute('aria-pressed');
          if (label != null) item.ariaLabel = label;
          if (pressed != null) item.ariaPressed = pressed;
        } catch (e) {}
        items.push(item);
      }
      return { selector: selector, count: els.length, items: items };
    } catch (e) {
      return { selector: selector, error: String((e && e.message) || e) };
    }
  }

  var TOOLS = [
    {
      name: 'get_diag',
      description: '读取「覆盖图自动选色」脚本运行现场快照：脚本版本、设置（enabled/hoverMode/segFix）、模板瓦片数、校准状态、补画引擎 BP 状态（phase/进度/跳过/暂停消息）、色板与 Paint 按钮状态。诊断任何脚本问题时先调用它。',
      parameters: { type: 'object', properties: {} },
      handler: async function () { return mainDiag(); }
    },
    {
      name: 'get_dom',
      description: '在 wplace.live 页面按 CSS 选择器查询元素，返回 tag/id/class/文本/aria-label/aria-pressed（最多 30 个）。用于检查官方 UI 结构，例如色板 .paint-palette、色块 button[aria-pressed="true"]、锁定色块 svg、Paint 按钮文本等。',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS 选择器，例如 .paint-palette 或 button[aria-pressed="true"]' }
        },
        required: ['selector']
      },
      handler: async function (args) { return domProbe(args.selector); }
    }
  ];

  var SYSTEM = [
    '你是 wplace.live 用户脚本「覆盖图自动选色」（wplace-overlay-autocolor.user.js）的诊断助手。',
    '用户会描述脚本故障（校准失败、补画暂停、画错颜色、涂不上、HUD 异常等），你通过工具读现场后给出结论与建议。',
    '',
    '工作流程：',
    '1. 先调 get_diag 拿运行现场快照；',
    '2. 按快照线索决定是否用 get_dom 检查官方 UI（常用选择器：.paint-palette、button[aria-pressed="true"]、#color-N 色块、button 文本以 Paint 开头的主按钮、.paint-button-cooldown）；',
    '3. 结论先行，用中文给出可操作建议（含涉及的主脚本版本号），不确定时明确说需要什么信息，不要编造。',
    '',
    '领域知识（逆向实证，可信）：',
    '- 官方连画是「上一点→当前点」整条线段插值落笔，全用当前选中色；主脚本 v2.8.0 的分段注入（segFix）会拦下跨色线段按色分段。',
    '- charges（画图点数）数字画在主按钮 canvas 上，DOM 文本读不到；按钮只剩「Paint (m:ss)」= charges<max 正在恢复 ≠ 颜料耗尽。',
    '- 颜料按颜色分库存：色块 aria-label 形如「颜色名: N left」；库存 0 的色能选中但放置被拒、草稿不涨。',
    '- 草稿数画在面板标题 h2 的 canvas 上；补画引擎用 canvas 像素指纹检测草稿增长。',
    '- 补画引擎 BP 状态含义：phase=run 运行中 / pause 暂停 / wait 等待恢复 / stop 已停止；msg 是当前动作；missed>=2 表示草稿指纹连续不涨（库存/charges/视图偏移都可能）；streakSkips 是连续涂不上的颜色数。',
    '- 校准状态：calib=null 且 anchor=null 表示未校准或校准被拒；suspect=true 表示检测到视图交互信号，校准被挂起；scrQuad=0 且 ovGone=true 表示官方覆盖图未渲染（退出覆盖模式或模板隐藏），此时一切取色都会放弃。',
    '- settings.segFix=false 时用户关闭了空格连画跨色分段；hoverMode=false 是点击换色模式（悬停不换色是正常表现）。',
    '- tiles=0 表示模板瓦片尚未捕获（模板未显示/未打开覆盖图）；templates 列出已加载模板。',
    '',
    '常见故障速查：',
    '- 补画整条线段画错色 → 看 get_diag 的 v（须 ≥2.8.0，2.8.0 修复 keydown 纠色破坏引擎选色的回归）、settings、bp.curRun；',
    '- 补画暂停 → 看 bp.msg/missed/streakSkips/paintBtn（有无 (m:ss) 恢复倒计时）；',
    '- 悬停不换色 → 看 settings.enabled/hoverMode、palette 是否为 null（绘画模式未开）、tiles/scrQuad（无几何）；',
    '- 校准失败 → 看 calibMsg、tiles、scrQuad、anchor。',
    '',
    '工具调用失败或返回 error 时，如实告诉用户（例如主脚本未装/版本过旧、Agent 未配模型），并给出安装/配置指引。'
  ].join('\n');

  async function ensureConv() {
    var saved = null;
    try { saved = localStorage.getItem(CONV_ID_KEY); } catch (e) {}
    if (saved) {
      try {
        var got = await CAT.agent.conversation.get(saved);
        if (got) return got;
      } catch (e) { /* 对话不存在/已损坏 → 重建 */ }
    }
    var conv = await CAT.agent.conversation.create({
      id: 'wpac-diag-' + Date.now().toString(36),
      title: 'Wplace 诊断',
      system: SYSTEM,
      tools: TOOLS
    });
    try { localStorage.setItem(CONV_ID_KEY, conv.id); } catch (e) {}
    return conv;
  }

  ensureConv().catch(function (e) {
    console.warn('[wpAC-diag] Agent 对话创建失败（未配模型？）:', e);
  });
})();
