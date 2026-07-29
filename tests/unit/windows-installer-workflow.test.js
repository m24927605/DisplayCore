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

test('GitHub Actions 可在 Windows x64 建置並驗證 EXE 與 MSI 安裝器', async () => {
  // Windows checkout 可能將文字檔轉成 CRLF；工作流契約不應依賴換行格式。
  const workflow = (await readFile(workflowPath, 'utf8')).replace(/\r\n?/gu, '\n');
  const packageJson = JSON.parse(
    await readFile(path.join(projectRoot, 'package.json'), 'utf8'),
  );

  assert.match(workflow, /^name: Build Windows installers$/m);
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
  assert.match(workflow, /^\s{8}run: npm run make$/m);
  assert.match(
    workflow,
    /out\/make\/installers\/x64\/DisplayCoreSetup\.exe/,
  );
  assert.match(
    workflow,
    /out\/make\/installers\/x64\/DisplayCoreSetup\.msi/,
  );
  assert.match(workflow, /\/S/);
  assert.match(
    workflow,
    /-RawArguments "\/S \/D=\$customInstallDirectory"/,
  );
  assert.match(
    workflow,
    /\$customInstallDirectory = Join-Path \$env:RUNNER_TEMP 'DisplayCore Custom Install'/,
  );
  assert.match(
    workflow,
    /\$installedPayload = Join-Path \$customInstallDirectory 'DisplayCore\.exe'/,
  );
  assert.match(
    workflow,
    /Test-Path -LiteralPath \$installedPayload -PathType Leaf/,
  );
  assert.match(
    workflow,
    /\$installedAsar = Join-Path \$customInstallDirectory 'resources\/app\.asar'/,
  );
  assert.match(workflow, /--displaycore-main-smoke-test/);
  assert.match(workflow, /Get-ChildItem[\s\S]*Uninstall\*\.exe/);
  assert.match(workflow, /WaitForExit\(\$TimeoutSeconds \* 1000\)/);
  assert.match(
    workflow,
    /\$tempUninstaller = Join-Path[\s\S]*"DisplayCoreUninstaller-\$PID\.exe"/,
  );
  assert.match(
    workflow,
    /Copy-Item[\s\S]*-LiteralPath \$uninstaller\.FullName[\s\S]*-Destination \$tempUninstaller/,
  );
  assert.match(
    workflow,
    /-RawArguments "\/S _\?=\$customInstallDirectory"/,
  );
  assert.match(
    workflow,
    /\$PSBoundParameters\.ContainsKey\('RawArguments'\)[\s\S]*\$startInfo\.Arguments = \$RawArguments/,
  );
  assert.match(
    workflow,
    /if \(Test-Path -LiteralPath \$customInstallDirectory -PathType Container\)/,
  );
  assert.match(workflow, /custom_install_smoke=passed/);
  assert.match(workflow, /msi_install_smoke=passed/);
  assert.match(workflow, /msiexec\.exe/);
  assert.match(workflow, /APPLICATIONFOLDER=\$msiInstallDirectory/);
  assert.match(workflow, /@\(0,\s*3010\)/);
  assert.match(
    workflow,
    /Copy-Item[\s\S]*\$msiSource[\s\S]*DisplayCoreSetup\.msi/,
  );
  assert.match(
    workflow,
    /DisplayCoreSetup\.msi\.sha256/,
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

test('npm run make 同時產生可選路徑的 NSIS EXE 與原生 MSI', async () => {
  const packageJson = require('../../package.json');
  const builderConfig = require('../../electron-builder.config');
  const forgeConfig = require('../../forge.config');
  const mainSource = await readFile(path.join(projectRoot, 'main.js'), 'utf8');

  assert.equal(
    packageJson.scripts.make,
    'npm run package:windows && npm run installer:windows',
  );
  assert.equal(
    packageJson.scripts['package:windows'],
    'electron-forge package --platform=win32 --arch=x64',
  );
  assert.equal(
    packageJson.scripts['installer:windows'],
    'electron-builder --config electron-builder.config.js --win nsis --win msi --x64 --prepackaged out/DisplayCore-win32-x64 --publish never',
  );
  assert.equal(packageJson.devDependencies['electron-builder'], '26.15.7');
  assert.equal(
    packageJson.devDependencies['@electron-forge/maker-squirrel'],
    undefined,
  );
  assert.equal(
    packageJson.dependencies?.['electron-squirrel-startup'],
    undefined,
  );
  assert.doesNotMatch(mainSource, /electron-squirrel-startup/u);

  assert.deepEqual(forgeConfig.makers, []);
  assert.equal(builderConfig.appId, 'com.displaycore.desktop');
  assert.equal(builderConfig.productName, 'DisplayCore');
  assert.equal(builderConfig.directories.output, 'out/make/installers/x64');
  assert.deepEqual(builderConfig.win.target, [
    {
      target: 'nsis',
      arch: ['x64'],
    },
    {
      target: 'msi',
      arch: ['x64'],
    },
  ]);
  assert.equal(builderConfig.win.executableName, 'DisplayCore');
  assert.equal(builderConfig.win.icon, 'assets/app-icon.png');
  const appIcon = await readFile(
    path.join(projectRoot, builderConfig.win.icon),
  );
  assert.deepEqual(
    Array.from(appIcon.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  );
  assert.equal(appIcon.readUInt32BE(16), 512);
  assert.equal(appIcon.readUInt32BE(20), 512);
  assert.equal(builderConfig.nsis.artifactName, 'DisplayCoreSetup.${ext}');
  assert.equal(builderConfig.nsis.oneClick, false);
  assert.equal(builderConfig.nsis.perMachine, true);
  assert.equal(builderConfig.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(builderConfig.nsis.runAfterFinish, false);
  assert.equal(builderConfig.msi.artifactName, 'DisplayCoreSetup.${ext}');
  assert.equal(builderConfig.msi.oneClick, false);
  assert.equal(builderConfig.msi.perMachine, true);
  assert.equal(builderConfig.msi.createDesktopShortcut, true);
  assert.equal(builderConfig.msi.createStartMenuShortcut, true);
  assert.equal(builderConfig.msi.runAfterFinish, false);
  assert.equal(builderConfig.msi.shortcutName, 'DisplayCore');
  assert.equal(
    builderConfig.msi.upgradeCode,
    '{58070DFC-451A-49BD-878E-B877E9644506}',
  );
  assert.equal(builderConfig.msi.warningsAsErrors, true);
});
