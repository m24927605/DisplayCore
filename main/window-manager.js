'use strict';

const {
  createControlWindowOptions,
  createDisplayWindowOptions,
} = require('./window-options');
const { getDisplayAlwaysOnTopLevel } = require('./display-signage-mode');

/**
 * 集中管理 Control 與 Display 兩個 BrowserWindow 的建立與生命週期。
 *
 * 本模組只負責安全的視窗外殼，不包含 IPC、顯示內容、設定或螢幕偵測。
 */
class WindowManager {
  /**
   * @param {object} dependencies
   * @param {typeof Electron.BrowserWindow} dependencies.BrowserWindow
   * @param {Electron.Session} [dependencies.session]
   * @param {() => Electron.Session} [dependencies.sessionProvider]
   * @param {string} dependencies.controlPreloadPath
   * @param {string} dependencies.displayPreloadPath
   * @param {string} dependencies.controlUrl
   * @param {string} dependencies.displayUrl
   * @param {(contents: Electron.WebContents) => void} dependencies.hardenWebContents
   * @param {() => void} dependencies.onControlClosed
   * @param {(displayWindow: Electron.BrowserWindow) => void|Promise<void>} dependencies.onDisplayAvailable
   * @param {() => void} dependencies.onDisplayUnavailable
   * @param {(error: Error) => void} dependencies.onRecoveryFailed
   * @param {(displayWindow: Electron.BrowserWindow) => void|Promise<void>} [dependencies.configureDisplayWindow]
   * @param {boolean} dependencies.windowedDisplay
   * @param {boolean} dependencies.controlDevTools
   * @param {NodeJS.Platform|string} dependencies.platform
   */
  constructor({
    BrowserWindow,
    session = null,
    sessionProvider = null,
    controlPreloadPath,
    displayPreloadPath,
    controlUrl,
    displayUrl,
    hardenWebContents,
    onControlClosed = () => {},
    onDisplayAvailable = () => {},
    onDisplayUnavailable = () => {},
    onRecoveryFailed = () => {},
    configureDisplayWindow = null,
    windowedDisplay = false,
    controlDevTools = false,
    platform = process.platform,
  }) {
    this.BrowserWindow = BrowserWindow;
    this.session = session;
    this.sessionProvider = sessionProvider;
    this.controlPreloadPath = controlPreloadPath;
    this.displayPreloadPath = displayPreloadPath;
    this.controlUrl = controlUrl;
    this.displayUrl = displayUrl;
    this.hardenWebContents = hardenWebContents;
    this.onControlClosed = onControlClosed;
    this.onDisplayAvailable = onDisplayAvailable;
    this.onDisplayUnavailable = onDisplayUnavailable;
    this.onRecoveryFailed = onRecoveryFailed;
    this.configureDisplayWindow = configureDisplayWindow;
    this.windowedDisplay = windowedDisplay;
    this.controlDevTools = controlDevTools;
    this.platform = platform;

    this.controlWindow = null;
    this.displayWindow = null;
    this.creationPromise = null;
    this.recoveryPromise = null;
    this.isQuitting = false;
    this.availableDisplayWindow = null;
    this.reloadingDisplayWindows = new WeakSet();
    this.suppressedControlCloseWindows = new WeakSet();
    this.suppressedDisplayCloseWindows = new WeakSet();
  }

  /**
   * 建立雙視窗；併發或重複呼叫時沿用既有建立工作與視窗。
   *
   * @returns {Promise<{controlWindow: Electron.BrowserWindow, displayWindow: Electron.BrowserWindow}>}
   */
  async createWindows() {
    if (this.isQuitting) {
      return this.getWindowState();
    }

    if (this.recoveryPromise) {
      return this.recoveryPromise;
    }

    try {
      return await this.ensureWindowPair();
    } catch (error) {
      // 初次載入期間若 Renderer 崩潰，事件處理器會接手原子復原；原始呼叫者
      // 應等待新視窗，而不是把已接管的暫時性錯誤上拋到 bootstrap。
      if (this.recoveryPromise) {
        return this.recoveryPromise;
      }

      throw error;
    }
  }

