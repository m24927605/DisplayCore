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
- `npm run make`：產生安裝檔；Squirrel.Windows 應於 Windows 10／11 環境執行。

## 目前進度：第 7 步設定管理

本階段已完成：

- 單一執行個體、Electron App 生命週期與安全的雙 BrowserWindow 外殼。
- 專用、非持久化且完全離線的 Electron Session。
- `displaycore://app/` 本機資源協定與路徑穿越防護。
- 權限、下載、網路請求、Popup、WebView 與 Renderer 導覽封鎖。
- Renderer 啟用 sandbox 與 Context Isolation，關閉 Node Integration。
- Control 與 Display 分離的 contextBridge API；Display 只有讀取 snapshot 與訂閱能力。
- Main Process 內唯一的 presentation 狀態、單調遞增 revision 與 v2 IPC 契約。
- 依目前視窗、main frame 與精確 URL 驗證每個 IPC sender。
- 固定成功／錯誤 envelope，不向 Renderer 洩漏 stack 或本機路徑。
- Renderer 異常消失時原子重建雙視窗，包含非預期 `clean-exit`。
- `請至前廳`、`前廳000` 與 `自定義` 三種單則編輯模式。
- 編號或花名保留 `001` 等前導零；自定義可不填編號／花名而直接顯示公告。
- 本機待播清單可加入、刪除指定項目與清空，不會提前改變電視畫面。
- 每頁最多 5 則；第 6 則起自動分頁，最後一頁不足 5 則仍完整停留指定秒數。
- 可設定每頁 1～3,600 秒、整輪顯示 1～999 次，或改用持續顯示。
- Control 即時顯示頁數、每輪時間與預計總播放時間。
- Main Process 以串接 `setTimeout` 管理翻頁與整輪次數，Renderer 不控制 timer。
- 有限模式播完最後一輪、最後一頁的完整秒數後才自動清空。
- 新清單、清除畫面、555 或 888 會使舊 timer 失效，不會自動恢復舊播放。
- Display 只接收目前頁面的 1～5 則完整 `message`，不接收整份草稿清單。
- Display 以彈性排版、viewport 單位與有界二分搜尋自動縮放單行字體。
- 到達最小字級仍放不下時使用水平跑馬燈；不換行、不分段、不省略。
- `555` 臨檢與 `888` 解除臨檢使用獨立 IPC、確認對話框與 6×4 滿屏排版，不受單行限制。
- 啟動時先訂閱再取得 snapshot，並以 revision 防止舊狀態覆蓋新事件。
- Control、Display、IPC、排程器、安全邊界與真實 Electron Renderer 的自動化測試。
- 封裝內 `config.json` 作為唯讀、版本化的原廠預設值；執行期不會寫回應用程式目錄。
- 可寫設定儲存在 Electron `userData/displaycore-data/config.json`，首次啟動會自動建立。
- 設定檔使用精確 schema、64 KiB 上限、正規化與完整物件驗證，拒絕未知欄位。
- 設定以同目錄暫存檔、fsync 與 rename 原子寫入，並以 revision 防止過期表單覆寫新設定。
- 使用者設定損壞時保留原檔，先採安全預設值啟動並在 Control 顯示可修復警告。
- Logo 由 Main Process 原生選檔，只接受 PNG、JPEG、WebP 與真實檔案簽章。
- Logo 會複製至受管理的 `userData/displaycore-data/logos`；Renderer 不會取得來源絕對路徑。
- Control 提供獨立設定對話框、未儲存狀態、載入預設值、欄位錯誤與安全儲存流程。
- 第 7 步只保存設定；Logo、顏色、字型、日期時間與跑馬燈將於第 8 步套用至 Display。

## 播放模型

DisplayCore 不設定可能在頁面中途截斷的「整體顯示時間」。

- 1 輪：從第 1 頁播放到最後一頁一次。
- 每輪時間：頁數 × 每頁秒數。
- 預計總時間：每輪時間 × 整輪顯示次數。
- 有限模式完成所有整輪後清空；持續模式循環到新指令為止。

例如 7 則訊息、每頁 3 秒、整輪 10 次：每頁最多 5 則，因此共 2 頁；每輪 6 秒，預計總播放時間為 60 秒。

## Control 操作方式

1. 在「編號或花名」輸入 `001`、`Nancy` 或其他原始文字。
2. 選擇「請至前廳」、「前廳000」或「自定義」。
3. 確認完整 `message` 預覽，按「加入顯示清單」。
4. 重複加入需要的訊息，並在待播清單中檢查順序與分頁。
5. 設定每頁秒數，選擇整輪次數或持續顯示。
6. 確認頁數、每輪時間與預計總時間，按「顯示清單到電視」。
7. `555` 與 `888` 會先開啟確認對話框；確認後立即覆蓋一般清單。
8. 「清空待播清單」只刪除未送出草稿；「清除電視畫面」只清除 Main 目前播放。
9. 按「開啟系統設定」可調整本機設定；「載入預設值」只改草稿，仍須按「儲存設定」。

