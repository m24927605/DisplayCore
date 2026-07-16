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
npm run start:main-smoke
npm start
npm run package
npm run make
```

- `npm run start:smoke`：只驗證 Electron 專案骨架，不建立視窗。
- `npm run start:main-smoke`：建立安全的 Control 與視窗化 Display，驗證後自動結束。
- `npm start`：啟動 Control Window 與全螢幕 Display Window。
- `npm run package`：產生目前作業系統的未安裝應用程式封裝。
- `npm run make`：產生安裝檔；Squirrel.Windows 應在 Windows 10／11 環境執行。

## 目前進度：第 3 步 Main Process

本階段已完成：

- 單一執行個體與 Electron App 生命週期管理。
- Control 與 Display 兩個安全 BrowserWindow 外殼。
- Display 的全螢幕、無框、置頂、不可聚焦與滑鼠穿透設定。
- Renderer 崩潰或 Display 意外關閉時自動原子重建雙視窗。
- 專用、非持久化且完全離線的 Electron Session。
- `displaycore://app/` 本機資源協定與路徑穿越防護。
- 權限、下載、網路請求、Popup、WebView 與 Renderer 導覽封鎖。
- 嚴格 CSP 的 Control／Display 占位頁。

主程序模組位置：

- `main/application-controller.js`：App 單例與生命週期。
- `main/window-manager.js`：雙視窗建立、聚焦與關閉。
- `main/window-options.js`：BrowserWindow 安全選項。
- `main/security-policy.js`：Session 與 WebContents 安全政策。
- `main/local-protocol.js`：受限的本機靜態資源協定。

IPC、正式 Control 介面、正式 Display 畫面、設定讀寫與 HDMI 自動偵測尚未實作，會依第 4～9 步逐項完成。第 9 步完成前，Display 由作業系統放在預設螢幕；Control 會維持在更高視窗層級，避免單螢幕測試時被 Display 遮住。
