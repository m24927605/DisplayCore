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
  assert.match(html, /id="display-announcement"[^>]+role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /aria-atomic="true"/);
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
  assert.match(css, /\.message-row\s*{[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.fill-layer\s*{[^}]*display:\s*grid/s);
  assert.match(css, /\.is-marquee\s+\.marquee-track\s*{[^}]*will-change:\s*transform/s);
  assert.match(css, /font-smoothing:\s*antialiased/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.doesNotMatch(css, /text-overflow:\s*ellipsis/);
  assert.doesNotMatch(css, /transition(?:-property)?:\s*all\b/);
  assert.doesNotMatch(css, /will-change:\s*all\b/);
});

test('Display app 僅使用唯讀 bridge 與 textContent，且不解析緊急代碼語意', async () => {
  const source = await readDisplayFile('app.mjs');

  assert.match(source, /window\.displayCoreDisplay/);
  assert.match(source, /createDisplayController/);
  assert.match(source, /findLargestFittingFontSize/);
  assert.match(source, /\.textContent\s*=/);
  assert.match(source, /new ResizeObserver/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /document\.fonts\.ready/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /\brequire\s*\(|\bprocess\.|\bipcRenderer\b/);
  assert.doesNotMatch(source, /555|888/);
  assert.doesNotMatch(source, /showEmergency|startProgram|clearPresentation/);
});
