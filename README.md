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

## 目前進度：第 5 步 Control Window

本階段已完成：

- 單一執行個體與 Electron App 生命週期管理。
- Control 與 Display 兩個安全 BrowserWindow 外殼。
- Display 的全螢幕、無框、置頂、不可聚焦與滑鼠穿透設定。
- Renderer 崩潰或 Display 意外關閉時自動原子重建雙視窗。
- 專用、非持久化且完全離線的 Electron Session。
- `displaycore://app/` 本機資源協定與路徑穿越防護。
- 權限、下載、網路請求、Popup、WebView 與 Renderer 導覽封鎖。
- 嚴格 CSP 的正式 Control 頁面與 Display 占位頁。
- Main Process 內唯一的 presentation 狀態與單調遞增 revision。
- Control → Main → Display 的固定白名單 IPC 路由。
- 依目前視窗、main frame 與精確 URL 驗證每一個 IPC sender。
- Control 與 Display 分離的 contextBridge API；Display 僅有唯讀能力。
- 固定成功／錯誤 envelope，不向 Renderer 洩漏 stack 或本機路徑。
- Renderer 重建後可透過完整 snapshot 取得最新顯示狀態。
- 真實 Electron sandbox preload IPC round-trip 整合測試。
- 可輸入完整編號或花名，包含 `001` 等前導零。
- `請至前廳`、`前廳000` 與 `自定義` 三種操作模式。
- 自定義模式可省略編號／花名，直接顯示公告等任意文字。
- 送出前的完整 message 預覽與 Main 目前顯示狀態分離。
- 一般訊息顯示、清除畫面與 IPC 操作結果提示。
- `555` 臨檢與 `888` 解除臨檢的滿屏模式及防誤觸確認對話框。
- 同步鎖定進行中的操作，避免雙擊或連續送出重複 IPC。
- 啟動時先訂閱再讀取 snapshot，並以 revision 防止舊狀態覆蓋新事件。
- 響應式、可鍵盤操作且具清楚焦點狀態的 Control 介面。
- 正式 Control DOM → sandbox preload → Main IPC 的 Electron 整合測試。

主程序模組位置：

- `main/application-controller.js`：App 單例與生命週期。
- `main/window-manager.js`：雙視窗建立、聚焦與關閉。
- `main/window-options.js`：BrowserWindow 安全選項。
- `main/security-policy.js`：Session 與 WebContents 安全政策。
- `main/local-protocol.js`：受限的本機靜態資源協定。

IPC 模組位置：

- `ipc/channels.js`：版本化 channel、角色與 layout 常數。
- `ipc/validators.js`：Main 端顯示 payload 白名單驗證。
- `ipc/presentation-store.js`：唯一 message 狀態與 revision。
- `ipc/ipc-coordinator.js`：sender 授權、request handler 與狀態廣播。
- `preload.js`：Control 的固定用途操作 API。
- `preload/display-preload.js`：Display 的唯讀 snapshot API。

Control 模組位置：

- `control/index.html`：語意化表單、目前狀態、滿屏代碼與後續功能區。
- `control/control.css`：Control 的響應式版面與可存取互動樣式。
- `control/message-composer.mjs`：固定動作、自定義與滿屏代碼組合規則。
- `control/presentation-state.mjs`：snapshot 結構與 revision 防亂序規則。
- `control/control-controller.mjs`：IPC envelope、操作鎖定與狀態協調。
- `control/app.mjs`：DOM adapter 與 preload bridge 接線。

## Control 操作方式

1. 在「編號或花名」輸入 `001`、`Nancy` 或其他原始文字。
2. 選擇「請至前廳」、「前廳000」或「自定義」。
3. 確認「完整訊息預覽」後按下「顯示到電視」。
4. 自定義公告可將編號／花名留空，例如直接輸入「公告今日停止服務」。
5. `555` 與 `888` 會先開啟確認對話框；確認後以 `fill-screen` 送出。
6. 「清除畫面」使用獨立 IPC，不會把 `888` 誤當成清除指令。

所有輸入都以純文字預覽與呈現，不會解析 HTML。編號／花名、自定義內容及
前後空白不會被 trim、正規化或轉換；Main 仍會套用 10,000 Unicode code point
的資源保護上限。

Presentation 契約只有一個 `message`，不拆成 title、編號、花名或其他固定欄位。`layout` 只控制排版方式：一般內容使用 `single-line`；Control 會將臨檢 `555`、解除臨檢 `888` 明確指定為 `fill-screen`。Main 與 Display 不依文字內容判斷代碼。

正式 Display 畫面、設定讀寫、Display 響應式排版與 HDMI 自動偵測尚未實作，會依第 6～9 步逐項完成。第 9 步完成前，Display 由作業系統放在預設螢幕；Control 會維持在更高視窗層級，避免單螢幕測試時被 Display 遮住。Control 內的 HDMI、輸出螢幕、全螢幕與設定區目前會明確顯示「尚未完成」，且不可操作。
