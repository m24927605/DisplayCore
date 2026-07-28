'use strict';

const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..', '..');
const workflowPath = path.join(
  projectRoot,
  '.github',
  'workflows',
  'windows-installer.yml',
);
const approvedActionReferences = [
  'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1',
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020',
  'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
];
const windowsCiIntegrationTests = [
  'tests/integration/control-settings-focus.regression-1.test.js',
  'tests/integration/control-window-smoke.test.js',
  'tests/integration/ipc-bridge-smoke.test.js',
  'tests/integration/main-process-smoke.test.js',
  'tests/integration/message-liquid-lifetime-qa.test.js',
];

test('GitHub Actions 可在 Windows x64 建置並保存 DisplayCoreSetup.exe', async () => {
  // Windows checkout 可能將文字檔轉成 CRLF；工作流契約不應依賴換行格式。
  const workflow = (await readFile(workflowPath, 'utf8')).replace(/\r\n?/gu, '\n');
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );

  assert.match(workflow, /^name: Build Windows installer$/m);
  assert.match(workflow, /^\s{2}workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^\s{2}(?:push|pull_request):$/m);
  assert.match(workflow, /^permissions:\n\s{2}contents: read$/m);
  assert.equal(workflow.match(/^\s*permissions:$/gm)?.length, 1);
  assert.match(workflow, /^\s{4}if: github\.ref == 'refs\/heads\/main'$/m);
  assert.match(workflow, /^\s{4}runs-on: windows-2022$/m);
  assert.match(workflow, /^\s{4}timeout-minutes: 45$/m);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /node-version-file: \.nvmrc/);
  assert.match(workflow, /^\s{8}run: npm ci$/m);
  assert.match(workflow, /^\s{8}run: npm run test:ci:windows$/m);
  assert.match(
    workflow,
    /^\s{8}run: npm run make -- --platform=win32 --arch=x64$/m,
  );
  assert.match(
    workflow,
    /out\/make\/squirrel\.windows\/x64\/DisplayCoreSetup\.exe/,
  );
  assert.match(workflow, /ReadUInt16\(\) -ne 0x5A4D/);
  assert.match(workflow, /ReadUInt32\(\) -ne 0x00004550/);
  assert.match(
    workflow,
    /\$payload = 'out\/DisplayCore-win32-x64\/DisplayCore\.exe'/,
  );
  assert.match(workflow, /\$payloadMachine -ne 0x8664/);
  assert.doesNotMatch(workflow, /\$setupMachine -ne 0x8664/);
  assert.match(workflow, /Get-FileHash[\s\S]*-Algorithm SHA256/);
  assert.match(workflow, /name: DisplayCoreSetup-windows-x64/);
  assert.match(workflow, /path: release\/windows-x64/);
  assert.match(workflow, /if-no-files-found: error/);
  assert.match(workflow, /commit=\$env:GITHUB_SHA/);
  assert.match(workflow, /image_version=\$env:ImageVersion/);
  assert.match(workflow, /authenticode=unsigned/);
  assert.match(workflow, /steps\.upload-installer\.outputs\.artifact-digest/);
  assert.match(
    workflow,
    /^ {10}"- GitHub artifact digest:.*" >> \$env:GITHUB_STEP_SUMMARY$/m,
  );
  assert.doesNotMatch(workflow, /continue-on-error:/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./);
  assert.doesNotMatch(workflow, /\$\{\{\s*github\.token\s*\}\}/);

  const actionReferences = Array.from(
    workflow.matchAll(/^\s*uses:\s*([^#\s]+)(?:\s+#.*)?$/gm),
    (match) => match[1],
  );

  assert.deepEqual(actionReferences, approvedActionReferences);

  const windowsCiCommand = packageJson.scripts['test:ci:windows'];
  assert.equal(typeof windowsCiCommand, 'string');
  assert.match(
    windowsCiCommand,
    /^node --test "tests\/unit\/\*\.test\.js"(?:\s|$)/u,
  );
  for (const integrationTest of windowsCiIntegrationTests) {
    assert.match(
      windowsCiCommand,
      new RegExp(`(?:^|\\s)${integrationTest}(?:\\s|$)`, 'u'),
    );
  }
  assert.doesNotMatch(windowsCiCommand, /display-window-smoke/u);
  assert.doesNotMatch(windowsCiCommand, /liquid-message-prototype/u);
  assert.doesNotMatch(windowsCiCommand, /sand-webgl-renderer-smoke/u);
});

test('Forge 固定使用 DisplayCoreSetup.exe 作為 Squirrel 安裝檔名', () => {
  const forgeConfig = require('../../forge.config');
  const squirrelMaker = forgeConfig.makers.find(
    (maker) => maker.name === '@electron-forge/maker-squirrel',
  );

  assert.ok(squirrelMaker);
  assert.equal(squirrelMaker.config.setupExe, 'DisplayCoreSetup.exe');
});
