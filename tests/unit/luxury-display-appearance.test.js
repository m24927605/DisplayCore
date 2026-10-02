'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { access, readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

const MESSAGE_BACKGROUND_ASSETS = Object.freeze({
  obsidian: 'obsidian.jpg',
  'dark-marble': 'dark-marble.jpg',
  walnut: 'walnut.jpg',
  'emerald-onyx': 'emerald-onyx.jpg',
});

async function readProjectFile(...segments) {
  return readFile(path.join(projectRoot, ...segments), 'utf8');
}

function readJpegDimensions(contents) {
  assert.equal(contents.readUInt16BE(0), 0xFFD8, '訊息材質必須是有效 JPEG');

  const startOfFrameMarkers = new Set([
    0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
    0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF,
  ]);
  let offset = 2;

  while (offset + 8 < contents.length) {
    if (contents[offset] !== 0xFF) {
      offset += 1;
      continue;
    }

    const marker = contents[offset + 1];
    offset += 2;
    if (marker === 0xD8 || marker === 0xD9 || marker === 0x01 ||
      (marker >= 0xD0 && marker <= 0xD7)) {
      continue;
    }

    const segmentLength = contents.readUInt16BE(offset);
    assert.ok(segmentLength >= 2, 'JPEG segment 長度必須有效');
    if (startOfFrameMarkers.has(marker)) {
      return Object.freeze({
        width: contents.readUInt16BE(offset + 5),
        height: contents.readUInt16BE(offset + 3),
      });
    }
    offset += segmentLength;
  }

  assert.fail('JPEG 缺少可讀取尺寸的 Start Of Frame segment');
}

