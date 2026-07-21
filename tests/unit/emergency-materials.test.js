'use strict';

const assert = require('node:assert/strict');
const { readFile, stat } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');
const displayHtmlPath = path.join(projectRoot, 'display', 'index.html');
const materialCssPath = path.join(
  projectRoot,
  'display',
  'emergency-materials.css',
);
const assetDirectory = path.join(projectRoot, 'assets', 'emergency-materials');

const MATERIALS = Object.freeze([
  Object.freeze({
    tone: 'inspection',
    fileName: 'red-cypress-4k.jpg',
    signalColor: '#A70F22',
  }),
  Object.freeze({
    tone: 'release',
    fileName: 'emerald-4k.jpg',
    signalColor: '#087A46',
  }),
]);

function readJpegDimensions(buffer) {
  assert.equal(buffer[0], 0xff, 'JPEG 必須以 FF D8 起始');
  assert.equal(buffer[1], 0xd8, 'JPEG 必須以 FF D8 起始');

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = buffer[offset + 1];
    if (marker === 0xd9 || marker === 0xda) {
      break;
    }

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (
      marker >= 0xc0 &&
      marker <= 0xc3 &&
      segmentLength >= 7
    ) {
      return Object.freeze({
        height: buffer.readUInt16BE(offset + 5),
        width: buffer.readUInt16BE(offset + 7),
      });
    }

    offset += 2 + segmentLength;
  }

  throw new Error('找不到 JPEG 尺寸標記。');
}

test('Display 載入獨立緊急材質樣式，555 與 888 使用正確的本機材質', async () => {
  const [html, css] = await Promise.all([
    readFile(displayHtmlPath, 'utf8'),
    readFile(materialCssPath, 'utf8'),
  ]);

  assert.match(
    html,
    /<link\s+rel="stylesheet"\s+href="\.\/emergency-materials\.css">/,
  );

  for (const material of MATERIALS) {
    const escapedFileName = material.fileName.replaceAll('.', '\\.');
    assert.match(
      css,
      new RegExp(
        `data-emergency-tone="${material.tone}"[\\s\\S]*?` +
        `--emergency-material-image:\\s*url\\("\\.\\.\\/assets\\/` +
        `emergency-materials\\/${escapedFileName}"\\)`,
      ),
      `${material.tone} 必須綁定自己的離線材質`,
    );
    assert.match(css, new RegExp(material.signalColor, 'i'));
  }

  assert.doesNotMatch(css, /https?:|data:/i, '緊急材質不得依賴網路或 data URL');
});

test('九宮格共同切割一張材質，且保留純白數字的高對比保護', async () => {
  const css = await readFile(materialCssPath, 'utf8');

  assert.match(
    css,
    /\.fill-cell\s*\{[\s\S]*?background-size:\s*100%\s+100%,\s*300%\s+300%/,
    '每格的材質層必須放大為 3×3，才能共同切割而不重複貼圖',
  );
  assert.match(css, /color:\s*#ffffff/i);
  assert.match(css, /text-shadow:/);
  assert.doesNotMatch(css, /animation|transition|will-change/i);

  const expectedPositions = [
    ['1', '0%', '0%'],
    ['2', '50%', '0%'],
    ['3', '100%', '0%'],
    ['4', '0%', '50%'],
    ['5', '50%', '50%'],
    ['6', '100%', '50%'],
    ['7', '0%', '100%'],
    ['8', '50%', '100%'],
    ['9', '100%', '100%'],
  ];

  for (const [index, inlinePosition, blockPosition] of expectedPositions) {
    assert.match(
      css,
      new RegExp(
        `\\.fill-cell:nth-child\\(${index}\\)\\s*\\{` +
        `[\\s\\S]*?--material-inline-position:\\s*${inlinePosition}` +
        `[\\s\\S]*?--material-block-position:\\s*${blockPosition}`,
      ),
      `第 ${index} 格必須取得材質的 ${inlinePosition} ${blockPosition}`,
    );
  }
});

test('非 16:9 螢幕邊帶仍依 555／888 tone 維持明顯紅色與綠色', async () => {
  const css = await readFile(materialCssPath, 'utf8');

  assert.match(
    css,
    /body:has\(\s*\.display-stage\[data-mode="emergency"\]\[data-emergency-tone="inspection"\]\s*\)\s*\{[\s\S]*?background-color:\s*color-mix\([\s\S]*?#A70F22[\s\S]*?\)/i,
  );
  assert.match(
    css,
    /body:has\(\s*\.display-stage\[data-mode="emergency"\]\[data-emergency-tone="release"\]\s*\)\s*\{[\s\S]*?background-color:\s*color-mix\([\s\S]*?#087A46[\s\S]*?\)/i,
  );
});

test('紅檜木與祖母綠材質以 4K JPEG 隨專案封裝', async () => {
  for (const material of MATERIALS) {
    const assetPath = path.join(assetDirectory, material.fileName);
    const [metadata, bytes] = await Promise.all([
      stat(assetPath),
      readFile(assetPath),
    ]);
    const dimensions = readJpegDimensions(bytes);

    assert.ok(metadata.size >= 250_000, `${material.fileName} 不得是空白占位圖`);
    assert.deepEqual(dimensions, { width: 3840, height: 2160 });
  }

  const provenance = await readFile(
    path.join(assetDirectory, 'ASSET_PROVENANCE.md'),
    'utf8',
  );
  assert.match(provenance, /red-cypress-4k\.jpg/);
  assert.match(provenance, /emerald-4k\.jpg/);
  assert.match(provenance, /OpenAI/i);
});
