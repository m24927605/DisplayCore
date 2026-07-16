'use strict';

const { IPC_CHANNELS, IPC_ROLES } = require('./channels');
const { validateShowMessagePayload } = require('./validators');

const REQUEST_CHANNELS = Object.freeze([
  IPC_CHANNELS.CONTROL_GET_PRESENTATION,
  IPC_CHANNELS.CONTROL_SHOW_MESSAGE,
  IPC_CHANNELS.CONTROL_CLEAR_MESSAGE,
  IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
]);

/**
 * @param {unknown} data
 */
function success(data) {
  return { ok: true, data };
}

function forbidden() {
  return {
    ok: false,
    error: {
      code: 'FORBIDDEN',
      message: '此視窗沒有執行該操作的權限。',
    },
  };
}

function internalError() {
  return {
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: '操作失敗，請稍後再試。',
    },
  };
}

/**
 * Main Process 的 IPC 路由與授權中心。
 *
 * 每個 request channel 固定綁定一個角色。授權時動態取得目前視窗，確保
 * WindowManager 自動復原後新 Renderer 可立即使用，而舊 sender 失去權限。
 */
class IpcCoordinator {
  /**
   * @param {object} dependencies
   * @param {Electron.IpcMain} dependencies.ipcMain
   * @param {import('./presentation-store').PresentationStore} dependencies.presentationStore
   * @param {(role: string) => Electron.BrowserWindow|null} dependencies.getWindow
   * @param {Record<string, string>} dependencies.allowedUrls
   * @param {{warn: Function, error: Function}} dependencies.logger
   */
  constructor({
    ipcMain,
    presentationStore,
    getWindow,
    allowedUrls,
    logger = console,
  }) {
    this.ipcMain = ipcMain;
    this.presentationStore = presentationStore;
    this.getWindow = getWindow;
    this.allowedUrls = allowedUrls;
    this.logger = logger;
    this.registered = false;
  }

  /** 註冊固定白名單 handlers；重複呼叫不會重複綁定。 */
  register() {
    if (this.registered) {
      return;
    }

    this.ipcMain.handle(
      IPC_CHANNELS.CONTROL_GET_PRESENTATION,
      (event) => this.handleRequest(IPC_ROLES.CONTROL, event, () =>
        success(this.presentationStore.getSnapshot()),
      ),
    );
    this.ipcMain.handle(
      IPC_CHANNELS.CONTROL_SHOW_MESSAGE,
      (event, payload) => this.handleRequest(
        IPC_ROLES.CONTROL,
        event,
        () => this.showMessage(payload),
      ),
    );
    this.ipcMain.handle(
      IPC_CHANNELS.CONTROL_CLEAR_MESSAGE,
      (event) => this.handleRequest(
        IPC_ROLES.CONTROL,
        event,
        () => this.clearMessage(),
      ),
    );
    this.ipcMain.handle(
      IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
      (event) => this.handleRequest(IPC_ROLES.DISPLAY, event, () =>
        success(this.presentationStore.getSnapshot()),
      ),
    );
    this.registered = true;
  }

  /** 程式退出時移除 handlers，避免測試或重新初始化時殘留全域狀態。 */
  dispose() {
    if (!this.registered) {
      return;
    }

    for (const channel of REQUEST_CHANNELS) {
      this.ipcMain.removeHandler(channel);
    }

    this.registered = false;
  }

  /** @private */
  handleRequest(role, event, operation) {
    if (!this.isAuthorized(role, event)) {
      return forbidden();
    }

    try {
      return operation();
    } catch (error) {
      this.logger.error('[DisplayCore] IPC 操作發生內部錯誤。', error);
      return internalError();
    }
  }

  /** @private */
  isAuthorized(role, event) {
    const browserWindow = this.getWindow(role);

    if (
      !browserWindow ||
      browserWindow.isDestroyed() ||
      !event ||
      event.sender !== browserWindow.webContents ||
      event.sender.isDestroyed()
    ) {
      return false;
    }

    const senderFrame = event.senderFrame;
    const mainFrame = event.sender.mainFrame;

    if (
      !senderFrame ||
      senderFrame.detached ||
      senderFrame.isDestroyed() ||
      mainFrame.detached ||
      mainFrame.isDestroyed() ||
      senderFrame.frameTreeNodeId !== mainFrame.frameTreeNodeId
    ) {
      return false;
    }

    return senderFrame.url === this.allowedUrls[role];
  }

  /** @private */
  showMessage(payload) {
    const validation = validateShowMessagePayload(payload);

    if (!validation.ok) {
      return validation;
    }

    const snapshot = this.presentationStore.showMessage(validation.value);
    this.broadcast(snapshot);
    return success(snapshot);
  }

  /** @private */
  clearMessage() {
    const snapshot = this.presentationStore.clearMessage();
    this.broadcast(snapshot);
    return success(snapshot);
  }

  /** @private */
  broadcast(snapshot) {
    this.sendToRole(
      IPC_ROLES.CONTROL,
      IPC_CHANNELS.CONTROL_PRESENTATION_CHANGED,
      snapshot,
    );
    this.sendToRole(
      IPC_ROLES.DISPLAY,
      IPC_CHANNELS.DISPLAY_PRESENTATION_CHANGED,
      snapshot,
    );
  }

  /** @private */
  sendToRole(role, channel, snapshot) {
    const browserWindow = this.getWindow(role);
    const webContents = browserWindow?.webContents;

    if (
      !browserWindow ||
      browserWindow.isDestroyed() ||
      !webContents ||
      webContents.isDestroyed()
    ) {
      return;
    }

    try {
      webContents.send(channel, snapshot);
    } catch (error) {
      // Main 已保存完整 snapshot；新 Renderer 啟動後會主動重新取得。
      this.logger.warn('[DisplayCore] IPC 狀態事件暫時無法送達。', error);
    }
  }
}

module.exports = { IpcCoordinator };
