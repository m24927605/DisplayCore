'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { IPC_CHANNELS } = require('../../ipc/channels');

const projectRoot = path.resolve(__dirname, '..', '..');

async function loadPreload(relativePath) {
  const source = await readFile(path.join(projectRoot, relativePath), 'utf8');
  const exposed = new Map();
  const invocations = [];
  const listeners = new Map();
  const requiredModules = [];
  const ipcRenderer = {
    async invoke(channel, ...args) {
      invocations.push({ channel, args });
      return { ok: true, data: { channel } };
    },
    on(channel, listener) {
      const channelListeners = listeners.get(channel) || new Set();
      channelListeners.add(listener);
      listeners.set(channel, channelListeners);
      return this;
    },
    removeListener(channel, listener) {
      listeners.get(channel)?.delete(listener);
      return this;
    },
  };
  const contextBridge = {
    exposeInMainWorld(name, api) {
      exposed.set(name, api);
    },
  };
  const sandbox = {
    require(moduleName) {
      requiredModules.push(moduleName);

      if (moduleName !== 'electron/renderer') {
        throw new Error(`sandbox preload 不得載入 ${moduleName}`);
      }

      return { contextBridge, ipcRenderer };
    },
  };

  vm.runInNewContext(source, sandbox, { filename: relativePath });

  return {
    emit(channel, payload) {
      for (const listener of listeners.get(channel) || []) {
        listener({ secretElectronEvent: true }, payload);
      }
    },
    exposed,
    invocations,
    listeners,
    requiredModules,
  };
}

test('Control preload 只暴露固定用途的 invoke 方法', async () => {
  const harness = await loadPreload('preload.js');
  const api = harness.exposed.get('displayCoreControl');

  assert.ok(api);
  assert.deepEqual(Object.keys(api).sort(), [
    'chooseLogo',
    'chooseStandbyBackground',
    'clearPresentation',
    'getOutputStatus',
    'getPresentation',
    'getSettings',
    'onOutputStatusChanged',
    'onPresentationChanged',
    'saveSettings',
    'showEmergency',
    'startProgram',
  ]);
  assert.deepEqual(harness.requiredModules, ['electron/renderer']);
  assert.equal(api.invoke, undefined);
  assert.equal(api.send, undefined);
  assert.equal(api.on, undefined);

  await api.getPresentation();
  await api.startProgram(
    [{ message: '  Nancy請至前廳\n原樣保留  ' }],
    3,
    { mode: 'continuous' },
    12,
  );
  await api.showEmergency('555');
  await api.clearPresentation(12);
  await api.getSettings();
  await api.saveSettings({ configVersion: 1 }, 7);
  await api.chooseLogo();
  await api.chooseStandbyBackground('slideshow');
  await api.getOutputStatus();

  assert.deepEqual(
    harness.invocations.map(({ channel }) => channel),
    [
      IPC_CHANNELS.CONTROL_GET_PRESENTATION,
      IPC_CHANNELS.CONTROL_START_PROGRAM,
      IPC_CHANNELS.CONTROL_SHOW_EMERGENCY,
      IPC_CHANNELS.CONTROL_CLEAR_PRESENTATION,
      IPC_CHANNELS.CONTROL_GET_SETTINGS,
      IPC_CHANNELS.CONTROL_SAVE_SETTINGS,
      IPC_CHANNELS.CONTROL_CHOOSE_LOGO,
      IPC_CHANNELS.CONTROL_CHOOSE_STANDBY_BACKGROUND,
      IPC_CHANNELS.CONTROL_GET_OUTPUT_STATUS,
    ],
  );
  assert.equal(
    JSON.stringify(harness.invocations[1].args[0]),
    JSON.stringify({
      messages: [{ message: '  Nancy請至前廳\n原樣保留  ' }],
      pageDurationSeconds: 3,
      repeat: { mode: 'continuous' },
      expectedContentRevision: 12,
    }),
  );
  assert.equal(
    JSON.stringify(harness.invocations[2].args[0]),
    JSON.stringify({ code: '555' }),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.invocations[3].args[0])),
    { expectedContentRevision: 12 },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.invocations[5].args[0])),
    { config: { configVersion: 1 }, expectedRevision: 7 },
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.invocations[7].args)),
    [{ backgroundMode: 'slideshow' }],
  );
});

