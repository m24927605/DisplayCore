'use strict';

const {
  MAXIMUM_MANAGED_IMAGE_BYTES,
  ManagedImageImporter,
  matchesImageSignature,
  validateLocalImageSourcePath,
} = require('./managed-image-importer');

class LogoImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LogoImportError';
    this.code = 'LOGO_IMPORT_FAILED';
  }
}

/** Main 專用的原生 Logo 選取與受管理檔案匯入器。 */
class LogoImporter extends ManagedImageImporter {
  constructor(options) {
    super({
      ...options,
      assetPathPrefix: 'logos',
      dialogTitle: '選擇 Logo 圖片',
      dialogButtonLabel: '匯入 Logo',
      dialogFilterName: 'Logo 圖片',
      imageLabel: 'Logo',
      errorFactory: (message) => new LogoImportError(message),
    });
  }
}

module.exports = {
  LogoImporter,
  LogoImportError,
  MAXIMUM_LOGO_BYTES: MAXIMUM_MANAGED_IMAGE_BYTES,
  matchesImageSignature,
  validateLocalSourcePath: validateLocalImageSourcePath,
};
