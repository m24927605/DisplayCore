'use strict';

const assert = require('node:assert/strict');
const {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const fixtureRoot = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'liquid-message-prototype',
);

test('真實 Electron 呈現五段白色容器與酒液填充原型', () => {
  const electronBinary = require('electron');
  const result = spawnSync(electronBinary, [fixtureRoot], {
    encoding: 'utf8',
    timeout: 25_000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Liquid message prototype workflow succeeded/,
  );
});

test('Retina compositor 以實體像素輸出五張等比例原型圖', () => {
  const electronBinary = require('electron');
  const outputDirectory = mkdtempSync(path.join(
    os.tmpdir(),
    'displaycore-liquid-prototype-',
  ));

  try {
    const result = spawnSync(electronBinary, [fixtureRoot], {
      encoding: 'utf8',
      timeout: 25_000,
      env: {
        ...process.env,
        DISPLAYCORE_LIQUID_PROTOTYPE_DIRECTORY: outputDirectory,
      },
    });

    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const files = readdirSync(outputDirectory).sort();
    assert.deepEqual(files, [
      'liquid-message-000.png',
      'liquid-message-025.png',
      'liquid-message-050.png',
      'liquid-message-075.png',
      'liquid-message-100.png',
    ]);

    const sizes = files.map((fileName) => {
      const png = readFileSync(path.join(outputDirectory, fileName));
      assert.deepEqual(
        [...png.subarray(0, 8)],
        [137, 80, 78, 71, 13, 10, 26, 10],
      );
      return {
        height: png.readUInt32BE(20),
        width: png.readUInt32BE(16),
      };
    });
    assert.equal(sizes.every(({ height, width }) =>
      width / 1_920 === height / 1_080 && width >= 1_920), true);
    assert.deepEqual(sizes, Array(5).fill(sizes[0]));
  } finally {
    rmSync(outputDirectory, { force: true, recursive: true });
  }
});
