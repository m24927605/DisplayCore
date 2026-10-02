'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MonitorControl,
  parseApplyOutput,
  parseQueryOutput,
} = require('../../main/monitor-control');

function createExecFile(stdout) {
  const calls = [];
  return {
    calls,
    async execFile(file, args, options) {
      calls.push({ file, args, options });
      return { stdout, stderr: '' };
    },
  };
}

test('Query 輸出依面積排序並去重，DDC/CI 支援與否皆明確表示', () => {
  const result = parseQueryOutput(
    '\uFEFF{"found":true,"current":[1920,1080],' +
      '"modes":[[1280,720],[1920,1080],[3840,2160],[1280,720],[1366,768]],' +
      '"brightness":{"supported":true,"percent":65},' +
      '"contrast":{"supported":false}}',
  );

  assert.deepEqual(result, {
    found: true,
    current: { width: 1920, height: 1080 },
    modes: [
      { width: 3840, height: 2160 },
      { width: 1920, height: 1080 },
      { width: 1366, height: 768 },
      { width: 1280, height: 720 },
    ],
    brightness: { supported: true, percent: 65 },
    contrast: { supported: false, percent: null },
  });
  assert.equal(Object.isFrozen(result.modes), true);
  assert.deepEqual(parseQueryOutput('{"found":false}'), { found: false });
});

test('Query 與 Apply 輸出拒絕畸形或超界資料', () => {
  for (const stdout of [
    '',
    'not json',
    '[]',
    '{"found":"true"}',
    '{"found":true,"current":[1920],"modes":[],"brightness":{"supported":false},"contrast":{"supported":false}}',
    '{"found":true,"current":[1920,1080],"modes":[[0,720]],"brightness":{"supported":false},"contrast":{"supported":false}}',
    '{"found":true,"current":[1920,1080],"modes":[[20000,720]],"brightness":{"supported":false},"contrast":{"supported":false}}',
    '{"found":true,"current":[1920,1080],"modes":[],"brightness":{"supported":true,"percent":101},"contrast":{"supported":false}}',
    '{"found":true,"current":[1920,1080],"modes":[],"brightness":{"supported":true},"contrast":{"supported":false}}',
    `{"found":true,"current":[1920,1080],"modes":${JSON.stringify(Array(513).fill([1920, 1080]))},"brightness":{"supported":false},"contrast":{"supported":false}}`,
  ]) {
    assert.throws(() => parseQueryOutput(stdout), Error, stdout.slice(0, 80));
  }

  assert.deepEqual(
    parseApplyOutput(
      '{"found":true,"resolution":"applied","brightness":"unchanged","contrast":"unsupported"}',
    ),
    {
      found: true,
      resolution: 'applied',
      brightness: 'unchanged',
      contrast: 'unsupported',
    },
  );
  for (const stdout of [
    '{"found":true,"resolution":"ok","brightness":"unchanged","contrast":"unchanged"}',
    '{"found":true,"resolution":"applied","brightness":"unchanged"}',
  ]) {
    assert.throws(() => parseApplyOutput(stdout), Error);
  }
});

test('非 Windows 或系統路徑無效時不支援，也不執行任何程序', async () => {
  const runner = createExecFile('{"found":false}');
  for (const control of [
    new MonitorControl({
      platform: 'darwin',
      systemRoot: 'C:\\Windows',
      execFile: runner.execFile,
    }),
    new MonitorControl({
      platform: 'win32',
      systemRoot: 'D:\\Untrusted',
      execFile: runner.execFile,
    }),
  ]) {
    assert.equal(control.isSupported(), false);
    await assert.rejects(control.query({ x: 0, y: 0 }), /不支援/);
  }
  assert.equal(runner.calls.length, 0);
});

test('Windows 以固定 PowerShell 路徑、無 shell 與受限輸出呼叫整數參數', async () => {
  const runner = createExecFile(
    '{"found":true,"resolution":"applied","brightness":"applied","contrast":"unchanged"}',
  );
  const control = new MonitorControl({
    platform: 'win32',
    systemRoot: 'C:\\Windows',
    execFile: runner.execFile,
    environment: { SystemRoot: 'C:\\Windows' },
  });

  assert.equal(control.isSupported(), true);
  const result = await control.apply(
    { x: -1920, y: 0 },
    {
      resolution: { width: 1280, height: 720 },
      brightnessPercent: 40,
      contrastPercent: null,
    },
  );

  assert.equal(result.resolution, 'applied');
  assert.equal(runner.calls.length, 1);
  const [{ file, args, options }] = runner.calls;
  assert.equal(
    file,
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  );
  assert.deepEqual(args.slice(0, 4), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
  ]);
  assert.match(
    args[4],
    /\[DisplayCoreMonitorControl\]::Apply\(-1920, 0, 1280, 720, 40, -1\)/,
  );
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(options.env.SystemRoot, 'C:\\Windows');
  assert.match(
    options.env.DISPLAYCORE_MONITOR_CONTROL_SOURCE,
    /public static string Query\(int x, int y\)/,
  );
  assert.ok(options.timeout > 0);
  assert.ok(options.maxBuffer > 0);
});

test('Windows 拒絕非整數座標、超界百分比與畸形解析度，不啟動程序', async () => {
  const runner = createExecFile('{"found":false}');
  const control = new MonitorControl({
    platform: 'win32',
    systemRoot: 'C:\\Windows',
    execFile: runner.execFile,
  });
  const valid = {
    resolution: null,
    brightnessPercent: null,
    contrastPercent: null,
  };

  await assert.rejects(control.query({ x: 0.5, y: 0 }), TypeError);
  await assert.rejects(control.query({ x: '0); Remove-Item C:\\', y: 0 }), TypeError);
  for (const request of [
    { ...valid, brightnessPercent: 101 },
    { ...valid, contrastPercent: -1 },
    { ...valid, resolution: { width: 1280 } },
    { ...valid, resolution: { width: 0, height: 720 } },
  ]) {
    await assert.rejects(control.apply({ x: 0, y: 0 }, request), TypeError);
  }
  assert.equal(runner.calls.length, 0);
});

test(
  '真實 Windows PowerShell 可編譯螢幕控制並查詢主螢幕',
  { skip: process.platform !== 'win32' },
  async () => {
    const control = new MonitorControl();
    const result = await control.query({ x: 0, y: 0 });

    assert.equal(result.found, true);
    assert.ok(result.modes.length > 0);
    assert.ok(result.modes.some(({ width, height }) =>
      width === result.current.width && height === result.current.height));
  },
);
