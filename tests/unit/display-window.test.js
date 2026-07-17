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
  assert.doesNotMatch(html, /id="standby-layer"|id="standby-message"|歡迎光臨/);
  assert.match(html, /id="display-chrome"[^>]+aria-hidden="true"/);
  assert.match(
    html,
    /<img[^>]+id="display-logo"[^>]+alt=""[^>]+aria-hidden="true"/,
  );
  assert.match(html, /<time[^>]+id="display-clock"[^>]+aria-hidden="true"/);
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
  assert.match(css, /\.display-render-surface\s*{[^}]*container-type:\s*size/s);
  assert.match(css, /\.display-render-surface\s*{[^}]*transform:/s);
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
  assert.match(css, /\.display-clock\s*{[^}]*position:\s*absolute[^}]*inset-inline-end:/s);
  assert.match(css, /\.display-clock\s*{[^}]*inset-block-end:/s);
  assert.match(
    css,
    /\.display-stage\[data-mode="blank"\]\s+\.normal-layer\s*{[^}]*place-content:\s*center/s,
  );
  assert.match(
    css,
    /\.display-stage\[data-mode="blank"\]\s+\.display-clock\s*{[^}]*position:\s*static[^}]*text-align:\s*center/s,
  );
  assert.match(
    css,
    /\.display-stage\[data-mode="blank"\]\s+\.logo-frame\s*{[^}]*justify-self:\s*center/s,
  );
  assert.doesNotMatch(css, /\.standby-message\s*{/);
  assert.match(
    css,
    /\.display-stage\[data-mode="blank"\]\s+\.display-clock\s*{[^}]*calc\(14cqmin \* var\(--message-font-scale\)\)[^}]*font-weight:\s*800/s,
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
  assert.match(css, /--display-font-family/);
  assert.match(css, /--message-line-spacing-scale/);
  assert.match(css, /--emergency-background/);
  assert.match(css, /--viewport-background/);
  assert.match(css, /body\s*{[^}]*background:\s*var\(--viewport-background\)/s);
  assert.match(css, /\.is-marquee\s+\.marquee-track\s*{[^}]*will-change:\s*transform/s);
  assert.match(css, /font-smoothing:\s*antialiased/);
  assert.doesNotMatch(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
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
  assert.match(source, /resolveRenderResolution/);
  assert.match(source, /createPageProgressReporter/);
  assert.match(source, /createStandbyBackgroundPlayer/);
  assert.match(source, /createSandTransition/);
  assert.match(source, /SAFE_DISPLAY_SETTINGS/);
  assert.match(source, /findLargestFittingFontSize/);
  assert.match(source, /classifyLogoAlpha/);
  assert.match(source, /\.textContent\s*=/);
  assert.match(source, /new ResizeObserver/);
  assert.match(source, /renderResolution/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /document\.fonts\.ready/);
  assert.match(source, /bridge\.getSettings\(\)/);
  assert.match(source, /bridge\.onSettingsChanged\(listener\)/);
  assert.match(source, /bridge\.reportPageProgress\(\.\.\.args\)/);
  assert.match(source, /bridge\.onRefitRequested\(handleRefitRequested\)/);
  assert.match(source, /sessionStorage\.getItem/);
  assert.match(source, /sessionStorage\.setItem/);
  assert.doesNotMatch(source, /prefers-reduced-motion/);
  assert.match(source, /\.setProperty\(\s*'--display-background'/);
  assert.match(source, /\.setProperty\(\s*'--display-font-family'/);
  assert.match(source, /row\.dataset\.alignment\s*=\s*alignment/);
  assert.match(source, /snapshot\.emergencyTone/);
  assert.match(source, /'--message-line-spacing-scale'/);
  assert.match(source, /'--message-font-scale'/);
  assert.match(source, /calculateLogoLayoutScales\(snapshot\.logo\.sizePercent\)/);
  assert.match(source, /'--logo-size-scale'/);
  assert.match(source, /'--logo-page-size-scale'/);
  assert.match(source, /'--logo-standby-size-scale'/);
  assert.match(source, /'--emergency-background'/);
  assert.match(source, /'--viewport-background'/);
  assert.match(source, /standby\.backgroundImageUrls/);
  assert.match(source, /standby\.backgroundMode/);
  assert.match(source, /standby\.slideDurationSeconds/);
  assert.match(source, /standbyBackgroundImages/);
  assert.match(source, /activeStandbyBackgroundImage/);
  assert.match(source, /pendingStandbyBackgroundImage/);
  assert.match(source, /standbyBackgroundPlayer\.handleLoad/);
  assert.match(source, /standbyBackgroundPlayer\.handleError/);
  assert.match(source, /standbyBackgroundPlayer\.dispose/);
  assert.match(source, /sandTransition\.start/);
  assert.match(source, /sandTransition\.cancel/);
  assert.match(source, /sandTransition\.dispose/);
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
  assert.doesNotMatch(source, /standbyLayer|歡迎光臨/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /\brequire\s*\(|\bprocess\.|\bipcRenderer\b/);
  assert.doesNotMatch(source, /555|888/);
  assert.doesNotMatch(source, /showEmergency|startProgram|clearPresentation/);
});
