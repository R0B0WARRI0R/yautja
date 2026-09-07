const statusEl = document.getElementById('status');
const dotEl = document.getElementById('dot');
const statusTextEl = document.getElementById('statusText');
const tabsInfoEl = document.getElementById('tabsInfo');
const reconnectBtn = document.getElementById('reconnect');

function updateUI(state) {
  if (state.connected) {
    statusEl.className = 'status connected';
    dotEl.className = 'dot on';
    statusTextEl.textContent = 'Connected to Yautja';
  } else {
    statusEl.className = 'status disconnected';
    dotEl.className = 'dot off';
    statusTextEl.textContent = 'Disconnected — waiting for Yautja';
  }

  const tabCount = state.attachedTabs || 0;
  if (tabCount > 0) {
    tabsInfoEl.textContent = `${tabCount} tab${tabCount > 1 ? 's' : ''} attached`;
  } else {
    tabsInfoEl.textContent = state.connected ? 'No tabs attached yet' : 'No tabs attached';
  }
}

// Query the background service worker for current state
async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'getState' });
    if (response) {
      updateUI(response);
    }
  } catch {
    updateUI({ connected: false, attachedTabs: 0 });
  }
}

reconnectBtn.addEventListener('click', async () => {
  reconnectBtn.textContent = 'Reconnecting...';
  reconnectBtn.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: 'forceReconnect' });
  } catch {}
  setTimeout(() => {
    reconnectBtn.textContent = 'Reconnect';
    reconnectBtn.disabled = false;
    refreshState();
  }, 1500);
});

refreshState();
