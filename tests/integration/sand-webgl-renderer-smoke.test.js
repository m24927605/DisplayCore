'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const fixtureRoot = path.resolve(
  __dirname,
  '..',
  'fixtures',
  'sand-webgl-renderer-smoke',
);

test('真實 Electron WebGL2 可編譯並繪製風吹砂 renderer', () => {
  const electronBinary = require('electron');
  const result = spawnSync(electronBinary, [fixtureRoot], {
    encoding: 'utf8',
    timeout: 20_000,
  });

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    /Sand WebGL renderer workflow succeeded/,
  );
});
