'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const projectRoot = path.resolve(__dirname, '..', '..');
const viewPath = path.join(projectRoot, 'control', 'output-view.mjs');

class FakeElement {
  constructor() {
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  constructor(ids) {
    this.elements = new Map(ids.map((id) => [id, new FakeElement()]));
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }
}

const OUTPUT_ELEMENT_IDS = Object.freeze([
  'output-status-panel',
  'hdmi-status-badge',
  'hdmi-status-text',
  'output-target',
  'output-mode',
  'output-display-count',
  'output-status-notice',
  'output-status-error',
  'manage-output-settings-button',
]);

function createDocument() {
  return new FakeDocument(OUTPUT_ELEMENT_IDS);
}

function createSnapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    topologyStatus: 'ready',
    hdmiConnectionStatus: 'connected',
    displays: [
      {
        id: 1,
        label: '內建顯示器',
        width: 1920,
        height: 1080,
        scaleFactor: 1,
        isPrimary: true,
        isInternal: true,
      },
      {
        id: 2,
        label: '會議室電視',
        width: 3840,
        height: 2160,
        scaleFactor: 1.5,
        isPrimary: false,
        isInternal: false,
      },
    ],
    effectiveDisplayId: 2,
    configuredDisplayId: null,
    selectionMode: 'auto',
    fullscreen: true,
    usingFallback: false,
    configRevision: 3,
    topologyRevision: 4,
    placement: {
      status: 'applied',
      displayId: 2,
      fullscreen: true,
      revision: 5,
    },
    ...overrides,
  };
}

function createUx(hdmiStatus = 'connected', routingStatus = 'applied') {
  return {
    hdmi: { status: hdmiStatus },
    routing: { status: routingStatus },
  };
}

async function loadViewModule() {
  return import(pathToFileURL(viewPath).href);
}

test('output view 將 HDMI、實際輸出目標、模式與螢幕數量分開呈現', async () => {
  const { createOutputView } = await loadViewModule();
  const document = createDocument();
  const view = createOutputView({ document });

  const rendered = view.renderOutputStatus(
    createSnapshot(),
    createUx(),
  );

  assert.equal(rendered, true);
  assert.equal(document.getElementById('hdmi-status-text').textContent, 'HDMI 已連接');
  assert.equal(document.getElementById('hdmi-status-badge').dataset.tone, 'connected');
  assert.equal(document.getElementById('output-target').textContent, '會議室電視');
  assert.equal(document.getElementById('output-mode').textContent, '全螢幕');
  assert.equal(document.getElementById('output-display-count').textContent, '2 台');
  assert.equal(
    document.getElementById('output-status-notice').textContent,
    '顯示畫面已輸出至「會議室電視」。',
  );
  assert.equal(document.getElementById('output-status-notice').dataset.tone, 'applied');
  assert.equal(document.getElementById('output-status-panel').getAttribute('aria-busy'), 'false');
  assert.equal(document.getElementById('output-status-error').hidden, true);
  assert.equal(document.getElementById('manage-output-settings-button').disabled, false);
});

test('HDMI 未連接不會把目前使用中的其他外接螢幕誤稱為 HDMI', async () => {
  const { createOutputView } = await loadViewModule();
  const document = createDocument();
  const view = createOutputView({ document });
  const snapshot = createSnapshot({
    hdmiConnectionStatus: 'not-connected',
    selectionMode: 'manual',
    configuredDisplayId: 2,
    usingFallback: true,
    displays: [
      {
        id: 2,
        label: 'DisplayPort 投影機',
        width: 2560,
        height: 1440,
        scaleFactor: 1,
        isPrimary: true,
        isInternal: false,
      },
    ],
  });

  view.renderOutputStatus(
    snapshot,
    createUx('not-connected', 'manual-fallback'),
  );

  assert.equal(document.getElementById('hdmi-status-text').textContent, 'HDMI 未連接');
  assert.equal(
    document.getElementById('output-target').textContent,
    'DisplayPort 投影機',
  );
  assert.doesNotMatch(document.getElementById('output-target').textContent, /HDMI/u);
  assert.equal(
    document.getElementById('output-status-notice').textContent,
    '原先指定的螢幕目前不可用，已暫時改用「DisplayPort 投影機」。',
  );
  assert.equal(document.getElementById('output-status-notice').dataset.tone, 'warning');
});

