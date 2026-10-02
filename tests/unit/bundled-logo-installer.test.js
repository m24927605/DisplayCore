'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fileSystem = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const defaultConfig = require('../../config.json');
const {
  installBundledLogos,
} = require('../../config/bundled-logo-installer');

const projectRoot = path.resolve(__dirname, '..', '..');
const bundledLogoDirectory = path.join(projectRoot, 'assets', 'logos');

async function createDirectory(t) {
  const directory = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-bundled-logo-'),
  );
  t.after(() => fileSystem.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('原廠預設 Logo 指向內建且檔名等於內容雜湊的富春居 Logo', async () => {
  assert.equal(defaultConfig.logo.enabled, true);
  const fileName = path.basename(defaultConfig.logo.path);
  assert.equal(defaultConfig.logo.path, `logos/${fileName}`);

  const contents = await fileSystem.readFile(
    path.join(bundledLogoDirectory, fileName),
  );
  assert.equal(
    createHash('sha256').update(contents).digest('hex').slice(0, 24),
    fileName.replace(/\.png$/, ''),
  );
});

test('安裝內建 Logo 到受管理目錄，已存在者不覆寫', async (t) => {
  const assetDirectory = path.join(await createDirectory(t), 'logos');
  const fileName = path.basename(defaultConfig.logo.path);

  assert.deepEqual(
    await installBundledLogos({
      sourceDirectory: bundledLogoDirectory,
      assetDirectory,
    }),
    [fileName],
  );
  const installedPath = path.join(assetDirectory, fileName);
  assert.deepEqual(
    await fileSystem.readFile(installedPath),
    await fileSystem.readFile(path.join(bundledLogoDirectory, fileName)),
  );

  await fileSystem.writeFile(installedPath, 'operator copy');
  assert.deepEqual(
    await installBundledLogos({
      sourceDirectory: bundledLogoDirectory,
      assetDirectory,
    }),
    [],
  );
  assert.equal(await fileSystem.readFile(installedPath, 'utf8'), 'operator copy');
});

test('內建 Logo 檔名與內容雜湊不符時拒絕安裝', async (t) => {
  const root = await createDirectory(t);
  const sourceDirectory = path.join(root, 'source');
  await fileSystem.mkdir(sourceDirectory);
  await fileSystem.writeFile(
    path.join(sourceDirectory, '0123456789abcdef01234567.png'),
    'not matching',
  );
  await fileSystem.writeFile(path.join(sourceDirectory, 'README.md'), 'ignored');

  await assert.rejects(
    installBundledLogos({
      sourceDirectory,
      assetDirectory: path.join(root, 'logos'),
    }),
    /雜湊不符/,
  );
});