所有輸入都以純文字預覽與呈現，不會解析 HTML。編號／花名、自定義內容及前後空白不會被 trim、正規化或轉換。Main 會再次套用最多 500 則與合計 10,000 Unicode code point 的資源保護上限。

## 設定檔與 Logo

專案根目錄的 `config.json` 隨應用程式封裝，只提供經版本控制的安全預設值。實際修改會寫入 Electron 解析出的 `userData/displaycore-data/config.json`；程式不硬編 Windows 使用者路徑，也不會修改 ASAR 或安裝目錄。

可設定欄位包括：

- Logo 是否顯示與受管理的相對資產名稱。
- 背景顏色、字型、字體顏色與最小字體大小。
- 是否顯示日期時間、12／24 小時制與日期語系。
- 最小字體仍放不下時是否使用水平跑馬燈。
- 預設顯示模式與全螢幕偏好；實體螢幕選擇於第 9 步啟用。

Logo 選擇由 Main Process 開啟系統原生對話框。來源圖片經檔案類型、大小、符號連結、路徑及 magic bytes 驗證後，才原子複製到受管理目錄；設定只保存 `logos/...` 相對名稱。即使設定檔或 IPC payload 被竄改，Main 端仍會重新驗證。

## 模組位置

主程式：

- `main/application-controller.js`：App 單例與生命週期。
- `main/window-manager.js`：雙視窗建立、聚焦、關閉與異常復原。
- `main/window-options.js`：BrowserWindow 安全選項。
- `main/security-policy.js`：Session 與 WebContents 安全政策。
- `main/local-protocol.js`：受限的本機靜態資源協定。

IPC：

- `ipc/channels.js`：版本化 channel、角色、顯示與播放模式常數。
- `ipc/validators.js`：Main 端 payload 白名單與資源上限。
- `ipc/presentation-store.js`：不可變播放狀態機、分頁投影與 revision。
- `ipc/presentation-service.js`：翻頁 timer、整輪推進與狀態發布。
- `ipc/ipc-coordinator.js`：sender 授權、request handler 與雙視窗廣播。
- `preload.js`：Control 的顯示操作、設定讀寫與 Logo 選擇固定用途 API。
- `preload/display-preload.js`：Display 的唯讀 snapshot API。

設定：

- `config.json`：封裝內唯讀預設設定。
- `config/config-schema.js`：完整設定 schema、正規化與資源上限。
- `config/config-manager.js`：初始化、snapshot、revision 與原子持久化。
- `config/logo-importer.js`：原生選檔、圖片驗證及受管理資產匯入。

Control：

- `control/index.html`：單則編輯、分頁草稿、整輪設定、目前狀態、滿屏代碼與設定對話框。
- `control/control.css`：響應式版面、可存取互動與視覺層級。
- `control/message-composer.mjs`：固定動作、自定義與滿屏代碼組合規則。
- `control/program-builder.mjs`：不可變草稿、分頁計算、整輪 program 與時間試算。
- `control/presentation-state.mjs`：snapshot 結構與 revision 防亂序規則。
- `control/control-controller.mjs`：IPC envelope、操作鎖定與狀態協調。
- `control/settings-model.mjs`：設定 snapshot、草稿驗證與 dirty 比較。
- `control/settings-controller.mjs`：設定 IPC envelope、防重送與錯誤協調。
- `control/settings-view.mjs`：設定對話框、欄位投影、預設值與儲存互動。
- `control/app.mjs`：DOM adapter、草稿操作與 preload bridge 接線。

Display：

- `display/index.html`：無互動元素的唯讀顯示舞台。
- `display/display.css`：單行分頁、跑馬燈與 6×4 滿屏響應式排版。
- `display/presentation-state.mjs`：Display snapshot 白名單與 revision 驗證。
- `display/display-controller.mjs`：先訂閱後查詢與亂序防護。
- `display/text-fit.mjs`：有界二分搜尋字體適配。
- `display/app.mjs`：純文字呈現、字體適配、跑馬燈與 ResizeObserver。

Presentation 中每個項目只有一個完整 `message`，不會拆成 title、編號、花名或動作欄位。Main 與 Display 不依一般文字內容判斷 555／888。

## 尚未進入的步驟

- 第 8 步：將 Logo、日期時間、顏色、字型與跑馬燈設定完整套用到多解析度畫面。
- 第 9 步：HDMI 自動偵測、輸出螢幕選擇與 Display 全螢幕切換。
- 第 10 步：Windows 10／11 實機與目標解析度的完整驗收。

第 9 步完成前，Display 由作業系統放在預設螢幕；Control 內 HDMI、輸出螢幕與全螢幕區會維持明確的「尚未完成」狀態。
