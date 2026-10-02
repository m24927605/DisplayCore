'use strict';

const { execFile: executeFile } = require('node:child_process');
const fileSystem = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');

const { resolvePowerShellExecutable } = require('./hdmi-detector');

const execFileAsync = promisify(executeFile);

// Add-Type 每次都需編譯 C#，DDC/CI 讀寫也可能等待螢幕回應。
const POWERSHELL_TIMEOUT_MS = 20_000;
const POWERSHELL_MAX_BUFFER_BYTES = 256 * 1024;
const MAXIMUM_MODE_COUNT = 512;
const MAXIMUM_DIMENSION = 16_384;
const SOURCE_ENVIRONMENT_KEY = 'DISPLAYCORE_MONITOR_CONTROL_SOURCE';
const APPLY_RESULTS = new Set(['unchanged', 'applied', 'unsupported', 'failed']);

const CONTROL_SOURCE = fileSystem.readFileSync(
  path.join(__dirname, 'monitor-control.cs'),
  'utf8',
);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isDimension(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= MAXIMUM_DIMENSION;
}

function isCoordinate(value) {
  return Number.isSafeInteger(value) && Math.abs(value) <= 1_000_000;
}

function isPercent(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100;
}

function invalidOutput() {
  throw new TypeError('螢幕控制回傳格式不正確。');
}

function parseJson(stdout) {
  if (typeof stdout !== 'string') {
    return invalidOutput();
  }

  const normalized = stdout.replace(/^﻿/, '').trim();
  return normalized.length === 0 ? invalidOutput() : JSON.parse(normalized);
}

function parseResolutionPair(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !isDimension(value[0]) ||
    !isDimension(value[1])
  ) {
    return invalidOutput();
  }

  return Object.freeze({ width: value[0], height: value[1] });
}

function parseVcp(value) {
  if (!isPlainObject(value) || typeof value.supported !== 'boolean') {
    return invalidOutput();
  }

  if (!value.supported) {
    return Object.freeze({ supported: false, percent: null });
  }

  return isPercent(value.percent)
    ? Object.freeze({ supported: true, percent: value.percent })
    : invalidOutput();
}

/**
 * 驗證 C# Query 輸出；模式依面積由大到小排序並去除重複。
 *
 * @param {string} stdout
 */
function parseQueryOutput(stdout) {
  const parsed = parseJson(stdout);

  if (!isPlainObject(parsed) || typeof parsed.found !== 'boolean') {
    return invalidOutput();
  }

  if (!parsed.found) {
    return Object.freeze({ found: false });
  }

  if (
    !Array.isArray(parsed.modes) ||
    parsed.modes.length > MAXIMUM_MODE_COUNT
  ) {
    return invalidOutput();
  }

  const seen = new Set();
  const modes = parsed.modes
    .map(parseResolutionPair)
    .filter(({ width, height }) => {
      const key = `${width}x${height}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
    .sort((a, b) =>
      (b.width * b.height) - (a.width * a.height) || b.width - a.width);

  return Object.freeze({
    found: true,
    current: parseResolutionPair(parsed.current),
    modes: Object.freeze(modes),
    brightness: parseVcp(parsed.brightness),
    contrast: parseVcp(parsed.contrast),
  });
}

/** @param {string} stdout */
function parseApplyOutput(stdout) {
  const parsed = parseJson(stdout);

  if (!isPlainObject(parsed) || typeof parsed.found !== 'boolean') {
    return invalidOutput();
  }

  if (!parsed.found) {
    return Object.freeze({ found: false });
  }

  if (
    !APPLY_RESULTS.has(parsed.resolution) ||
    !APPLY_RESULTS.has(parsed.brightness) ||
    !APPLY_RESULTS.has(parsed.contrast)
  ) {
    return invalidOutput();
  }

  return Object.freeze({
    found: true,
    resolution: parsed.resolution,
    brightness: parsed.brightness,
    contrast: parsed.contrast,
  });
}

/**
 * Windows 輸出螢幕的顯示模式與 DDC/CI 亮度／對比控制。
 *
 * 螢幕以桌面原點（實體像素）辨識。C# 原始碼固定隨程式封裝，所有參數都是
 * 驗證過的整數；以 execFile 關閉 shell 並限制時間與輸出大小。
 */
class MonitorControl {
  constructor({
    platform = process.platform,
    systemRoot = process.env.SystemRoot,
    execFile = execFileAsync,
    environment = process.env,
  } = {}) {
    this.platform = platform;
    this.powerShellExecutable = resolvePowerShellExecutable(systemRoot);
    this.execFile = execFile;
    this.environment = environment;
  }

  isSupported() {
    return this.platform === 'win32' && this.powerShellExecutable !== null;
  }

  /**
   * @param {{x: number, y: number}} origin 螢幕桌面原點（實體像素）
   */
  async query(origin) {
    const { x, y } = this.validateOrigin(origin);
    return parseQueryOutput(
      await this.run(`[DisplayCoreMonitorControl]::Query(${x}, ${y})`),
    );
  }

  /**
   * @param {{x: number, y: number}} origin
   * @param {object} request
   * @param {{width: number, height: number} | null} request.resolution
   * @param {number | null} request.brightnessPercent
   * @param {number | null} request.contrastPercent
   */
  async apply(origin, { resolution, brightnessPercent, contrastPercent }) {
    const { x, y } = this.validateOrigin(origin);

    if (
      !(resolution === null ||
        (isDimension(resolution?.width) && isDimension(resolution?.height))) ||
      !(brightnessPercent === null || isPercent(brightnessPercent)) ||
      !(contrastPercent === null || isPercent(contrastPercent))
    ) {
      throw new TypeError('螢幕控制參數不正確。');
    }

    const width = resolution?.width ?? 0;
    const height = resolution?.height ?? 0;
    return parseApplyOutput(await this.run(
      `[DisplayCoreMonitorControl]::Apply(${x}, ${y}, ${width}, ${height}, ` +
      `${brightnessPercent ?? -1}, ${contrastPercent ?? -1})`,
    ));
  }

  /** @private */
  validateOrigin(origin) {
    if (!isCoordinate(origin?.x) || !isCoordinate(origin?.y)) {
      throw new TypeError('螢幕原點不正確。');
    }

    return origin;
  }

  /** @private */
  async run(invocation) {
    if (!this.isSupported()) {
      throw new Error('此平台不支援輸出螢幕控制。');
    }

    const { stdout } = await this.execFile(
      this.powerShellExecutable,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference='Stop';" +
          `Add-Type -TypeDefinition $env:${SOURCE_ENVIRONMENT_KEY} -Language CSharp;` +
          `[Console]::Out.Write(${invocation})`,
      ],
      {
        encoding: 'utf8',
        env: { ...this.environment, [SOURCE_ENVIRONMENT_KEY]: CONTROL_SOURCE },
        maxBuffer: POWERSHELL_MAX_BUFFER_BYTES,
        shell: false,
        timeout: POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return stdout;
  }
}

module.exports = {
  MonitorControl,
  parseApplyOutput,
  parseQueryOutput,
};
