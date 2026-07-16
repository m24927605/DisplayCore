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

## 目前進度：第 9 步 HDMI 與輸出螢幕管理

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
- Display 以 Flexbox、CSS Grid、viewport 單位與有界二分搜尋自動縮放單行字體。
- 一般訊息固定為每頁 1～5 行，每則維持單行、不換行、不分段、不省略；到達有效最小字級仍放不下時，依設定使用水平跑馬燈或水平壓縮。
- `555` 臨檢與 `888` 解除臨檢使用獨立 IPC、確認對話框與 6×4 滿屏排版，不受單行限制，並固定採黑底白字以維持緊急狀態辨識度。
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
- Main 只將 Display 所需的唯讀設定白名單投影至專用 IPC，不會傳送預設設定、警告內容、本機路徑或 Control 寫入能力。
- Logo 透過同源的 `displaycore://app/managed/logo/...` 受限路由載入；每次請求都重新核對目前設定、檔案類型、大小、簽章與內容雜湊。
- Logo、背景色、字型、字色、最小字級、日期時間與跑馬燈設定會在儲存後即時套用至 Display，不必重新啟動或重送播放內容。
- 日期時間依設定語系與 12／24 小時制格式化，更新排程對齊下一個整分鐘，避免長時間運作累積漂移。
- 一般畫面會為 Logo 與日期時間保留比例式安全區；空白畫面與臨檢滿屏會隱藏所有裝飾資訊。
- 真實 Electron Renderer 自動驗證 1366×768、1600×900、1920×1080、2560×1440 與 3840×2160，包含溢位、重疊、字體縮放、跑馬燈切換及即時設定更新。
- Main Process 透過 Electron `screen` 維護可用螢幕拓樸，監聽新增、移除、尺寸／DPI 變更，以及系統恢復與解鎖。
- 自動模式優先使用外接螢幕，沒有可用外接螢幕時回退主螢幕；外接電視被設為 Windows 主螢幕時也能正確辨識。
- 手動模式保存指定 Display ID；螢幕中斷時暫用主螢幕但不覆寫原設定，重新連接同一 ID 後自動恢復。
- Display Window 在載入頁面前先依目標螢幕的 DIP bounds 定位；可切換全螢幕或可用區 80% 的置中 16:9 視窗。
- Windows 只從受信任的 `SystemRoot\\System32\\WindowsPowerShell` 絕對路徑執行固定、無使用者輸入的 WMI 查詢；只有明確的空陣列代表未連接，逾時、空白或畸形輸出則顯示 unknown，不影響正常螢幕路由。
- HDMI 查詢在背景執行，熱插拔事件會 debounce 並保持 single-flight，不會阻塞雙視窗啟動或連續建立 PowerShell 子程序。
- Control 以獨立狀態卡呈現 HDMI、實際輸出目標、全螢幕模式及螢幕數；輸出 snapshot 不包含 bounds、WMI 裝置路徑或 raw Electron 物件。
- Control 設定對話框可選自動／指定螢幕與全螢幕；拓樸事件不會覆蓋尚未儲存的表單草稿。

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
9. 按「開啟系統設定」可調整本機設定；「載入預設值」只改草稿，按「儲存設定」後才會保存並即時更新 Display。
10. 「螢幕連線與輸出」會即時顯示 HDMI 與實際輸出狀態；按「管理輸出設定」可直接開啟輸出偏好，選擇自動／指定螢幕及全螢幕。

所有輸入都以純文字預覽與呈現，不會解析 HTML。編號／花名、自定義內容及前後空白不會被 trim、正規化或轉換。Main 會再次套用最多 500 則與合計 10,000 Unicode code point 的資源保護上限。

## 設定檔與 Logo

專案根目錄的 `config.json` 隨應用程式封裝，只提供經版本控制的安全預設值。實際修改會寫入 Electron 解析出的 `userData/displaycore-data/config.json`；程式不硬編 Windows 使用者路徑，也不會修改 ASAR 或安裝目錄。

可設定欄位包括：

- Logo 是否顯示與受管理的相對資產名稱。
- 背景顏色、字型、字體顏色與最小字體大小。
- 是否顯示日期時間、12／24 小時制與日期語系。
- 最小字體仍放不下時是否使用水平跑馬燈。
- 自動／指定螢幕、指定 Display ID 與全螢幕偏好。