  /**
   * 建立或沿用一組健康視窗；內部復原流程可直接呼叫，避免等待自己。
   *
   * @private
   */
  async ensureWindowPair() {
    if (this.creationPromise) {
      return this.creationPromise;
    }

    if (this.hasWindows()) {
      return this.getWindowState();
    }

    const currentCreation = this.createWindowPair();
    this.creationPromise = currentCreation;

    try {
      return await currentCreation;
    } finally {
      if (this.creationPromise === currentCreation) {
        this.creationPromise = null;
      }
    }
  }

  /**
   * 實際建立並載入一組 Control 與 Display Window。
   * 任一頁面載入失敗時，會原子清除整組視窗，避免留下不可管理的 Display。
   *
   * @private
   */
  async createWindowPair() {
    const appSession = this.resolveSession();
    const controlWindow = new this.BrowserWindow(
      createControlWindowOptions({
        preloadPath: this.controlPreloadPath,
        session: appSession,
        devTools: this.controlDevTools,
      }),
    );
    const displayWindow = new this.BrowserWindow(
      createDisplayWindowOptions({
        preloadPath: this.displayPreloadPath,
        session: appSession,
        windowed: this.windowedDisplay,
        managedOutput: Boolean(this.configureDisplayWindow),
      }),
    );

    this.controlWindow = controlWindow;
    this.displayWindow = displayWindow;
    this.bindWindowLifecycle(controlWindow, displayWindow);

    try {
      if (this.configureDisplayWindow) {
        await this.configureDisplayWindow(displayWindow);
      }

      this.hardenWebContents(controlWindow.webContents);
      this.hardenWebContents(displayWindow.webContents);

      controlWindow.setAlwaysOnTop(true, 'pop-up-menu');
      displayWindow.setAlwaysOnTop(
        true,
        getDisplayAlwaysOnTopLevel(this.platform),
      );
      displayWindow.setIgnoreMouseEvents(true);

      await Promise.all([
        controlWindow.loadURL(this.controlUrl),
        displayWindow.loadURL(this.displayUrl),
      ]);

      if (controlWindow.isDestroyed() || displayWindow.isDestroyed()) {
        throw new Error('視窗在初次頁面載入完成前已關閉。');
      }

      if (this.windowedDisplay && typeof displayWindow.center === 'function') {
        displayWindow.center();
      }

      displayWindow.showInactive();
      // 最短顯示時間只能從電視視窗真正顯示後的全新 refit 開始計算。
      this.availableDisplayWindow = displayWindow;
      await this.onDisplayAvailable(displayWindow);

      if (controlWindow.isDestroyed() || displayWindow.isDestroyed()) {
        throw new Error('視窗在 Display 可用通知完成前已關閉。');
      }

      controlWindow.show();
      controlWindow.focus();

      return this.getWindowState();
    } catch (error) {
      // 可用通知與撤銷必須成對；建立流程後段失敗時不可留下可計時的幽靈 Display。
      this.notifyDisplayUnavailable(displayWindow);
      this.destroyWindowPair(controlWindow, displayWindow);
      throw error;
    }
  }

  /**
   * @private
   * @returns {Electron.Session}
   */
  resolveSession() {
    const appSession = this.session || this.sessionProvider?.();

    if (!appSession) {
      throw new Error('DisplayCore 專用 Session 尚未初始化。');
    }

    return appSession;
  }

