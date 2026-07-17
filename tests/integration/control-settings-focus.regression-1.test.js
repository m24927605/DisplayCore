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

    const clean = result?.clean;
    const dirty = result?.dirty;
    if (
      clean?.restoredFocusId !== 'open-settings-button' ||
      clean?.preservedNewFocusId !== 'next-action-input' ||
      dirty?.restoredFocusId !== 'open-settings-button' ||
      dirty?.preservedNewFocusId !== 'next-action-input' ||
      dirty?.beforeClose?.dirtyStatus !== '有未儲存變更' ||
      dirty?.beforeClose?.closeButtonText !== '捨棄變更' ||
      dirty?.beforeClose?.saveDisabled !== false ||
      dirty?.afterClose?.dirtyStatus !== '所有變更皆已儲存' ||
      dirty?.afterClose?.closeButtonText !== '關閉' ||
      dirty?.afterClose?.saveDisabled !== true ||
      dirty?.afterClose?.pageDuration !== '3' ||
      dirty?.afterClose?.finiteChecked !== true ||
      dirty?.afterClose?.continuousChecked !== false ||
      dirty?.afterClose?.roundCount !== '1'
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
  test('設定對話框恢復單一齒輪入口，且捨棄 playback dirty 草稿', () => {
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
