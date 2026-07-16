'use strict';

const { IPC_CHANNELS, IPC_ROLES } = require('./channels');
const { createDisplaySettingsSnapshot } = require('./display-settings');
const {
  validateEmergencyPayload,
  validateSaveSettingsPayload,
  validateStartProgramPayload,
} = require('./validators');

const REQUEST_CHANNELS = Object.freeze([
  IPC_CHANNELS.CONTROL_GET_PRESENTATION,
  IPC_CHANNELS.CONTROL_START_PROGRAM,
  IPC_CHANNELS.CONTROL_SHOW_EMERGENCY,
  IPC_CHANNELS.CONTROL_CLEAR_PRESENTATION,
  IPC_CHANNELS.CONTROL_GET_SETTINGS,
  IPC_CHANNELS.CONTROL_SAVE_SETTINGS,
  IPC_CHANNELS.CONTROL_CHOOSE_LOGO,
  IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
  IPC_CHANNELS.DISPLAY_GET_SETTINGS,
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

function knownOperationError(error) {
  if (
    error?.code === 'VALIDATION_FAILED' &&
    error.validationError?.code === 'VALIDATION_FAILED'
  ) {
    return { ok: false, error: { ...error.validationError } };
  }

  if (error?.code === 'CONFIG_CONFLICT') {
    return {
      ok: false,
      error: {
        code: 'CONFIG_CONFLICT',
        message: '設定已由另一個操作更新，請重新載入後再儲存。',
      },
    };
  }

  if (error?.code === 'LOGO_IMPORT_FAILED') {
    return {
      ok: false,
      error: {
        code: 'LOGO_IMPORT_FAILED',
        message: '無法匯入 Logo，請確認圖片格式與檔案大小。',
      },
    };
  }

  return null;
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
    settingsManager = null,
    logoImporter = null,
    getWindow,
    allowedUrls,
    logger = console,
  }) {
    this.ipcMain = ipcMain;
    this.presentationService = presentationService;
    this.settingsManager = settingsManager;
    this.logoImporter = logoImporter;
    this.getWindow = getWindow;
    this.allowedUrls = allowedUrls;
    this.logger = logger;
    this.registered = false;
    this.presentationUnsubscribe = null;
    this.settingsUnsubscribe = null;
  }

  register() {
    if (this.registered) {
      return;
    }

    this.presentationUnsubscribe = this.presentationService.subscribe((snapshot) => {
      this.broadcast(snapshot);
    });

    if (typeof this.settingsManager?.subscribe === 'function') {
      this.settingsUnsubscribe = this.settingsManager.subscribe((snapshot) => {
        try {
          this.broadcastSettings(createDisplaySettingsSnapshot(snapshot));
        } catch (error) {
          this.logger.error('[DisplayCore] Display 設定投影失敗。', error);
        }
      });
    }

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
      IPC_CHANNELS.CONTROL_GET_SETTINGS,
      (event) => this.handleRequest(IPC_ROLES.CONTROL, event, () =>
        success(this.settingsManager.getSnapshot()),
      ),
    );
    this.ipcMain.handle(
      IPC_CHANNELS.CONTROL_SAVE_SETTINGS,
      (event, payload) => this.handleAsyncRequest(
        IPC_ROLES.CONTROL,
        event,
        () => this.saveSettings(payload),
      ),
    );
    this.ipcMain.handle(
      IPC_CHANNELS.CONTROL_CHOOSE_LOGO,
      (event) => this.handleAsyncRequest(
        IPC_ROLES.CONTROL,
        event,
        async () => success(await this.logoImporter.chooseAndImport()),
      ),
    );
    this.ipcMain.handle(
      IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
      (event) => this.handleRequest(IPC_ROLES.DISPLAY, event, () =>
        success(this.presentationService.getSnapshot()),
      ),
    );
    this.ipcMain.handle(
      IPC_CHANNELS.DISPLAY_GET_SETTINGS,
      (event) => this.handleRequest(IPC_ROLES.DISPLAY, event, () =>
        success(
          createDisplaySettingsSnapshot(this.settingsManager.getSnapshot()),
        ),
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

    this.presentationUnsubscribe?.();
    this.settingsUnsubscribe?.();
    this.presentationUnsubscribe = null;
    this.settingsUnsubscribe = null;
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

  async handleAsyncRequest(role, event, operation) {
    if (!this.isAuthorized(role, event)) {
      return forbidden();
    }

    try {
      return await operation();
    } catch (error) {
      const knownError = knownOperationError(error);

      if (knownError) {
        return knownError;
      }

      this.logger.error('[DisplayCore] IPC 非同步操作發生內部錯誤。', error);
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

  async saveSettings(payload) {
    const validation = validateSaveSettingsPayload(payload);

    if (!validation.ok) {
      return validation;
    }

    return success(
      await this.settingsManager.saveConfig(
        validation.value.config,
        validation.value.expectedRevision,
      ),
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

  broadcastSettings(snapshot) {
    this.sendToRole(
      IPC_ROLES.DISPLAY,
      IPC_CHANNELS.DISPLAY_SETTINGS_CHANGED,
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
