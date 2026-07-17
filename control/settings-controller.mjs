import { acceptSettingsSnapshot } from './settings-model.mjs';

const CONNECTION_ERROR = '無法連接主程序，請重新啟動 DisplayCore。';
const INVALID_SETTINGS_ERROR =
  '主程序回傳無效設定資料，請重新啟動 DisplayCore。';
const MANAGED_LOGO_PATH = /^logos\/[a-f0-9]{24}\.(?:jpg|png|webp)$/;
const MANAGED_STANDBY_BACKGROUND_PATH =
  /^standby-backgrounds\/[a-f0-9]{24}\.(?:jpg|png|webp)$/;
const MAX_STANDBY_BACKGROUND_IMAGES = 20;
const STANDBY_BACKGROUND_MODES = Object.freeze(['fixed', 'slideshow']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) {
    return false;
  }

  const keys = Object.keys(value).sort();
  return (
    keys.length === expectedKeys.length &&
    keys.every((key, index) => key === expectedKeys[index])
  );
}

function readEnvelope(response) {
  if (!isPlainObject(response)) {
    return { kind: 'invalid' };
  }

  if (response.ok === true && Object.hasOwn(response, 'data')) {
    return { kind: 'success', data: response.data };
  }

  if (
    response.ok === false &&
    isPlainObject(response.error) &&
    typeof response.error.message === 'string' &&
    response.error.message.length > 0 &&
    (response.error.field === undefined ||
      typeof response.error.field === 'string')
  ) {
    return {
      kind: 'application-error',
      message: response.error.message,
      field: response.error.field,
    };
  }

  return { kind: 'invalid' };
}

function acceptManagedImageSelection(candidate, managedPathPattern) {
  if (
    !hasExactKeys(candidate, ['assetPath', 'canceled']) ||
    typeof candidate.canceled !== 'boolean'
  ) {
    return null;
  }

  if (candidate.canceled) {
    return candidate.assetPath === null
      ? Object.freeze({ canceled: true, assetPath: null })
      : null;
  }

  if (
    typeof candidate.assetPath !== 'string' ||
    candidate.assetPath.length > 128 ||
    !managedPathPattern.test(candidate.assetPath)
  ) {
    return null;
  }

  return Object.freeze({
    canceled: false,
    assetPath: candidate.assetPath,
  });
}

function acceptLogoSelection(candidate) {
  return acceptManagedImageSelection(candidate, MANAGED_LOGO_PATH);
}

function acceptStandbyBackgroundSelection(candidate, backgroundMode) {
  if (
    !hasExactKeys(candidate, ['assetPaths', 'canceled']) ||
    typeof candidate.canceled !== 'boolean' ||
    !Array.isArray(candidate.assetPaths)
  ) {
    return null;
  }

  if (candidate.canceled) {
    return candidate.assetPaths.length === 0
      ? Object.freeze({ canceled: true, assetPaths: Object.freeze([]) })
      : null;
  }

  const assetPaths = candidate.assetPaths;
  const expectedMaximum = backgroundMode === 'fixed'
    ? 1
    : MAX_STANDBY_BACKGROUND_IMAGES;

  if (
    assetPaths.length < 1 ||
    assetPaths.length > expectedMaximum ||
    new Set(assetPaths).size !== assetPaths.length ||
    assetPaths.some(
      (assetPath) =>
        typeof assetPath !== 'string' ||
        assetPath.length > 128 ||
        !MANAGED_STANDBY_BACKGROUND_PATH.test(assetPath),
    )
  ) {
    return null;
  }

  return Object.freeze({
    canceled: false,
    assetPaths: Object.freeze([...assetPaths]),
  });
}

/** 設定專用控制器；不接觸 presentation revision 或 DOM。 */
export function createSettingsController({ api, view }) {
  let busy = false;
  let disposed = false;

  async function runOperation(operationName, operation, onSuccess) {
    if (busy || disposed) {
      return false;
    }

    busy = true;
    view.setSettingsBusy(true, operationName);

    try {
      const envelope = readEnvelope(await operation());

      if (envelope.kind === 'application-error') {
        view.renderSettingsError(envelope.message, envelope.field);
        return false;
      }

      if (envelope.kind !== 'success') {
        view.renderSettingsError(INVALID_SETTINGS_ERROR);
        return false;
      }

      return onSuccess(envelope.data);
    } catch {
      view.renderSettingsError(CONNECTION_ERROR);
      return false;
    } finally {
      busy = false;
      view.setSettingsBusy(false, operationName);
    }
  }

  return Object.freeze({
    loadSettings() {
      return runOperation(
        'load',
        () => api.getSettings(),
        (candidate) => {
          const result = acceptSettingsSnapshot(candidate);

          if (!result.ok) {
            view.renderSettingsError(INVALID_SETTINGS_ERROR);
            return false;
          }

          view.renderSettingsSnapshot(result.snapshot);
          view.renderSettingsStatus('設定已載入。');
          return true;
        },
      );
    },

    saveSettings(config, expectedRevision) {
      return runOperation(
        'save',
        () => api.saveSettings(config, expectedRevision),
        (candidate) => {
          const result = acceptSettingsSnapshot(candidate);

          if (!result.ok) {
            view.renderSettingsError(INVALID_SETTINGS_ERROR);
            return false;
          }

          view.renderSettingsSnapshot(result.snapshot);
          view.renderSettingsStatus(
            '設定已儲存並即時套用到顯示畫面。',
          );
          return true;
        },
      );
    },

    chooseLogo() {
      return runOperation(
        'logo',
        () => api.chooseLogo(),
        (candidate) => {
          const result = acceptLogoSelection(candidate);

          if (!result) {
            view.renderSettingsError(INVALID_SETTINGS_ERROR);
            return false;
          }

          if (result.canceled) {
            view.renderSettingsStatus('已取消選擇 Logo。');
            return true;
          }

          view.renderLogoSelection(result.assetPath);
          view.renderSettingsStatus('Logo 已匯入；儲存設定後才會採用。');
          return true;
        },
      );
    },

    chooseStandbyBackground(backgroundMode) {
      if (!STANDBY_BACKGROUND_MODES.includes(backgroundMode)) {
        view.renderSettingsError(INVALID_SETTINGS_ERROR);
        return false;
      }

      return runOperation(
        'standby-background',
        () => api.chooseStandbyBackground(backgroundMode),
        (candidate) => {
          const result = acceptStandbyBackgroundSelection(
            candidate,
            backgroundMode,
          );

          if (!result) {
            view.renderSettingsError(INVALID_SETTINGS_ERROR);
            return false;
          }

          if (result.canceled) {
            view.renderSettingsStatus('已取消選擇待機背景圖片。');
            return true;
          }

          view.renderStandbyBackgroundSelection(result.assetPaths);
          view.renderSettingsStatus(
            `已匯入 ${result.assetPaths.length} 張待機背景；儲存設定後才會採用。`,
          );
          return true;
        },
      );
    },

    dispose() {
      disposed = true;
    },
  });
}
