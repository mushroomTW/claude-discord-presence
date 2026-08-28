'use strict';

// CJK／全形字元在 Discord 用戶端約佔兩倍顯示寬度，僅用字元數截斷會讓
// 「Workspace: 很長的中文名稱 · Waiting」這類字串在渲染時被截尾省略，
// 導致後面的活動狀態（Waiting／Editing…）完全看不到。
const WIDE_CHAR_RANGES = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0xa4cf], // CJK 部首、標點、統一表意文字
  [0xac00, 0xd7a3], // Hangul 音節
  [0xf900, 0xfaff], // CJK 相容表意文字
  [0xff00, 0xff60], // 全形 ASCII 變體
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd] // CJK 擴充區
];

function charDisplayWidth(codePoint) {
  return WIDE_CHAR_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end) ? 2 : 1;
}

function displayWidth(value) {
  let width = 0;
  for (const char of String(value ?? '')) width += charDisplayWidth(char.codePointAt(0));
  return width;
}

function truncateToWidth(value, maximumWidth, ellipsis = '…') {
  const text = String(value ?? '');
  if (displayWidth(text) <= maximumWidth) return text;
  const budget = Math.max(0, maximumWidth - displayWidth(ellipsis));
  let result = '';
  let width = 0;
  for (const char of text) {
    const charWidth = charDisplayWidth(char.codePointAt(0));
    if (width + charWidth > budget) break;
    result += char;
    width += charWidth;
  }
  return budget <= 0 ? '' : `${result}${ellipsis}`;
}

function truncate(value, maximumLength) {
  return String(value ?? '').slice(0, maximumLength);
}

function buildPresence(options) {
  const {
    details,
    state,
    startedAt,
    showElapsedTime = true,
    repositoryUrl,
    repositoryButtonLabel = 'View Repository'
  } = options;

  return {
    details: truncate(details, 128),
    state: truncate(state, 128),
    ...(showElapsedTime ? { timestamps: { start: startedAt } } : {}),
    instance: false,
    buttons: repositoryUrl
      ? [{ label: truncate(repositoryButtonLabel, 32), url: repositoryUrl }]
      : undefined
  };
}

module.exports = { buildPresence, truncate, displayWidth, truncateToWidth };
