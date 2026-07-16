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
    'clearPresentation',
    'getPresentation',
    'getSettings',
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
  );
  await api.showEmergency('555');
  await api.clearPresentation();
  await api.getSettings();
  await api.saveSettings({ configVersion: 1 }, 7);
  await api.chooseLogo();

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
    ],
  );
  assert.equal(
    JSON.stringify(harness.invocations[1].args[0]),
    JSON.stringify({
      messages: [{ message: '  Nancy請至前廳\n原樣保留  ' }],
      pageDurationSeconds: 3,
      repeat: { mode: 'continuous' },
    }),
  );
  assert.equal(
    JSON.stringify(harness.invocations[2].args[0]),
    JSON.stringify({ code: '555' }),
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(harness.invocations[5].args[0])),
    { config: { configVersion: 1 }, expectedRevision: 7 },
  );
});

test('Display preload 只有唯讀 snapshot 與事件訂閱能力', async () => {
  const harness = await loadPreload('preload/display-preload.js');
  const api = harness.exposed.get('displayCoreDisplay');

  assert.ok(api);
  assert.deepEqual(Object.keys(api).sort(), [
    'getPresentation',
    'onPresentationChanged',
  ]);
  assert.deepEqual(harness.requiredModules, ['electron/renderer']);
  assert.equal(api.startProgram, undefined);
  assert.equal(api.showEmergency, undefined);
  assert.equal(api.clearPresentation, undefined);
  assert.equal(api.getSettings, undefined);
  assert.equal(api.saveSettings, undefined);
  assert.equal(api.chooseLogo, undefined);

  await api.getPresentation();
  assert.equal(
    harness.invocations[0].channel,
    IPC_CHANNELS.DISPLAY_GET_PRESENTATION,
  );
});

test('preload 事件訂閱不洩漏 Electron event 且可精確解除', async () => {
  for (const scenario of [
    {
      file: 'preload.js',
      apiName: 'displayCoreControl',
      channel: IPC_CHANNELS.CONTROL_PRESENTATION_CHANGED,
    },
    {
      file: 'preload/display-preload.js',
      apiName: 'displayCoreDisplay',
      channel: IPC_CHANNELS.DISPLAY_PRESENTATION_CHANGED,
    },
  ]) {
    const harness = await loadPreload(scenario.file);
    const api = harness.exposed.get(scenario.apiName);
    const receivedArguments = [];

    assert.throws(
      () => api.onPresentationChanged('不是函式'),
      { name: 'TypeError', message: 'listener 必須是函式。' },
    );

    const unsubscribe = api.onPresentationChanged((...args) => {
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