test('Display preload 只有唯讀 snapshot、訂閱與固定頁面進度回報能力', async () => {
  const harness = await loadPreload('preload/display-preload.js');
  const api = harness.exposed.get('displayCoreDisplay');

  assert.ok(api);
  assert.deepEqual(Object.keys(api).sort(), [
    'getPresentation',
    'getSettings',
    'onPresentationChanged',
    'onRefitRequested',
    'onSettingsChanged',
    'reportPageProgress',
  ]);
  assert.deepEqual(harness.requiredModules, ['electron/renderer']);
  assert.equal(api.startProgram, undefined);
  assert.equal(api.showEmergency, undefined);
  assert.equal(api.clearPresentation, undefined);
  assert.equal(api.saveSettings, undefined);
  assert.equal(api.chooseLogo, undefined);
  assert.equal(api.chooseStandbyBackground, undefined);

  await api.getPresentation();
  await api.getSettings();
  await api.reportPageProgress('pending', 7, 2, 4, 9, 11);
  await api.reportPageProgress('ready', 7, 2, 4, 9, 11, 3);
  await api.reportPageProgress('started', 7, 2, 4, 9, 11);
  await api.reportPageProgress('complete', 7, 2, 4, 9, 11);
  assert.equal(
    harness.invocations[0].channel,
    IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
  );
  assert.equal(
    harness.invocations[1].channel,
    IPC_CHANNELS.DISPLAY_GET_SETTINGS,
  );
  assert.deepEqual(
    harness.invocations.slice(2).map(({ channel, args }) => ({
      channel,
      payload: JSON.parse(JSON.stringify(args[0])),
    })),
    [
      {
        channel: IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
        payload: {
          phase: 'pending',
          revision: 7,
          pageNumber: 2,
          settingsRevision: 4,
          displayEpoch: 9,
          layoutGeneration: 11,
        },
      },
      {
        channel: IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
        payload: {
          phase: 'ready',
          revision: 7,
          pageNumber: 2,
          settingsRevision: 4,
          displayEpoch: 9,
          layoutGeneration: 11,
          marqueeCount: 3,
        },
      },
      {
        channel: IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
        payload: {
          phase: 'started',
          revision: 7,
          pageNumber: 2,
          settingsRevision: 4,
          displayEpoch: 9,
          layoutGeneration: 11,
        },
      },
      {
        channel: IPC_CHANNELS.DISPLAY_REPORT_PAGE_PROGRESS,
        payload: {
          phase: 'complete',
          revision: 7,
          pageNumber: 2,
          settingsRevision: 4,
          displayEpoch: 9,
          layoutGeneration: 11,
        },
      },
    ],
  );
  assert.equal(api.invoke, undefined);
  assert.equal(api.send, undefined);
});

test('preload 事件訂閱不洩漏 Electron event 且可精確解除', async () => {
  for (const scenario of [
    {
      file: 'preload.js',
      apiName: 'displayCoreControl',
      channel: IPC_CHANNELS.CONTROL_PRESENTATION_CHANGED,
    },
    {
      file: 'preload.js',
      apiName: 'displayCoreControl',
      channel: IPC_CHANNELS.CONTROL_OUTPUT_STATUS_CHANGED,
      subscribeMethod: 'onOutputStatusChanged',
    },
    {
      file: 'preload/display-preload.js',
      apiName: 'displayCoreDisplay',
      channel: IPC_CHANNELS.DISPLAY_PRESENTATION_CHANGED,
      subscribeMethod: 'onPresentationChanged',
    },
    {
      file: 'preload/display-preload.js',
      apiName: 'displayCoreDisplay',
      channel: IPC_CHANNELS.DISPLAY_SETTINGS_CHANGED,
      subscribeMethod: 'onSettingsChanged',
    },
    {
      file: 'preload/display-preload.js',
      apiName: 'displayCoreDisplay',
      channel: IPC_CHANNELS.DISPLAY_REFIT_REQUESTED,
      subscribeMethod: 'onRefitRequested',
    },
  ]) {
    const harness = await loadPreload(scenario.file);
    const api = harness.exposed.get(scenario.apiName);
    const receivedArguments = [];

    assert.throws(
      () => api[scenario.subscribeMethod || 'onPresentationChanged']('不是函式'),
      { name: 'TypeError', message: 'listener 必須是函式。' },
    );

    const unsubscribe = api[scenario.subscribeMethod || 'onPresentationChanged']((...args) => {
      receivedArguments.push(args);
    });
    const snapshot = {
      mode: 'emergency',
      messages: [{ message: '888' }],
      layout: 'fill-screen',
      pageDurationSeconds: null,
      pageNumber: null,
      pageCount: null,
      roundNumber: null,
      totalRounds: null,
      revision: 7,
    };

    harness.emit(scenario.channel, snapshot);
    assert.deepEqual(receivedArguments, [[snapshot]]);
    assert.equal(harness.listeners.get(scenario.channel).size, 1);

    unsubscribe();
    assert.equal(harness.listeners.get(scenario.channel).size, 0);
    harness.emit(scenario.channel, { ...snapshot, revision: 8 });
    assert.equal(receivedArguments.length, 1);
  }
});
