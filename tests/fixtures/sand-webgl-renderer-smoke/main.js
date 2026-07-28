'use strict';

const assert = require('node:assert/strict');
const fileSystem = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow, net, protocol } = require('electron');

const TEST_SCHEME = 'displaycore-webgl-smoke';
const TEST_URL = `${TEST_SCHEME}://app/index.html`;
const visualQaDirectory = process.env.DISPLAYCORE_VISUAL_QA_DIRECTORY?.trim();
const projectRoot = path.resolve(__dirname, '..', '..', '..');
const allowedResources = new Map([
  ['/index.html', path.join(__dirname, 'index.html')],
  ['/renderer.mjs', path.join(__dirname, 'renderer.mjs')],
  [
    '/display/sand-webgl-renderer.mjs',
    path.join(projectRoot, 'display', 'sand-webgl-renderer.mjs'),
  ],
]);

let testWindow = null;
let completed = false;
let timeout = null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: TEST_SCHEME,
    privileges: {
      standard: true,
      secure: true,
    },
  },
]);

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

async function waitForResult() {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const result = await testWindow.webContents.executeJavaScript(
      'window.__sandWebglSmoke ?? null',
      true,
    );

    if (result?.state === 'succeeded' || result?.state === 'failed') {
      return result;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error('等待 WebGL2 renderer smoke 結果逾時。');
}

app.whenReady().then(async () => {
  try {
    protocol.handle(TEST_SCHEME, (request) => {
      const requestUrl = new URL(request.url);
      const filePath = allowedResources.get(requestUrl.pathname);
      if (!filePath || requestUrl.host !== 'app') {
        return new Response('Not Found', { status: 404 });
      }
      return net.fetch(pathToFileURL(filePath).toString());
    });

    testWindow = new BrowserWindow({
      width: 320,
      height: 180,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });

    testWindow.webContents.on('console-message', (_event, details) => {
      if (details.level === 'error') {
        console.error(`Renderer console: ${details.message}`);
      }
    });

    await testWindow.loadURL(
      visualQaDirectory ? `${TEST_URL}?capture=1` : TEST_URL,
    );
    const result = await waitForResult();

    assert.equal(result.state, 'succeeded', result.stack || result.message);
    assert.equal(result.rendererCreated, true);
    assert.match(result.webglVersion, /WebGL 2\.0/i);
    assert.equal(result.frames.length, 3);
    assert.deepEqual(
      result.frames.map((frame) => frame.progress),
      [0.25, 0.5, 0.75],
    );
    for (const frame of result.frames) {
      assert.ok(frame.visiblePixelCount > 0);
      assert.ok(frame.coloredPixelCount > 0);
      assert.ok(frame.alphaTotal > 0);
      assert.ok(frame.colorTotal > 0);
      assert.ok(
        frame.mixedRowRatio >= 0.08,
        `進度 ${frame.progress} 缺少多孔風蝕前緣：` + JSON.stringify(frame),
      );
      assert.ok(
        frame.directionalLead >= 0.08,
        `進度 ${frame.progress} 未形成左清右留的風向：` +
          JSON.stringify(frame),
      );
    }
    assert.ok(
      result.particleTransport.downwindPixelCount >= 200 &&
        result.particleTransport.downwindCenterX >= 0.66 &&
        result.particleTransport.downwindCenterX <= 0.96,
      `圖片砂粒必須離開來源後向右形成可見尾流：${JSON.stringify(
        result.particleTransport,
      )}`,
    );
    assert.ok(
      result.particleTransport.upwindPixelCount <= 4,
      `圖片砂粒不可逆風出現在來源左側：${JSON.stringify(
        result.particleTransport,
      )}`,
    );
    assert.ok(
      result.frames[1].opaqueCenterY >= result.frames[0].opaqueCenterY + 0.08 &&
        result.frames[2].opaqueCenterY >= result.frames[1].opaqueCenterY + 0.08,
      `剩餘圖片必須隨風勢由下往上收縮：${JSON.stringify(
        result.frames.map(({ progress, opaqueCenterY }) => ({
          progress,
          opaqueCenterY,
        })),
      )}`,
    );
    assert.equal(result.fullHdDrawTimes.length, 3);
    for (const frameTime of result.fullHdDrawTimes) {
      assert.ok(
        Number.isFinite(frameTime.elapsedMs) && frameTime.elapsedMs <= 250,
        `1080p GPU 單幀不可超過 250ms：${JSON.stringify(
          result.fullHdDrawTimes,
        )}`,
      );
    }
    assert.equal(result.disposed, true);

    if (visualQaDirectory) {
      await fileSystem.mkdir(visualQaDirectory, { recursive: true });
      await Promise.all(result.frames.map((frame) => {
        assert.match(frame.dataUrl, /^data:image\/png;base64,/);
        return fileSystem.writeFile(
          path.join(
            visualQaDirectory,
            `sand-webgl-${String(frame.progress).replace('.', '-')}.png`,
          ),
          Buffer.from(frame.dataUrl.split(',', 2)[1], 'base64'),
        );
      }));
    }

    finish(
      0,
      `Sand WebGL renderer workflow succeeded ${JSON.stringify({
        particleTransport: result.particleTransport,
        fullHdDrawTimes: result.fullHdDrawTimes,
      })}`,
    );
  } catch (error) {
    finish(1, 'Sand WebGL renderer workflow failed', error);
  }
}).catch((error) => {
  finish(1, 'Sand WebGL renderer app startup failed', error);
});

timeout = setTimeout(() => {
  finish(1, 'Sand WebGL renderer workflow timed out');
}, 15_000);

app.on('window-all-closed', () => {
  if (!completed) {
    finish(1, 'Sand WebGL renderer window closed unexpectedly');
  }
});
