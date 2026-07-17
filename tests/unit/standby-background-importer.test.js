'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fileSystem = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAXIMUM_MANAGED_IMAGE_BYTES,
  MAXIMUM_MANAGED_IMAGE_SELECTIONS,
  ManagedImageImporter,
} = require('../../config/managed-image-importer');
const {
  StandbyBackgroundImporter,
} = require('../../config/standby-background-importer');

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x01,
]);

async function createHarness(t, dialogResult, overrides = {}) {
  const directory = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-standby-background-'),
  );
  const assetDirectory = path.join(directory, 'managed', 'standby-backgrounds');
  const calls = [];
  const parentWindow = { role: 'control' };
  const dialog = {
    async showOpenDialog(...args) {
      calls.push(args);
      return dialogResult;
    },
  };
  const importer = new StandbyBackgroundImporter({
    dialog,
    getParentWindow: () => parentWindow,
    assetDirectory,
    ...overrides,
  });

  t.after(async () => {
    await fileSystem.rm(directory, { recursive: true, force: true });
  });

  return { assetDirectory, calls, directory, importer, parentWindow };
}

test('待機背景 importer 使用共用受管理圖片安全核心', () => {
  assert.equal(
    Object.getPrototypeOf(StandbyBackgroundImporter.prototype),
    ManagedImageImporter.prototype,
  );
  assert.equal(MAXIMUM_MANAGED_IMAGE_BYTES, 10 * 1_024 * 1_024);
  assert.equal(MAXIMUM_MANAGED_IMAGE_SELECTIONS, 20);
});

test('取消待機背景原生選檔時回傳 exact envelope 且不建立檔案', async (t) => {
  const harness = await createHarness(t, { canceled: true, filePaths: [] });

  const result = await harness.importer.chooseAndImport({ multiple: false });

  assert.deepEqual(result, { canceled: true, assetPaths: [] });
  assert.deepEqual(Object.keys(result).sort(), ['assetPaths', 'canceled']);
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0][0], harness.parentWindow);
  assert.deepEqual(harness.calls[0][1], {
    title: '選擇待機背景圖片',
    buttonLabel: '匯入背景圖片',
    properties: ['openFile', 'dontAddToRecent'],
    filters: [
      { name: '背景圖片', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
    ],
  });
  await assert.rejects(fileSystem.access(harness.assetDirectory));
});

test('Main 驗證待機背景後以內容雜湊匯入獨立受管理目錄', async (t) => {
  const sourceDirectory = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-standby-background-source-'),
  );
  const sourcePath = path.join(sourceDirectory, '待機 背景.PNG');
  await fileSystem.writeFile(sourcePath, PNG_BYTES);
  t.after(async () => {
    await fileSystem.rm(sourceDirectory, { recursive: true, force: true });
  });

  const harness = await createHarness(t, {
    canceled: false,
    filePaths: [sourcePath],
  });
  const result = await harness.importer.chooseAndImport({ multiple: false });
  const digest = createHash('sha256').update(PNG_BYTES).digest('hex').slice(0, 24);

  assert.deepEqual(result, {
    canceled: false,
    assetPaths: [`standby-backgrounds/${digest}.png`],
  });
  assert.deepEqual(Object.keys(result).sort(), ['assetPaths', 'canceled']);
  assert.doesNotMatch(JSON.stringify(result), /tmp|待機 背景|source/i);
  assert.deepEqual(
    await fileSystem.readFile(
      path.join(harness.assetDirectory, `${digest}.png`),
    ),
    PNG_BYTES,
  );
  assert.deepEqual(await fileSystem.readdir(harness.assetDirectory), [
    `${digest}.png`,
  ]);
});

test('輪播模式啟用原生多選，並依原順序去除重複內容', async (t) => {
  const sourceDirectory = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-standby-background-multiple-'),
  );
  const firstBytes = PNG_BYTES;
  const secondBytes = Buffer.concat([PNG_BYTES, Buffer.from('second')]);
  const firstPath = path.join(sourceDirectory, 'first.png');
  const duplicatePath = path.join(sourceDirectory, 'duplicate.png');
  const secondPath = path.join(sourceDirectory, 'second.png');
  await fileSystem.writeFile(firstPath, firstBytes);
  await fileSystem.writeFile(duplicatePath, firstBytes);
  await fileSystem.writeFile(secondPath, secondBytes);
  t.after(async () => {
    await fileSystem.rm(sourceDirectory, { recursive: true, force: true });
  });

  const harness = await createHarness(t, {
    canceled: false,
    filePaths: [firstPath, duplicatePath, firstPath, secondPath],
  });
  const result = await harness.importer.chooseAndImport({ multiple: true });
  const firstDigest = createHash('sha256')
    .update(firstBytes)
    .digest('hex')
    .slice(0, 24);
  const secondDigest = createHash('sha256')
    .update(secondBytes)
    .digest('hex')
    .slice(0, 24);

  assert.deepEqual(harness.calls[0][1].properties, [
    'openFile',
    'multiSelections',
    'dontAddToRecent',
  ]);
  assert.deepEqual(result, {
    canceled: false,
    assetPaths: [
      `standby-backgrounds/${firstDigest}.png`,
      `standby-backgrounds/${secondDigest}.png`,
    ],
  });
  assert.deepEqual(
    (await fileSystem.readdir(harness.assetDirectory)).sort(),
    [`${firstDigest}.png`, `${secondDigest}.png`].sort(),
  );
});

