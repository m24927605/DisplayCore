'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

test('Main composition root 組合 HDMI、螢幕拓樸與 Display 定位服務', async () => {
  const source = await readFile(path.join(projectRoot, 'main.js'), 'utf8');

  assert.match(source, /\bscreen\s*,/);
  assert.match(source, /require\('\.\/main\/hdmi-detector'\)/);
  assert.match(source, /require\('\.\/main\/display-topology-service'\)/);
  assert.match(source, /require\('\.\/main\/display-placement-controller'\)/);
  assert.match(source, /new HdmiDetector\(/);
  assert.match(source, /new DisplayTopologyService\(/);
  assert.match(source, /new DisplayPlacementController\(/);
  assert.match(
    source,
    /configureDisplayWindow:[\s\S]*displayPlacementController\.applyToWindow/,
  );
  assert.match(
    source,
    /new IpcCoordinator\(\{[\s\S]*displayTopologyService,[\s\S]*displayPlacementController,/,
  );
});

test('Main 在設定後初始化拓樸與定位，退出時反向解除資源', async () => {
  const source = await readFile(path.join(projectRoot, 'main.js'), 'utf8');
  const initializeBlock = source.slice(
    source.indexOf('initializeRuntime:'),
    source.indexOf('shutdownRuntime:'),
  );
  const shutdownBlock = source.slice(
    source.indexOf('shutdownRuntime:'),
    source.indexOf('const started'),
  );

  const settingsPosition = initializeBlock.indexOf('settingsManager.initialize()');
  const topologyPosition = initializeBlock.indexOf(
    'displayTopologyService.initialize()',
  );
  const placementPosition = initializeBlock.indexOf(
    'displayPlacementController.initialize()',
  );
  const ipcPosition = initializeBlock.indexOf('ipcCoordinator.register()');

  assert.ok(settingsPosition >= 0);
  assert.ok(topologyPosition > settingsPosition);
  assert.ok(placementPosition > topologyPosition);
  assert.ok(ipcPosition > placementPosition);
  assert.match(shutdownBlock, /displayPlacementController\.dispose\(\)/);
  assert.match(shutdownBlock, /displayTopologyService\.dispose\(\)/);
});
