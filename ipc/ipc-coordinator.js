'use strict';

const { IPC_CHANNELS, IPC_ROLES } = require('./channels');
const { createDisplaySettingsSnapshot } = require('./display-settings');
const { createControlOutputSnapshot } = require('./output-status');
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
  IPC_CHANNELS.CONTROL_GET_OUTPUT_STATUS,
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
    displayTopologyService = null,
    displayPlacementController = null,
    getWindow,
    allowedUrls,
    logger = console,
  }) {
    this.ipcMain = ipcMain;
    this.presentationService = presentationService;
    this.settingsManager = settingsManager;
    this.logoImporter = logoImporter;
    this.displayTopologyService = displayTopologyService;
    this.displayPlacementController = displayPlacementController;
    this.getWindow = getWindow;
    this.allowedUrls = allowedUrls;
    this.logger = logger;
    this.registered = false;
    this.presentationUnsubscribe = null;
    this.settingsUnsubscribe = null;
    this.outputUnsubscribes = [];
    this.lastOutputStatusSignature = null;
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

    if (
      typeof this.displayTopologyService?.subscribe === 'function' &&
      typeof this.displayPlacementController?.subscribe === 'function'
    ) {
      const publishOutputStatus = () => this.broadcastOutputStatus();
      this.outputUnsubscribes = [
        this.displayTopologyService.subscribe(publishOutputStatus),
        this.displayPlacementController.subscribe(publishOutputStatus),
      ];
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
      IPC_CHANNELS.CONTROL_GET_OUTPUT_STATUS,
      (event) => this.handleRequest(IPC_ROLES.CONTROL, event, () =>
        success(this.createOutputStatusSnapshot()),
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
    for (const unsubscribe of this.outputUnsubscribes) {
      unsubscribe();
    }
    this.presentationUnsubscribe = null;
    this.settingsUnsubscribe = null;
    this.outputUnsubscribes = [];
    this.lastOutputStatusSignature = null;
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

  /**
   * 每次都從兩個 Main 服務讀取同一時刻的最新狀態，再交由安全投影器逐欄複製。
   * Renderer 不會取得 Electron Display、bounds 或其他原生裝置資料。
   */
  createOutputStatusSnapshot() {
    if (
      typeof this.displayTopologyService?.getSnapshot !== 'function' ||
      typeof this.displayPlacementController?.getStatus !== 'function'
    ) {
      throw new Error('Control 輸出狀態服務尚未初始化。');
    }

    return createControlOutputSnapshot(
      this.displayTopologyService.getSnapshot(),
      this.displayPlacementController.getStatus(),
    );
  }

  /**
   * Topology 更新時，Placement 也可能同步發布一次。以完整安全快照去重，確保
   * Control 對同一組 revision 只收到一個 changed 事件。
   */
  broadcastOutputStatus() {
    try {
      const snapshot = this.createOutputStatusSnapshot();
      const signature = JSON.stringify(snapshot);

      if (signature === this.lastOutputStatusSignature) {
        return false;
      }

      this.lastOutputStatusSignature = signature;
      this.sendToRole(
        IPC_ROLES.CONTROL,
        IPC_CHANNELS.CONTROL_OUTPUT_STATUS_CHANGED,
        snapshot,
      );
      return true;
    } catch (error) {
      this.logger.error('[DisplayCore] Control 輸出狀態投影失敗。', error);
      return false;
    }
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
