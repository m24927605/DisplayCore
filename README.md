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

## 目前進度：第 10 步軟體 QA 與 macOS 外接螢幕驗收完成；Windows 實機驗收待進行

本階段已完成：

- 單一執行個體、Electron App 生命週期與安全的雙 BrowserWindow 外殼。
- 專用、非持久化且完全離線的 Electron Session。
- `displaycore://app/` 本機資源協定與路徑穿越防護。
- 權限、下載、網路請求、Popup、WebView 與 Renderer 導覽封鎖。
- Renderer 啟用 sandbox 與 Context Isolation，關閉 Node Integration。
- Control 與 Display 分離的 contextBridge API；Display 只能讀取 snapshot、訂閱及回報受限的目前版面進度。
- Main Process 內唯一的 presentation 狀態、單調遞增 revision 與 v2 IPC 契約。
- 依目前視窗、main frame 與精確 URL 驗證每個 IPC sender。
- 固定成功／錯誤 envelope，不向 Renderer 洩漏 stack 或本機路徑。
- Renderer 異常消失時原子重建雙視窗，包含非預期 `clean-exit`。
- `請至前廳`、`前廳000`、`聯絡櫃台` 與 `自定義` 四種單則編輯模式。
- 編號或花名保留 `001` 等前導零；自定義可不填編號／花名而直接顯示公告。
- 沒有一般訊息時自動進入待機畫面，只以原歡迎文字的大字級置中顯示校正後的 `HH:mm:ss`；啟用 Logo 時會置中顯示在時間上方，待機背景可使用固定圖片或最多 20 張圖片輪播。
- 固定營運訊息只保留置中的「請輕聲細語」；一般與自定訊息仍以單一「顯示」動作立即更新電視，沒有待播清單或二次確認流程。
- 每頁最多 3 則；第 4 則起自動分頁，最後一頁不足 3 則仍至少完整停留指定秒數。
- 可持久設定每頁 1～3,600 秒的最短停留時間、整輪顯示 1～999 次，或改用持續顯示；重新啟動後仍保留。
- Control 右側分開呈現唯讀「即時狀態」與可操作「顯示清單」；清單每頁最多 3 則，可獨立翻頁、逐筆刪除或全部刪除，不會因電視自動換頁而跳動。
- Main Process 同時等待「Display layout ready 後的最短停留時間」與「目前頁所有跑馬燈各完成一輪」，兩者都滿足才翻頁。
- 有限模式播完最後一輪、最後一頁的最短時間，且所有跑馬燈完成後才自動清空。
- 新訊息內容、清除畫面、555 或 888 會使舊 timer 失效，不會自動恢復舊播放。
- Display 只接收目前頁面的 1～3 則完整 `message`，不接收整份草稿清單。
- Display 以 Flexbox、CSS Grid 與 container query 單位建立響應式排版；置中的營運訊息使用有界二分搜尋自動縮放單行字體。
- 一般訊息固定保留每頁 3 個槽位與同一響應式字級，1～3 則都從訊息區左上開始，不因數量或文字長度改變字級；每則維持單行、不換行、不分段、不省略，放不下時依設定使用水平跑馬燈或水平壓縮。
- 啟用跑馬燈時以 DisplayCore 設定為準，不受作業系統 `prefers-reduced-motion` 停用；多列跑馬燈必須每列各完成第一次 traversal。
- Resize、外觀設定變更、同一 WebContents reload 或 Display Renderer 重建會使舊 timer 與動畫事件失效；Main 核發新的 Display 可見世代，新 layout 未 ready 前採 fail-closed 保留目前頁。
- `555` 臨檢與 `888` 解除臨檢使用獨立 IPC、確認對話框與 6×4 滿屏排版，不受單行或顯示時間限制；555 持續到 888、清除或新訊息，888 持續到清除或新訊息；兩者可分別設定背景顏色。
- 啟動時先訂閱再取得 snapshot，並以 revision 防止舊狀態覆蓋新事件。
- Control、Display、IPC、排程器、安全邊界與真實 Electron Renderer 的自動化測試。
- 封裝內 `config.json` 作為唯讀、版本化的原廠預設值；執行期不會寫回應用程式目錄。
- 可寫設定儲存在 Electron `userData/displaycore-data/config.json`，首次啟動會自動建立。
- 設定檔使用精確 schema、64 KiB 上限、正規化與完整物件驗證，拒絕未知欄位。
- 設定以同目錄暫存檔、fsync 與 rename 原子寫入，並以 revision 防止過期表單覆寫新設定。
- 使用者設定損壞時保留原檔，先採安全預設值啟動並在 Control 顯示可修復警告。
- Logo 與待機背景由 Main Process 原生選檔；Logo 固定單選，待機背景依固定／輪播模式單選或一次選取最多 20 張，只接受每張 10 MiB 以內的 PNG、JPEG、WebP 與真實檔案簽章。
- 圖片會依用途複製至受管理目錄；Renderer 只取得同源內容雜湊 URL，不會取得來源或 `userData` 絕對路徑。
- Control 提供獨立設定對話框、未儲存狀態、載入預設值、欄位錯誤與安全儲存流程。
- Main 只將 Display 所需的唯讀設定白名單投影至專用 IPC，不會傳送預設設定、警告內容、本機路徑或 Control 寫入能力。
- Logo 與待機背景透過各自的 `displaycore://app/managed/...` 受限路由載入；每次請求都重新核對目前設定、檔案類型、大小、簽章與內容雜湊。
- Logo 大小、待機背景、背景色、字型、字色、整體字體比例、行距、最小字級、555／888 背景、時間與跑馬燈設定會在儲存後即時套用至 Display，不必重新啟動或重送播放內容。
- Logo 尺寸可在 50%～1000% 之間以 5% 調整，一般訊息與待機畫面共用；50%～200% 維持等比例，較高數值持續壓縮成長至安全上限，避免擠掉訊息或時間。透明背景 Logo 會呈現為亮白輪廓，JPG 或不透明圖片則保留原圖並使用亮白底襯，避免整張變成白色方塊。
- 待機背景輪播可設定每張 1～3,600 秒；第一張直接顯示，後續圖片以舊圖由左向右碎成沙粒並向右飄散的轉場揭露。轉場完成後才開始計算新圖片停留時間；顯示一般訊息或 555／888 時停止輪播，回到待機畫面時從第一張重新開始。
- 待機時間置中顯示；一般訊息頁的時間放大顯示於右上角，並與 Logo 位於同一頂部列。兩者都只顯示 24 小時制 `HH:mm:ss`，並對齊下一個整秒更新。
- 管理員可用 `HH:mm:ss` 校正 DisplayCore 顯示時間；程式只保存日內偏移，不修改 Windows 系統時間，也不需要網路或系統管理員權限。
- 一般畫面會為同列的 Logo 與右上角時間保留比例式頂部安全區；臨檢滿屏會隱藏所有裝飾資訊。
- 一般與自定義訊息固定置頂靠左；營運訊息「請輕聲細語」、555／888 與待機時間維持置中或其專用位置。對齊方式由 Main 明確傳遞，Display 不解析文字內容猜測用途。
- 管理員可選自動、1366×768、1600×900、1920×1080、2560×1440 或 3840×2160 排版基準；Display 以等比例 contain 置中縮放，不裁切或拉伸。此設定不指定輸出螢幕，也不變更 Windows 的 HDMI 實體輸出模式。
- 真實 Electron Renderer 自動驗證 1366×768、1600×900、1920×1080、2560×1440 與 3840×2160，包含溢位、重疊、字體縮放、跑馬燈切換及即時設定更新。
- Main Process 透過 Electron `screen` 維護可用螢幕拓樸，監聽新增、移除、尺寸／DPI 變更，以及系統恢復與解鎖。
- 輸出路由完全自動：優先使用外接螢幕，拔除後回退主螢幕，重新接入時自動返回外接螢幕。
- Display Window 在載入頁面前先依目標螢幕的 DIP bounds 定位，並始終使用原生全螢幕；macOS 託管輸出也明確保留 `fullscreenable`，不會留下頂端選單列。Control 不提供手動指定螢幕或視窗模式。
- Windows 只從受信任的 `SystemRoot\System32\WindowsPowerShell` 絕對路徑執行固定、無使用者輸入的 WMI 查詢；只有明確的空陣列代表未連接，逾時、空白或畸形輸出則顯示 unknown，不影響正常螢幕路由。
- HDMI 查詢在背景執行，熱插拔事件會 debounce 並保持 single-flight，不會阻塞雙視窗啟動或連續建立 PowerShell 子程序。
- Control 頁首只讀呈現 HDMI 與目前實際輸出目標；輸出 snapshot 不包含 bounds、WMI 裝置路徑或 raw Electron 物件。
- Control 只保留一個齒輪設定入口，播放、Logo、外觀與顯示行為集中在同一對話框。
- 完整自動化測試 338/338 通過，覆蓋播放設定持久化、一鍵顯示、Logo 最高 1000%／透明度處理／高亮、固定及風吹沙輪播待機背景、一般訊息固定三槽、原生全螢幕回歸、離線校時、排版解析度、顯示清單獨立分頁與刪除、555／888 無限時、內容版本競態保護、雙閘門排程、多列跑馬燈與 Renderer 重建。
- 真實 Electron Renderer 已驗證 Control／Display 完整流程、7 則訊息的 3＋3＋1 分頁、555／888 滿屏與五種目標解析度，且沒有 Renderer console error 或 warning。
- 已修正設定對話框原生焦點恢復競態並加入確定性 Electron 回歸測試。
- macOS 與 Windows x64 交叉封裝的 ASAR 均確認不含 `.ait`、`ait`、`*.ait` 或 `.gstack` QA 產物；Forge 規則有正例及 `wait/` 負例測試。
- dependencies 與 devDependencies 的 `npm audit` 均為 0 vulnerabilities；封裝已驗證安全 Electron fuses、ASAR integrity 與 macOS code signature。

