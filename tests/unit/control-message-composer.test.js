'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '..', '..', 'control', 'message-composer.mjs'),
).toString();

async function loadComposer() {
  return import(moduleUrl);
}

test('營運罐頭訊息只保留置中的請輕聲細語', async () => {
  const { OPERATION_MESSAGES } = await loadComposer();

  assert.deepEqual(OPERATION_MESSAGES, {
    QUIET: '請輕聲細語',
  });
  assert.equal(Object.isFrozen(OPERATION_MESSAGES), true);
});

test('固定動作把編號或花名放在完整 message 最前方', async () => {
  const { ACTIONS, composeMessage } = await loadComposer();

  assert.deepEqual(
    composeMessage({
      recipient: '001',
      action: ACTIONS.GO_TO_LOBBY,
      customText: '',
    }),
    {
      ok: true,
      presentation: {
        message: '001請至前廳',
        alignment: 'left',
        layout: 'single-line',
      },
    },
  );
  assert.deepEqual(
    composeMessage({
      recipient: 'Nancy',
      action: ACTIONS.LOBBY_CODE,
      customText: '',
    }),
    {
      ok: true,
      presentation: {
        message: 'Nancy前廳000',
        alignment: 'left',
        layout: 'single-line',
      },
    },
  );
  assert.deepEqual(
    composeMessage({
      recipient: 'Nancy',
      action: ACTIONS.CONTACT_COUNTER,
      customText: '',
    }),
    {
      ok: true,
      presentation: {
        message: 'Nancy聯絡櫃台',
        alignment: 'left',
        layout: 'single-line',
      },
    },
  );
});

test('自定義動作可加編號／花名，也可直接顯示公告', async () => {
  const { ACTIONS, composeMessage } = await loadComposer();

  assert.deepEqual(
    composeMessage({
      recipient: '001',
      action: ACTIONS.CUSTOM,
      customText: '請至後門',
    }),
    {
      ok: true,
      presentation: {
        message: '001請至後門',
        alignment: 'left',
        layout: 'single-line',
      },
    },
  );
  assert.deepEqual(
    composeMessage({
      recipient: '',
      action: ACTIONS.CUSTOM,
      customText: '公告今日停止服務',
    }),
    {
      ok: true,
      presentation: {
        message: '公告今日停止服務',
        alignment: 'left',
        layout: 'single-line',
      },
    },
  );
});

test('編號／花名與自定義內容皆原樣保留，不做 trim 或 HTML 解析', async () => {
  const { ACTIONS, composeMessage } = await loadComposer();
  const customText = '  <script>僅作文字</script>  ';

  assert.deepEqual(
    composeMessage({
      recipient: '  Nancy  ',
      action: ACTIONS.CUSTOM,
      customText,
    }),
    {
      ok: true,
      presentation: {
        message: `  Nancy  ${customText}`,
        alignment: 'left',
        layout: 'single-line',
      },
    },
  );
});

test('固定動作需要編號／花名，自定義需要非空字串', async () => {
  const { ACTIONS, composeMessage } = await loadComposer();

  assert.deepEqual(
    composeMessage({
      recipient: '',
      action: ACTIONS.GO_TO_LOBBY,
      customText: '',
    }),
    {
      ok: false,
      error: {
        field: 'recipient',
        message: '請輸入編號或花名。',
      },
    },
  );
  assert.deepEqual(
    composeMessage({
      recipient: '',
      action: ACTIONS.CONTACT_COUNTER,
      customText: '',
    }),
    {
      ok: false,
      error: {
        field: 'recipient',
        message: '請輸入編號或花名。',
      },
    },
  );
  assert.deepEqual(
    composeMessage({
      recipient: '',
      action: ACTIONS.CUSTOM,
      customText: '',
    }),
    {
      ok: false,
      error: {
        field: 'customText',
        message: '請輸入自定義內容。',
      },
    },
  );

  assert.deepEqual(
    composeMessage({
      recipient: '   ',
      action: ACTIONS.GO_TO_LOBBY,
      customText: '',
    }),
    {
      ok: true,
      presentation: {
        message: '   請至前廳',
        alignment: 'left',
        layout: 'single-line',
      },
    },
  );
});

test('未知動作與錯誤欄位型別會安全失敗', async () => {
  const { composeMessage } = await loadComposer();

  assert.deepEqual(
    composeMessage({ recipient: '', action: 'unknown', customText: '' }),
    {
      ok: false,
      error: {
        field: 'action',
        message: '請選擇有效的動作指令。',
      },
    },
  );
  assert.deepEqual(
    composeMessage({ recipient: 1, action: 'custom', customText: '' }),
    {
      ok: false,
      error: {
        field: 'recipient',
        message: '編號或花名必須是文字。',
      },
    },
  );
});

test('555 與 888 明確映射為滿屏 presentation，其他代碼一律拒絕', async () => {
  const { EMERGENCY_CODES, createEmergencyPresentation } =
    await loadComposer();

  assert.deepEqual(createEmergencyPresentation(EMERGENCY_CODES.INSPECTION), {
    ok: true,
    presentation: {
      message: '555',
      alignment: 'center',
      layout: 'fill-screen',
    },
  });
  assert.deepEqual(createEmergencyPresentation(EMERGENCY_CODES.CLEAR), {
    ok: true,
    presentation: {
      message: '888',
      alignment: 'center',
      layout: 'fill-screen',
    },
  });
  assert.deepEqual(createEmergencyPresentation('999'), {
    ok: false,
    error: {
      field: 'emergencyCode',
      message: '不支援的滿屏代碼。',
    },
  });
});
