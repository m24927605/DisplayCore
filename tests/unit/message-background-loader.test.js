'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'display', 'message-background-loader.mjs'),
).href;

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return Object.freeze({ promise, resolve, reject });
}

function createImageHarness({ immediate = false } = {}) {
  const images = [];

  return Object.freeze({
    images,
    createImage() {
      const decoded = createDeferred();
      const image = {
        decoding: '',
        naturalWidth: 0,
        naturalHeight: 0,
        removedSource: false,
        source: '',
        decodeCalls: 0,
        get src() {
          return this.source;
        },
        set src(value) {
          this.source = value;
        },
        decode() {
          this.decodeCalls += 1;
          if (immediate) {
            this.naturalWidth = 3_840;
            this.naturalHeight = 2_160;
            return Promise.resolve();
          }
          return decoded.promise.then(() => {
            this.naturalWidth = 3_840;
            this.naturalHeight = 2_160;
          });
        },
        removeAttribute(name) {
          assert.equal(name, 'src');
          this.removedSource = true;
          this.source = '';
        },
        decoded,
      };
      images.push(image);
      return image;
    },
  });
}

test('只解碼目前選取的單一 4K 材質，重複選取共用同一 Promise', async () => {
  const { createMessageBackgroundLoader } = await import(moduleUrl);
  const harness = createImageHarness({ immediate: true });
  const loader = createMessageBackgroundLoader({
    createImage: harness.createImage,
    assetUrls: {
      obsidian: 'displaycore://app/assets/message-backgrounds/obsidian.jpg',
    },
  });

  const first = loader.prepare('obsidian');
  const repeated = loader.prepare('obsidian');

  assert.equal(first, repeated);
  assert.equal(await first, true);
  assert.equal(harness.images.length, 1);
  assert.equal(harness.images[0].decoding, 'async');
  assert.equal(harness.images[0].decodeCalls, 1);
  assert.equal(
    harness.images[0].src,
    'displaycore://app/assets/message-backgrounds/obsidian.jpg',
  );
});

test('快速切換材質會釋放舊圖，舊 decode 完成也不能被視為可套用', async () => {
  const { createMessageBackgroundLoader } = await import(moduleUrl);
  const harness = createImageHarness();
  const loader = createMessageBackgroundLoader({
    createImage: harness.createImage,
    assetUrls: {
      obsidian: 'displaycore://app/assets/message-backgrounds/obsidian.jpg',
      walnut: 'displaycore://app/assets/message-backgrounds/walnut.jpg',
    },
  });

  const stale = loader.prepare('obsidian');
  const current = loader.prepare('walnut');

  assert.equal(harness.images.length, 2);
  assert.equal(harness.images[0].removedSource, true);
  harness.images[0].decoded.resolve();
  harness.images[1].decoded.resolve();
  assert.equal(await stale, false);
  assert.equal(await current, true);
});

test('純色、未知材質、解碼失敗與 dispose 都會安全失敗且釋放圖片', async () => {
  const { createMessageBackgroundLoader } = await import(moduleUrl);
  const harness = createImageHarness();
  const loader = createMessageBackgroundLoader({
    createImage: harness.createImage,
    assetUrls: {
      obsidian: 'displaycore://app/assets/message-backgrounds/obsidian.jpg',
    },
  });

  assert.equal(await loader.prepare('solid'), true);
  assert.equal(await loader.prepare('unknown'), false);
  assert.equal(harness.images.length, 0);

  const failed = loader.prepare('obsidian');
  // 某些 Chromium 解碼失敗仍可能先填入 natural dimensions；仍須可重試。
  harness.images[0].naturalWidth = 3_840;
  harness.images[0].naturalHeight = 2_160;
  harness.images[0].decoded.reject(new Error('private decode detail'));
  assert.equal(await failed, false);

  const retry = loader.prepare('obsidian');
  assert.notEqual(retry, failed);
  assert.equal(harness.images.length, 2);
  loader.dispose();
  harness.images[1].decoded.resolve();
  assert.equal(await retry, false);
  assert.equal(harness.images[1].removedSource, true);
  assert.equal(await loader.prepare('obsidian'), false);
});
