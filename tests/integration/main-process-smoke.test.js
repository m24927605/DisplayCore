'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

test('Main Process 可以安全建立雙視窗並正常結束', () => {
  const electronBinary = require('electron');
  const result = spawnSync(
    electronBinary,
    [projectRoot, '--displaycore-main-smoke-test'],
    {
      encoding: 'utf8',
      timeout: 20_000,
    },
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Main Process 雙視窗啟動成功/,
  );
});