Logo 選擇由 Main Process 開啟系統原生對話框。來源圖片經檔案類型、大小、符號連結、路徑及 magic bytes 驗證後，才原子複製到受管理目錄；設定只保存 `logos/...` 相對名稱。Display 只取得由內容雜湊組成的同源 URL，不會接觸 `userData` 或絕對路徑。即使設定檔、URL 或 IPC payload 被竄改，Main 端仍會重新驗證。

## 模組位置

主程式：

- `main/application-controller.js`：App 單例與生命週期。
- `main/window-manager.js`：雙視窗建立、聚焦、關閉與異常復原。
- `main/window-options.js`：BrowserWindow 安全選項。
- `main/security-policy.js`：Session 與 WebContents 安全政策。
- `main/local-protocol.js`：受限的本機靜態資源與目前啟用 Logo 同源協定。
- `main/hdmi-detector.js`：Windows 本機 WMI HDMI aggregate 查詢、逾時與安全降級。
- `main/display-topology-service.js`：螢幕正規化、自動／手動目標選擇、熱插拔與休眠恢復。
- `main/display-placement-controller.js`：以 Electron DIP bounds 套用全螢幕或置中視窗位置。

IPC：

- `ipc/channels.js`：版本化 channel、角色、顯示與播放模式常數。
- `ipc/validators.js`：Main 端 payload 白名單與資源上限。
- `ipc/presentation-store.js`：不可變播放狀態機、分頁投影與 revision。
- `ipc/presentation-service.js`：翻頁 timer、整輪推進與狀態發布。
- `ipc/display-settings.js`：將完整設定投影為 Display 所需的唯讀安全白名單。
- `ipc/output-status.js`：將拓樸與定位狀態投影為 Control 所需的最小唯讀白名單。
- `ipc/ipc-coordinator.js`：sender 授權、request handler 與雙視窗廣播。
- `preload.js`：Control 的顯示操作、設定讀寫與 Logo 選擇固定用途 API。
- `preload/display-preload.js`：Display 的唯讀播放與顯示設定 snapshot API。

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
- `control/output-state.mjs`：輸出 snapshot exact schema、雙 revision 防亂序與 UI 狀態衍生。
- `control/output-controller.mjs`：先訂閱後查詢、錯誤復原與最後有效狀態保留。
- `control/output-view.mjs`：HDMI 與實際輸出分離的即時狀態卡。
- `control/app.mjs`：DOM adapter、草稿操作與 preload bridge 接線。

Display：

- `display/index.html`：無互動元素的唯讀顯示舞台。
- `display/display.css`：Logo／時鐘安全區、單行分頁、跑馬燈與 6×4 滿屏響應式排版。
- `display/presentation-state.mjs`：Display snapshot 白名單與 revision 驗證。
- `display/display-controller.mjs`：先訂閱後查詢與亂序防護。
- `display/settings-state.mjs`：Display 設定白名單、型別驗證、安全預設值與 revision 防亂序規則。
- `display/settings-controller.mjs`：獨立於播放狀態的設定訂閱、查詢與錯誤復原。
- `display/date-time.mjs`：本機日期時間格式化與整分鐘對齊排程。
- `display/text-fit.mjs`：依實際列高計算有效字級範圍並執行有界二分搜尋。
- `display/app.mjs`：純文字呈現、即時視覺設定、Logo、時鐘、字體適配、跑馬燈與 ResizeObserver。

Presentation 中每個項目只有一個完整 `message`，不會拆成 title、編號、花名或動作欄位。Main 與 Display 不依一般文字內容判斷 555／888。

## HDMI 判定範圍

Electron `screen` 能可靠取得可用顯示器、內建／外接資訊、DIP 座標及熱插拔事件，但 `Display` 沒有實體 connector type。因此 DisplayCore 將兩件事分開處理：

- 視窗路由依 Electron 顯示器拓樸選擇外接或手動指定螢幕。
- HDMI 狀態是 Windows WMI 對全機作用中輸出的 aggregate 回報，不能證明目前選取的某一台螢幕使用 HDMI。

因此 Control 不會把任何單一螢幕選項標成 HDMI；DisplayPort、USB-C、轉接器、虛擬或遠端顯示環境仍可能出現在螢幕清單。非 Windows 或 WMI 無法查詢時，HDMI 會顯示「無法判定」，而不是誤報「未連接」。

## 尚未進入的步驟

- 第 10 步：Windows 10／11 實機、HDMI 電視、熱插拔、睡眠恢復、混合 DPI 與目標解析度的完整驗收。