test('高級顯示預設具備離線字型、材質背景、獨立特效開關與待機畫面時間字體大小', async () => {
  const [configSource, html, css, appSource] = await Promise.all([
    readProjectFile('config.json'),
    readProjectFile('control', 'index.html'),
    readProjectFile('display', 'display.css'),
    readProjectFile('display', 'app.mjs'),
  ]);
  const config = JSON.parse(configSource);

  assert.equal(config.configVersion, 12);
  assert.equal(config.appearance.messageBackgroundPreset, 'obsidian');
  assert.equal(config.appearance.messageLiquidEffectEnabled, true);
  assert.equal(config.standby.sandEffectEnabled, true);
  assert.equal(config.appearance.standbyClockSizePercent, 100);
  assert.match(config.appearance.fontFamily, /DisplayCore Source Han Serif TC/);

  assert.match(html, /id="message-background-preset-select"/);
  for (const preset of [
    'solid',
    'obsidian',
    'dark-marble',
    'walnut',
    'emerald-onyx',
  ]) {
    assert.match(html, new RegExp(`value="${preset}"`));
  }
  assert.match(
    html,
    /id="standby-clock-size-percent-input"[^>]+min="50"[^>]+max="300"[^>]+step="5"/,
  );
  assert.match(
    html,
    /<label[^>]+for="message-liquid-effect-enabled-input"[\s\S]*?<strong>訊息特效<\/strong>[\s\S]*?<input[^>]+id="message-liquid-effect-enabled-input"[^>]+type="checkbox"/,
  );
  assert.match(
    html,
    /<label[^>]+for="standby-sand-effect-enabled-input"[\s\S]*?<strong>待機頁面特效（風吹沙）<\/strong>[\s\S]*?<input[^>]+id="standby-sand-effect-enabled-input"[^>]+type="checkbox"/,
  );

  assert.match(css, /@font-face\s*{[^}]*font-family:\s*"DisplayCore Source Han Serif TC"/s);
  assert.match(css, /url\("\.\.\/assets\/fonts\/SourceHanSerifTC-SemiBold\.otf"\)/);
  assert.match(css, /--standby-clock-size-scale:\s*1/);
  assert.match(
    css,
    /data-message-background="obsidian"[\s\S]*data-message-background="dark-marble"[\s\S]*data-message-background="walnut"[\s\S]*data-message-background="emerald-onyx"/,
  );
  for (const [preset, fileName] of Object.entries(MESSAGE_BACKGROUND_ASSETS)) {
    assert.match(
      css,
      new RegExp(
        `data-message-background="${preset}"[^}]*` +
        `background-image:\\s*url\\("\\.\\.\\/assets\\/message-backgrounds\\/${fileName.replace('.', '\\.')}"\\)`,
        's',
      ),
      `${preset} 必須載入真實材質圖片，不能再用 CSS 幾何漸層模擬`,
    );
  }
  assert.match(
    css,
    /data-mode="blank"[^}]*\.display-clock[\s\S]*var\(--standby-clock-size-scale\)/,
  );
  assert.match(
    css,
    /data-mode="page"[^}]*not\(\[data-message-background="solid"\]\)::after[\s\S]*linear-gradient\(rgb\(0 0 0 \/ 14%\), rgb\(0 0 0 \/ 14%\)\)/,
  );
  assert.match(
    css,
    /\.message-row\s*{[^}]*text-shadow:[^;]*rgb\(0 0 0 \/ 48%\)/s,
  );
  assert.match(appSource, /'--standby-clock-size-scale'/);
  assert.match(appSource, /dataset\.messageBackground\s*=/);
  assert.match(appSource, /createMessageBackgroundLoader/);
  assert.match(appSource, /messageBackgroundLoader\.prepare/);
  assert.match(appSource, /waitForCurrentMessageBackground/);

  await Promise.all([
    access(
      path.join(
        projectRoot,
        'assets',
        'fonts',
        'SourceHanSerifTC-SemiBold.otf',
      ),
    ),
    access(path.join(projectRoot, 'assets', 'fonts', 'OFL-SourceHanSerif.txt')),
    access(
      path.join(
        projectRoot,
        'assets',
        'message-backgrounds',
        'ASSET_PROVENANCE.md',
      ),
    ),
  ]);

  const materialDigests = new Set();
  for (const [preset, fileName] of Object.entries(MESSAGE_BACKGROUND_ASSETS)) {
    const assetPath = path.join(
      projectRoot,
      'assets',
      'message-backgrounds',
      fileName,
    );
    const [contents, metadata] = await Promise.all([
      readFile(assetPath),
      stat(assetPath),
    ]);
    const { width, height } = readJpegDimensions(contents);

    assert.ok(width >= 1_920, `${preset} 寬度不足 Full HD：${width}px`);
    assert.ok(height >= 1_080, `${preset} 高度不足 Full HD：${height}px`);
    assert.ok(
      Math.abs((width / height) - (16 / 9)) < 0.01,
      `${preset} 必須是 16:9：${width}x${height}`,
    );
    assert.ok(
      metadata.size >= 200_000,
      `${preset} 檔案過小，疑似缺乏足夠真實紋理：${metadata.size} bytes`,
    );
    materialDigests.add(
      createHash('sha256').update(contents).digest('hex'),
    );
  }
  assert.equal(
    materialDigests.size,
    Object.keys(MESSAGE_BACKGROUND_ASSETS).length,
    '四種背景必須使用四張不同材質圖片',
  );
});

test('555 與 888 依 emergencyTone 顯示為九宮格單一數字', async () => {
  const [css, appSource] = await Promise.all([
    readProjectFile('display', 'display.css'),
    readProjectFile('display', 'app.mjs'),
  ]);

  assert.match(appSource, /EMERGENCY_GRID_CELL_COUNT\s*=\s*9/);
  assert.match(
    appSource,
    /EMERGENCY_GLYPHS[\s\S]*inspection:\s*'5'[\s\S]*release:\s*'8'/,
  );
  assert.match(appSource, /cell\.textContent\s*=\s*glyph/);
  assert.doesNotMatch(appSource, /message\[0\]/);
  assert.doesNotMatch(appSource, /555|888/);
  assert.match(
    css,
    /\.fill-layer\s*{[^}]*grid-template-columns:\s*repeat\(3,[^}]*grid-template-rows:\s*repeat\(3,/s,
  );
  assert.match(css, /\.fill-cell\s*{[^}]*place-items:\s*center/s);
});
