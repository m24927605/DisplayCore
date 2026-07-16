'use strict';

const path = require('node:path');
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  powerMonitor,
  protocol,
  screen,
  session,
} = require('electron');
const isSquirrelStartup = require('electron-squirrel-startup');

const { ConfigManager } = require('./config/config-manager');
const { LogoImporter } = require('./config/logo-importer');
const { ApplicationController } = require('./main/application-controller');
const {
  DisplayPlacementController,
} = require('./main/display-placement-controller');
const {
  DisplayTopologyService,
} = require('./main/display-topology-service');
const { HdmiDetector } = require('./main/hdmi-detector');
const { IPC_ROLES } = require('./ipc/channels');
const { IpcCoordinator } = require('./ipc/ipc-coordinator');
const { PresentationService } = require('./ipc/presentation-service');
const { PresentationStore } = require('./ipc/presentation-store');
const {
  installLocalProtocol,
  registerAppScheme,
} = require('./main/local-protocol');
const {
  configureOfflineSession,
  hardenWebContents,
} = require('./main/security-policy');
const { WindowManager } = require('./main/window-manager');

const PROJECT_ROOT = __dirname;
const CONTROL_URL = 'displaycore://app/control/index.html';
const DISPLAY_URL = 'displaycore://app/display/index.html';
const SCAFFOLD_SMOKE_FLAG = '--displaycore-smoke-test';
const MAIN_PROCESS_SMOKE_FLAG = '--displaycore-main-smoke-test';

/**
 * DisplayCore 主程序 composition root。
 *
 * 本檔只負責組合 Electron API 與各單一職責模組；螢幕查詢、定位、IPC、
 * 設定持久化與顯示排程仍由各自模組處理。
 */
async function bootstrap() {
  // Squirrel.Windows 安裝或解除安裝時會短暫啟動程式，此時不可建立視窗。
  if (isSquirrelStartup) {
    app.quit();
    return;
  }

  // 保留第 2 步的純 Electron 環境煙霧測試，不建立 Chromium 視窗。
  if (process.argv.includes(SCAFFOLD_SMOKE_FLAG)) {
    await app.whenReady();
    console.info('[DisplayCore] Electron 專案骨架啟動成功。');
    app.quit();
    return;
  }

  // Electron 規定 privileged scheme 必須在 app ready 之前完成註冊。
  registerAppScheme(protocol);

  const isMainProcessSmokeTest = process.argv.includes(MAIN_PROCESS_SMOKE_FLAG);
  const dataRoot = isMainProcessSmokeTest
    ? path.join(app.getPath('temp'), `displaycore-main-smoke-${process.pid}`)
    : path.join(app.getPath('userData'), 'displaycore-data');
  let appSession = null;
  let displayPlacementController = null;

  const windowManager = new WindowManager({
    BrowserWindow,
    // Session 只能在 ready 後建立，因此以 provider 延後到 createWindows 取用。
    sessionProvider: () => appSession,
    controlPreloadPath: path.join(PROJECT_ROOT, 'preload.js'),
    displayPreloadPath: path.join(
      PROJECT_ROOT,
      'preload',
      'display-preload.js',
    ),
    controlUrl: CONTROL_URL,
    displayUrl: DISPLAY_URL,
    hardenWebContents,
    onControlClosed: () => app.quit(),
    onRecoveryFailed: (error) => {
      console.error('[DisplayCore] 視窗自動復原失敗。', error);
      app.exit(1);
    },
    configureDisplayWindow: isMainProcessSmokeTest
      ? null
      : (displayWindow) => {
        if (
          !displayPlacementController ||
          !displayPlacementController.applyToWindow(displayWindow)
        ) {
          throw new Error('Display Window 無法套用目前輸出位置。');
        }
      },
    windowedDisplay: isMainProcessSmokeTest,
    controlDevTools: !app.isPackaged && !isMainProcessSmokeTest,
  });
  const presentationStore = new PresentationStore();
  const presentationService = new PresentationService({
    store: presentationStore,
    onListenerError: (error) => {
      console.error('[DisplayCore] 顯示狀態發布失敗。', error);
    },
  });
  const settingsManager = new ConfigManager({
    defaultConfigPath: path.join(PROJECT_ROOT, 'config.json'),
    configPath: path.join(dataRoot, 'config.json'),
    logger: console,
  });
  const hdmiDetector = new HdmiDetector({ logger: console });
  const displayTopologyService = new DisplayTopologyService({
    screen,
    powerMonitor,
    settingsManager,
    hdmiDetector,
    logger: console,
  });
  displayPlacementController = new DisplayPlacementController({
    topologyService: displayTopologyService,
    getDisplayWindow: () => windowManager.getDisplayWindow(),
    logger: console,
  });
  const logoImporter = new LogoImporter({
    dialog,
    getParentWindow: () => windowManager.getControlWindow(),
    assetDirectory: path.join(dataRoot, 'logos'),
  });
  const ipcCoordinator = new IpcCoordinator({
    ipcMain,
    presentationService,
    settingsManager,
    logoImporter,
    displayTopologyService,
    displayPlacementController,
    getWindow: (role) => {
      if (role === IPC_ROLES.CONTROL) {
        return windowManager.getControlWindow();
      }
      if (role === IPC_ROLES.DISPLAY) {
        return windowManager.getDisplayWindow();
      }

      return null;
    },
    allowedUrls: {
      [IPC_ROLES.CONTROL]: CONTROL_URL,
      [IPC_ROLES.DISPLAY]: DISPLAY_URL,
    },
    logger: console,
  });

  const controller = new ApplicationController({
    app,
    windowManager,
    platform: process.platform,
    logger: console,
    initializeRuntime: async () => {
      Menu.setApplicationMenu(null);

      // 不加 persist: 前綴，確保權限、Cookie 與快取不跨執行階段保留。
      appSession = session.fromPartition('displaycore', { cache: false });
      configureOfflineSession(appSession);
      installLocalProtocol({
        protocol: appSession.protocol,
        net,
        appRoot: PROJECT_ROOT,
        managedLogoDirectory: path.join(dataRoot, 'logos'),
        getAllowedLogoPath: () => {
          const logo = settingsManager.getSnapshot().config.logo;
          return logo.enabled ? logo.path : null;
        },
      });
      await settingsManager.initialize();
      await displayTopologyService.initialize();
      displayPlacementController.initialize();
      ipcCoordinator.register();
    },
    shutdownRuntime: () => {
      ipcCoordinator.dispose();
      displayPlacementController.dispose();
      displayTopologyService.dispose();
      presentationService.dispose();
    },
  });

  const started = await controller.start();

  if (!started) {
    return;
  }

  if (isMainProcessSmokeTest) {
    console.info('[DisplayCore] Main Process 雙視窗啟動成功。');
    app.quit();
  } else {
    console.info('[DisplayCore] Main Process 已啟動。');
  }
}

bootstrap().catch((error) => {
  console.error('[DisplayCore] Main Process 啟動失敗。', error);
  app.exit(1);
});
