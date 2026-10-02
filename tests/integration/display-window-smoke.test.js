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

test('正式 Display 完成播放、離線校時與邏輯解析度流程', () => {
  const electronBinary = require('electron');
  const result = spawnSync(electronBinary, [fixtureRoot], {
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Display window workflow succeeded/,
  );
});

test('正式 Display 連續兩次完成 4K 真材質解碼、切換與三列文字渲染', () => {
  const electronBinary = require('electron');

  for (let iteration = 1; iteration <= 2; iteration += 1) {
    const result = spawnSync(electronBinary, [fixtureRoot], {
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        DISPLAYCORE_MESSAGE_BACKGROUND_QA_ONLY: '1',
      },
    });

    assert.equal(
      result.error,
      undefined,
      `第 ${iteration} 次：${result.error?.message}`,
    );
    assert.equal(
      result.status,
      0,
      `第 ${iteration} 次：${result.stderr || result.stdout}`,
    );
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /Display window workflow succeeded/,
    );
  }
});

test('正式 Display 在各解析度與設定極值下訊息、Logo 與時間互不碰觸', () => {
  const electronBinary = require('electron');
  const result = spawnSync(electronBinary, [fixtureRoot], {
    encoding: 'utf8',
    timeout: 300_000,
    env: {
      ...process.env,
      DISPLAYCORE_LAYOUT_COLLISION_QA_ONLY: '1',
    },
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Layout collision matrix inspected 324 layouts/,
  );
});

test('正式 Display 可由設定關閉倒酒效果並安全退回固定白字', () => {
  const electronBinary = require('electron');
  const result = spawnSync(electronBinary, [fixtureRoot], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      DISPLAYCORE_LIQUID_SETTING_QA_ONLY: '1',
    },
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Display window workflow succeeded/,
  );
});

test('正式 Display 關閉待機風吹沙後立即釋放 Canvas 且輪播仍繼續', () => {
  const electronBinary = require('electron');
  const result = spawnSync(electronBinary, [fixtureRoot], {
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      DISPLAYCORE_STANDBY_EFFECT_QA_ONLY: '1',
    },
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Display window standby effect workflow succeeded/,
  );
});

test('正式 Display 以 4K compositor 顯示紅檜木 555 與祖母綠 888 九宮格', () => {
  const electronBinary = require('electron');
  const result = spawnSync(electronBinary, [fixtureRoot], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      DISPLAYCORE_EMERGENCY_MATERIAL_QA_ONLY: '1',
    },
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Display window workflow succeeded/,
  );
});
