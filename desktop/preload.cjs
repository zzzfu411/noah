const { contextBridge, ipcRenderer } = require('electron');
let unloading = false;
window.addEventListener('beforeunload', () => { unloading = true; });
const subscribe = (channel, callback) => {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
let appearance;
function applyWindowAppearance(value) {
  appearance = value;
  if (!document.documentElement || !appearance) return;
  document.documentElement.dataset.windowMaterial = appearance.material;
  document.documentElement.dataset.reducedTransparency = String(appearance.reducedTransparency);
}
try {
  const argument = process.argv.find(arg => arg.startsWith('--noah-window-appearance='));
  if (argument) applyWindowAppearance(JSON.parse(argument.slice('--noah-window-appearance='.length)));
} catch { /* Keep the stylesheet's opaque default if initial metadata is unavailable. */ }
subscribe('noah:window-appearance-changed', applyWindowAppearance);
async function readWindowAppearance() {
  const value = await ipcRenderer.invoke('noah:window-appearance');
  applyWindowAppearance(value);
  return value;
}
window.addEventListener('DOMContentLoaded', () => {
  applyWindowAppearance(appearance);
  // The loading page has no trusted backend origin. Its initial native metadata
  // is enough; refresh the state once the real application document loads.
  if (window.location.protocol === 'http:') void readWindowAppearance().catch(() => {});
});
contextBridge.exposeInMainWorld('noahDesktop', Object.freeze({
  platform: process.platform,
  version: process.argv.find(arg => arg.startsWith('--noah-version='))?.slice(15) || 'development',
  windowAppearance: readWindowAppearance,
  onWindowAppearance: callback => subscribe('noah:window-appearance-changed', callback),
  onNewConversation: callback => subscribe('noah:new-conversation', callback),
  onFocusComposer: callback => subscribe('noah:focus-composer', callback),
  onOpenConversation: callback => subscribe('noah:open-conversation', callback),
  notificationSettings: () => ipcRenderer.invoke('noah:notification-settings'),
  setNotificationsEnabled: enabled => ipcRenderer.invoke('noah:set-notifications-enabled', enabled),
  notifyActionable: event => ipcRenderer.invoke('noah:notify-actionable', event),
  testNotification: (conversationId = null) => ipcRenderer.invoke('noah:test-notification', conversationId),
  releaseInfo: () => ipcRenderer.invoke('noah:release-info'),
  loadUiState: () => ipcRenderer.invoke('noah:load-ui-state'),
  saveUiState: state => {
    if (!unloading) return ipcRenderer.invoke('noah:save-ui-state', state);
    const result = ipcRenderer.sendSync('noah:save-ui-state-final', state);
    return result?.ok ? Promise.resolve() : Promise.reject(new Error('最后的草稿未能保存'));
  },
}));
