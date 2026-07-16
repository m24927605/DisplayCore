'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

test('Control 與 Display 占位頁只載入本機樣式並設定嚴格 CSP', async () => {
  for (const pageName of ['control', 'display']) {
    const html = await readFile(
      path.join(projectRoot, pageName, 'index.html'),
      'utf8',
    );

    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /default-src 'none'/);
    assert.match(html, /script-src 'self'/);
    assert.match(html, /connect-src 'none'/);
    assert.match(html, /style-src 'self'/);
    assert.doesNotMatch(html, /https?:\/\//i);
    assert.doesNotMatch(html, /<script[\s>]/i);
    assert.doesNotMatch(html, /<style[\s>]/i);
    assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  }
});

test('Display preload 只使用 sandbox 允許的 Electron bridge', async () => {
  const source = await readFile(
    path.join(projectRoot, 'preload', 'display-preload.js'),
    'utf8',
  );

  assert.match(source, /require\(['"]electron\/renderer['"]\)/);
  assert.match(
    source,
    /exposeInMainWorld\(\s*['"]displayCoreDisplay['"]/,
  );
  assert.doesNotMatch(source, /showMessage|clearMessage/);
  assert.doesNotMatch(source, /require\(['"](?:\.|node:)/);
});