  /**
   * @private
   */
  bindWindowLifecycle(controlWindow, displayWindow) {
    controlWindow.once('closed', () => {
      const closeWasSuppressed =
        this.suppressedControlCloseWindows.delete(controlWindow);

      if (this.controlWindow === controlWindow) {
        this.controlWindow = null;
      }

      if (!this.isQuitting && !closeWasSuppressed) {
        this.onControlClosed();
      }
    });

    displayWindow.once('closed', () => {
      const closeWasSuppressed =
        this.suppressedDisplayCloseWindows.delete(displayWindow);
      const wasCurrentWindow = this.displayWindow === displayWindow;

      if (this.displayWindow === displayWindow) {
        this.displayWindow = null;
      }

      if (!this.isQuitting && !closeWasSuppressed && wasCurrentWindow) {
        this.scheduleWindowPairRecovery(controlWindow, displayWindow);
      }
    });

    displayWindow.webContents.on('did-start-loading', () => {
      if (
        !this.isQuitting &&
        this.displayWindow === displayWindow &&
        this.notifyDisplayUnavailable(displayWindow)
      ) {
        // 初次 load 尚未發布可用，因此只有同一 WebContents reload 會進入此集合。
        this.reloadingDisplayWindows.add(displayWindow);
      }
    });

    displayWindow.webContents.on('did-finish-load', () => {
      if (!this.reloadingDisplayWindows.delete(displayWindow)) {
        return;
      }

      void this.restoreDisplayAfterReload(controlWindow, displayWindow);
    });

    displayWindow.webContents.on(
      'did-fail-load',
      (_event, _errorCode, _description, _url, isMainFrame) => {
        if (
          isMainFrame &&
          this.reloadingDisplayWindows.delete(displayWindow)
        ) {
          this.scheduleWindowPairRecovery(controlWindow, displayWindow);
        }
      },
    );

    for (const browserWindow of [controlWindow, displayWindow]) {
      browserWindow.webContents.on(
        'render-process-gone',
        () => {
          // BrowserWindow 仍是目前視窗但 Renderer 已消失時，即使
          // Electron 標示 clean-exit，對無人顯示系統仍是必須復原的
          // 異常狀態。正常 app 退出由 isQuitting 明確抑制重建。
          this.scheduleWindowPairRecovery(controlWindow, displayWindow);
        },
      );
    }
  }

  /**
   * 同一 WebContents reload 完成後重新核發可見世代；失敗則改走原子復原。
   *
   * @private
   */
  async restoreDisplayAfterReload(controlWindow, displayWindow) {
    if (
      this.isQuitting ||
      this.controlWindow !== controlWindow ||
      this.displayWindow !== displayWindow ||
      controlWindow.isDestroyed() ||
      displayWindow.isDestroyed()
    ) {
      return;
    }

    this.availableDisplayWindow = displayWindow;
    try {
      await this.onDisplayAvailable(displayWindow);
      if (
        controlWindow.isDestroyed() ||
        displayWindow.isDestroyed() ||
        this.displayWindow !== displayWindow
      ) {
        throw new Error('Display reload 可用通知完成前視窗已失效。');
      }
    } catch {
      this.notifyDisplayUnavailable(displayWindow);
      this.scheduleWindowPairRecovery(controlWindow, displayWindow);
    }
  }

  /**
   * Renderer 崩潰或 Display 意外消失時，原子銷毀舊視窗並重建整組視窗。
   * 以 microtask 延後實際動作，確保 recoveryPromise 先完成指派，避免舊視窗
   * 同時送出多個事件時重複建立。
   *
   * @private
   */
  scheduleWindowPairRecovery(controlWindow, displayWindow) {
    if (
      this.isQuitting ||
      this.recoveryPromise ||
      (this.controlWindow !== controlWindow &&
        this.displayWindow !== displayWindow) ||
      this.suppressedControlCloseWindows.has(controlWindow) ||
      this.suppressedDisplayCloseWindows.has(displayWindow)
    ) {
      return;
    }

    // 先使舊 Display 的 timer／動畫閘門失效，再開始非同步重建。
    this.notifyDisplayUnavailable(displayWindow);

    const interruptedCreation = this.creationPromise;
    const recoveryWork = Promise.resolve().then(async () => {
      if (this.isQuitting) {
        return this.getWindowState();
      }

      this.destroyWindowPair(controlWindow, displayWindow);

      // 啟動期間的舊 loadURL 必須先結束，並從 creationPromise 解除，否則
      // ensureWindowPair 會誤把已崩潰的建立工作當成正在建立的新視窗。
      if (interruptedCreation) {
        try {
          await interruptedCreation;
        } catch {
          // 舊視窗已被刻意銷毀，載入失敗是復原流程的一部分。
        }

        if (this.creationPromise === interruptedCreation) {
          this.creationPromise = null;
        }
      }

      if (this.isQuitting) {
        return this.getWindowState();
      }

      const windowState = await this.ensureWindowPair();

      // 視窗載入期間仍可能收到 before-quit；此時不可顯示剛重建的視窗。
      if (this.isQuitting) {
        this.destroyWindowPair(
          windowState?.controlWindow,
          windowState?.displayWindow,
        );
      }

      return windowState;
    });
    let trackedRecovery;

    trackedRecovery = recoveryWork.finally(() => {
      if (this.recoveryPromise === trackedRecovery) {
        this.recoveryPromise = null;
      }
    });
    this.recoveryPromise = trackedRecovery;

    // 事件處理器無法 await；在此消化 rejection，並交由 composition root
    // 決定致命復原錯誤的記錄與退出策略。
    void trackedRecovery.catch((error) => {
      if (!this.isQuitting) {
        this.onRecoveryFailed(error);
      }
    });
  }

