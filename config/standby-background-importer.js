'use strict';

const {
  MAXIMUM_MANAGED_IMAGE_SELECTIONS,
  ManagedImageImporter,
} = require('./managed-image-importer');

class StandbyBackgroundImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StandbyBackgroundImportError';
    this.code = 'STANDBY_BACKGROUND_IMPORT_FAILED';
  }
}

/** Main 專用的待機背景原生選檔與受管理檔案匯入器。 */
class StandbyBackgroundImporter extends ManagedImageImporter {
  constructor(options) {
    super({
      ...options,
      assetPathPrefix: 'standby-backgrounds',
      dialogTitle: '選擇待機背景圖片',
      dialogButtonLabel: '匯入背景圖片',
      dialogFilterName: '背景圖片',
      imageLabel: '待機背景圖片',
      errorFactory: (message) => new StandbyBackgroundImportError(message),
    });
    this.importedAssetPaths = new Set();
  }

  /**
   * 本次執行期間匯入、但可能尚未儲存的背景圖片。設定頁需要在儲存前預覽
   * 縮圖，本機協定因此同時允許這些由管理員剛匯入的檔案。
   */
  getImportedAssetPaths() {
    return Object.freeze([...this.importedAssetPaths]);
  }

  /**
   * 固定背景只允許單選；輪播背景可一次選取最多 20 張。
   * 回傳值永遠是 assetPaths 陣列，不暴露原始本機路徑。
   */
  async chooseAndImport({ multiple } = {}) {
    if (typeof multiple !== 'boolean') {
      throw new TypeError('待機背景選檔模式不正確。');
    }

    const result = await this.chooseAndImportMany({
      multiple,
      maximumSelectionCount: multiple
        ? MAXIMUM_MANAGED_IMAGE_SELECTIONS
        : 1,
    });
    for (const assetPath of result.assetPaths) {
      this.importedAssetPaths.add(assetPath);
    }
    return result;
  }
}

module.exports = {
  StandbyBackgroundImporter,
  StandbyBackgroundImportError,
};
