'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HDMI_CONNECTION_STATUSES,
  HdmiDetector,
} = require('../../main/hdmi-detector');

const TEST_SYSTEM_ROOT = 'C:\\Windows';
const TEST_POWERSHELL_PATH =
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

test('Windows 只把作用中的 HDMI 技術代碼 5 判定為已連接', async () => {
  const calls = [];
  const detector = new HdmiDetector({
    platform: 'win32',
    systemRoot: TEST_SYSTEM_ROOT,
    execFile: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return { stdout: '\uFEFF[5,10,5]\r\n', stderr: '' };
    },
  });

  const result = await detector.detect();

  assert.deepEqual(result, {
    status: HDMI_CONNECTION_STATUSES.CONNECTED,
    activeConnectionCount: 3,
    hdmiConnectionCount: 2,
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, TEST_POWERSHELL_PATH);
  assert.deepEqual(calls[0].args.slice(0, 3), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 3_000);
  assert.match(calls[0].args.at(-1), /WmiMonitorConnectionParams/);
  assert.match(calls[0].args.at(-1), /VideoOutputTechnology/);
  assert.doesNotMatch(
    calls[0].args.at(-1),
    /;\s*\|/,
    'PowerShell pipeline 前不可插入 statement separator',
  );
});

test('Windows 接受 PowerShell 單值輸出，非 HDMI 連接回報未連接', async () => {
  const detector = new HdmiDetector({
    platform: 'win32',
    systemRoot: TEST_SYSTEM_ROOT,
    execFile: async () => ({ stdout: '10', stderr: '' }),
  });

  assert.deepEqual(await detector.detect(), {
    status: HDMI_CONNECTION_STATUSES.NOT_CONNECTED,
    activeConnectionCount: 1,
    hdmiConnectionCount: 0,
  });
});

test('Windows 沒有作用中輸出時回報 HDMI 未連接', async () => {
  const detector = new HdmiDetector({
    platform: 'win32',
    systemRoot: TEST_SYSTEM_ROOT,
    execFile: async () => ({ stdout: '[]', stderr: '' }),
  });

  assert.deepEqual(await detector.detect(), {
    status: HDMI_CONNECTION_STATUSES.NOT_CONNECTED,
    activeConnectionCount: 0,
    hdmiConnectionCount: 0,
  });
});

test('Windows PowerShell 空白輸出時回報無法判定，不誤報未連接', async () => {
  const warnings = [];
  const detector = new HdmiDetector({
    platform: 'win32',
    systemRoot: TEST_SYSTEM_ROOT,
    execFile: async () => ({ stdout: ' \r\n', stderr: '' }),
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  assert.deepEqual(await detector.detect(), {
    status: HDMI_CONNECTION_STATUSES.UNKNOWN,
    activeConnectionCount: 0,
    hdmiConnectionCount: 0,
  });
  assert.deepEqual(warnings, ['[DisplayCore] Windows HDMI 狀態查詢失敗。']);
});

test('Windows 系統目錄不受信任時不啟動 PowerShell 並回報無法判定', async () => {
  const warnings = [];
  let calls = 0;
  const detector = new HdmiDetector({
    platform: 'win32',
    systemRoot: 'C:\\Users\\Operator\\Writable',
    execFile: async () => {
      calls += 1;
      return { stdout: '[5]', stderr: '' };
    },
    logger: {
      warn(message) {
        warnings.push(message);
      },
    },
  });

  assert.deepEqual(await detector.detect(), {
    status: HDMI_CONNECTION_STATUSES.UNKNOWN,
    activeConnectionCount: 0,
    hdmiConnectionCount: 0,
  });
  assert.equal(calls, 0);
  assert.deepEqual(warnings, [
    '[DisplayCore] Windows PowerShell 系統路徑無效，無法查詢 HDMI 狀態。',
  ]);
});

test('非 Windows 不執行系統指令並明確回報無法判定', async () => {
  let calls = 0;
  const detector = new HdmiDetector({
    platform: 'darwin',
    execFile: async () => {
      calls += 1;
      return { stdout: '[5]', stderr: '' };
    },
  });

  assert.deepEqual(await detector.detect(), {
    status: HDMI_CONNECTION_STATUSES.UNKNOWN,
    activeConnectionCount: 0,
    hdmiConnectionCount: 0,
  });
  assert.equal(calls, 0);
});

test('WMI 查詢失敗或回傳畸形資料時安全降級，不誤報 HDMI', async () => {
  const warnings = [];
  const scenarios = [
    async () => {
      throw new Error('private device path');
    },
    async () => ({ stdout: '{"unexpected":true}', stderr: '' }),
    async () => ({ stdout: '[5,"5"]', stderr: '' }),
  ];

  for (const execFile of scenarios) {
    const detector = new HdmiDetector({
      platform: 'win32',
      systemRoot: TEST_SYSTEM_ROOT,
      execFile,
      logger: {
        warn(message) {
          warnings.push(message);
        },
      },
    });

    assert.deepEqual(await detector.detect(), {
      status: HDMI_CONNECTION_STATUSES.UNKNOWN,
      activeConnectionCount: 0,
      hdmiConnectionCount: 0,
    });
  }

  assert.equal(warnings.length, scenarios.length);
  assert.ok(warnings.every((message) => !message.includes('private device path')));
});
