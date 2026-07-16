'use strict';

const path = require('node:path');

async function runElectronFixture() {
  const { app, BrowserWindow } = require('electron');
  let window = null;

  try {
    await app.whenReady();
    window = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await window.loadFile(path.join(
      __dirname,
      '..',
      'fixtures',
      'control-settings-focus',
      'index.html',
    ));
    const result = await window.webContents.executeJavaScript(
      'window.runFocusRegression()',
      true,
    );

    if (
      result?.restoredFocusId !== 'open-settings-button' ||
      result?.preservedNewFocusId !== 'next-action-input'
    ) {
      console.error(
        `[DisplayCore] 設定焦點結果不正確：${JSON.stringify(result)}。`,
      );
      app.exit(1);
      return;
    }

    console.info('[DisplayCore] 設定對話框焦點恢復回歸測試成功。');
    app.exit(0);
  } catch (error) {
    console.error('[DisplayCore] 設定對話框焦點恢復回歸測試失敗。', error);
    app.exit(1);
  } finally {
    if (window && !window.isDestroyed()) {
      window.destroy();
    }
  }
}

if (process.versions.electron) {
  void runElectronFixture();
} else {
  const assert = require('node:assert/strict');
  const { spawnSync } = require('node:child_process');
  const test = require('node:test');

  // Regression: ISSUE-001 — 設定對話框偶爾恢復到錯誤的入口按鈕
  // Found by /qa on 2026-07-17
  // Report: .gstack/qa-reports/qa-report-displaycore-2026-07-17.md
  test('設定對話框恢復單一齒輪入口且不延遲搶走後續焦點', () => {
    const electronBinary = require('electron');
    const result = spawnSync(electronBinary, [__filename], {
      encoding: 'utf8',
      timeout: 20_000,
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /設定對話框焦點恢復回歸測試成功/,
    );
  });
}
