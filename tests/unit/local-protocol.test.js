'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fileSystem = require('node:fs/promises');
const os = require('node:os');
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
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
]);

async function createManagedLogoHarness(t, contents = PNG_SIGNATURE) {
  const root = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-protocol-logo-'),
  );
  const managedLogoDirectory = path.join(root, 'logos');
  const digest = createHash('sha256').update(contents).digest('hex').slice(0, 24);
  const fileName = `${digest}.png`;
  await fileSystem.mkdir(managedLogoDirectory, { recursive: true });
  await fileSystem.writeFile(path.join(managedLogoDirectory, fileName), contents);
  t.after(() => fileSystem.rm(root, { recursive: true, force: true }));

  return {
    fileName,
    managedLogoDirectory,
    assetPath: `logos/${fileName}`,
  };
}

async function createManagedStandbyBackgroundHarness(
  t,
  contents = PNG_SIGNATURE,
) {
  const root = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-protocol-standby-background-'),
  );
  const managedStandbyBackgroundDirectory = path.join(
    root,
    'standby-backgrounds',
  );
  const digest = createHash('sha256').update(contents).digest('hex').slice(0, 24);
  const fileName = `${digest}.png`;
  await fileSystem.mkdir(managedStandbyBackgroundDirectory, { recursive: true });
  await fileSystem.writeFile(
    path.join(managedStandbyBackgroundDirectory, fileName),
    contents,
  );
  t.after(() => fileSystem.rm(root, { recursive: true, force: true }));

  return {
    fileName,
    managedStandbyBackgroundDirectory,
    assetPath: `standby-backgrounds/${fileName}`,
  };
}

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

test('受管理 Logo 只以目前啟用的同源雜湊 URL 提供正確 MIME', async (t) => {
  const logo = await createManagedLogoHarness(t);
  const handler = createLocalProtocolHandler({
    appRoot,
    net: { fetch: async () => new Response('static') },
    managedLogoDirectory: logo.managedLogoDirectory,
    getAllowedLogoPath: () => logo.assetPath,
  });
  const url = `displaycore://app/managed/logo/${logo.fileName}`;

  const response = await handler({ method: 'GET', url });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    response.headers.get('cross-origin-resource-policy'),
    'same-origin',
  );
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG_SIGNATURE);

  const headResponse = await handler({ method: 'HEAD', url });
  assert.equal(headResponse.status, 200);
  assert.equal((await headResponse.arrayBuffer()).byteLength, 0);
});

test('受管理 Logo 路由拒絕未選取檔案、變形 URL 與非唯讀方法', async (t) => {
  const logo = await createManagedLogoHarness(t);
  let allowedPath = logo.assetPath;
  const handler = createLocalProtocolHandler({
    appRoot,
    net: { fetch: async () => new Response('static') },
    managedLogoDirectory: logo.managedLogoDirectory,
    getAllowedLogoPath: () => allowedPath,
  });
  const validUrl = `displaycore://app/managed/logo/${logo.fileName}`;
  const otherHash = 'f'.repeat(24);

  for (const url of [
    `displaycore://other/managed/logo/${logo.fileName}`,
    `displaycore://app/managed/logo/${otherHash}.png`,
    `displaycore://app/managed/logo/${logo.fileName}/extra`,
    `displaycore://app/managed/logo/${logo.fileName}?cache=1`,
    `displaycore://app/managed/logo/${logo.fileName}#fragment`,
    'displaycore://app/managed/logo/../../config.json',
    'displaycore://app/managed/logo/%2e%2e%2fconfig.json',
    'displaycore://app/managed/logo/%252e%252e%252fconfig.json',
    'displaycore://app/managed/logo/%5c..%5cconfig.json',
    `displaycore://app/managed/logo/${otherHash}.svg`,
  ]) {
    const response = await handler({ method: 'GET', url });
    assert.equal(response.status, 404, url);
    assert.equal(await response.text(), 'Not Found');
  }

  allowedPath = null;
  assert.equal((await handler({ method: 'GET', url: validUrl })).status, 404);
  assert.equal((await handler({ method: 'POST', url: validUrl })).status, 405);
});