## 播放模型

DisplayCore 不設定可能在頁面中途截斷的「整體顯示時間」。

- 1 輪：從第 1 頁播放到最後一頁一次。
- 每輪最短時間：頁數 × 每頁最短秒數。
- 預計最短總時間：每輪最短時間 × 整輪顯示次數。
- 若某頁需要跑馬燈，該頁會等所有列各完整跑完一輪；實際時間可能高於試算下限。
- 有限模式完成所有整輪後清空；持續模式循環到新指令為止。

例如 7 則訊息、每頁最短 3 秒、整輪 10 次：每頁最多 3 則，因此共 3 頁；每輪至少 9 秒，預計最短總播放時間為 90 秒。若其中一頁的跑馬燈需 8 秒才完成，該頁會自動延長，不會在第 3 秒截斷。

## Control 操作方式

1. 沒有一般訊息時，電視會自動以大字置中顯示目前時間；不需要手動加入。
2. 要顯示固定營運訊息時，直接按「請輕聲細語」；內容會置中加入目前電視畫面。
3. 要顯示一般訊息時，在「編號或花名」輸入 `001`、`Nancy` 或其他原始文字，再選擇「請至前廳」、「前廳000」、「聯絡櫃台」或「自定義」。
4. 確認完整 `message` 預覽後按「顯示」；內容會立即加入目前電視畫面，不需要再送出一次清單。
5. 右側「即時狀態」只供觀看，反映電視真正正在播放的頁面；「顯示清單」可獨立分頁瀏覽，每頁最多 3 則，並提供逐筆刪除與全部刪除。
6. 齒輪設定內的所有變更都由同一個「儲存設定」按鈕保存；播放秒數、整輪次數與播放方式會從下一次顯示或移除操作開始採用。
7. `555` 與 `888` 會先開啟確認對話框；確認後立即覆蓋一般訊息，並使用不受單行與顯示時間限制的滿屏排版，直到清除、解除或送出新的顯示指令。
8. 頁首只讀顯示 HDMI 與目前輸出目標。DisplayCore 會自動選擇外接螢幕，沒有外接螢幕時使用主螢幕。

