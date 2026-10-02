'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

async function readDisplayFile(fileName) {
  return readFile(path.join(projectRoot, 'display', fileName), 'utf8');
}

test('Display HTML 只有唯讀顯示舞台、互斥視覺層與單一語意狀態來源', async () => {
  const html = await readDisplayFile('index.html');

  assert.match(html, /<main[^>]+id="display-stage"/);
  assert.match(html, /id="display-render-surface"/);
  assert.match(html, /id="display-announcement"[^>]+role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-atomic="true"/);
  assert.match(html, /id="normal-layer"[^>]+aria-hidden="true"/);
  assert.match(
    html,
    /id="standby-background-layer"[^>]+aria-hidden="true"[^>]+hidden/,
  );
  assert.match(
    html,
    /<img[^>]+id="standby-background-image"[^>]+alt=""[^>]+aria-hidden="true"[^>]+hidden/,
  );
  assert.match(
    html,
    /<img[^>]+id="standby-background-image-buffer"[^>]+alt=""[^>]+aria-hidden="true"[^>]+hidden/,
  );
  assert.match(
    html,
    /<canvas[^>]+id="standby-sand-transition"[^>]+aria-hidden="true"[^>]+hidden/,
  );
  assert.match(
    html,
    /<canvas[^>]+id="standby-sand-particles"[^>]+aria-hidden="true"[^>]+hidden/,
  );
  assert.doesNotMatch(html, /id="standby-layer"|id="standby-message"|歡迎光臨/);
  assert.match(html, /id="display-chrome"[^>]+aria-hidden="true"/);
  assert.match(
    html,
    /<img[^>]+id="display-logo"[^>]+alt=""[^>]+aria-hidden="true"/,
  );
  assert.match(html, /<time[^>]+id="display-clock"[^>]+aria-hidden="true"/);
  assert.match(
    html,
    /<header[^>]+id="display-chrome"[\s\S]*?<time[^>]+id="display-clock"[\s\S]*?<\/header>/,
    '一般訊息的時間必須與 Logo 共用同一個頂部 chrome',
  );
  assert.match(html, /id="page-layer"[^>]+aria-hidden="true"/);
  assert.match(html, /id="fill-layer"[^>]+aria-hidden="true"/);
  assert.match(
    html,
    /<script[^>]+type="module"[^>]+src="\.\/app\.mjs"[^>]*><\/script>/,
  );
  assert.doesNotMatch(html, />\s*DisplayCore\s*</);
  assert.doesNotMatch(
    html,
    /<(?:button|input|select|textarea|a|video|audio)\b/i,
  );
  assert.doesNotMatch(html, /\b(?:tabindex|contenteditable)\s*=/i);
  assert.match(html, /img-src 'self'/);
  assert.doesNotMatch(html, /img-src[^;]*(?:data:|file:|blob:|\*)/);
});

