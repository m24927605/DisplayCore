'use strict';

const defaultFileSystem = require('node:fs/promises');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const { CONFIG_LIMITS, validateConfig } = require('./config-schema');

const INVALID_USER_CONFIG_NOTICE = Object.freeze({
  code: 'INVALID_USER_CONFIG',
  message: '使用者設定檔無法讀取，目前使用安全預設值；儲存後可修復。',
});
const RETRYABLE_RENAME_ERRORS = new Set(['EBUSY', 'EPERM']);
const NOOP_LOGGER = Object.freeze({
  error() {},
  warn() {},
});

class ConfigValidationError extends Error {
  constructor(validationError) {
    super(validationError.message);
    this.name = 'ConfigValidationError';
    this.code = 'VALIDATION_FAILED';
    this.validationError = Object.freeze({ ...validationError });
  }
}

class ConfigConflictError extends Error {
  constructor() {
    super('設定已由另一個操作更新，請重新載入後再儲存。');
    this.name = 'ConfigConflictError';
    this.code = 'CONFIG_CONFLICT';
  }
}

function createSnapshot({ config, defaults, revision, notice }) {
  return Object.freeze({
    config,
    defaults,
    revision,
    notice,
  });
}

function parseJson(text) {
  const withoutBom = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  return JSON.parse(withoutBom);
}

async function readValidatedConfig(fileSystem, filePath) {
  const stats = await fileSystem.stat(filePath);

  if (!stats.isFile()) {
    throw new Error('設定路徑不是一般檔案。');
  }

  if (stats.size > CONFIG_LIMITS.MAX_FILE_BYTES) {
    throw new Error('設定檔超過安全大小上限。');
  }

  const parsed = parseJson(await fileSystem.readFile(filePath, 'utf8'));
  const validation = validateConfig(parsed);

  if (!validation.ok) {
    throw new ConfigValidationError(validation.error);
  }

  return validation.value;
}

function serializeConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

async function renameWithRetry(fileSystem, sourcePath, destinationPath) {
  const maximumAttempts = 3;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      await fileSystem.rename(sourcePath, destinationPath);
      return;
    } catch (error) {
      if (
        !RETRYABLE_RENAME_ERRORS.has(error?.code) ||
        attempt === maximumAttempts
      ) {
        throw error;
      }

      await delay(25 * attempt);
    }
  }
}

/** 在同一目錄完成 write、fsync、close、rename，舊檔不先刪除。 */
async function writeConfigAtomically({
  fileSystem,
  configPath,
  config,
  idFactory,
  logger,
}) {
  const directory = path.dirname(configPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(configPath)}.${idFactory()}.tmp`,
  );
  let handle = null;

  await fileSystem.mkdir(directory, { recursive: true });

  try {
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(serializeConfig(config), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(fileSystem, temporaryPath, configPath);
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch (closeError) {
        logger.warn('[DisplayCore] 設定暫存檔無法正常關閉。', closeError);
      }
    }

    try {
      await fileSystem.rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      logger.warn('[DisplayCore] 設定暫存檔無法清理。', cleanupError);
    }

    throw error;
  }
}

/**
 * 管理封裝預設值與 userData/config.json。
 *
 * 記憶體狀態只有在原子 rename 成功後才更新；所有儲存操作會依呼叫順序
 * 串行化，並在佇列內再次檢查 revision，避免較舊表單覆蓋新設定。
 */
class ConfigManager {
  constructor({
    defaultConfigPath,
    configPath,
    fileSystem = defaultFileSystem,
    idFactory = randomUUID,
    logger = NOOP_LOGGER,
  }) {
    if (
      typeof defaultConfigPath !== 'string' ||
      defaultConfigPath.length === 0 ||
      typeof configPath !== 'string' ||
      configPath.length === 0
    ) {
      throw new TypeError('設定管理器需要有效的預設與使用者設定路徑。');
    }

    this.defaultConfigPath = defaultConfigPath;
    this.configPath = configPath;
    this.fileSystem = fileSystem;
    this.idFactory = idFactory;
    this.logger = logger;
    this.snapshot = null;
    this.initializationPromise = null;
    this.writeQueue = Promise.resolve();
    this.listeners = new Set();
  }

  async initialize() {
    if (this.snapshot) {
      return this.snapshot;
    }

    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeOnce();
    }

    return this.initializationPromise;
  }

  async initializeOnce() {
    let defaults;

    try {
      defaults = await readValidatedConfig(
        this.fileSystem,
        this.defaultConfigPath,
      );
    } catch (error) {
      throw new Error('DisplayCore 原廠預設設定無效。', { cause: error });
    }

    let config;
    let notice = null;

    try {
      config = await readValidatedConfig(this.fileSystem, this.configPath);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        await writeConfigAtomically({
          fileSystem: this.fileSystem,
          configPath: this.configPath,
          config: defaults,
          idFactory: this.idFactory,
          logger: this.logger,
        });
        config = defaults;
      } else {
        this.logger.warn(
          '[DisplayCore] 使用者設定無法讀取，暫時使用安全預設值。',
          error,
        );
        config = defaults;
        notice = INVALID_USER_CONFIG_NOTICE;
      }
    }

    this.snapshot = createSnapshot({
      config,
      defaults,
      revision: 0,
      notice,
    });
    return this.snapshot;
  }

  getSnapshot() {
    if (!this.snapshot) {
      throw new Error('設定管理器尚未初始化。');
    }

    return this.snapshot;
  }

  async saveConfig(candidate, expectedRevision) {
    if (!this.snapshot) {
      throw new Error('設定管理器尚未初始化。');
    }

    const validation = validateConfig(candidate);

    if (!validation.ok) {
      throw new ConfigValidationError(validation.error);
    }

    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw new ConfigValidationError({
        code: 'VALIDATION_FAILED',
        message: 'expectedRevision 必須是非負整數。',
        field: 'expectedRevision',
      });
    }

    const operation = this.writeQueue.then(async () => {
      if (this.snapshot.revision !== expectedRevision) {
        throw new ConfigConflictError();
      }

      await writeConfigAtomically({
        fileSystem: this.fileSystem,
        configPath: this.configPath,
        config: validation.value,
        idFactory: this.idFactory,
        logger: this.logger,
      });

      this.snapshot = createSnapshot({
        config: validation.value,
        defaults: this.snapshot.defaults,
        revision: this.snapshot.revision + 1,
        notice: null,
      });
      this.publish(this.snapshot);
      return this.snapshot;
    });

    // 失敗不能讓佇列永久 rejected；下一次操作仍可安全重試。
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new TypeError('設定訂閱者必須是函式。');
    }

    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(snapshot) {
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        this.logger.error('[DisplayCore] 設定狀態發布失敗。', error);
      }
    }
  }
}

module.exports = {
  ConfigConflictError,
  ConfigManager,
  ConfigValidationError,
};

