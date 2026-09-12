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

// Emoji 在 Discord 以圖片渲染，約佔兩倍寬度。這是近似值：
// - U+1F300–1FAFF 一律視為 Emoji；
// - U+2600–27BF 混有 ☐ ✓ ★ 等窄符號，只在後接 U+FE0F（Emoji 呈現）時算 2；
// - 變異選擇子、ZWJ、膚色修飾符與 ZWJ 之後的字元併入前一個字形，寬度為 0。
const EMOJI_RANGE = [0x1f300, 0x1faff];
const SYMBOL_RANGE = [0x2600, 0x27bf];
const EMOJI_MODIFIER_RANGE = [0x1f3fb, 0x1f3ff];
const VARIATION_SELECTOR_15 = 0xfe0e;
const VARIATION_SELECTOR_16 = 0xfe0f;
const ZERO_WIDTH_JOINER = 0x200d;

function inRange(codePoint, [start, end]) {
  return codePoint >= start && codePoint <= end;
}

// 逐字元產生 [字元, 顯示寬度]；需要前後文（ZWJ、FE0F）才能決定寬度。
function* charWidths(text) {
  const chars = [...text];
  let joined = false;
  for (let index = 0; index < chars.length; index += 1) {
    const codePoint = chars[index].codePointAt(0);
    const next = chars[index + 1]?.codePointAt(0);
    let width;
    if (codePoint === ZERO_WIDTH_JOINER || codePoint === VARIATION_SELECTOR_15 || codePoint === VARIATION_SELECTOR_16
      || inRange(codePoint, EMOJI_MODIFIER_RANGE) || joined) width = 0;
    else if (inRange(codePoint, EMOJI_RANGE)) width = 2;
    else if (inRange(codePoint, SYMBOL_RANGE)) width = next === VARIATION_SELECTOR_16 ? 2 : 1;
    else width = WIDE_CHAR_RANGES.some((range) => inRange(codePoint, range)) ? 2 : 1;
    joined = codePoint === ZERO_WIDTH_JOINER;
    yield [chars[index], width];
  }
}

function displayWidth(value) {
  let width = 0;
  for (const [, charWidth] of charWidths(String(value ?? ''))) width += charWidth;
  return width;
}

function truncateToWidth(value, maximumWidth, ellipsis = '…') {
  const text = String(value ?? '');
  if (displayWidth(text) <= maximumWidth) return text;
  const budget = Math.max(0, maximumWidth - displayWidth(ellipsis));
  let result = '';
  let width = 0;
  for (const [char, charWidth] of charWidths(text)) {
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
    repositoryButtonLabel = 'View Repository',
    assets: customAssets,
    largeImage,
    largeText,
    smallImage,
    smallText
  } = options;

  const assetOptions = customAssets || { largeImage, largeText, smallImage, smallText };
  const assets = {};
  if (assetOptions.largeImage) assets.large_image = String(assetOptions.largeImage);
  if (assetOptions.largeText) assets.large_text = truncate(assetOptions.largeText, 128);
  if (assetOptions.smallImage) {
    assets.small_image = String(assetOptions.smallImage);
    if (assetOptions.smallText) assets.small_text = truncate(assetOptions.smallText, 128);
  }

  return {
    details: truncate(details, 128),
    state: truncate(state, 128),
    ...(showElapsedTime ? { timestamps: { start: startedAt } } : {}),
    ...(Object.keys(assets).length > 0 ? { assets } : {}),
    instance: false,
    buttons: repositoryUrl
      ? [{ label: truncate(repositoryButtonLabel, 32), url: repositoryUrl }]
      : undefined
  };
}


module.exports = { buildPresence, truncate, displayWidth, truncateToWidth };

