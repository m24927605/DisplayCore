'use strict';

const assert = require('node:assert/strict');
const { readFile, readdir } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');
const displayRoot = path.join(projectRoot, 'display');

async function readDisplayFile(fileName) {
  return readFile(path.join(displayRoot, fileName), 'utf8');
}

async function readDisplayModuleSources() {
  const fileNames = (await readdir(displayRoot))
    .filter((fileName) => fileName.endsWith('.mjs'))
    .sort();
  const sources = await Promise.all(fileNames.map(async (fileName) =>
    `\n/* ${fileName} */\n${await readDisplayFile(fileName)}`));
  return sources.join('\n');
}

test('正式訊息改用 SVG 字形 alpha mask，酒體、折射與 meniscus 全在同一遮罩內', async () => {
  const source = await readDisplayModuleSources();

  assert.match(source, /http:\/\/www\.w3\.org\/2000\/svg/);
  assert.match(source, /createElementNS\(/);
  assert.match(source, /['"]defs['"]/);
  assert.match(source, /['"]mask['"]/);
  assert.match(
    source,
    /['"]text['"]/,
    'alpha mask 必須由實際訊息字形產生，不能以矩形假裝文字容器',
  );
  assert.doesNotMatch(
    source,
    /['"]foreignObject['"]|<foreignObject/i,
    'Electron compositor 無法可靠 rasterize mask 內的 foreignObject',
  );
  assert.match(source, /message-liquid-canonical-glyph/);
  assert.match(source, /message-liquid-mask-glyph/);
  assert.match(source, /message-liquid-outline-glyph/);
  assert.match(source, /message-liquid-mask/);
  assert.match(source, /message-liquid-paint/);
  assert.match(source, /message-liquid-body/);
  assert.match(source, /message-liquid-refraction/);
  assert.match(source, /message-liquid-meniscus/);
  assert.match(
    source,
    /message-liquid-meniscus-depth/,
    '液面下方必須有受酒體裁切的柔和厚度，遠距才看得出自然波形',
  );
  assert.match(source, /message-liquid-fluid-clip/);
  assert.match(source, /message-liquid-fluid-clip-path/);
  assert.match(source, /message-liquid-refraction-primary/);
  assert.match(source, /message-liquid-refraction-secondary/);
  assert.match(source, /message-liquid-caustic/);
  assert.match(source, /message-liquid-surface-focus/);
  assert.match(source, /message-liquid-bubble-bodies/);
  assert.match(source, /message-liquid-bubble-highlights/);
  assert.match(source, /bubbleBodyPath/);
  assert.match(source, /bubbleHighlightPath/);
  assert.match(
    source,
    /createGradientStop\([^\n]*['"]0%['"][^\n]*0\.84\)/,
    '酒體必須保留少量透光，不能所有 stop 都是完全不透明樹脂',
  );
  assert.match(
    source,
    /x2:\s*fluidBounds\.width\s*\*\s*1\.08/,
    '酒體漸層必須覆蓋整列文字，不得在前 26% 就 clamp 成單一深色',
  );
  assert.match(
    source,
    /resolveMessageLiquidCanvasStyle/,
    'meniscus 與氣泡線寬必須由可直接測試的 responsive style resolver 提供',
  );
  assert.match(
    source,
    /setAttribute\(\s*['"]clip-path['"][\s\S]*?url\(#/,
    '折射、焦散與局部液面反應必須再受酒體路徑裁切，不能出現在液面上方',
  );
  assert.match(
    source,
    /optics\.append\([\s\S]*?bubbleBodies[\s\S]*?bubbleHighlights[\s\S]*?\)/,
    '氣泡必須位於同一個 fluid clip 內，不能浮到當幀液面之外',
  );
  assert.match(
    source,
    /(?:setAttribute\(\s*['"]mask['"]|\.mask\s*=)[\s\S]*?url\(#/,
    '所有帶酒色的 SVG path 必須先放進字形 alpha mask',
  );
  assert.match(source, /(?:maskId|maskIdentifier|liquidMaskId)/);
  assert.match(
    source,
    /(?:\+\+|randomUUID\(|crypto\.getRandomValues\()/,
    '每個訊息與跑馬燈副本必須取得不同 mask id，避免互相引用',
  );
});

test('4K 動態酒液使用單一 Canvas 與只 rasterize 一次的字形 alpha mask', async () => {
  const [source, css] = await Promise.all([
    readDisplayFile('message-liquid-svg.mjs'),
    readDisplayFile('display.css'),
  ]);

  assert.match(source, /createElement\(\s*['"]canvas['"]\s*\)/);
  assert.match(source, /getContext\(\s*['"]2d['"]/);
  assert.match(source, /function\s+rasterizeGlyphMask\s*\(/);
  assert.match(source, /new\s+PathConstructor\(frame\.bodyPath\)/);
  assert.match(
    source,
    /globalCompositeOperation\s*=\s*['"]destination-in['"][\s\S]*?drawImage\(glyphMask\.canvas/,
    '最後必須以 cached glyph alpha 裁切整幅酒液',
  );
  assert.match(
    source,
    /function\s+sync\(\)[\s\S]*?rasterizeGlyphMask\s*\(/,
    '字形 alpha 只能在排版 sync 時建立',
  );
  const renderBody = /function\s+render\([^)]*\)\s*{([\s\S]*?)\n\s*function\s+reset\(/
    .exec(source)?.[1] ?? '';
  assert.doesNotMatch(
    renderBody,
    /rasterizeGlyphMask|createDetachedMaskCanvas/,
    '每幀不得重新 rasterize 字形',
  );
  assert.match(
    css,
    /\.message-liquid-paint\s*{[^}]*display:\s*none\s*!important/s,
    '舊動態 SVG mask 必須停止 paint，否則 4K 仍會重複 raster',
  );
  assert.match(
    css,
    /\[data-liquid-effect="active"\]\s+\.message-liquid-canvas\s*{[^}]*display:\s*block/s,
  );
});

test('Renderer 逐幀套用可定位純模型的圓滑路徑，不使用 CSS polygon 動畫', async () => {
  const [source, css] = await Promise.all([
    readDisplayModuleSources(),
    readDisplayFile('display.css'),
  ]);

  assert.match(source, /from\s+['"]\.\/liquid-surface-model\.mjs['"]/);
  assert.match(source, /createLiquidSurfaceFrame\s*\(/);
  assert.match(source, /bodyPath/);
  assert.match(source, /meniscusPath/);
  assert.match(source, /refractionOffset/);
  assert.match(source, /setAttribute\(\s*['"]gradientTransform['"]/);
  assert.match(source, /setAttribute\(\s*['"]d['"]/);
  assert.match(source, /requestAnimationFrame\s*\(/);
  assert.match(source, /cancelAnimationFrame\s*\(/);
  assert.doesNotMatch(
    css,
    /\.message-glyph-(?:liquid|ripple)[\s\S]*?clip-path:\s*polygon\(/,
  );
  assert.doesNotMatch(css, /@keyframes\s+message-liquid-(?:slosh|ripple)/);
  assert.doesNotMatch(
    css,
    /animation-name:\s*message-liquid-(?:slosh|ripple)/,
  );
  assert.doesNotMatch(
    source,
    /\['sizing',\s*'liquid',\s*'ripple',\s*'shell'\]/,
    '不得保留四層文字配上規律 CSS polygon 的舊架構',
  );
  assert.doesNotMatch(
    source,
    /createElementNS\([^\n]*['"](?:feTurbulence|feDisplacementMap)['"]|createSvgElement\([^\n]*['"](?:feTurbulence|feDisplacementMap)['"]|<fe(?:Turbulence|DisplacementMap)/i,
    '固定 SVG turbulence 既不跟隨流場，又會造成首輪 4K shader/raster 卡頓；折射必須由同一物理 flow state 驅動',
  );
});

test('首頁在 Main ready 前以實際 SVG 預熱合成管線，不把 4K 冷啟動卡頓留給使用者', async () => {
  const [svgSource, appSource] = await Promise.all([
    readDisplayFile('message-liquid-svg.mjs'),
    readDisplayFile('app.mjs'),
  ]);

  assert.match(svgSource, /export\s+async\s+function\s+warmMessageLiquidPipeline/);
  assert.match(svgSource, /setWarmupOpacity/);
  assert.match(svgSource, /progress:\s*0[\s\S]*?timeMilliseconds:\s*0/);
  assert.match(
    appSource,
    /await\s+warmMessageLiquidPipeline\([\s\S]*?pageProgressReporter\.ready\(/,
    '必須先完成不可見預熱並恢復空杯，才允許 Main 開始計時',
  );
});

test('SVG 與白框共用同一文字幾何，且 SVG 邊界與酒色像素都不能溢出容器', async () => {
  const [source, css] = await Promise.all([
    readDisplayModuleSources(),
    readDisplayFile('display.css'),
  ]);

  assert.ok(
    [...source.matchAll(/cloneNode\(\s*true\s*\)/g)].length >= 2,
    'mask 與純白 outline 必須各自 clone 同一 canonical SVG glyph',
  );
  assert.match(source, /createRange\s*\(/);
  assert.match(source, /getBoundingClientRect\s*\(/);
  assert.match(source, /measureText\s*\(/);
  assert.match(source, /actualBoundingBoxAscent/);
  assert.match(source, /actualBoundingBoxDescent/);
  assert.doesNotMatch(
    source,
    /canonicalGlyph\.getBBox\s*\(/,
    'Chromium SVG text getBBox 會回傳超出可見區的字型盒，不可拿來當液位容器',
  );
  assert.match(
    source,
    /fluidBounds\.(?:x|y|width|height)/,
    '液面模型與幾何偏移必須共用同一份實際字形邊界',
  );
  assert.match(
    source,
    /paths\.meniscusDepth\.setAttribute\(\s*['"]d['"]\s*,\s*frame\.meniscusPath\s*\)/,
    '液面厚度與細亮芯必須沿用同一條物理曲線，不能另播規律動畫',
  );
  assert.match(source, /setAttribute\(\s*['"]viewBox['"]/);
  assert.match(source, /message-liquid-glyph-run/);
  assert.match(source, /message-liquid-glyph-number/);
  assert.match(
    source,
    /\.style\.setProperty\(\s*['"]text-shadow['"],\s*['"]none['"]\s*\)/,
    'alpha mask 的 native SVG text 不得繼承訊息列陰影',
  );
  assert.match(
    source,
    /\.style\.setProperty\(\s*['"]filter['"],\s*['"]none['"]\s*\)/,
  );
  assert.match(
    source,
    /\.style\.setProperty\(\s*['"]opacity['"],\s*['"]1['"]\s*\)/,
  );
  const svgRule = /\.message-liquid-svg\s*{([^}]*)}/s.exec(css)?.[1] ?? '';
  assert.match(svgRule, /position:\s*absolute/);
  assert.match(svgRule, /inset:\s*0/);
  assert.match(svgRule, /inline-size:\s*100%/);
  assert.match(svgRule, /block-size:\s*100%/);
  assert.match(svgRule, /overflow:\s*hidden/);
  assert.match(svgRule, /pointer-events:\s*none/);
  assert.match(
    css,
    /\.message-glyph-shell\s*{[^}]*-webkit-text-stroke-color:\s*#ffffff/s,
  );
  assert.match(
    css,
    /\[data-liquid-effect="active"\]\s+\.message-glyph-shell\s*{[^}]*visibility:\s*hidden/s,
    'active 狀態只能顯示 canonical SVG outline，HTML shell 必須隱藏',
  );
  assert.match(
    css,
    /\.message-liquid-outline-glyph\s*{[^}]*stroke:\s*#ffffff/s,
  );
  assert.doesNotMatch(css, /\.message-vessel::(?:before|after)/);
  assert.doesNotMatch(source, /message-pour-(?:stream|impact)/);
  assert.doesNotMatch(
    source,
    /message-(?:pour-stream|liquid-drop|liquid-splash|liquid-particle)/,
    '不可藉由字外／字內酒柱、酒滴、飛濺或粒子假裝倒酒',
  );
});

test('一般訊息白框加粗，但不改動置中營運訊息與其他顯示模式', async () => {
  const [source, css] = await Promise.all([
    readDisplayFile('message-liquid-svg.mjs'),
    readDisplayFile('display.css'),
  ]);

  assert.match(
    source,
    /const MESSAGE_OUTLINE_STROKE_FONT_RATIO\s*=\s*0\.022;/,
    '倒酒容器的純白 SVG 外框應由 1.4% 加粗至 2.2%',
  );
  assert.match(
    source,
    /const MINIMUM_MESSAGE_OUTLINE_STROKE_WIDTH\s*=\s*1;/,
    '低解析度也必須保留至少一個邏輯像素的清楚白框',
  );
  assert.match(
    source,
    /fontSize\s*\*\s*MESSAGE_OUTLINE_STROKE_FONT_RATIO/,
    'SVG 外框必須隨一般訊息字體等比例縮放',
  );
  assert.match(
    css,
    /\.message-row\[data-alignment="left"\]\s+\.message-glyph-shell\s*{[^}]*-webkit-text-stroke-width:\s*0\.04em/s,
    '只有靠左的一般訊息靜態白框應加粗，效果關閉與安全降級時仍清楚',
  );
  assert.match(
    css,
    /\.message-glyph-shell\s*{[^}]*-webkit-text-stroke-width:\s*0\.03em/s,
    '置中營運訊息應維持原本粗細，避免本次局部調整擴散',
  );
});

test('降低動態或 SVG 建立失敗時退回固定白字，不啟動背景流體迴圈', async () => {
  const [source, css] = await Promise.all([
    readDisplayModuleSources(),
    readDisplayFile('display.css'),
  ]);

  assert.match(source, /matchMedia\(\s*['"]\(prefers-reduced-motion:\s*reduce\)['"]\s*\)/);
  assert.match(source, /dataset\.liquidEffect\s*=\s*['"]static['"]/);
  assert.match(source, /try\s*{[\s\S]*?createMessageLiquid/s);
  assert.match(source, /catch\s*\([^)]*\)\s*{[\s\S]*?liquidEffect/s);
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*{[\s\S]*?\.message-liquid-svg\s*{[^}]*display:\s*none/s,
  );
  assert.match(
    css,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.message-glyph-shell\s*{[^}]*-webkit-text-fill-color:\s*#ffffff/s,
  );
});

test('新流體架構仍受每頁三列與跑馬燈單行規則約束', async () => {
  const [validators, css, source] = await Promise.all([
    readFile(path.join(projectRoot, 'ipc', 'validators.js'), 'utf8'),
    readDisplayFile('display.css'),
    readDisplayModuleSources(),
  ]);

  assert.match(validators, /const MESSAGES_PER_PAGE\s*=\s*3;/);
  assert.match(
    css,
    /\.page-layer\[data-layout="messages"\]\s*{[^}]*grid-template-rows:\s*repeat\(3,/s,
  );
  assert.match(css, /\.message-row\s*{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.marquee-copy\s*{[^}]*white-space:\s*nowrap/s);
  assert.match(source, /for \(let index = 0; index < 2; index \+= 1\)/);
  assert.match(source, /createMessageVessel\(message,\s*['"]marquee-message['"]\)/);
});
