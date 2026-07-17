'use strict';

const { ManagedImageImporter } = require('./managed-image-importer');

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
  }
}

module.exports = {
  StandbyBackgroundImporter,
  StandbyBackgroundImportError,
};
