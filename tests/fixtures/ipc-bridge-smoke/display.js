'use strict';

let latestRevision = -1;

function isExpectedSnapshot(snapshot) {
  return (
    snapshot.message === '555\nNancy原樣<script>不是標籤</script>' &&
    snapshot.layout === 'fill-screen' &&
    snapshot.revision === 1
  );
}

async function applySnapshot(snapshot) {
  if (!snapshot || snapshot.revision <= latestRevision) {
    return;
  }

  latestRevision = snapshot.revision;

  if (!isExpectedSnapshot(snapshot)) {
    return;
  }

  const current = await window.displayCoreDisplay.getPresentation();

  if (current.ok && isExpectedSnapshot(current.data)) {
    document.title = 'DISPLAYCORE_IPC_OK';
  }
}

// 固定順序：先訂閱，再取得初始 snapshot；revision 防止舊回應蓋掉新事件。
window.displayCoreDisplay.onPresentationChanged((snapshot) => {
  void applySnapshot(snapshot);
});

void window.displayCoreDisplay.getPresentation().then((result) => {
  if (result.ok) {
    void applySnapshot(result.data);
  }
});
