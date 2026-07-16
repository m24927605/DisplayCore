'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const {
  APP_SCHEME,
  createLocalProtocolHandler,
  installLocalProtocol,
  registerAppScheme,
  resolveAppResource,
} = require('../../main/local-protocol');

const appRoot = path.resolve(__dirname, '..', '..');

test('自訂協定在 app ready 前註冊為 standard 與 secure', () => {
  const protocol = {
    registerSchemesAsPrivileged(schemes) {
      this.schemes = schemes;
    },
  };

  registerAppScheme(protocol);

  assert.equal(APP_SCHEME, 'displaycore');
  assert.deepEqual(protocol.schemes, [
    {
      scheme: 'displaycore',
      privileges: {
        standard: true,
        secure: true,
      },
    },
  ]);
});

test('資源解析只允許 control、display 與 assets 目錄', () => {
  assert.equal(
    resolveAppResource(appRoot, 'displaycore://app/control/index.html'),
    path.join(appRoot, 'control', 'index.html'),
  );
  assert.equal(
    resolveAppResource(appRoot, 'displaycore://app/assets/logos/logo.svg'),
    path.join(appRoot, 'assets', 'logos', 'logo.svg'),
  );

  for (const unsafeUrl of [
    'displaycore://other/control/index.html',
    'displaycore://app/config.json',
    'displaycore://app/../package.json',
    'displaycore://app/control/%2e%2e/%2e%2e/package.json',
    'displaycore://app/control/%5c..%5cpackage.json',
    'displaycore://app/control/%E0%A4%A',
    'displaycore://app/control/%00index.html',
  ]) {
    assert.equal(resolveAppResource(appRoot, unsafeUrl), null, unsafeUrl);
  }
});

test('協定 handler 以 net.fetch 提供本機檔案並隱藏無效路徑', async () => {
  const fetchedUrls = [];
  const net = {
    async fetch(url) {
      fetchedUrls.push(url);
      return new Response('ok', { status: 200 });
    },
  };
  const handler = createLocalProtocolHandler({ appRoot, net });

  const validResponse = await handler({
    method: 'GET',
    url: 'displaycore://app/display/index.html',
  });
  assert.equal(validResponse.status, 200);
  assert.deepEqual(fetchedUrls, [
    pathToFileURL(path.join(appRoot, 'display', 'index.html')).toString(),
  ]);

  const invalidResponse = await handler({
    method: 'GET',
    url: 'displaycore://app/config.json',
  });
  assert.equal(invalidResponse.status, 404);
  assert.equal(await invalidResponse.text(), 'Not Found');

  const rejectedMethod = await handler({
    method: 'POST',
    url: 'displaycore://app/display/index.html',
  });
  assert.equal(rejectedMethod.status, 405);
});

test('本機檔案讀取錯誤不洩漏系統路徑或例外內容', async () => {
  const handler = createLocalProtocolHandler({
    appRoot,
    net: {
      async fetch() {
        throw new Error(`無法讀取 ${path.join(appRoot, 'display', 'index.html')}`);
      },
    },
  });

  const response = await handler({
    method: 'GET',
    url: 'displaycore://app/display/index.html',
  });

  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not Found');
});

test('安裝協定時使用 protocol.handle', () => {
  const protocol = {
    handle(scheme, handler) {
      this.scheme = scheme;
      this.handler = handler;
    },
  };

  installLocalProtocol({
    protocol,
    net: { fetch: async () => new Response('ok') },
    appRoot,
  });

  assert.equal(protocol.scheme, 'displaycore');
  assert.equal(typeof protocol.handler, 'function');
});
