'use strict';

const { IPC_CHANNELS, IPC_ROLES } = require('./channels');
const {
  validateEmergencyPayload,
  validateStartProgramPayload,
} = require('./validators');

const REQUEST_CHANNELS = Object.freeze([
  IPC_CHANNELS.CONTROL_GET_PRESENTATION,
  IPC_CHANNELS.CONTROL_START_PROGRAM,
  IPC_CHANNELS.CONTROL_SHOW_EMERGENCY,
  IPC_CHANNELS.CONTROL_CLEAR_PRESENTATION,
  IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
]);

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
 * Main Process 的 v2 IPC 路由與角色授權中心。
 *
 * Control 只能啟動清單、顯示固定緊急代碼及清除；Display 只能讀取 snapshot。
 * Main scheduler 發布的自動翻頁也透過同一 subscription 廣播，Renderer 不需
 * 也不能回報 next page。
 */
class IpcCoordinator {
  constructor({
    ipcMain,
    presentationService,
    getWindow,
    allowedUrls,
    logger = console,
  }) {
    this.ipcMain = ipcMain;
    this.presentationService = presentationService;
    this.getWindow = getWindow;
    this.allowedUrls = allowedUrls;
    this.logger = logger;
    this.registered = false;
    this.unsubscribe = null;
  }

  register() {
    if (this.registered) {
      return;
    }

    this.unsubscribe = this.presentationService.subscribe((snapshot) => {
      this.broadcast(snapshot);
    });

    this.ipcMain.handle(
      IPC_CHANNELS.CONTROL_GET_PRESENTATION,
      (event) => this.handleRequest(IPC_ROLES.CONTROL, event, () =>
        success(this.presentationService.getSnapshot()),
      ),
    );
    this.ipcMain.handle(
      IPC_CHANNELS.CONTROL_START_PROGRAM,
      (event, payload) => this.handleRequest(
        IPC_ROLES.CONTROL,
        event,
        () => this.startProgram(payload),
      ),
    );
    this.ipcMain.handle(
      IPC_CHANNELS.CONTROL_SHOW_EMERGENCY,
      (event, payload) => this.handleRequest(
        IPC_ROLES.CONTROL,
        event,
        () => this.showEmergency(payload),
      ),
    );
    this.ipcMain.handle(
      IPC_CHANNELS.CONTROL_CLEAR_PRESENTATION,
      (event) => this.handleRequest(
        IPC_ROLES.CONTROL,
        event,
        () => success(this.presentationService.clearPresentation()),
      ),
    );
    this.ipcMain.handle(
      IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
      (event) => this.handleRequest(IPC_ROLES.DISPLAY, event, () =>
        success(this.presentationService.getSnapshot()),
      ),
    );
    this.registered = true;
  }

  dispose() {
    if (!this.registered) {
      return;
    }

    for (const channel of REQUEST_CHANNELS) {
      this.ipcMain.removeHandler(channel);
    }

    this.unsubscribe?.();
    this.unsubscribe = null;
    this.registered = false;
  }

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

  isAuthorized(role, event) {
    try {
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
        senderFrame.isDestroyed() ||
        senderFrame.detached ||
        !mainFrame ||
        mainFrame.isDestroyed() ||
        mainFrame.detached ||
        senderFrame.frameTreeNodeId !== mainFrame.frameTreeNodeId
      ) {
        return false;
      }

      return senderFrame.url === this.allowedUrls[role];
    } catch (error) {
      this.logger.warn('[DisplayCore] IPC sender 驗證無法完成。', error);
      return false;
    }
  }

  startProgram(payload) {
    const validation = validateStartProgramPayload(payload);

    if (!validation.ok) {
      return validation;
    }

    return success(this.presentationService.startProgram(validation.value));
  }

  showEmergency(payload) {
    const validation = validateEmergencyPayload(payload);

    if (!validation.ok) {
      return validation;
    }

    return success(
      this.presentationService.showEmergency(validation.value.code),
    );
  }

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
      // Main 已保存最新頁；新 Renderer 啟動後會重新取得完整 snapshot。
      this.logger.warn('[DisplayCore] IPC 狀態事件暫時無法送達。', error);
    }
  }
}

module.exports = { IpcCoordinator };
