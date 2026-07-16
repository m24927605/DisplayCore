'use strict';

const assert = require('node:assert/strict');
const { readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

test('Main Process 載入安全設定後建立雙視窗並正常結束', async () => {
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

  const smokeDataRoot = path.join(
    os.tmpdir(),
    `displaycore-main-smoke-${result.pid}`,
  );
  const persistedConfig = JSON.parse(
    await readFile(path.join(smokeDataRoot, 'config.json'), 'utf8'),
  );
  const bundledDefault = JSON.parse(
    await readFile(path.join(projectRoot, 'config.json'), 'utf8'),
  );

  assert.deepEqual(persistedConfig, bundledDefault);
  await rm(smokeDataRoot, { recursive: true, force: true });
});
