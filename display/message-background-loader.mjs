export const MESSAGE_BACKGROUND_ASSET_URLS = Object.freeze({
  obsidian: new URL(
    '../assets/message-backgrounds/obsidian.jpg',
    import.meta.url,
  ).href,
  'dark-marble': new URL(
    '../assets/message-backgrounds/dark-marble.jpg',
    import.meta.url,
  ).href,
  walnut: new URL(
    '../assets/message-backgrounds/walnut.jpg',
    import.meta.url,
  ).href,
  'emerald-onyx': new URL(
    '../assets/message-backgrounds/emerald-onyx.jpg',
    import.meta.url,
  ).href,
});

function releaseImage(image) {
  try {
    if (typeof image?.removeAttribute === 'function') {
      image.removeAttribute('src');
    } else if (image) {
      image.src = '';
    }
  } catch {
    // 解碼取消只負責釋放資源；瀏覽器實作拒絕清除時不得中斷 Display。
  }
}

/**
 * 只保留目前選取材質的單一解碼圖片。
 *
 * CSS 背景沒有可直接等待的 load 事件；先以 Image.decode() 完成解碼，再由
 * 呼叫端切換 data attribute，可避免第一次顯示時短暫露出純色 fallback。
 */
export function createMessageBackgroundLoader({
  createImage = () => new Image(),
  assetUrls = MESSAGE_BACKGROUND_ASSET_URLS,
} = {}) {
  if (typeof createImage !== 'function' ||
    assetUrls === null || typeof assetUrls !== 'object') {
    throw new TypeError('Invalid message background loader dependencies.');
  }

  let activeRecord = null;
  let disposed = false;

  function clearActiveRecord() {
    if (!activeRecord) {
      return;
    }

    const previousRecord = activeRecord;
    activeRecord = null;
    releaseImage(previousRecord.image);
  }

  async function decodeRecord(record) {
    let decodedSuccessfully = false;

    try {
      record.image.decoding = 'async';
      record.image.src = record.url;

      if (typeof record.image.decode !== 'function') {
        return false;
      }

      await record.image.decode();
      decodedSuccessfully =
        record.image.naturalWidth > 0 && record.image.naturalHeight > 0;
      return !disposed &&
        activeRecord === record &&
        decodedSuccessfully;
    } catch {
      return false;
    } finally {
      if (
        activeRecord === record &&
        (disposed || !decodedSuccessfully)
      ) {
        clearActiveRecord();
      }
    }
  }

  return Object.freeze({
    prepare(preset) {
      if (disposed) {
        return Promise.resolve(false);
      }

      if (preset === 'solid') {
        clearActiveRecord();
        return Promise.resolve(true);
      }

      const url = assetUrls[preset];
      if (typeof url !== 'string' || url.length === 0) {
        return Promise.resolve(false);
      }

      if (activeRecord?.preset === preset) {
        return activeRecord.promise;
      }

      clearActiveRecord();

      let image;
      try {
        image = createImage();
      } catch {
        return Promise.resolve(false);
      }

      const record = {
        preset,
        url,
        image,
        promise: null,
      };
      activeRecord = record;
      record.promise = decodeRecord(record);
      return record.promise;
    },

    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      clearActiveRecord();
    },
  });
}
