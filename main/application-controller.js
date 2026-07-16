'use strict';

/**
 * 管理 Electron App 的單例鎖、ready 與跨平台生命週期事件。
 *
 * Electron 物件均由 composition root 注入，使生命週期可以使用 Node.js 測試
 * 雙精確驗證，不需要在單元測試中真正啟動 Chromium。
 */
class ApplicationController {
  /**
   * @param {object} dependencies
   * @param {Electron.App} dependencies.app
   * @param {import('./window-manager').WindowManager} dependencies.windowManager
   * @param {() => Promise<void>} dependencies.initializeRuntime
   * @param {NodeJS.Platform} dependencies.platform
   * @param {{error: Function}} dependencies.logger
   */
  constructor({
    app,
    windowManager,
    initializeRuntime,
    platform = process.platform,
    logger = console,
  }) {
    this.app = app;
    this.windowManager = windowManager;
    this.initializeRuntime = initializeRuntime;
    this.platform = platform;
    this.logger = logger;
    this.startPromise = null;
    this.lifecycleBound = false;
    this.runtimeReady = false;
  }

  /**
   * 依序取得單例鎖、等待 Electron ready、初始化安全執行環境並建立視窗。
   * 重複呼叫會共用同一個 Promise。
   *
   * @returns {Promise<boolean>} 是否由目前執行個體接管應用程式
   */
  async start() {
    if (!this.startPromise) {
      this.startPromise = this.startApplication();
    }

    return this.startPromise;
  }

  /** @private */
  async startApplication() {
    if (!this.app.requestSingleInstanceLock()) {
      this.app.quit();
      return false;
    }

    this.bindLifecycle();
    await this.app.whenReady();
    await this.initializeRuntime();
    await this.windowManager.createWindows();
    this.runtimeReady = true;
    return true;
  }

  /** @private */
  bindLifecycle() {
    if (this.lifecycleBound) {
      return;
    }

    this.lifecycleBound = true;

    this.app.on('second-instance', () => {
      this.windowManager.focusControlWindow();
    });

    this.app.on('before-quit', () => {
      this.windowManager.prepareForQuit();
    });

    this.app.on('window-all-closed', () => {
      if (
        this.platform !== 'darwin' &&
        !this.windowManager.isRecovering() &&
        !this.windowManager.hasWindows()
      ) {
        this.app.quit();
      }
    });

    this.app.on('activate', () => {
      void this.restoreWindowsAfterActivation();
    });
  }

  /** @private */
  async restoreWindowsAfterActivation() {
    if (!this.runtimeReady || this.windowManager.hasWindows()) {
      return;
    }

    try {
      await this.windowManager.createWindows();
    } catch (error) {
      this.logger.error('[DisplayCore] activate 重新建立視窗失敗。', error);
    }
  }
}

module.exports = { ApplicationController };