test('Display CSS 使用 viewport 比例、安全區、單行與滿屏 grid，不截斷文字', async () => {
  const css = await readDisplayFile('display.css');

  assert.match(css, /overflow:\s*hidden/);
  assert.match(css, /pointer-events:\s*none/);
  assert.match(css, /user-select:\s*none/);
  assert.match(css, /cursor:\s*none/);
  assert.match(css, /touch-action:\s*none/);
  assert.match(css, /clamp\(/);
  assert.match(css, /(?:vw|vh|vmin|rem|%)/);
  assert.match(css, /\.page-layer\s*{[^}]*display:\s*grid/s);
  assert.match(
    css,
    /\.message-glyph-shell\s*{[^}]*-webkit-text-fill-color:\s*#ffffff[^}]*-webkit-text-stroke-color:\s*#ffffff[^}]*-webkit-text-stroke-width:\s*0\.03em/s,
    '無期限訊息維持白色實心字與純白外框',
  );
  assert.match(
    css,
    /\[data-liquid-effect="active"\][\s\S]*?\.message-glyph-shell\s*{[^}]*-webkit-text-fill-color:\s*transparent[^}]*-webkit-text-stroke-color:\s*#ffffff/s,
    '有限一般訊息必須是透明字腔與固定純白外框',
  );
  assert.match(
    css,
    /\.message-liquid-svg\s*{[^}]*display:\s*none/s,
    '未啟用或降級時不得留下任何酒色像素',
  );
  assert.doesNotMatch(
    css,
    /\[data-liquid-effect="active"\][^}]*\.message-vessel::(?:before|after)/s,
    '不得再於字體外建立酒柱或撞擊飛濺',
  );
  assert.doesNotMatch(
    css,
    /\.message-(?:glyph|liquid)[^{]*{[^}]*clip-path:\s*polygon\(/s,
  );
  assert.doesNotMatch(css, /@keyframes\s+message-liquid-(?:slosh|ripple)/);
  assert.doesNotMatch(
    css,
    /animation-name:\s*message-liquid-(?:slosh|ripple)/,
  );
  assert.doesNotMatch(css, /message-pour-(?:stream|impact)/);
  assert.match(
    css,
    /\.marquee-track\s*{[^}]*animation-play-state:\s*paused/s,
    '跑馬燈必須等待 Main 接受 ready，不能比酒液時軸提早開始',
  );
  assert.doesNotMatch(css, /(?:transition|will-change):\s*all/);
  assert.doesNotMatch(
    css,
    /\.message-vessel::(?:before|after)/,
    '字體容器外不得存在任何酒柱或飛濺 pseudo-element',
  );
  assert.doesNotMatch(css, /--message-outline-color/);
  assert.match(css, /\.display-render-surface\s*{[^}]*container-type:\s*size/s);
  // Display 依實際視窗排版；輸出解析度由 Main 切換 Windows 顯示模式。
  assert.doesNotMatch(css, /\.display-render-surface\s*{[^}]*transform:/s);
  assert.match(css, /(?:cqw|cqh|cqmin)/);
  assert.match(css, /\.normal-layer\s*{[^}]*position:\s*relative/s);
  assert.match(
    css,
    /\.standby-background-layer\s*{[^}]*position:\s*absolute[^}]*inset:\s*0/s,
  );
  assert.match(
    css,
    /\.standby-background-image\s*{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*inline-size:\s*100%[^}]*block-size:\s*100%[^}]*object-fit:\s*cover/s,
  );
  assert.match(
    css,
    /\.standby-sand-transition\s*{[^}]*position:\s*absolute[^}]*inset:\s*0[^}]*inline-size:\s*100%[^}]*block-size:\s*100%/s,
  );
  assert.doesNotMatch(
    css,
    /\.standby-sand-particles\s*{[^}]*filter:[^}]*blur\(/s,
    '圖片沙粒不得再套模糊濾鏡而退化成灰霧',
  );
  assert.match(
    css,
    /\.standby-sand-particles\s*{[^}]*z-index:\s*4[^}]*opacity:\s*0\.8/s,
    'Canvas 2D 圖片細砂可越過背景壓暗層，但仍需限制整層透明度',
  );
  assert.match(
    css,
    /\[data-sand-renderer="webgl"\][\s\S]*?\.standby-sand-particles\s*{[^}]*z-index:\s*4[^}]*opacity:\s*1/s,
    'WebGL 砂粒已由 shader 控制透明度，必須完整顯示於待機遮罩上方',
  );
  assert.match(css, /\.display-logo\s*{[^}]*object-fit:\s*contain/s);
  assert.match(css, /--logo-size-scale:\s*1/);
  assert.match(css, /--logo-page-size-scale:\s*1/);
  assert.match(css, /--logo-standby-size-scale:\s*1/);
  assert.match(
    css,
    /--logo-mode-size-scale:\s*var\(--logo-page-size-scale\)/,
  );
  assert.match(css, /--logo-max-inline:\s*92cqw/);
  assert.match(css, /--logo-page-max-block:\s*30cqh/);
  assert.match(css, /--logo-standby-max-block:\s*42cqh/);
  assert.match(
    css,
    /\.logo-frame\s*{[^}]*block-size:\s*min\([^;]*var\(--logo-mode-size-scale\)[^;]*var\(--logo-mode-max-block\)[^}]*max-inline-size:\s*var\(--logo-max-inline\)/s,
  );
  assert.match(
    css,
    /\.display-logo\s*{[^}]*block-size:\s*100%[^}]*max-inline-size:\s*100%[^}]*max-block-size:\s*100%/s,
  );
  assert.match(
    css,
    /\.display-stage\[data-mode="blank"\]\s+\.logo-frame\s*{[^}]*--logo-mode-max-block:\s*var\(--logo-standby-max-block\)/s,
  );
  assert.match(
    css,
    /\.logo-frame\[data-logo-treatment="bright-white"\]\s+\.display-logo\s*{[^}]*filter:\s*brightness\(0\)\s*invert\(1\)\s*drop-shadow\([^;]*rgb\(255 255 255 \/ 45%\)[^;]*\)\s*drop-shadow\([^;]*rgb\(0 0 0 \/ 70%\)[^;]*\)/s,
  );
  assert.match(
    css,
    /\.logo-frame\[data-logo-treatment="light-plate"\]\s*{[^}]*background:\s*rgb\(255 255 255 \/ 96%\)[^}]*padding:/s,
  );
  assert.match(
    css,
    /\.logo-frame\[data-logo-treatment="light-plate"\]\s+\.display-logo\s*{[^}]*filter:\s*drop-shadow\([^;]*rgb\(0 0 0 \/ 35%\)[^;]*\)/s,
  );
  assert.match(css, /\.display-clock\s*{[^}]*font-variant-numeric:\s*tabular-nums/s);
  assert.match(
    css,
    /\.display-chrome\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto[^}]*align-items:\s*center/s,
  );
  assert.match(
    css,
    /\.display-clock\s*{[^}]*position:\s*static[^}]*grid-column:\s*2[^}]*justify-self:\s*end/s,
  );
  assert.match(
    css,
    /\.display-clock\s*{[^}]*calc\(8cqmin \* var\(--message-font-scale\)\)/s,
  );
  assert.doesNotMatch(css, /\.display-clock\s*{[^}]*inset-block-end:/s);
  assert.match(
    css,
    /\.normal-layer:not\(\.has-chrome\)\s*{[^}]*grid-template-rows:\s*minmax\(0,\s*1fr\)/s,
  );
  assert.match(
    css,
    /\.display-stage\[data-mode="blank"\]\s+\.normal-layer\s*{[^}]*place-content:\s*center/s,
  );
  assert.match(
    css,
    /\.display-stage\[data-mode="blank"\]\s+\.display-clock\s*{[^}]*grid-column:\s*1[^}]*text-align:\s*center/s,
  );
  assert.match(
    css,
    /\.display-stage\[data-mode="blank"\]\s+\.logo-frame\s*{[^}]*justify-self:\s*center/s,
  );
  assert.doesNotMatch(css, /\.standby-message\s*{/);
  assert.match(
    css,
    /\.display-stage\[data-mode="blank"\]\s+\.display-clock\s*{[^}]*calc\(14cqmin \* var\(--standby-clock-size-scale\)\)[^}]*font-weight:\s*600/s,
  );
  assert.match(
    css,
    /\.page-layer\[data-layout="messages"\]\s*{[^}]*grid-template-rows:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s,
  );
  assert.match(css, /\.message-row\s*{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.message-row\s*{[^}]*align-items:\s*flex-start[^}]*justify-content:\s*flex-start[^}]*text-align:\s*left/s);
  assert.match(
    css,
    /\.message-row\[data-alignment="center"\]\s*{[^}]*align-items:\s*center[^}]*justify-content:\s*center/s,
  );
  assert.match(css, /\.fill-layer\s*{[^}]*display:\s*grid/s);
  assert.match(css, /\.fill-layer\s*{[^}]*position:\s*absolute[^}]*inset:\s*0/s);
  assert.match(
    css,
    /\.fill-layer\s*{[^}]*grid-template-columns:\s*repeat\(3,[^}]*grid-template-rows:\s*repeat\(3,/s,
  );
  assert.match(css, /\.fill-cell\s*{[^}]*place-items:\s*center/s);
  assert.match(css, /\.message-row\s*{[^}]*font-weight:\s*600/s);
  assert.match(css, /--display-font-family/);
  assert.match(css, /--message-line-spacing-scale/);
  assert.match(css, /--standby-clock-size-scale/);
  assert.match(css, /--emergency-background/);
  // 畫布永遠填滿視窗，不再有需要配色的邊帶。
  assert.doesNotMatch(css, /--viewport-background/);
  assert.match(css, /\.is-marquee\s+\.marquee-track\s*{[^}]*will-change:\s*transform/s);
  assert.match(css, /font-smoothing:\s*antialiased/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(css, /transition(?:-property)?:\s*all\b/);
  assert.doesNotMatch(css, /will-change:\s*all\b/);
});