test('偵測、無目標與未知狀態使用明確但不武斷的提示', async () => {
  const { createOutputView } = await loadViewModule();
  const document = createDocument();
  const view = createOutputView({ document });
  const noTarget = createSnapshot({
    topologyStatus: 'unknown',
    hdmiConnectionStatus: 'detecting',
    displays: [],
    effectiveDisplayId: null,
    placement: {
      status: 'pending',
      displayId: null,
      fullscreen: false,
      revision: 0,
    },
  });

  view.renderOutputStatus(noTarget, createUx('detecting', 'no-target'));

  assert.equal(document.getElementById('hdmi-status-text').textContent, '正在偵測 HDMI…');
  assert.equal(document.getElementById('output-target').textContent, '沒有可用螢幕');
  assert.equal(document.getElementById('output-mode').textContent, '視窗模式');
  assert.equal(document.getElementById('output-display-count').textContent, '0 台');
  assert.equal(
    document.getElementById('output-status-notice').textContent,
    '目前找不到可用的顯示螢幕，請檢查螢幕連線。',
  );
  assert.equal(document.getElementById('output-status-notice').dataset.tone, 'warning');
  assert.equal(document.getElementById('output-status-panel').getAttribute('aria-busy'), 'true');

  view.renderOutputStatus(
    createSnapshot({ hdmiConnectionStatus: 'unknown' }),
    createUx('unknown', 'applied'),
  );
  assert.equal(
    document.getElementById('hdmi-status-text').textContent,
    'HDMI 無法判定',
  );
  assert.notEqual(
    document.getElementById('hdmi-status-text').textContent,
    'HDMI 未連接',
  );
});

test('錯誤與螢幕名稱只透過 textContent 寫入且不會建立可執行標記', async () => {
  const [{ createOutputView }, source] = await Promise.all([
    loadViewModule(),
    readFile(viewPath, 'utf8'),
  ]);
  const document = createDocument();
  const view = createOutputView({ document });
  const unsafeText = '<img src=x onerror=alert(1)>';
  const snapshot = createSnapshot({
    displays: [
      {
        id: 2,
        label: unsafeText,
        width: 1920,
        height: 1080,
        scaleFactor: 1,
        isPrimary: true,
        isInternal: false,
      },
    ],
  });

  view.renderOutputStatus(snapshot, createUx());
  view.renderOutputError(unsafeText);

  assert.equal(document.getElementById('output-target').textContent, unsafeText);
  assert.equal(document.getElementById('output-status-error').textContent, unsafeText);
  assert.equal(document.getElementById('output-status-error').hidden, false);
  assert.equal(document.getElementById('output-status-notice').hidden, true);
  assert.equal(document.getElementById('output-status-panel').getAttribute('aria-busy'), 'false');
  assert.equal(document.getElementById('manage-output-settings-button').disabled, false);
  assert.match(source, /\.textContent\s*=/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /\brequire\s*\(|\bprocess\.|\bipcRenderer\b|\bwindow\./);
});

test('不完整狀態會安全拒絕並保留初始載入提示', async () => {
  const { createOutputView } = await loadViewModule();
  const document = createDocument();
  document.getElementById('hdmi-status-text').textContent = '正在偵測 HDMI…';
  document.getElementById('output-target').textContent = '正在取得螢幕資訊…';
  const view = createOutputView({ document });

  const rendered = view.renderOutputStatus(
    { displays: null },
    createUx('connected', 'applied'),
  );

  assert.equal(rendered, false);
  assert.equal(document.getElementById('hdmi-status-text').textContent, '正在偵測 HDMI…');
  assert.equal(document.getElementById('output-target').textContent, '正在取得螢幕資訊…');
  assert.equal(document.getElementById('manage-output-settings-button').disabled, true);
});
