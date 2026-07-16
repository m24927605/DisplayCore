'use strict';

const { createHash, randomUUID } = require('node:crypto');
const defaultFileSystem = require('node:fs/promises');
const path = require('node:path');

const MAXIMUM_LOGO_BYTES = 10 * 1_024 * 1_024;
const ALLOWED_EXTENSIONS = new Set(['.jpeg', '.jpg', '.png', '.webp']);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

class LogoImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LogoImportError';
    this.code = 'LOGO_IMPORT_FAILED';
  }
}

function validationFailure(message) {
  return { ok: false, error: new LogoImportError(message) };
}

/** 驗證選檔來源是本機絕對路徑，Windows 額外拒絕 UNC、device 與 ADS。 */
function validateLocalSourcePath(sourcePath, platform = process.platform) {
  if (
    typeof sourcePath !== 'string' ||
    sourcePath.length === 0 ||
    sourcePath.length > 32_767 ||
    CONTROL_CHARACTERS.test(sourcePath)
  ) {
    return validationFailure('Logo 來源路徑格式不正確。');
  }

  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  if (platform === 'win32') {
    const isNetworkOrDevicePath =
      sourcePath.startsWith('\\\\') || sourcePath.startsWith('//');
    const isLocalDrivePath = /^[a-z]:[\\/]/i.test(sourcePath);
    const hasAlternateDataStream =
      isLocalDrivePath && sourcePath.slice(3).includes(':');

    if (isNetworkOrDevicePath || !isLocalDrivePath || hasAlternateDataStream) {
      return validationFailure('Logo 只能從本機磁碟匯入。');
    }
  } else if (sourcePath.startsWith('//')) {
    return validationFailure('Logo 只能從本機路徑匯入。');
  }

  if (!pathApi.isAbsolute(sourcePath)) {
    return validationFailure('Logo 來源必須是絕對路徑。');
  }

  const extension = pathApi.extname(sourcePath).toLowerCase();

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    return validationFailure('Logo 只支援 PNG、JPEG 或 WebP。');
  }

  return { ok: true, extension: extension === '.jpeg' ? '.jpg' : extension };
}

function matchesImageSignature(contents, extension) {
  if (extension === '.png') {
    return (
      contents.length >= 8 &&
      contents.subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
      )
    );
  }

  if (extension === '.jpg') {
    return (
      contents.length >= 3 &&
      contents[0] === 0xFF &&
      contents[1] === 0xD8 &&
      contents[2] === 0xFF
    );
  }

  if (extension === '.webp') {
    return (
      contents.length >= 12 &&
      contents.subarray(0, 4).toString('ascii') === 'RIFF' &&
      contents.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }

  return false;
}

async function writeManagedAsset({
  fileSystem,
  destinationPath,
  contents,
  idFactory,
}) {
  const directory = path.dirname(destinationPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(destinationPath)}.${idFactory()}.tmp`,
  );
  let handle = null;

  await fileSystem.mkdir(directory, { recursive: true });

  try {
    try {
      const existing = await fileSystem.readFile(destinationPath);

      if (existing.equals(contents)) {
        return;
      }

      throw new LogoImportError('受管理 Logo 發生雜湊衝突。');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await fileSystem.rename(temporaryPath, destinationPath);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // 原始錯誤優先；下方仍會嘗試清理暫存檔。
      }
    }

    try {
      await fileSystem.rm(temporaryPath, { force: true });
    } catch {
      // 匯入已失敗，清理錯誤不取代原始錯誤。
    }

    throw error;
  }
}

/** Main 專用的原生 Logo 選取與受管理檔案匯入器。 */
class LogoImporter {
  constructor({
    dialog,
    getParentWindow,
    assetDirectory,
    fileSystem = defaultFileSystem,
    idFactory = randomUUID,
    platform = process.platform,
  }) {
    if (
      !dialog ||
      typeof dialog.showOpenDialog !== 'function' ||
      typeof getParentWindow !== 'function' ||
      typeof assetDirectory !== 'string' ||
      assetDirectory.length === 0
    ) {
      throw new TypeError('Logo 匯入器缺少必要相依物件。');
    }

    this.dialog = dialog;
    this.getParentWindow = getParentWindow;
    this.assetDirectory = assetDirectory;
    this.fileSystem = fileSystem;
    this.idFactory = idFactory;
    this.platform = platform;
  }

  async chooseAndImport() {
    const result = await this.dialog.showOpenDialog(
      this.getParentWindow(),
      {
        title: '選擇 Logo 圖片',
        buttonLabel: '匯入 Logo',
        properties: ['openFile', 'dontAddToRecent'],
        filters: [
          {
            name: 'Logo 圖片',
            extensions: ['png', 'jpg', 'jpeg', 'webp'],
          },
        ],
      },
    );

    if (result?.canceled === true) {
      return Object.freeze({ canceled: true, assetPath: null });
    }

    if (
      result?.canceled !== false ||
      !Array.isArray(result.filePaths) ||
      result.filePaths.length !== 1
    ) {
      throw new LogoImportError('Logo 選檔結果格式不正確。');
    }

    const sourcePath = result.filePaths[0];
    const pathValidation = validateLocalSourcePath(sourcePath, this.platform);

    if (!pathValidation.ok) {
      throw pathValidation.error;
    }

    const stats = await this.fileSystem.lstat(sourcePath);

    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size === 0 ||
      stats.size > MAXIMUM_LOGO_BYTES
    ) {
      throw new LogoImportError('Logo 必須是 1 Byte 至 10 MiB 的一般檔案。');
    }

    const contents = await this.fileSystem.readFile(sourcePath);

    if (
      contents.length === 0 ||
      contents.length > MAXIMUM_LOGO_BYTES ||
      !matchesImageSignature(contents, pathValidation.extension)
    ) {
      throw new LogoImportError('Logo 圖片內容與檔案格式不符。');
    }

    const digest = createHash('sha256').update(contents).digest('hex').slice(0, 24);
    const fileName = `${digest}${pathValidation.extension}`;
    const destinationPath = path.join(this.assetDirectory, fileName);

    await writeManagedAsset({
      fileSystem: this.fileSystem,
      destinationPath,
      contents,
      idFactory: this.idFactory,
    });

    return Object.freeze({
      canceled: false,
      assetPath: `logos/${fileName}`,
    });
  }
}

module.exports = {
  LogoImporter,
  LogoImportError,
  MAXIMUM_LOGO_BYTES,
  validateLocalSourcePath,
};