test('受管理 Logo 每次重驗一般檔案、magic bytes 與內容雜湊', async (t) => {
  const logo = await createManagedLogoHarness(t);
  let allowedPath = logo.assetPath;
  const handler = createLocalProtocolHandler({
    appRoot,
    net: { fetch: async () => new Response('static') },
    managedLogoDirectory: logo.managedLogoDirectory,
    getAllowedLogoPath: () => allowedPath,
  });
  const url = `displaycore://app/managed/logo/${logo.fileName}`;
  const filePath = path.join(logo.managedLogoDirectory, logo.fileName);

  await fileSystem.writeFile(filePath, Buffer.from('not a png'));
  let response = await handler({ method: 'GET', url });
  assert.equal(response.status, 404);

  const replacement = Buffer.concat([PNG_SIGNATURE, Buffer.from('changed')]);
  await fileSystem.writeFile(filePath, replacement);
  response = await handler({ method: 'GET', url });
  assert.equal(response.status, 404);

  await fileSystem.rm(filePath);
  const targetPath = path.join(logo.managedLogoDirectory, 'target.png');
  await fileSystem.writeFile(targetPath, PNG_SIGNATURE);
  await fileSystem.symlink(targetPath, filePath);
  response = await handler({ method: 'GET', url });
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), /tmp|displaycore-protocol-logo|target/i);

  allowedPath = `logos/${'a'.repeat(24)}.png`;
  response = await handler({
    method: 'GET',
    url: `displaycore://app/managed/logo/${'a'.repeat(24)}.png`,
  });
  assert.equal(response.status, 404);
});

test('受管理待機背景只以目前設定的同源雜湊 URL 提供正確 MIME', async (t) => {
  const background = await createManagedStandbyBackgroundHarness(t);
  const fetchedUrls = [];
  const handler = createLocalProtocolHandler({
    appRoot,
    net: {
      async fetch(url) {
        fetchedUrls.push(url);
        return new Response('static');
      },
    },
    managedStandbyBackgroundDirectory:
      background.managedStandbyBackgroundDirectory,
    getAllowedStandbyBackgroundPath: () => background.assetPath,
  });
  const url =
    `displaycore://app/managed/standby-background/${background.fileName}`;

  const response = await handler({ method: 'GET', url });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('content-length'), String(PNG_SIGNATURE.length));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(
    response.headers.get('cross-origin-resource-policy'),
    'same-origin',
  );
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG_SIGNATURE);
  assert.deepEqual(fetchedUrls, []);

  const headResponse = await handler({ method: 'HEAD', url });
  assert.equal(headResponse.status, 200);
  assert.equal(headResponse.headers.get('content-length'), String(PNG_SIGNATURE.length));
  assert.equal((await headResponse.arrayBuffer()).byteLength, 0);
});

test('受管理待機背景拒絕變形路由、未選取檔案、非唯讀方法與內容篡改', async (t) => {
  const background = await createManagedStandbyBackgroundHarness(t);
  let allowedPath = background.assetPath;
  const handler = createLocalProtocolHandler({
    appRoot,
    net: { fetch: async () => new Response('static') },
    managedStandbyBackgroundDirectory:
      background.managedStandbyBackgroundDirectory,
    getAllowedStandbyBackgroundPath: () => allowedPath,
  });
  const validUrl =
    `displaycore://app/managed/standby-background/${background.fileName}`;
  const otherHash = 'f'.repeat(24);

  for (const url of [
    `displaycore://other/managed/standby-background/${background.fileName}`,
    `displaycore://app/managed/standby-background/${otherHash}.png`,
    `displaycore://app/managed/standby-background/${background.fileName}?cache=1`,
    'displaycore://app/managed/standby-background/%2e%2e%2fconfig.json',
    `displaycore://app/managed/logo/${background.fileName}`,
  ]) {
    const response = await handler({ method: 'GET', url });
    assert.equal(response.status, 404, url);
    assert.equal(await response.text(), 'Not Found');
  }

  allowedPath = null;
  assert.equal((await handler({ method: 'GET', url: validUrl })).status, 404);
  allowedPath = background.assetPath;
  assert.equal((await handler({ method: 'POST', url: validUrl })).status, 405);
  const filePath = path.join(
    background.managedStandbyBackgroundDirectory,
    background.fileName,
  );

  await fileSystem.writeFile(filePath, Buffer.from('not a png'));
  let response = await handler({ method: 'GET', url: validUrl });
  assert.equal(response.status, 404);

  const replacement = Buffer.concat([PNG_SIGNATURE, Buffer.from('changed')]);
  await fileSystem.writeFile(filePath, replacement);
  response = await handler({ method: 'GET', url: validUrl });
  assert.equal(response.status, 404);
});