test('待機背景每次最多 20 張，且批次內任一無效時不寫入部分檔案', async (t) => {
  const sourceDirectory = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-standby-background-batch-invalid-'),
  );
  const validPath = path.join(sourceDirectory, 'valid.png');
  const invalidPath = path.join(sourceDirectory, 'invalid.png');
  await fileSystem.writeFile(validPath, PNG_BYTES);
  await fileSystem.writeFile(invalidPath, Buffer.from('not a png'));
  const boundaryPaths = [];
  const expectedBoundaryAssetPaths = [];

  for (let index = 0; index < MAXIMUM_MANAGED_IMAGE_SELECTIONS; index += 1) {
    const contents = Buffer.concat([
      PNG_BYTES,
      Buffer.from(`boundary-${index}`),
    ]);
    const sourcePath = path.join(sourceDirectory, `boundary-${index}.png`);
    const digest = createHash('sha256')
      .update(contents)
      .digest('hex')
      .slice(0, 24);
    await fileSystem.writeFile(sourcePath, contents);
    boundaryPaths.push(sourcePath);
    expectedBoundaryAssetPaths.push(`standby-backgrounds/${digest}.png`);
  }

  t.after(async () => {
    await fileSystem.rm(sourceDirectory, { recursive: true, force: true });
  });

  const boundaryHarness = await createHarness(t, {
    canceled: false,
    filePaths: boundaryPaths,
  });
  const boundaryResult = await boundaryHarness.importer.chooseAndImport({
    multiple: true,
  });
  assert.deepEqual(
    boundaryResult.assetPaths,
    expectedBoundaryAssetPaths,
  );
  assert.deepEqual(
    (await fileSystem.readdir(boundaryHarness.assetDirectory)).sort(),
    expectedBoundaryAssetPaths
      .map((assetPath) => path.basename(assetPath))
      .sort(),
  );

  const invalidHarness = await createHarness(t, {
    canceled: false,
    filePaths: [validPath, invalidPath],
  });
  await assert.rejects(
    invalidHarness.importer.chooseAndImport({ multiple: true }),
    { code: 'STANDBY_BACKGROUND_IMPORT_FAILED' },
  );
  await assert.rejects(fileSystem.access(invalidHarness.assetDirectory));

  const tooManyHarness = await createHarness(t, {
    canceled: false,
    filePaths: Array.from(
      { length: 21 },
      (_value, index) => path.join(sourceDirectory, `${index}.png`),
    ),
  });
  await assert.rejects(
    tooManyHarness.importer.chooseAndImport({ multiple: true }),
    (error) =>
      error?.code === 'STANDBY_BACKGROUND_IMPORT_FAILED' &&
      !JSON.stringify(error).includes(sourceDirectory),
  );
  await assert.rejects(fileSystem.access(tooManyHarness.assetDirectory));
});

test('固定背景拒絕原生 dialog 畸形回傳兩個檔案且不寫入', async (t) => {
  const sourceDirectory = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-standby-background-fixed-malformed-'),
  );
  const firstPath = path.join(sourceDirectory, 'first.png');
  const secondPath = path.join(sourceDirectory, 'second.png');
  await fileSystem.writeFile(firstPath, PNG_BYTES);
  await fileSystem.writeFile(
    secondPath,
    Buffer.concat([PNG_BYTES, Buffer.from('second')]),
  );
  t.after(async () => {
    await fileSystem.rm(sourceDirectory, { recursive: true, force: true });
  });

  const harness = await createHarness(t, {
    canceled: false,
    filePaths: [firstPath, secondPath],
  });

  await assert.rejects(
    harness.importer.chooseAndImport({ multiple: false }),
    { code: 'STANDBY_BACKGROUND_IMPORT_FAILED' },
  );
  assert.deepEqual(harness.calls[0][1].properties, [
    'openFile',
    'dontAddToRecent',
  ]);
  await assert.rejects(fileSystem.access(harness.assetDirectory));
});

test('待機背景匯入固定拒絕 SVG、偽造格式、空檔、超量檔案與符號連結', async (t) => {
  const directory = await fileSystem.mkdtemp(
    path.join(os.tmpdir(), 'displaycore-standby-background-invalid-'),
  );
  t.after(async () => {
    await fileSystem.rm(directory, { recursive: true, force: true });
  });

  const invalidFiles = [
    ['background.svg', Buffer.from('<svg></svg>')],
    ['fake.png', Buffer.from('not-a-png')],
    ['empty.jpg', Buffer.alloc(0)],
    ['large.webp', Buffer.alloc(MAXIMUM_MANAGED_IMAGE_BYTES + 1)],
  ];

  for (const [fileName, contents] of invalidFiles) {
    const sourcePath = path.join(directory, fileName);
    await fileSystem.writeFile(sourcePath, contents);
    const harness = await createHarness(t, {
      canceled: false,
      filePaths: [sourcePath],
    });

    await assert.rejects(
      harness.importer.chooseAndImport({ multiple: false }),
      (error) =>
        error?.code === 'STANDBY_BACKGROUND_IMPORT_FAILED' &&
        !/tmp|Users|background\.svg|fake\.png|empty\.jpg|large\.webp/i.test(
          error.message,
        ),
      fileName,
    );
  }

  const validTarget = path.join(directory, 'valid-target.png');
  const linkedPath = path.join(directory, 'linked.png');
  await fileSystem.writeFile(validTarget, PNG_BYTES);
  await fileSystem.symlink(validTarget, linkedPath);
  const linkedHarness = await createHarness(t, {
    canceled: false,
    filePaths: [linkedPath],
  });
  await assert.rejects(
    linkedHarness.importer.chooseAndImport({ multiple: false }),
    { code: 'STANDBY_BACKGROUND_IMPORT_FAILED' },
  );
});
