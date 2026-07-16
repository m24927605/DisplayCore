import { acceptSettingsSnapshot } from './settings-model.mjs';

const CONNECTION_ERROR = '無法連接主程序，請重新啟動 DisplayCore。';
const INVALID_SETTINGS_ERROR =
  '主程序回傳無效設定資料，請重新啟動 DisplayCore。';
const MANAGED_LOGO_PATH = /^logos\/[a-z0-9][a-z0-9._-]*\.(?:jpe?g|png|webp)$/i;

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

function acceptLogoSelection(candidate) {
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
    !MANAGED_LOGO_PATH.test(candidate.assetPath)
  ) {
    return null;
  }

  return Object.freeze({
    canceled: false,
    assetPath: candidate.assetPath,
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

    dispose() {
      disposed = true;
    },
  });
}
