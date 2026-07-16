'use strict';

window.addEventListener('DOMContentLoaded', async () => {
  const result = await window.displayCoreControl.startProgram(
    [{ message: '555\nNancy原樣<script>不是標籤</script>' }],
    3,
    { mode: 'continuous' },
  );

  if (!result.ok) {
    document.title = 'DISPLAYCORE_IPC_FAILED';
  }
});