所有輸入都以純文字預覽與呈現，不會解析 HTML。編號／花名、自定義內容及前後空白不會被 trim、正規化或轉換。Main 會再次套用最多 500 則與合計 10,000 Unicode code point 的資源保護上限。

## 設定檔與圖片

專案根目錄的 `config.json` 隨應用程式封裝，只提供經版本控制的安全預設值。實際修改會寫入 Electron 解析出的 `userData/displaycore-data/config.json`；程式不硬編 Windows 使用者路徑，也不會修改 ASAR 或安裝目錄。

可設定欄位包括：

- Logo 是否顯示、受管理的相對資產名稱與 50%～1000% 顯示尺寸；啟用後同時用於一般訊息頁及待機時間上方。
- 待機畫面使用固定或輪播背景、0～20 張有序圖片及每張 1～3,600 秒；固定模式使用第一張，清除全部圖片後回到純色背景。
- 背景顏色、字型、字體顏色、整體字體大小比例、行距與營運訊息自動縮字下限；字體比例也套用於固定字級的一般訊息、待機時間及 555／888。
- 555 臨檢與 888 解除臨檢各自的背景顏色。
- 是否在一般訊息頁右上角顯示與 Logo 同列的 24 小時制 `HH:mm:ss`；待機畫面永遠顯示時間。
- DisplayCore 專用的離線時間偏移，可在設定頁以 `HH:mm:ss` 重新校正，不修改作業系統時鐘。
- Display 的邏輯排版解析度；實際 HDMI 輸出解析度仍由 Windows 顯示設定控制。
- 一般訊息超出單行寬度時是否使用水平跑馬燈；停用時改用水平壓縮保留全文。
- 每頁顯示秒數、指定整輪次數或持續顯示模式。

