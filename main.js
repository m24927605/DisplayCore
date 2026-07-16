'use strict';

const { app } = require('electron');
const isSquirrelStartup = require('electron-squirrel-startup');

/**
 * DisplayCore 主程序入口。
 *
 * 第 2 步只建立可安裝、可驗證的 Electron 專案骨架。
 * 應用程式生命週期與視窗建立會在第 3 步實作。
 */
async function bootstrap() {
  // Squirrel.Windows 在安裝或解除安裝時會短暫啟動程式，此時不應建立視窗。
  if (isSquirrelStartup) {
    app.quit();
    return;
  }

  await app.whenReady();

  if (process.argv.includes('--displaycore-smoke-test')) {
    console.info('[DisplayCore] Electron 專案骨架啟動成功。');
  } else {
    console.info('[DisplayCore] 專案骨架已就緒，主程序將於第 3 步建立。');
  }

  // 第 2 步沒有視窗，完成環境驗證後應主動結束，避免留下隱形背景程序。
  app.quit();
}

bootstrap().catch((error) => {
  console.error('[DisplayCore] 專案骨架啟動失敗。', error);
  app.exit(1);
});
