'use strict';

const { createHash } = require('node:crypto');
const defaultFileSystem = require('node:fs/promises');
const path = require('node:path');

// 與 LogoImporter 相同的受管理命名：內容 SHA-256 前 24 碼。
const BUNDLED_LOGO_FILE_NAME = /^([a-f0-9]{24})\.png$/;

/**
 * 將隨程式封裝的 Logo 複製到 userData 的受管理 Logo 目錄。
 *
 * 原廠預設設定以受管理路徑引用內建 Logo；本機協定只從受管理目錄提供圖片，
 * 因此啟動時先補齊缺少的檔案。檔名必須等於內容雜湊，已存在者不覆寫。
 *
 * @param {object} options
 * @param {string} options.sourceDirectory 封裝內的 assets/logos
 * @param {string} options.assetDirectory userData 的受管理 Logo 目錄
 * @param {typeof defaultFileSystem} [options.fileSystem]
 * @returns {Promise<string[]>} 本次新複製的檔名
 */
async function installBundledLogos({
  sourceDirectory,
  assetDirectory,
  fileSystem = defaultFileSystem,
}) {
  const fileNames = (await fileSystem.readdir(sourceDirectory))
    .filter((fileName) => BUNDLED_LOGO_FILE_NAME.test(fileName))
    .sort();
  const installed = [];

  await fileSystem.mkdir(assetDirectory, { recursive: true });

  for (const fileName of fileNames) {
    const contents = await fileSystem.readFile(
      path.join(sourceDirectory, fileName),
    );
    const digest = createHash('sha256')
      .update(contents)
      .digest('hex')
      .slice(0, 24);

    if (digest !== BUNDLED_LOGO_FILE_NAME.exec(fileName)[1]) {
      throw new Error(`內建 Logo ${fileName} 的內容與檔名雜湊不符。`);
    }

    try {
      await fileSystem.writeFile(
        path.join(assetDirectory, fileName),
        contents,
        { flag: 'wx' },
      );
      installed.push(fileName);
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
    }
  }

  return installed;
}

module.exports = { installBundledLogos };
