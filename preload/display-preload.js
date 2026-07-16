'use strict';

/**
 * Display Window 的安全 preload 占位入口。
 *
 * 第 3 步不向顯示頁面暴露任何特權能力；唯讀顯示通道會在第 4 步透過
 * context isolation 白名單建立。
 */
