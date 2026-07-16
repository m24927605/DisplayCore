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
  constructor() {
    this.elements = new Map([
      'output-status-cluster',
      'hdmi-status-badge',
      'hdmi-status-text',
      'output-target',
      'output-status-notice',
      'output-status-error',
    ].map((id) => [id, new FakeElement()]));
  }

  getElementById(id) {
    return this.elements.get(id) ?? null;
  }
}

function createSnapshot(overrides = {}) {
  return {
    displays: [
      { id: 1, label: '內建顯示器' },
      { id: 2, label: '會議室電視' },
    ],
    effectiveDisplayId: 2,
    placement: { status: 'applied', displayId: 2, fullscreen: true },
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

test('唯讀輸出狀態只呈現 HDMI 與目前實際目標', async () => {
  const { createOutputView } = await loadViewModule();
  const document = new FakeDocument();
  const view = createOutputView({ document });

  assert.equal(view.renderOutputStatus(createSnapshot(), createUx()), true);
  assert.equal(document.getElementById('hdmi-status-text').textContent, 'HDMI 已連接');
  assert.equal(document.getElementById('hdmi-status-badge').dataset.tone, 'connected');
  assert.equal(document.getElementById('output-target').textContent, '會議室電視');
  assert.equal(document.getElementById('output-status-cluster').getAttribute('aria-busy'), 'false');
  assert.equal(document.getElementById('output-status-error').hidden, true);
});

test('偵測、未連接、未知與無目標都有不武斷的唯讀提示', async () => {
  const { createOutputView } = await loadViewModule();
  const document = new FakeDocument();
  const view = createOutputView({ document });

  view.renderOutputStatus(
    createSnapshot({ displays: [], effectiveDisplayId: null, placement: {
      status: 'pending', displayId: null, fullscreen: true,
    } }),
    createUx('detecting', 'no-target'),
  );
  assert.equal(document.getElementById('hdmi-status-text').textContent, '正在偵測 HDMI…');
  assert.equal(document.getElementById('output-target').textContent, '沒有可用螢幕');
  assert.equal(document.getElementById('output-status-cluster').getAttribute('aria-busy'), 'true');

  view.renderOutputStatus(createSnapshot(), createUx('not-connected', 'applied'));
  assert.equal(document.getElementById('hdmi-status-text').textContent, 'HDMI 未連接');
  view.renderOutputStatus(createSnapshot(), createUx('unknown', 'unknown'));
  assert.equal(document.getElementById('hdmi-status-text').textContent, 'HDMI 無法判定');

  view.renderOutputStatus(createSnapshot(), createUx('connected', 'error'));
  assert.equal(
    document.getElementById('output-target').textContent,
    '會議室電視 · 輸出失敗',
  );
});

test('螢幕名稱與錯誤只透過 textContent 寫入', async () => {
  const [{ createOutputView }, source] = await Promise.all([
    loadViewModule(),
    readFile(viewPath, 'utf8'),
  ]);
  const document = new FakeDocument();
  const view = createOutputView({ document });
  const unsafeText = '<img src=x onerror=alert(1)>';

  view.renderOutputStatus(createSnapshot({
    displays: [{ id: 2, label: unsafeText }],
  }), createUx());
  assert.equal(document.getElementById('output-target').textContent, unsafeText);
  view.renderOutputError(unsafeText);

  assert.equal(document.getElementById('hdmi-status-text').textContent, 'HDMI 無法判定');
  assert.equal(document.getElementById('hdmi-status-badge').dataset.tone, 'unknown');
  assert.equal(document.getElementById('output-target').textContent, '無法取得輸出狀態');
  assert.equal(document.getElementById('output-status-error').textContent, unsafeText);
  assert.equal(document.getElementById('output-status-error').hidden, false);
  assert.match(source, /\.textContent\s*=/);
  assert.doesNotMatch(source, /\.innerHTML\s*=/);
  assert.doesNotMatch(source, /\brequire\s*\(|\bprocess\.|\bipcRenderer\b|\bwindow\./);
});

test('不完整狀態會安全拒絕並保留初始提示', async () => {
  const { createOutputView } = await loadViewModule();
  const document = new FakeDocument();
  document.getElementById('hdmi-status-text').textContent = '正在偵測 HDMI…';
  document.getElementById('output-target').textContent = '正在取得螢幕資訊…';
  const view = createOutputView({ document });

  assert.equal(view.renderOutputStatus({ displays: null }, createUx()), false);
  assert.equal(document.getElementById('hdmi-status-text').textContent, '正在偵測 HDMI…');
  assert.equal(document.getElementById('output-target').textContent, '正在取得螢幕資訊…');
});
