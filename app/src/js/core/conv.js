// ================================================
// core/conv.js — 简繁转换层（纯逻辑，零 DOM）
// 从 index.html IIFE 提取（v4.3 逐字迁移）
// 数据以简体存储，显示/复制经本层转繁体
// ================================================
import { S2T_MAP, T2S_MAP } from '../data/conv-tables.mjs';

// 全局转换器: 读取 conv_tables 定义的 S2T_MAP / T2S_MAP
export function getConvTables() {
  return { s2t: S2T_MAP || {}, t2s: T2S_MAP || {} };
}

// 生成排序后的键列表 (长键优先) — 惰性缓存
let _s2tKeys = null, _t2sKeys = null;
export function getKeys(mapObj) {
  return Object.keys(mapObj).sort((a, b) => b.length - a.length || a.localeCompare(b, 'zh'));
}

// 核心转换: 按最长键匹配替换
export function convertText(text, mapObj) {
  if (!text || !mapObj) return text;
  if (mapObj === getConvTables().s2t) {
    if (!_s2tKeys) _s2tKeys = getKeys(mapObj);
  } else if (mapObj === getConvTables().t2s) {
    if (!_t2sKeys) _t2sKeys = getKeys(mapObj);
  }
  const keys = (mapObj === getConvTables().s2t) ? _s2tKeys : _t2sKeys;
  if (!keys || keys.length === 0) return text;

  let result = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    let matched = false;
    for (const k of keys) {
      if (text.startsWith(k, i)) {
        result += mapObj[k];
        i += k.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      result += text[i];
      i += 1;
    }
  }
  return result;
}

// 简体 -> 繁体
export function toTraditional(text) {
  return convertText(text, getConvTables().s2t);
}
// 繁体 -> 简体
export function toSimplified(text) {
  return convertText(text, getConvTables().t2s);
}

// ========================================
// 显示字形状态: 's' 简体 | 't' 繁体
// 默认繁体由 ui 层 init 时 setDisplayLang('t')
// ========================================
export let displayLang = 's';

export function setLangState(lang) {
  displayLang = lang === 't' ? 't' : 's';
}
export function getDisplayLang() {
  return displayLang;
}

export function toDisplay(text) {
  return displayLang === 't' ? toTraditional(text) : text;
}
// 显式目标字形转换: 切繁体用 s2t, 切简体用 t2s (UI 静态文本用, 双向可靠)
export function toLang(text, lang) {
  if (lang === 't') return toTraditional(text);
  return toSimplified(text);
}
// 转换含 HTML 的字符串 (转换标签间文本 + data-copy 属性值, 保留标签结构)
export function toDisplayHtml(html) {
  if (displayLang !== 't' || !html) return html;
  return html
    // 标签间文本
    .replace(/>([^<]*)</g, (m, text) => '>' + toTraditional(text) + '<')
    // data-copy 属性值 (复制文本)
    .replace(/(data-copy=")([^"]*)(")/g, (m, pre, val, post) => pre + toTraditional(val) + post)
    // title/aria-label 属性值
    .replace(/(title=")([^"]*)(")/g, (m, pre, val, post) => pre + toTraditional(val) + post)
    .replace(/(aria-label=")([^"]*)(")/g, (m, pre, val, post) => pre + toTraditional(val) + post);
}
// 高亮查询词的字形适配: 跟随当前显示字形
export function queryForDisplay(q) {
  return displayLang === 't' ? toTraditional(toSimplified(q)) : q;
}
