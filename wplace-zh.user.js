// ==UserScript==
// @name         Wplace 汉化助手
// @name:en      Wplace Chinese (Simplified) Localization
// @namespace    https://wplace.live/
// @version      1.0.0
// @description  启用 wplace.live 内置但未公开的官方简体中文语言包（3400+ 词条全量汉化），并补充翻译语言包遗漏的界面残留英文。支持一键开关。
// @description:en  Enable the built-in but hidden Simplified Chinese language pack of wplace.live, plus a supplement dictionary for untranslated leftovers.
// @author       ZCode
// @match        https://wplace.live/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @license      MIT
// ==/UserScript==

/*
 * 原理说明：
 * wplace.live 使用自研 i18n（paraglide 风格），语言代码存放在 localStorage 的
 * "PARAGLIDE_LOCALE" 键中。其内置了 12 个语言包（en/pt/ch/de/es/fr/it/jp/pl/ru/uk/vi），
 * 其中 "ch" 就是官方简体中文包（约 3400 条，覆盖全部界面），但站点的语言菜单
 * 只放出了 English 和 Português 两个入口。
 *
 * 本脚本做两件事：
 *   1. 在页面加载前（document-start）把 PARAGLIDE_LOCALE 设为 "ch"，
 *      让网站自己用官方中文包渲染所有界面 —— 包括动态弹窗、通知、商店等，
 *      覆盖率和性能都远优于逐词替换 DOM。
 *   2. 用一份补充词典 + MutationObserver，精确替换官方包尚未翻译的少量
 *      残留英文（企业账户、商店批量管理等较新板块）以及不经过 i18n 的
 *      MapLibre 地图控件文本。
 *
 * 想临时换回英文/葡语？通过油猴菜单"暂停汉化"即可；
 * 暂停期间在站点语言菜单里的选择会被尊重，脚本刷新页面后不再改动。
 */

