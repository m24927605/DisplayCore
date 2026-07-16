'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const fixtureRoot = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'display-window-smoke',
);

test('正式 Display 完成分頁、跑馬燈、滿屏與清除流程', () => {
  const electronBinary = require('electron');
  const result = spawnSync(electronBinary, [fixtureRoot], {
    encoding: 'utf8',
    timeout: 30_000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Display window workflow succeeded/,
  );
});