  /**
   * 對特定 Display 最多發布一次不可用通知，避免 close／renderer-gone 競態重複撤銷。
   *
   * @private
   */
  notifyDisplayUnavailable(displayWindow) {
    if (this.availableDisplayWindow !== displayWindow) {
      return false;
    }

    this.availableDisplayWindow = null;
    this.onDisplayUnavailable();
    return true;
  }

  /**
   * @private
   */
  destroyWindowPair(controlWindow, displayWindow) {
    // closed 可能在 destroy() 返回後才觸發，因此抑制狀態必須綁定特定視窗，
    // 不能使用會被過早重設的全域布林值。
    if (controlWindow) {
      this.suppressedControlCloseWindows.add(controlWindow);
    }
    if (displayWindow) {
      this.suppressedDisplayCloseWindows.add(displayWindow);
    }

    try {
      for (const browserWindow of [controlWindow, displayWindow]) {
        if (browserWindow && !browserWindow.isDestroyed()) {
          browserWindow.destroy();
        }
      }
    } finally {
      if (this.controlWindow === controlWindow) {
        this.controlWindow = null;
      }
      if (this.displayWindow === displayWindow) {
        this.displayWindow = null;
      }
    }
  }

  /**
   * 第二個程式執行個體啟動時，還原並聚焦既有 Control Window。
   */
  focusControlWindow() {
    const controlWindow = this.controlWindow;

    if (!controlWindow || controlWindow.isDestroyed()) {
      return;
    }

    if (controlWindow.isMinimized()) {
      controlWindow.restore();
    }

    controlWindow.show();
    controlWindow.focus();
  }

  /**
   * @returns {boolean} 兩個視窗是否都存在且未被銷毀
   */
  hasWindows() {
    return Boolean(
      !this.isQuitting &&
      !this.recoveryPromise &&
      this.controlWindow &&
      !this.controlWindow.isDestroyed() &&
      this.displayWindow &&
      !this.displayWindow.isDestroyed(),
    );
  }

  /**
   * @returns {Electron.BrowserWindow|null} 目前有效的 Control Window
   */
  getControlWindow() {
    if (!this.controlWindow || this.controlWindow.isDestroyed()) {
      return null;
    }

    return this.controlWindow;
  }

  /**
   * @returns {Electron.BrowserWindow|null} 目前有效的 Display Window
   */
  getDisplayWindow() {
    if (!this.displayWindow || this.displayWindow.isDestroyed()) {
      return null;
    }

    return this.displayWindow;
  }

  /**
   * @returns {boolean} 是否正在以新視窗取代失效的視窗組
   */
  isRecovering() {
    return Boolean(this.recoveryPromise);
  }

  /**
   * 在 app.quit 關閉視窗前解除 Display 的不可關閉限制，並停用退出通知。
   */
  prepareForQuit() {
    this.isQuitting = true;

    if (this.displayWindow && !this.displayWindow.isDestroyed()) {
      this.displayWindow.setClosable(true);
    }
  }

  /**
   * @private
   */
  getWindowState() {
    return {
      controlWindow: this.getControlWindow(),
      displayWindow: this.getDisplayWindow(),
    };
  }
}

module.exports = { WindowManager };
