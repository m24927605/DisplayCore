'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const fixtureRoot = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'message-liquid-lifetime-qa',
);
const EVIDENCE_MARKER = 'MESSAGE_LIQUID_LIFETIME_EVIDENCE ';

test('真實 Electron 頁面在最後一個未滿影格後注滿，才允許移除訊息', () => {
  const electronBinary = require('electron');
  const result = spawnSync(electronBinary, [fixtureRoot], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  const output = `${result.stdout}\n${result.stderr}`;

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, output);

  const evidenceLine = output
    .split(/\r?\n/u)
    .find((line) => line.startsWith(EVIDENCE_MARKER));
  assert.ok(evidenceLine, `缺少真實時序證據：\n${output}`);

  const evidence = JSON.parse(evidenceLine.slice(EVIDENCE_MARKER.length));
  assert.equal(evidence.timerKind, 'real');
  assert.equal(evidence.manualSeekUsed, false);
  assert.equal(evidence.lastUnderOne.progress < 1, true);
  assert.equal(evidence.lastUnderOne.progress >= 0.85, true);
  assert.equal(evidence.fullBeforeRemoval.progress, 1);
  assert.equal(evidence.fullBeforeRemoval.mode, 'page');
  assert.equal(evidence.fullBeforeRemoval.rowConnected, true);
  assert.equal(evidence.transition.mode, 'blank');
  assert.equal(evidence.transition.rowCount, 0);
  assert.equal(
    evidence.transition.performanceNow >=
      evidence.fullBeforeRemoval.performanceNow,
    true,
  );
});
