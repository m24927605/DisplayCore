'use strict';

const assert = require('node:assert/strict');
const fileSystem = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, net, protocol } = require('electron');

const TEST_SCHEME = 'displaycore-liquid-prototype';
const TEST_URL = `${TEST_SCHEME}://app/index.html`;
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const visualDirectory =
  process.env.DISPLAYCORE_LIQUID_PROTOTYPE_DIRECTORY?.trim();
const progressSteps = Object.freeze([0, 0.25, 0.5, 0.75, 1]);
const expectedColors = Object.freeze([
  '#B65B43',
  '#B65B43',
  '#B65B43',
  '#B65B43',
  '#B65B43',
]);
const allowedResources = new Map([
  ['/index.html', path.join(__dirname, 'index.html')],
  ['/prototype.css', path.join(__dirname, 'prototype.css')],
  ['/prototype.mjs', path.join(__dirname, 'prototype.mjs')],
  ['/liquid-state.mjs', path.join(__dirname, 'liquid-state.mjs')],
  ['/display/display.css', path.join(projectRoot, 'display', 'display.css')],
  [
    '/display/message-typography.mjs',
    path.join(projectRoot, 'display', 'message-typography.mjs'),
  ],
  [
    '/assets/fonts/GFSDidot-Regular.ttf',
    path.join(projectRoot, 'assets', 'fonts', 'GFSDidot-Regular.ttf'),
  ],
  [
    '/assets/fonts/SourceHanSerifTC-SemiBold.otf',
    path.join(projectRoot, 'assets', 'fonts', 'SourceHanSerifTC-SemiBold.otf'),
  ],
  ...['dark-marble', 'emerald-onyx', 'obsidian', 'walnut'].map((name) => [
    `/assets/message-backgrounds/${name}.jpg`,
    path.join(projectRoot, 'assets', 'message-backgrounds', `${name}.jpg`),
  ]),
]);

let testWindow = null;
let completed = false;
let timeout = null;
const rendererConsoleErrors = [];

app.commandLine.appendSwitch('force-device-scale-factor', '1');

protocol.registerSchemesAsPrivileged([{
  scheme: TEST_SCHEME,
  privileges: { standard: true, secure: true },
}]);

function finish(exitCode, message, error) {
  if (completed) {
    return;
  }
  completed = true;
  clearTimeout(timeout);
  if (error) {
    console.error(message, error);
  } else {
    console.info(message);
  }
  if (testWindow && !testWindow.isDestroyed()) {
    testWindow.destroy();
  }
  app.exit(exitCode);
}

async function waitForReady() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const result = await testWindow.webContents.executeJavaScript(
      'window.__liquidPrototype ?? null',
      true,
    );
    if (result?.state === 'succeeded' || result?.state === 'failed') {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待酒液文字原型 Renderer 逾時。');
}

function assertRectMatches(reference, candidate, label) {
  for (const property of ['left', 'top', 'width', 'height']) {
    assert.ok(
      Math.abs(reference[property] - candidate[property]) <= 0.5,
      `${label} ${property} 未與原始字層重合。`,
    );
  }
}

