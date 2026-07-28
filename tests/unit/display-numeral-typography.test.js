'use strict';

const assert = require('node:assert/strict');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const projectRoot = path.resolve(__dirname, '..', '..');

test('訊息混合內容只把 ASCII 數字段落標記為 Didot 數字', async () => {
  const moduleUrl = pathToFileURL(path.join(
    projectRoot,
    'display',
    'message-typography.mjs',
  )).href;
  const { splitMessageTypographyRuns } = await import(moduleUrl);

  assert.deepEqual(splitMessageTypographyRuns('Nancy001前廳000'), [
    { kind: 'text', text: 'Nancy' },
    { kind: 'number', text: '001' },
    { kind: 'text', text: '前廳' },
    { kind: 'number', text: '000' },
  ]);
  assert.deepEqual(splitMessageTypographyRuns('公告今日停止服務'), [
    { kind: 'text', text: '公告今日停止服務' },
  ]);
  assert.deepEqual(splitMessageTypographyRuns('555'), [
    { kind: 'number', text: '555' },
  ]);
});

test('極端長字串或大量交錯字型 run 會安全停用酒液並壓平 DOM', async () => {
  const moduleUrl = pathToFileURL(path.join(
    projectRoot,
    'display',
    'message-typography.mjs',
  )).href;
  const { createMessageTypographyPlan } = await import(moduleUrl);
  const ordinary = createMessageTypographyPlan('Nancy001請至前廳');

  assert.equal(ordinary.liquidCompatible, true);
  assert.deepEqual(ordinary.runs, [
    { kind: 'text', text: 'Nancy' },
    { kind: 'number', text: '001' },
    { kind: 'text', text: '請至前廳' },
  ]);

  const alternating = '1甲'.repeat(5_000);
  const pathological = createMessageTypographyPlan(alternating);
  assert.equal(pathological.liquidCompatible, false);
  assert.deepEqual(pathological.runs, [
    { kind: 'text', text: alternating },
  ]);
  assert.equal(
    pathological.runs.length,
    1,
    '合法的 10,000 字輸入不得建立數萬個 HTML/SVG 節點拖垮 4K Renderer',
  );

  const longSingleRun = createMessageTypographyPlan('公'.repeat(513));
  assert.equal(longSingleRun.liquidCompatible, false);
  assert.equal(longSingleRun.runs.length, 1);
});

test('Display 離線封裝 GFS Didot 與 OFL 授權，不依賴 Windows 預裝字型', async () => {
  const fontPath = path.join(
    projectRoot,
    'assets',
    'fonts',
    'GFSDidot-Regular.ttf',
  );
  const licensePath = path.join(
    projectRoot,
    'assets',
    'fonts',
    'OFL-GFSDidot.txt',
  );
  const [fontBytes, fontStats, license] = await Promise.all([
    readFile(fontPath),
    stat(fontPath),
    readFile(licensePath, 'utf8'),
  ]);

  assert.ok(fontStats.size >= 50_000, 'Didot 字型檔不可為空殼');
  assert.equal(fontBytes.readUInt32BE(0), 0x00010000, '必須是有效 TrueType');
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(license, /bundled,\s*embedded,\s*redistributed/);
});

test('數字段落、時間與 555／888 共用離線 Didot，中文維持原字型', async () => {
  const [css, source] = await Promise.all([
    readFile(path.join(projectRoot, 'display', 'display.css'), 'utf8'),
    readFile(path.join(projectRoot, 'display', 'app.mjs'), 'utf8'),
  ]);

  assert.match(
    css,
    /@font-face\s*{[^}]*font-family:\s*"DisplayCore GFS Didot"[^}]*font-weight:\s*400[^}]*url\("\.\.\/assets\/fonts\/GFSDidot-Regular\.ttf"\)/s,
  );
  assert.match(
    css,
    /--display-numeral-font-family:\s*"DisplayCore GFS Didot",\s*Didot,\s*"Bodoni 72",\s*"Bodoni MT",\s*serif/,
  );
  assert.match(
    css,
    /\.message-number\s*{[^}]*font-family:\s*var\(--display-numeral-font-family\)[^}]*font-weight:\s*400[^}]*font-variant-numeric:\s*lining-nums tabular-nums/s,
  );
  assert.match(
    css,
    /\.display-clock\s*{[^}]*font-family:\s*var\(--display-numeral-font-family\)/s,
  );
  assert.match(
    css,
    /\.fill-cell\s*{[^}]*font-family:\s*var\(--display-numeral-font-family\)/s,
  );
  assert.match(source, /createMessageTypographyPlan/);
  assert.match(source, /dataset\.liquidCompatible/);
  assert.match(source, /run\.kind\s*===\s*'number'/);
  assert.match(source, /className\s*=\s*'message-number'/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
});