(function () {
  'use strict';

  var LOCALE_KEY = 'PARAGLIDE_LOCALE';
  var STORE_KEY = 'wplaceZhEnabled';

  function gmGet(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
      if (typeof GM !== 'undefined' && GM && typeof GM.getValue === 'function') {
        // GM.getValue 是异步的，此处仅做尽力而为的同步降级
        return fallback;
      }
    } catch (e) { /* ignore */ }
    return fallback;
  }

  function gmSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; }
      if (typeof GM !== 'undefined' && GM && typeof GM.setValue === 'function') GM.setValue(key, value);
    } catch (e) { /* ignore */ }
  }

  var enabled = gmGet(STORE_KEY, true);

  // ── 第 1 步：启用官方中文语言包 ──────────────────────────────
  // document-start 阶段同步写入，一定早于网站 i18n 的初始化读取。
  if (enabled) {
    try { localStorage.setItem(LOCALE_KEY, 'ch'); } catch (e) { /* ignore */ }
  }

  // ── 油猴菜单：一键开关 ──────────────────────────────────────
  function registerMenu() {
    var label = enabled ? '⏸ 暂停汉化（恢复原语言）' : '▶ 启用汉化（简体中文）';
    var fn = function () {
      var next = !enabled;
      gmSet(STORE_KEY, next);
      try {
        if (next) localStorage.setItem(LOCALE_KEY, 'ch');
        else localStorage.removeItem(LOCALE_KEY); // 移除后网站回落到英文
      } catch (e) { /* ignore */ }
      location.reload();
    };
    try { if (typeof GM_registerMenuCommand === 'function') GM_registerMenuCommand(label, fn); } catch (e) {}
    try { if (typeof GM !== 'undefined' && GM && typeof GM.registerMenuCommand === 'function') GM.registerMenuCommand(label, fn); } catch (e) {}
  }
  registerMenu();

  if (!enabled) return;

  // ── 第 2 步：补充词典 ────────────────────────────────────────
  // 官方中文包约有 230 条残留英文（多为较新的企业账户/商店管理板块），
  // 以及 MapLibre 地图控件等不经过 i18n 的文本。以下按"整句精确匹配"替换，
  // 不会误伤聊天内容、用户名等动态文本（只有完全相等的整句才会被替换）。
  // 想增删词条，直接编辑下面的 DICT 即可，键是页面显示的原文，值是中文。
  var DICT = {
    /* ── 通用界面 ── */
    'Drafts': '草稿',
    'Headquarters': '总部',
    'Main Canvas': '主画布',
    'Overlay Studio': '覆盖图工作室',
    'Overlays': '覆盖图',
    'Skip': '跳过',
    'Delete': '删除',
    'Hidden': '已隐藏',
    'Visible': '可见',
    'Visible in store': '在商店中可见',
    'Hide from store': '从商店隐藏',
    'Protected': '受保护',
    'Automatic': '自动',
    'Season': '赛季',
    'Depth': '深度',
    'Historical': '历史',
    'Order': '排序',
    'Sort order': '排序方式',
    'Rarity': '稀有度',
    'Reward': '奖励',
    'Media': '媒体',
    'Inventory': '物品栏',
    'Total items': '物品总数',
    'Save changes': '保存更改',
    'Copy URL': '复制链接',
    'Choose image': '选择图片',
    'Choose images': '选择多张图片',
    'Choose an image or enter an image URL': '选择图片或输入图片链接',
    'Create badge': '创建徽章',
    'Create item': '创建物品',
    'Untitled item': '未命名物品',
    'No description': '暂无描述',
    'No image selected': '未选择图片',
    'Search catalog by name': '按名称搜索目录',
    'Add item': '添加物品',
    'Add row': '添加行',
    'Add multiple': '批量添加',
    'All roles': '所有角色',
    'All visibility': '所有可见性',
    'Image asset': '图片素材',
    'Asset library': '素材库',
    'Badge type': '徽章类型',
    'Batch workspace': '批量工作台',
    'Catalog control': '目录控制',
    'Catalog sections': '目录分区',
    'Catalog unavailable': '目录不可用',
    'Delete image asset': '删除图片素材',
    'Delete catalog item': '删除目录物品',
    'How to earn': '获取方式',
    'Image must be 5 MB or smaller': '图片不能超过 5 MB',
    'Image URL (optional when a file is selected)': '图片链接（已选择文件时可不填）',
    'Item deleted': '物品已删除',
    'Item hidden from the store': '物品已从商店隐藏',
    'Item updated': '物品已更新',
    'Item published to the store': '物品已发布到商店',
    'Failed to load the catalog': '目录加载失败',
    'Publish to store': '发布到商店',
    'Specific roles': '指定角色',
    'Buyer access': '购买者权限',
    'Upload new asset': '上传新素材',
    'Secret badge': '隐藏徽章',
    'Shared settings': '共享设置',

    /* ── 云同步（Google Drive 备份）── */
    'Connect Google Drive': '连接 Google 云端硬盘',
    'Connected to Google Drive': '已连接 Google 云端硬盘',
    'Disconnect': '断开连接',
    'Disconnect Google Drive?': '断开 Google 云端硬盘？',
    'Disconnected from Google Drive.': '已断开 Google 云端硬盘。',
    'Keep local': '保留本地',
    'Use cloud copy': '使用云端副本',
    'Sync now': '立即同步',
    'Syncing...': '同步中…',
    'Cloud backup (Google Drive)': '云端备份（Google 云端硬盘）',
    'Restore from Google Drive': '从 Google 云端硬盘恢复',
    'Restore complete.': '恢复完成。',
    'Restore overlays': '恢复覆盖图',
    'Up to date': '已是最新',
    'Cloud has newer changes': '云端有较新的更改',
    'Only in cloud': '仅存在于云端',
    'Local and cloud both changed': '本地与云端均已更改',
    'Local has unsynced changes': '本地有未同步的更改',
    'Never synced': '从未同步',
    'No backups found in your Google Drive.': '未在你的 Google 云端硬盘中找到备份。',

    /* ── 企业账户（较新的实验功能）── */
    'Businesses': '企业账户',
    'Business operations': '企业操作',
    'Personal account': '个人账户',
    'Company account': '企业账户',
    'Company accounts': '企业账户列表',
    'Company charges': '企业充能',
    'Company directory': '企业名录',
    'Company pixels': '企业像素',
    'Set up company': '设置企业',
    'Set up company account': '设置企业账户',
    'Employees': '员工',
    'Employee roster': '员工名单',
    'Employee ID': '员工 ID',
    'Employee user ID': '员工用户 ID',
    'Assign employee': '指派员工',
    'Remove employee': '移除员工',
    'Add employee': '添加员工',
    'Infinite charges': '无限充能',
    'Infinite charges enabled.': '已启用无限充能。',
    'Infinite charges disabled.': '已停用无限充能。',
    'Last painted': '最后绘画时间',
    'Paint routing': '绘画路线',
    'Paint perimeter': '绘画范围',
    'Unrestricted worldwide': '全球无限制',
    'Region ID': '区域 ID',
    'Tile X': '图块 X',
    'Tile Y': '图块 Y',
    'No companies yet': '还没有企业账户',
    'No employees assigned': '未指派员工',
    'No matching accounts': '没有匹配的账户',
    'Open user': '打开用户主页',
    'Account created': '账户已创建',
    'Audit details': '审计详情',
    'Target type': '目标类型',
    'Add country': '添加国家',
    'Add region': '添加区域',
    'Add tile': '添加图块',
    'Allowed countries': '允许的国家',
    'Allowed regions': '允许的区域',
    'Allowed tiles': '允许的图块',
    'Allow every tile within a country.': '允许一个国家内的全部图块。',
    'Allow every tile in a map region.': '允许一个地图区域内的全部图块。',
    'Allow one exact canvas tile.': '允许一个指定的画布图块。',
    'Setup candidate': '待设置账户',
    'Select a company account': '选择一个企业账户',
    'Business infinite charges updated': '企业无限充能已更新',
    'Business membership updated': '企业成员资格已更新',
    'Business paint restrictions updated': '企业绘画限制已更新',

    /* ── 联盟覆盖图 ── */
    'Alliance permission': '联盟权限',
    'Who can see it': '谁可以看到',
    'Overlay managers only': '仅覆盖图管理员',
    'Set position': '设置位置',
    'Update position': '更新位置',
    'Overlay position saved': '覆盖图位置已保存',
    'Where it appears': '显示位置',
    'Select where to start': '选择起点',

    /* ── 颜色 / 工具 ── */
    'Convert to legacy colors': '转换为旧版颜色',
    'Fixed colors enabled': '已启用固定颜色',
    'Legacy colors enabled': '已启用旧版颜色',
    'Use fixed colors': '使用固定颜色',

    /* ── 延时视频 ── */
    'Generate timelapse': '生成延时视频',
    'Generating area timelapse...': '正在生成区域延时视频…',
    'Select an area first to generate a timelapse.': '请先选择区域，再生成延时视频。',
    'Selected area timelapse saved': '区域延时视频已保存',
    'This browser cannot export timelapse videos.': '当前浏览器无法导出延时视频。',

    /* ── 角色标识 ── */
    'Game Master': '游戏管理员',
    'Game Master Leader': '游戏管理员主管',
    'Developer': '开发者',

    /* ── 不经过 i18n 的界面文本（覆盖图 HUD、页面标题等）── */
    'Select Area': '选择区域',
    'Max. Charge': '最大充能',
    'Profile frame': '头像框',
    'User profile': '用户资料',
    'Wplace - Paint the world': 'Wplace - 绘制世界',

    /* ── MapLibre 地图控件（title / aria-label）── */
    'Zoom in': '放大',
    'Zoom out': '缩小',
    'Close popup': '关闭弹窗',
    'Map feedback': '地图反馈',
    'Map marker': '地图标记',
    'Disable globe': '关闭地球视图',
    'Use Ctrl + scroll to zoom the map': '按住 Ctrl 并滚动滚轮缩放地图',
    'Use ⌘ + scroll to zoom the map': '按住 ⌘ 并滚动滚轮缩放地图'
  };

  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1, CODE: 1, PRE: 1 };
  var TRANSLATED_ATTRS = ['title', 'aria-label', 'placeholder', 'aria-description', 'aria-title'];
  var CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;

  function translateTextNode(node) {
    var text = node.nodeValue;
    if (!text) return;
    // 已含中文则跳过，避免重复处理
    if (text.length < 2 || CJK_RE.test(text)) return;
    var trimmed = text.trim();
    if (!trimmed) return;
    var hit = DICT[trimmed] || DICT[trimmed.replace(/\s+/g, ' ')];
    if (hit) node.nodeValue = text.replace(trimmed, hit);
  }

  function translateElement(el) {
    if (SKIP_TAGS[el.tagName]) return;
    // 跳过用户正在编辑的内容（聊天输入等），防止误替换
    if (el.isContentEditable) return;
    for (var i = 0; i < TRANSLATED_ATTRS.length; i++) {
      var name = TRANSLATED_ATTRS[i];
      if (!el.hasAttribute(name)) continue;
      var val = el.getAttribute(name);
      if (!val || CJK_RE.test(val)) continue;
      var hit = DICT[val] || DICT[val.replace(/\s+/g, ' ')];
      if (hit) el.setAttribute(name, hit);
    }
    // 处理子树中的文本节点
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    var n;
    while ((n = walker.nextNode())) {
      var p = n.parentElement;
      if (!p || SKIP_TAGS[p.tagName] || p.isContentEditable) continue;
      translateTextNode(n);
    }
  }

  function handleNode(node) {
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) {
      var p = node.parentElement;
      if (!p || SKIP_TAGS[p.tagName] || p.isContentEditable) return;
      translateTextNode(node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      translateElement(node);
    }
  }

  // ── MutationObserver：监听后续插入/修改的节点 ────────────────
  var pending = new Set();
  var scheduled = false;

  function flush() {
    scheduled = false;
    var batch = Array.from(pending);
    pending.clear();
    for (var i = 0; i < batch.length; i++) {
      try { handleNode(batch[i]); } catch (e) { /* 单节点失败不影响其余 */ }
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || setTimeout)(flush);
  }

  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var m = mutations[i];
      if (m.type === 'characterData') {
        if (m.target && m.target.nodeType === Node.TEXT_NODE) pending.add(m.target);
      } else {
        for (var j = 0; j < m.addedNodes.length; j++) pending.add(m.addedNodes[j]);
      }
    }
    if (pending.size) schedule();
  });

  function start() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
    // 初始全量处理一遍（body 此刻已可用）
    try { translateElement(document.body); } catch (e) { /* ignore */ }
    // 页面标题
    try {
      if (document.title && DICT[document.title]) document.title = DICT[document.title];
    } catch (e) { /* ignore */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
