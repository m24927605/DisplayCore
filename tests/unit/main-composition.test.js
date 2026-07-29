'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');

test('Main composition root 組合 HDMI、螢幕拓樸與雙視窗定位服務', async () => {
  const source = await readFile(path.join(projectRoot, 'main.js'), 'utf8');

  assert.match(source, /\bscreen\s*,/);
  assert.match(source, /\bpowerMonitor\s*,/);
  assert.match(source, /require\('\.\/main\/hdmi-detector'\)/);
  assert.match(source, /require\('\.\/main\/display-topology-service'\)/);
  assert.match(source, /require\('\.\/main\/display-placement-controller'\)/);
  assert.match(source, /require\('\.\/main\/control-placement-controller'\)/);
  assert.match(source, /new HdmiDetector\(/);
  assert.match(source, /new DisplayTopologyService\(/);
  assert.match(
    source,
    /new DisplayTopologyService\(\{[\s\S]*screen,[\s\S]*powerMonitor,/,
  );
  assert.match(source, /new DisplayPlacementController\(/);
  assert.match(source, /new ControlPlacementController\(/);
  assert.match(
    source,
    /new DisplayTopologyService\(\{[\s\S]*settingsManager,/,
  );
  assert.match(
    source,
    /configureControlWindow:[\s\S]*controlPlacementController\.applyToWindowWithRetry/,
  );
  assert.match(
    source,
    /configureDisplayWindow:[\s\S]*displayPlacementController\.applyToWindowWithRetry/,
  );
  assert.match(
    source,
    /new IpcCoordinator\(\{[\s\S]*displayTopologyService,[\s\S]*displayPlacementController,/,
  );
  assert.match(source, /displayAvailable:\s*false/);
  assert.match(source, /onDisplayUnavailable:[\s\S]*setDisplayAvailable\(false\)/);
  assert.match(source, /onDisplayAvailable:[\s\S]*setDisplayAvailable\(true\)/);
  assert.match(source, /DISPLAY_REFIT_REQUESTED/);
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
  const controlPlacementPosition = initializeBlock.indexOf(
    'controlPlacementController.initialize()',
  );
  const ipcPosition = initializeBlock.indexOf('ipcCoordinator.register()');

  assert.ok(settingsPosition >= 0);
  assert.ok(topologyPosition > settingsPosition);
  assert.ok(placementPosition > topologyPosition);
  assert.ok(controlPlacementPosition > topologyPosition);
  assert.ok(ipcPosition > placementPosition);
  assert.ok(ipcPosition > controlPlacementPosition);
  assert.match(shutdownBlock, /controlPlacementController\.dispose\(\)/);
  assert.match(shutdownBlock, /displayPlacementController\.dispose\(\)/);
  assert.match(shutdownBlock, /displayTopologyService\.dispose\(\)/);
});

test('Main 組合待機背景匯入器、Control IPC 與獨立受管理協定目錄', async () => {
  const source = await readFile(path.join(projectRoot, 'main.js'), 'utf8');

  assert.match(
    source,
    /require\('\.\/config\/standby-background-importer'\)/,
  );
  assert.match(source, /new StandbyBackgroundImporter\(\{/);
  assert.match(
    source,
    /new StandbyBackgroundImporter\(\{[\s\S]*assetDirectory:\s*path\.join\(dataRoot,\s*'standby-backgrounds'\)/,
  );
  assert.match(
    source,
    /new IpcCoordinator\(\{[\s\S]*standbyBackgroundImporter,/,
  );
  assert.match(
    source,
    /installLocalProtocol\(\{[\s\S]*managedStandbyBackgroundDirectory:\s*path\.join\(dataRoot,\s*'standby-backgrounds'\)/,
  );
  assert.match(
    source,
    /getAllowedStandbyBackgroundPaths:\s*\(\)\s*=>[\s\S]*config\.standby\.backgroundImagePaths/,
  );
});
