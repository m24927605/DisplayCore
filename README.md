# DisplayCore

DisplayCore 是一套完全離線、執行於 Windows 10／11 的 Electron 無人資訊顯示系統。

## 開發環境

- Node.js 24.18.0 LTS
- npm 11+
- Electron 43.1.1
- Electron Forge 7.11.2

## 專案指令

```bash
npm install
npm test
npm run start:smoke
npm run package
npm run make
```

目前完成第 2 步「建立 Electron 專案」。`npm run start:smoke` 會啟動 Electron、確認環境可用後正常結束。`main.js` 不建立任何視窗；雙視窗、IPC 與 Renderer 功能會依後續步驟逐一實作。

`npm run make` 的 Squirrel.Windows 安裝程式應在 Windows 10／11 環境建置。
