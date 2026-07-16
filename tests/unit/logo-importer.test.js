'use strict';

const assert = require('node:assert/strict');
const fileSystem = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  LogoImporter,
  MAXIMUM_LOGO_BYTES,
  validateLocalSourcePath,
} = require('../../config/logo-importer');

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01,
]);

async function createHarness(t, dialogResult) {
  const directory = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-logo-'),
  );
  const assetDirectory = path.join(directory, 'managed', 'logos');
  const calls = [];
  const parentWindow = { role: 'control' };
  const dialog = {
    async showOpenDialog(...args) {
      calls.push(args);
      return dialogResult;
    },
  };
  const importer = new LogoImporter({
    dialog,
    getParentWindow: () => parentWindow,
    assetDirectory,
  });

  t.after(async () => {
    await fileSystem.rm(directory, { recursive: true, force: true });
  });

  return { assetDirectory, calls, directory, importer, parentWindow };
}

test('取消原生選檔時不建立檔案，也不回傳來源路徑', async (t) => {
  const harness = await createHarness(t, { canceled: true, filePaths: [] });

  const result = await harness.importer.chooseAndImport();

  assert.deepEqual(result, { canceled: true, assetPath: null });
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0][0], harness.parentWindow);
  assert.deepEqual(harness.calls[0][1], {
    title: '選擇 Logo 圖片',
    buttonLabel: '匯入 Logo',
    properties: ['openFile', 'dontAddToRecent'],
    filters: [
      { name: 'Logo 圖片', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
    ],
  });
  await assert.rejects(fileSystem.access(harness.assetDirectory));
});

test('Main 驗證圖片內容後以雜湊名稱匯入受管理目錄', async (t) => {
  const directory = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-logo-source-'),
  );
  const sourcePath = path.join(directory, '品牌 Logo.PNG');
  await fileSystem.writeFile(sourcePath, PNG_BYTES);
  t.after(async () => {
    await fileSystem.rm(directory, { recursive: true, force: true });
  });

  const harness = await createHarness(t, {
    canceled: false,
    filePaths: [sourcePath],
  });
  const result = await harness.importer.chooseAndImport();

  assert.equal(result.canceled, false);
  assert.match(result.assetPath, /^logos\/[a-f0-9]{24}\.png$/);
  assert.equal(JSON.stringify(result).includes(sourcePath), false);
  assert.deepEqual(
    await fileSystem.readFile(
      path.join(harness.assetDirectory, path.basename(result.assetPath)),
    ),
    PNG_BYTES,
  );
  assert.deepEqual(await fileSystem.readdir(harness.assetDirectory), [
    path.basename(result.assetPath),
  ]);
});

test('Windows 來源只接受本機磁碟絕對路徑，拒絕 UNC、device、ADS 與 URL', () => {
  assert.equal(
    validateLocalSourcePath('C:\\Users\\Operator\\logo.png', 'win32').ok,
    true,
  );

  for (const sourcePath of [
    '\\\\server\\share\\logo.png',
    '\\\\?\\C:\\logo.png',
    '\\\\.\\C:\\logo.png',
    'C:\\logo.png:stream',
    'https://example.invalid/logo.png',
    'relative\\logo.png',
  ]) {
    assert.equal(
      validateLocalSourcePath(sourcePath, 'win32').ok,
      false,
      sourcePath,
    );
  }
});

test('匯入拒絕 SVG、偽造副檔名、空檔、超量檔案與符號連結', async (t) => {
  const directory = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-logo-invalid-'),
  );
  const invalidFiles = [
    ['logo.svg', Buffer.from('<svg></svg>')],
    ['fake.png', Buffer.from('not-a-png')],
    ['empty.png', Buffer.alloc(0)],
    ['large.png', Buffer.alloc(MAXIMUM_LOGO_BYTES + 1)],
  ];
  t.after(async () => {
    await fileSystem.rm(directory, { recursive: true, force: true });
  });

  for (const [fileName, contents] of invalidFiles) {
    const sourcePath = path.join(directory, fileName);
    await fileSystem.writeFile(sourcePath, contents);
    const harness = await createHarness(t, {
      canceled: false,
      filePaths: [sourcePath],
    });
    await assert.rejects(harness.importer.chooseAndImport());
  }

  const validTarget = path.join(directory, 'valid-target.png');
  const linkedPath = path.join(directory, 'linked.png');
  await fileSystem.writeFile(validTarget, PNG_BYTES);
  await fileSystem.symlink(validTarget, linkedPath);
  const linkedHarness = await createHarness(t, {
    canceled: false,
    filePaths: [linkedPath],
  });
  await assert.rejects(linkedHarness.importer.chooseAndImport());
});

