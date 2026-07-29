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
    const messageEffect = result?.messageEffect;
    const standbyEffect = result?.standbyEffect;
    const dirty = result?.dirty;
    if (
      clean?.restoredFocusId !== 'open-settings-button' ||
      clean?.preservedNewFocusId !== 'next-action-input' ||
      clean?.beforeClose?.messageLiquidEffectEnabled !== true ||
      clean?.beforeClose?.standbySandEffectEnabled !== true ||
      messageEffect?.beforeClose?.dirtyStatus !== '有未儲存變更' ||
      messageEffect?.beforeClose?.closeButtonText !== '捨棄變更' ||
      messageEffect?.beforeClose?.saveDisabled !== false ||
      messageEffect?.beforeClose?.messageLiquidEffectEnabled !== false ||
      messageEffect?.beforeClose?.standbySandEffectEnabled !== true ||
      messageEffect?.afterClose?.messageLiquidEffectEnabled !== true ||
      messageEffect?.afterClose?.standbySandEffectEnabled !== true ||
      standbyEffect?.beforeClose?.dirtyStatus !== '有未儲存變更' ||
      standbyEffect?.beforeClose?.closeButtonText !== '捨棄變更' ||
      standbyEffect?.beforeClose?.saveDisabled !== false ||
      standbyEffect?.beforeClose?.messageLiquidEffectEnabled !== true ||
      standbyEffect?.beforeClose?.standbySandEffectEnabled !== false ||
      standbyEffect?.afterClose?.messageLiquidEffectEnabled !== true ||
      standbyEffect?.afterClose?.standbySandEffectEnabled !== true ||
      dirty?.restoredFocusId !== 'open-settings-button' ||
      dirty?.preservedNewFocusId !== 'next-action-input' ||
      dirty?.beforeClose?.dirtyStatus !== '有未儲存變更' ||
      dirty?.beforeClose?.closeButtonText !== '捨棄變更' ||
      dirty?.beforeClose?.saveDisabled !== false ||
      dirty?.beforeClose?.messageLiquidEffectEnabled !== false ||
      dirty?.beforeClose?.standbySandEffectEnabled !== false ||
      dirty?.beforeClose?.controlDisplayId !== '1' ||
      dirty?.beforeClose?.defaultDisplayId !== '2' ||
      dirty?.beforeClose?.controlOptions?.[1]?.textContent !==
        '1. 管理螢幕 · 1920×1080（主螢幕）' ||
      dirty?.beforeClose?.connectedDisplayOptions?.[2]?.textContent !==
        '2. HDMI 電視 · 3840×2160' ||
      dirty?.beforeClose?.displayOptions?.[2]?.textContent !==
        '原指定螢幕 ID 2（目前未連接）' ||
      dirty?.afterClose?.dirtyStatus !== '所有變更皆已儲存' ||
      dirty?.afterClose?.closeButtonText !== '關閉' ||
      dirty?.afterClose?.saveDisabled !== true ||
      dirty?.afterClose?.pageDuration !== '3' ||
      dirty?.afterClose?.finiteChecked !== true ||
      dirty?.afterClose?.continuousChecked !== false ||
      dirty?.afterClose?.roundCount !== '1' ||
      dirty?.afterClose?.logoSizePercent !== '100' ||
      dirty?.afterClose?.messageBackgroundPreset !== 'obsidian' ||
      dirty?.afterClose?.standbyClockSizePercent !== '100' ||
      dirty?.afterClose?.messageLiquidEffectEnabled !== true ||
      dirty?.afterClose?.standbySandEffectEnabled !== true ||
      dirty?.afterClose?.controlDisplayId !== 'auto' ||
      dirty?.afterClose?.defaultDisplayId !== 'auto'
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
  test('設定對話框可操作雙螢幕選項，恢復焦點並捨棄 dirty 草稿', () => {
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
