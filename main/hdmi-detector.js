'use strict';

const { execFile: executeFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(executeFile);

const HDMI_CONNECTION_STATUSES = Object.freeze({
  CONNECTED: 'connected',
  NOT_CONNECTED: 'not-connected',
  UNKNOWN: 'unknown',
});

const HDMI_OUTPUT_TECHNOLOGY = 5;
const POWERSHELL_TIMEOUT_MS = 3_000;
const POWERSHELL_MAX_BUFFER_BYTES = 64 * 1024;
const POWERSHELL_QUERY = [
  "$ErrorActionPreference='Stop'",
  "$connections=@(Get-CimInstance -Namespace 'root\\wmi' -ClassName 'WmiMonitorConnectionParams'",
  "| Where-Object { $_.Active }",
  "| ForEach-Object { [uint32]$_.VideoOutputTechnology })",
  "if($connections.Count -eq 0){[Console]::Out.Write('[]')}",
  "else{[Console]::Out.Write(($connections | ConvertTo-Json -Compress))}",
].join(';');

const UNKNOWN_RESULT = Object.freeze({
  status: HDMI_CONNECTION_STATUSES.UNKNOWN,
  activeConnectionCount: 0,
  hdmiConnectionCount: 0,
});

/**
 * 將 Windows PowerShell 輸出轉成作用中顯示連接技術代碼。
 * Windows PowerShell 5.1 在單一值時會輸出數字而非陣列，因此兩者皆接受。
 *
 * @param {string} stdout
 * @returns {number[]}
 */
function parseConnectionTechnologies(stdout) {
  if (typeof stdout !== 'string') {
    throw new TypeError('PowerShell 輸出必須是字串。');
  }

  const normalized = stdout.replace(/^\uFEFF/, '').trim();

  if (normalized.length === 0) {
    return [];
  }

  const parsed = JSON.parse(normalized);
  const technologies = Array.isArray(parsed) ? parsed : [parsed];

  if (
    !technologies.every(
      (technology) =>
        Number.isInteger(technology) &&
        technology >= 0 &&
        technology <= 0xFFFFFFFF,
    )
  ) {
    throw new TypeError('PowerShell 回傳無效的顯示連接技術。');
  }

  return technologies;
}

/**
 * 使用 Windows 內建 WMI 判斷作用中顯示器是否經 HDMI 連接。
 *
 * 指令、參數與查詢內容全部固定，沒有 Renderer 或使用者輸入；並以 execFile
 * 關閉 shell、限制執行時間及輸出大小，避免命令注入與失控子程序。
 */
class HdmiDetector {
  /**
   * @param {object} [dependencies]
   * @param {NodeJS.Platform} [dependencies.platform]
   * @param {Function} [dependencies.execFile]
   * @param {{warn: Function}} [dependencies.logger]
   */
  constructor({
    platform = process.platform,
    execFile = execFileAsync,
    logger = console,
  } = {}) {
    this.platform = platform;
    this.execFile = execFile;
    this.logger = logger;
  }

  /**
   * @returns {Promise<{status: string, activeConnectionCount: number, hdmiConnectionCount: number}>}
   */
  async detect() {
    if (this.platform !== 'win32') {
      return UNKNOWN_RESULT;
    }

    try {
      const { stdout } = await this.execFile(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          POWERSHELL_QUERY,
        ],
        {
          encoding: 'utf8',
          maxBuffer: POWERSHELL_MAX_BUFFER_BYTES,
          shell: false,
          timeout: POWERSHELL_TIMEOUT_MS,
          windowsHide: true,
        },
      );
      const technologies = parseConnectionTechnologies(stdout);
      const hdmiConnectionCount = technologies.filter(
        (technology) => technology === HDMI_OUTPUT_TECHNOLOGY,
      ).length;

      return Object.freeze({
        status: hdmiConnectionCount > 0
          ? HDMI_CONNECTION_STATUSES.CONNECTED
          : HDMI_CONNECTION_STATUSES.NOT_CONNECTED,
        activeConnectionCount: technologies.length,
        hdmiConnectionCount,
      });
    } catch {
      this.logger.warn('[DisplayCore] Windows HDMI 狀態查詢失敗。');
      return UNKNOWN_RESULT;
    }
  }
}

module.exports = {
  HDMI_CONNECTION_STATUSES,
  HdmiDetector,
  parseConnectionTechnologies,
};
