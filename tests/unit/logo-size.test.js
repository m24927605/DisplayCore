'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

async function loadModule() {
  return import('../../display/logo-size.mjs');
}

test('Logo 50% 至 200% 保持原比例，超過 200% 後持續壓縮成長至安全上限', async () => {
  const { calculateLogoLayoutScales } = await loadModule();

  assert.deepEqual(calculateLogoLayoutScales(50), {
    configuredScale: 0.5,
    pageScale: 0.5,
  });
  assert.deepEqual(calculateLogoLayoutScales(200), {
    configuredScale: 2,
    pageScale: 2,
  });

  const fiveHundred = calculateLogoLayoutScales(500);
  const oneThousand = calculateLogoLayoutScales(1_000);
  assert.ok(fiveHundred.pageScale > 2);
  assert.ok(oneThousand.pageScale > fiveHundred.pageScale);
  assert.deepEqual(oneThousand, {
    configuredScale: 10,
    pageScale: 3.2,
  });
});

test('Logo 分段映射在每個 5% 設定步進皆單調成長', async () => {
  const { calculateLogoLayoutScales } = await loadModule();
  let previous = calculateLogoLayoutScales(50);

  for (let sizePercent = 55; sizePercent <= 1_000; sizePercent += 5) {
    const current = calculateLogoLayoutScales(sizePercent);
    assert.ok(current.configuredScale > previous.configuredScale);
    assert.ok(current.pageScale > previous.pageScale);
    previous = current;
  }
});

test('Logo 分段映射拒絕設定 schema 以外的數值', async () => {
  const { calculateLogoLayoutScales } = await loadModule();

  for (const value of [49, 1_001, 101, 100.5, '100']) {
    assert.throws(
      () => calculateLogoLayoutScales(value),
      { name: 'TypeError', message: 'Logo 大小設定不正確。' },
      String(value),
    );
  }
});