目前設定格式為 `configVersion: 7`。既有的有效 v1～v6 使用者設定會在載入時於記憶體安全遷移至 v7；v5／v6 的單張待機背景會轉成有序圖片清單，下一次儲存才原子寫回。程式仍不提供手動指定輸出螢幕、視窗模式或作業系統顯示模式。

Logo 與待機背景都由 Main Process 開啟系統原生對話框；Logo 單選，待機背景依模式單選或多選。整批來源圖片通過檔案類型、大小、符號連結、路徑及 magic bytes 驗證後，才原子複製到各自的受管理目錄；設定只保存有序的相對資產識別。Display 只取得由內容雜湊組成的同源 URL，不會接觸 `userData` 或絕對路徑。即使設定檔、URL 或 IPC payload 被竄改，Main 端仍會重新驗證。

## 模組位置

主程式：

- `main/application-controller.js`：App 單例與生命週期。
- `main/window-manager.js`：雙視窗建立、聚焦、關閉與異常復原。
- `main/window-options.js`：BrowserWindow 安全選項。
- `main/security-policy.js`：Session 與 WebContents 安全政策。
- `main/local-protocol.js`：受限的本機靜態資源、目前啟用 Logo 與待機背景同源協定。
- `main/hdmi-detector.js`：Windows 本機 WMI HDMI aggregate 查詢、逾時與安全降級。
- `main/display-topology-service.js`：螢幕正規化、外接／主螢幕自動目標選擇、熱插拔與休眠恢復。
- `main/display-placement-controller.js`：以 Electron DIP bounds 定位目標螢幕並套用全螢幕。

IPC：

- `ipc/channels.js`：版本化 channel、角色、顯示與播放模式常數。
- `ipc/validators.js`：Main 端 payload 白名單與資源上限。
- `ipc/presentation-store.js`：不可變播放狀態機、分頁投影與 revision。
- `ipc/presentation-service.js`：最短時間／跑馬燈雙閘門、整輪推進與狀態發布。
- `ipc/display-settings.js`：將完整設定投影為 Display 所需的唯讀安全白名單。
- `ipc/output-status.js`：將拓樸與定位狀態投影為 Control 所需的最小唯讀白名單。
- `ipc/ipc-coordinator.js`：sender 授權、request handler 與雙視窗廣播。
- `preload.js`：Control 的顯示操作、設定讀寫與受管理圖片選擇固定用途 API。
- `preload/display-preload.js`：Display 的唯讀 snapshot 與固定用途版面進度回報 API。

設定：

- `config.json`：封裝內唯讀預設設定。
- `config/config-schema.js`：完整設定 schema、正規化與資源上限。
- `config/config-migrations.js`：舊版設定的嚴格、不可變遷移。
- `config/config-manager.js`：初始化、snapshot、revision 與原子持久化。
- `config/managed-image-importer.js`：共用的原生選檔、圖片驗證及內容定址受管理資產匯入核心。
- `config/logo-importer.js`：Logo 專用的受管理圖片匯入器。
- `config/standby-background-importer.js`：待機背景專用的受管理圖片匯入器。

Control：