test('Display app 僅使用最小權限 bridge 與 textContent，且不解析緊急代碼語意', async () => {
  const source = await readDisplayFile('app.mjs');

  assert.match(source, /window\.displayCoreDisplay/);
  assert.match(source, /createDisplayController/);
  assert.match(source, /createDisplaySettingsController/);
  assert.match(source, /createDisplayClock/);
  assert.match(source, /createMessageLiquidAnimator/);
  assert.match(source, /createPageProgressReporter/);
  assert.match(source, /createStandbyBackgroundPlayer/);
  assert.match(source, /createSandTransition/);
  assert.match(source, /SAFE_DISPLAY_SETTINGS/);
  assert.match(source, /findLargestFittingFontSize/);
  assert.match(source, /classifyLogoAlpha/);
  assert.match(source, /\.textContent\s*=/);
  assert.match(source, /new ResizeObserver/);
  assert.doesNotMatch(source, /renderResolution/);
  assert.match(source, /bridge\.getOutputAdjustment\(\)/);
  assert.match(source, /bridge\.onOutputAdjustmentChanged\(/);
  assert.match(source, /brightness\(\$\{brightnessPercent \/ 100\}\)/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /document\.fonts\.ready/);
  assert.match(source, /bridge\.getSettings\(\)/);
  assert.match(source, /bridge\.onSettingsChanged\(listener\)/);
  assert.match(source, /bridge\.reportPageProgress\(\.\.\.args\)/);
  assert.match(source, /bridge\.onRefitRequested\(handleRefitRequested\)/);
  assert.match(source, /sessionStorage\.getItem/);
  assert.match(source, /sessionStorage\.setItem/);
  assert.match(source, /\.setProperty\(\s*'--display-background'/);
  assert.match(source, /\.setProperty\(\s*'--display-font-family'/);
  assert.match(source, /row\.dataset\.alignment\s*=\s*alignment/);
  assert.match(source, /classList\.toggle\('has-chrome',\s*showLogo\s*\|\|\s*showClock\)/);
  assert.match(source, /elements\.chrome\.hidden\s*=\s*!\(showLogo\s*\|\|\s*showClock\)/);
  assert.match(source, /snapshot\.emergencyTone/);
  assert.match(source, /EMERGENCY_GRID_CELL_COUNT\s*=\s*9/);
  assert.match(
    source,
    /EMERGENCY_GLYPHS[\s\S]*inspection:\s*'5'[\s\S]*release:\s*'8'/,
  );
  assert.match(source, /cell\.textContent\s*=\s*glyph/);
  assert.match(source, /'--message-line-spacing-scale'/);
  assert.match(source, /'--message-font-scale'/);
  assert.match(source, /calculateLogoLayoutScales\(snapshot\.logo\.sizePercent\)/);
  assert.match(source, /'--logo-size-scale'/);
  assert.match(source, /'--logo-page-size-scale'/);
  assert.match(source, /'--logo-standby-size-scale'/);
  assert.match(source, /'--emergency-background'/);
  assert.doesNotMatch(source, /'--viewport-background'/);
  assert.match(source, /standby\.backgroundImageUrls/);
  assert.match(source, /standby\.backgroundMode/);
  assert.match(source, /standby\.slideDurationSeconds/);
  assert.match(source, /standbyBackgroundImages/);
  assert.match(source, /activeStandbyBackgroundImage/);
  assert.match(source, /pendingStandbyBackgroundImage/);
  assert.match(source, /standbyBackgroundPlayer\.handleLoad/);
  assert.match(source, /standbyBackgroundPlayer\.handleError/);
  assert.match(source, /standbyBackgroundPlayer\.dispose/);
  assert.match(
    source,
    /function renderBlank\([^)]*\)\s*{[\s\S]*?clearStandbyBackgroundImages\(\)/,
  );
  assert.match(
    source,
    /if \(snapshot\.mode === 'blank'\)\s*{\s*renderBlank\(snapshot\);[\s\S]*?syncStandbyBackgroundPlayer\(\);\s*return;/,
  );
  assert.match(source, /sandTransition\.start/);
  assert.match(source, /sandTransition\.prepare/);
  assert.match(source, /sandTransition\.discardPrepared/);
  assert.match(source, /sandTransition\.cancel/);
  assert.match(source, /sandTransition\.dispose/);
  assert.match(source, /requestIdleCallback/);
  assert.match(
    source,
    /backgroundMode\s*!==\s*'slideshow'[\s\S]*?backgroundImageUrls\.length\s*<\s*2/,
    '固定或單張背景不得配置永遠不會使用的轉場記憶體',
  );
  assert.match(
    source,
    /backgroundMode\s*!==\s*'slideshow'[\s\S]*?backgroundImageUrls\.length\s*<\s*2[\s\S]*?sandTransition\.discardPrepared\(\)[\s\S]*?clearStandbySandCanvas\(\{\s*releaseBuffers:\s*true\s*\}\)/,
    '輪播切回固定或只剩單張圖片時必須立即釋放預建幾何與 Canvas buffers',
  );
  assert.match(source, /globalCompositeOperation\s*=\s*'destination-out'/);
  assert.match(
    source,
    /globalCompositeOperation\s*=\s*'destination-out'[\s\S]*?imageSmoothingEnabled\s*=\s*false[\s\S]*?drawImage\(\s*sandMaskCanvas/,
    '侵蝕遮罩放大時必須關閉平滑，避免新舊圖片形成 crossfade 灰幕',
  );
  assert.match(source, /updateSandMaskCanvas\(frame\.erosionMask\)/);
  assert.match(source, /sandMaskContext\.putImageData/);
  assert.match(source, /sandParticleContext/);
  assert.match(source, /sandParticleSourceContext\.getImageData/);
  assert.match(
    source,
    /sandParticleSourceCanvas\.getContext\('2d',\s*{[\s\S]*?alpha:\s*true[\s\S]*?willReadFrequently:\s*true/,
    '來源 Canvas 必須保留透明 PNG 的 alpha，避免透明區被轉成黑砂',
  );
  assert.match(source, /sandParticleContext\.putImageData/);
  assert.match(
    source,
    /const particleScale = Math\.min\(\s*1,\s*Math\.sqrt\(1_500_000 \/ \(width \* height\)\)/,
    '圖片沙粒緩衝需保留足夠解析度，避免放大成紙屑方塊',
  );
  assert.match(source, /frame\.erosionMask\.dirtyBounds/);
  assert.doesNotMatch(
    source,
    /sandContext\.clearRect\(\s*0,\s*0,\s*frame\.width,\s*frame\.height/,
  );
  assert.doesNotMatch(source, /\.arc\(/);
  assert.match(
    source,
    /function rasterizeSandGrain\(\s*destination,\s*sourceIndex,[\s\S]*?blendSandPixel\([\s\S]*?sourceIndex/,
  );
  assert.doesNotMatch(
    source,
    /rasterizeSandGrain\(\s*\{/,
    '每幀數萬次沙粒 raster 呼叫不得建立短命 options object',
  );
  assert.match(
    source,
    /for \(const particle of frame\.particles\)[\s\S]*?wakeIndex[\s\S]*?rasterizeSandGrain\([\s\S]*?particle\.wakeLength[\s\S]*?rasterizeSandGrain\([\s\S]*?particle\.x/,
  );
  assert.match(
    source,
    /const wakeJitter[\s\S]*?Math\.pow\([\s\S]*?const wakeSourceIndex/,
    '子粒間距需帶確定性擾動並取鄰近來源像素，避免同色等距亮點像紙屑',
  );
  assert.match(
    source,
    /fragmentGrainIndex[\s\S]*?fragmentSourceIndex[\s\S]*?rasterizeSandGrain/,
    '剛剝落的原圖碎片必須拆成多顆鄰近來源色微粒，不得畫成單一大圓斑',
  );
  assert.doesNotMatch(source, /function drawSandFragment\(/);
  assert.doesNotMatch(source, /drawCoverTail|dissolveFrontX/);
  assert.match(source, /dataset\.sandProgress\s*=/);
  assert.match(source, /delete elements\.stage\.dataset\.sandProgress/);
  assert.match(source, /drawImage/);
  assert.match(source, /getImageData/);
  assert.match(source, /dataset\.logoTreatment/);
  assert.match(source, /image\.addEventListener\('load',\s*handleStandbyBackgroundLoad\)/);
  assert.match(source, /image\.addEventListener\('error',\s*handleStandbyBackgroundError\)/);
  assert.match(
    source,
    /function updateAnnouncement\([^)]*\)\s*{[\s\S]*?setAttribute\('aria-live', priority\);[\s\S]*?\.textContent\s*=\s*message;/,
  );
  assert.match(source, /updateAnnouncement\([^;]+,\s*'polite',?\s*\);/s);
  assert.match(source, /updateAnnouncement\('',\s*'off'\);/);
  assert.match(source, /updateAnnouncement\(message,\s*'assertive'\);/s);
  assert.match(source, /pageLayer\.dataset\.layout\s*=/);
  assert.match(
    source,
    /const liquidPrepared\s*=\s*currentSettings\.appearance\.messageLiquidEffectEnabled\s*&&\s*hasLiquidEligibleMessage\s*&&\s*messageLiquidAnimator\.prepare\(snapshot,\s*elements\.pageLayer\)/,
    '只有管理員啟用倒酒效果時，有限一般訊息才能建立 page layer 時間軸',
  );
  assert.match(
    source,
    /function applyDisplaySettings\(snapshot\)\s*{[\s\S]*?currentSettings\s*=\s*snapshot;[\s\S]*?if \(snapshot\.appearance\.messageLiquidEffectEnabled === false\)\s*{[\s\S]*?messageLiquidAnimator\.reset\(\);[\s\S]*?disableMessageLiquidEffect\(\);[\s\S]*?}[\s\S]*?scheduleFit\(\);\s*}/,
    '管理員停用效果時必須先立即取消 WAAPI/rAF、移除 SVG 並退回白字，再沿用單一次設定 refit',
  );
  assert.doesNotMatch(
    source,
    /\['sizing',\s*'liquid',\s*'ripple',\s*'shell'\]/,
    '不得保留以四層文字與 CSS polygon 假裝流體的舊結構',
  );
  assert.match(source, /message-liquid-svg/);
  assert.match(source, /message-glyph-shell/);
  assert.match(source, /row\.dataset\.liquidEffect\s*=/);
  assert.match(source, /messageLiquidAnimator\.retime\(/);
  assert.match(
    source,
    /row\.dataset\.liquidEffect\s*=\s*'static'/,
    '倒酒動畫無法建立或重新計時時必須退回白色實心字',
  );
  assert.match(
    source,
    /function startAcceptedPageEffects\(\{\s*revision,\s*layoutGeneration\s*\}\)[\s\S]*?startMessageLiquidEffect\(revision,\s*layoutGeneration\)[\s\S]*?track\.style\.animationPlayState\s*=\s*'running'/,
    '必須等 Main 接受 started 並建立 timer，再於同一 callback 啟動酒液與跑馬燈',
  );
  assert.doesNotMatch(
    source,
    /hasActiveLiquid\s*&&\s*!startMessageLiquidEffect\([^)]*\)\s*\)\s*\{\s*return false;/,
    '裝飾性酒液啟動失敗只能退回白字，不得阻止 finite 頁回報 started',
  );
  assert.match(source, /onPendingAccepted:\s*startAcceptedPageLayout/);
  assert.match(source, /onStartedAccepted:\s*startAcceptedPageEffects/);
  assert.match(
    source,
    /function startAcceptedPageLayout\(layoutToken\)[\s\S]*?holdPageEffectsForLayout\(currentPresentation\.revision\)[\s\S]*?requestAnimationFrame/,
    'Main 接受 pending 並取消舊 timer 後，才可凍結舊跑馬燈與酒液並重新排版',
  );
  assert.match(
    source,
    /const layoutToken = pageProgressReporter\?\.begin\([\s\S]*?if \(!layoutToken\)[\s\S]*?return;/,
  );
  assert.match(source, /messageLiquidAnimator\.reset\(\)/);
  assert.match(source, /messageLiquidAnimator\.dispose\(\)/);
  assert.match(
    source,
    /messageLiquidMotionPreference\?\.addEventListener\?\.\(\s*'change',\s*handleMessageLiquidMotionPreferenceChange/,
    'Display 必須監聽播放途中的 prefers-reduced-motion 變更',
  );
  assert.match(
    source,
    /beforeunload[\s\S]*?messageLiquidMotionPreference\?\.removeEventListener\?\.\(\s*'change',\s*handleMessageLiquidMotionPreferenceChange/,
    'Renderer 卸載時必須移除 prefers-reduced-motion listener',
  );
  assert.doesNotMatch(
    source,
    /(?:elements\.(?:stage|clock|logo|fillLayer)|cell)\.animate\(/,
    '時間、Logo、555／888 與整個 stage 不得套用液面倒數',
  );
  assert.doesNotMatch(source, /messageExpiryColor|message-outline-color/);
  assert.doesNotMatch(source, /standbyLayer|歡迎光臨/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /\brequire\s*\(|\bprocess\.|\bipcRenderer\b/);
  assert.doesNotMatch(source, /555|888/);
  assert.doesNotMatch(source, /showEmergency|startProgram|clearPresentation/);
});