async function capture(progress) {
  if (!visualDirectory) {
    return null;
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const image = await testWindow.webContents.capturePage();
  const suffix = String(Math.round(progress * 100)).padStart(3, '0');
  await fileSystem.mkdir(visualDirectory, { recursive: true });
  await fileSystem.writeFile(
    path.join(visualDirectory, `liquid-message-${suffix}.png`),
    image.toPNG(),
  );
  return image.getSize();
}

app.whenReady().then(async () => {
  try {
    protocol.handle(TEST_SCHEME, (request) => {
      const requestUrl = new URL(request.url);
      const filePath = allowedResources.get(requestUrl.pathname);
      if (requestUrl.host !== 'app' || !filePath) {
        return new Response('Not Found', { status: 404 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    });

    testWindow = new BrowserWindow({
      width: 1_920,
      height: 1_080,
      frame: false,
      show: false,
      webPreferences: {
        backgroundThrottling: false,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    testWindow.webContents.on('console-message', (details) => {
      if (details.level === 'error') {
        rendererConsoleErrors.push(details.message);
        console.error(`Renderer console: ${details.message}`);
      }
    });

    await testWindow.loadURL(TEST_URL);
    const ready = await waitForReady();
    assert.equal(ready.state, 'succeeded', ready.stack || ready.message);
    assert.equal(
      await testWindow.webContents.executeJavaScript(
        "document.querySelectorAll('.prototype-caption').length",
        true,
      ),
      0,
      '原型不得加入正式 Display 沒有的裝飾標籤。',
    );

    const snapshots = [];
    for (let index = 0; index < progressSteps.length; index += 1) {
      const progress = progressSteps[index];
      const startedAt = performance.now();
      const snapshot = await testWindow.webContents.executeJavaScript(
        `window.__setLiquidPrototypeProgress(${progress})`,
        true,
      );
      const elapsedMilliseconds = performance.now() - startedAt;

      assert.equal(snapshot.progress, progress);
      assert.equal(snapshot.fillPercent, progress * 100);
      assert.equal(snapshot.surfacePercent, 100 - (progress * 100));
      assert.equal(snapshot.rowCount, 3);
      assert.equal(snapshot.stage.mode, 'page');
      assert.equal(snapshot.stage.width, 1_920);
      assert.equal(snapshot.stage.height, 1_080);
      assert.match(snapshot.stage.backgroundImage, /dark-marble\.jpg/);
      assert.equal(snapshot.viewportHasOverflow, false);
      assert.equal(snapshot.clock.animationCount, 0);
      assert.equal(snapshot.clock.liquidLayerCount, 0);
      assert.equal(snapshot.clock.strokeWidth, '0px');
      assert.ok(elapsedMilliseconds < 250);

      for (const row of snapshot.rows) {
        assert.equal(row.layerCount, 4);
        assert.equal(row.baseFillColor, 'rgba(0, 0, 0, 0)');
        assert.equal(row.fillTextColor, 'rgba(0, 0, 0, 0)');
        assert.equal(row.liquidColor, expectedColors[index]);
        assert.equal(row.shellStrokeColor, 'rgb(255, 255, 255)');
        assert.ok(Number.parseFloat(row.shellStrokeWidth) > 0);
        assert.match(row.fillClipPath, /^polygon\(/);
        assertRectMatches(row.baseRect, row.fillRect, `${row.message} 酒液層`);
        assertRectMatches(row.baseRect, row.surfaceRect, `${row.message} 液面層`);
        assertRectMatches(row.baseRect, row.shellRect, `${row.message} 白框層`);
        assertRectMatches(row.baseRect, row.wrapperRect, `${row.message} 容器`);
      }

      if (progress > 0 && progress < 1) {
        assert.ok(snapshot.surfaceSpread >= 1 && snapshot.surfaceSpread <= 4);
        assert.equal(
          snapshot.rows.every(({ surfaceOpacity }) =>
            surfaceOpacity >= 0.35 && surfaceOpacity <= 0.45),
          true,
        );
      } else {
        assert.equal(snapshot.rows.every(({ surfaceOpacity }) =>
          surfaceOpacity === 0), true);
      }

      const captureSize = await capture(progress);
      if (captureSize) {
        const horizontalScale = captureSize.width / snapshot.stage.width;
        const verticalScale = captureSize.height / snapshot.stage.height;
        assert.ok(
          horizontalScale >= 1 &&
            horizontalScale <= 4 &&
            Math.abs(horizontalScale - verticalScale) <= 0.001,
          `Compositor 截圖必須維持相同裝置縮放比例：${JSON.stringify({
            captureSize,
            stage: snapshot.stage,
          })}`,
        );
      }
      snapshots.push({ elapsedMilliseconds, snapshot });
    }

    assert.equal(
      snapshots.every(({ snapshot }) => snapshot.fontFaces.some(
        ({ family, status }) =>
          family === 'DisplayCore Source Han Serif TC' && status === 'loaded',
      )),
      true,
    );
    assert.equal(
      snapshots.every(({ snapshot }) => snapshot.fontFaces.some(
        ({ family, status }) =>
          family === 'DisplayCore GFS Didot' && status === 'loaded',
      )),
      true,
    );
    assert.deepEqual(
      rendererConsoleErrors,
      [],
      '酒液原型 Renderer 不得產生 console error。',
    );

    finish(0, `Liquid message prototype workflow succeeded ${JSON.stringify({
      captureDirectory: visualDirectory || null,
      elapsedMilliseconds: snapshots.map(({ elapsedMilliseconds }) =>
        Math.round(elapsedMilliseconds * 100) / 100),
    })}`);
  } catch (error) {
    finish(1, 'Liquid message prototype workflow failed', error);
  }
}).catch((error) => {
  finish(1, 'Liquid message prototype app startup failed', error);
});

timeout = setTimeout(() => {
  finish(1, 'Liquid message prototype workflow timed out');
}, 15_000);

app.on('window-all-closed', () => {
  if (!completed) {
    finish(1, 'Liquid message prototype window closed unexpectedly');
  }
});