- `control/index.html`：固定營運訊息、單則編輯、唯讀即時狀態、可分頁顯示清單、滿屏代碼與齒輪設定對話框。
- `control/control.css`：響應式版面、可存取互動與視覺層級。
- `control/message-composer.mjs`：固定動作、自定義與滿屏代碼組合規則。
- `control/message-list-pagination.mjs`：顯示清單獨立分頁、頁碼修正與全域項目索引。
- `control/program-builder.mjs`：不可變草稿、分頁計算、整輪 program 與時間試算。
- `control/presentation-state.mjs`：snapshot 結構與 revision 防亂序規則。
- `control/control-controller.mjs`：IPC envelope、操作鎖定與狀態協調。
- `control/settings-model.mjs`：設定 snapshot、草稿驗證與 dirty 比較。
- `control/settings-controller.mjs`：設定 IPC envelope、防重送與錯誤協調。
- `control/settings-view.mjs`：設定對話框、欄位投影、預設值與儲存互動。
- `control/time-calibration.mjs`：嚴格 `HH:mm:ss` 解析、格式化與跨午夜日內偏移計算。
- `control/output-state.mjs`：輸出 snapshot exact schema、雙 revision 防亂序與 UI 狀態衍生。
- `control/output-controller.mjs`：先訂閱後查詢、錯誤復原與最後有效狀態保留。
- `control/output-view.mjs`：HDMI 與實際輸出分離的即時狀態卡。
- `control/app.mjs`：DOM adapter、立即顯示／移除操作與 preload bridge 接線。

Display：

- `display/index.html`：無互動元素的唯讀顯示舞台。
- `display/display.css`：Logo 響應式尺寸／亮白輪廓與底襯、時鐘安全區、待機滿版背景、單行分頁、跑馬燈與 6×4 滿屏排版。
- `display/logo-appearance.mjs`：依縮小後的 alpha 樣本選擇亮白輪廓或亮白底襯，不保存圖片像素。
- `display/presentation-state.mjs`：Display snapshot 白名單與 revision 驗證。
- `display/display-controller.mjs`：先訂閱後查詢與亂序防護。
- `display/settings-state.mjs`：Display 設定白名單、型別驗證、安全預設值與 revision 防亂序規則。
- `display/settings-controller.mjs`：獨立於播放狀態的設定訂閱、查詢與錯誤復原。
- `display/standby-background-player.mjs`：待機背景固定／輪播、成功載入後計時、離開待機暫停及錯誤圖片有界跳過。
- `display/date-time.mjs`：本機 24 小時制 `HH:mm:ss`、離線偏移與整秒對齊排程。
- `display/render-resolution.mjs`：自動或固定邏輯解析度的等比例縮放與置中計算。
- `display/text-fit.mjs`：依實際列高計算有效字級範圍並執行有界二分搜尋。
- `display/page-progress.mjs`：layout generation、跑馬燈列完成追蹤、舊 DOM listener 取消及暫時性 IPC 失敗重試。
- `display/app.mjs`：純文字呈現、即時視覺設定、待機背景輪播、Logo 比例、時鐘、字體適配、跑馬燈與 ResizeObserver。

Presentation 中每個項目只有一個完整 `message`，不會拆成 title、編號、花名或動作欄位；額外的 `alignment` 只描述呈現方式。555／888 的模式由專用 IPC 狀態傳遞，Display 不依文字內容判斷緊急類型。

## HDMI 判定範圍

Electron `screen` 能可靠取得可用顯示器、內建／外接資訊、DIP 座標及熱插拔事件，但 `Display` 沒有實體 connector type。因此 DisplayCore 將兩件事分開處理：

- 視窗路由依 Electron 顯示器拓樸自動選擇外接螢幕，沒有外接螢幕時回退主螢幕。
- HDMI 狀態是 Windows WMI 對全機作用中輸出的 aggregate 回報，不能證明目前選取的某一台螢幕使用 HDMI。

因此 Control 只把 HDMI 當作全機連線狀態，不宣稱目前輸出目標必然使用 HDMI。非 Windows 或 WMI 無法查詢時，HDMI 會顯示「無法判定」，而不是誤報「未連接」。

## 尚待實機驗收

- Windows 10／11 實機、HDMI 電視、熱插拔、睡眠恢復、混合 DPI、目標解析度及 Squirrel.Windows 安裝流程仍需在 Windows 硬體執行。
