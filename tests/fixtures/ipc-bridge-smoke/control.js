'use strict';

window.addEventListener('DOMContentLoaded', async () => {
  const result = await window.displayCoreControl.showMessage(
    '555\nNancy原樣<script>不是標籤</script>',
    'fill-screen',
  );

  if (!result.ok) {
    document.title = 'DISPLAYCORE_IPC_FAILED';
  }
});
