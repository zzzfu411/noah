const { app, BrowserWindow, Menu, ipcMain, dialog, shell, session, nativeTheme, Notification } = require('electron');
const { join, dirname } = require('node:path');
const { mkdirSync } = require('node:fs');
const { Backend } = require('./backend.cjs');
const { validateUiState, readState, writeState } = require('./state.cjs');
const { DesktopNotifications } = require('./notifications.cjs');
const { releaseInfo: readReleaseInfo } = require('./release.cjs');

app.setName('Noah');
app.setPath('userData', process.env.NOAH_DESKTOP_USER_DATA || join(app.getPath('appData'), 'Noah'));
const userData = app.getPath('userData');
const dataDir = process.env.NOAH_DATA_DIR || join(userData, 'workspace');
const uiStateFile = join(userData, 'ui-state.json');
const windowStateFile = join(userData, 'window-state.json');
// Electron renders both materials behind the window. Under-window gives the
// navigation a clearer frosted backdrop; the renderer still calls that region
// "sidebar" and keeps the conversation canvas opaque.
const navigationVibrancy = 'under-window';
let win, backend, connection, browserSession;
let quitting = false, readyToQuit = false, fatalShowing = false;
let pendingConversation;
const visibleNotifications = new Map();
const notifications = new DesktopNotifications(join(userData, 'notifications.json'), {
  supported: () => Notification.isSupported(),
  foreground: () => !!win && !win.isDestroyed() && win.isVisible() && win.isFocused(),
  show: showNativeNotification,
  open: conversationId => conversationId ? action('noah:open-conversation', conversationId) : focusWindow(),
});

function trusted(event) {
  return !!win && !win.isDestroyed() && event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame && event.senderFrame.url.startsWith(connection?.url + '/');
}
function windowAppearance() {
  const reducedTransparency = nativeTheme.prefersReducedTransparency;
  return { material: process.platform === 'darwin' && !reducedTransparency ? 'sidebar' : 'solid',
    reducedTransparency, themeSource: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors };
}
function windowBackground(appearance) {
  return appearance.material === 'sidebar' ? '#00000000' : appearance.dark ? '#202124' : '#f1f2f4';
}
function syncWindowAppearance() {
  if (!win || win.isDestroyed()) return;
  const appearance = windowAppearance();
  if (process.platform === 'darwin') win.setVibrancy(appearance.material === 'sidebar' ? navigationVibrancy : null);
  win.setBackgroundColor(windowBackground(appearance));
  win.webContents.send('noah:window-appearance-changed', appearance);
}
nativeTheme.on('updated', syncWindowAppearance);
function saveUiState(event, value) {
  if (!trusted(event)) throw new Error('Invalid desktop sender');
  // Synchronous atomic replacement preserves IPC ordering, including the final unload commit.
  const validated = validateUiState(value);
  writeState(uiStateFile, validated);
  if (validated.appearance && nativeTheme.themeSource !== validated.appearance) nativeTheme.themeSource = validated.appearance;
  return { ok: true };
}
ipcMain.handle('noah:window-appearance', event => {
  if (!trusted(event)) throw new Error('Invalid desktop sender');
  return windowAppearance();
});
ipcMain.handle('noah:load-ui-state', event => {
  if (!trusted(event)) throw new Error('Invalid desktop sender');
  try { return validateUiState(readState(uiStateFile)); } catch { return { version: 1, drafts: [] }; }
});
ipcMain.handle('noah:save-ui-state', saveUiState);
ipcMain.on('noah:save-ui-state-final', (event, value) => {
  try { event.returnValue = saveUiState(event, value); } catch { event.returnValue = { ok: false }; }
});
ipcMain.handle('noah:notification-settings', event => {
  if (!trusted(event)) throw new Error('Invalid desktop sender');
  return notifications.settings();
});
ipcMain.handle('noah:set-notifications-enabled', (event, enabled) => {
  if (!trusted(event)) throw new Error('Invalid desktop sender');
  const result = notifications.setEnabled(enabled);
  if (!enabled) for (const notice of visibleNotifications.values()) notice.close();
  setMenu();
  return result;
});
ipcMain.handle('noah:notify-actionable', (event, value) => {
  if (!trusted(event)) throw new Error('Invalid desktop sender');
  return notifications.notify(value);
});
ipcMain.handle('noah:test-notification', (event, conversationId) => {
  if (!trusted(event)) throw new Error('Invalid desktop sender');
  return notifications.testNotification(conversationId);
});
ipcMain.handle('noah:release-info', event => {
  if (!trusted(event)) throw new Error('Invalid desktop sender');
  return currentReleaseInfo();
});
function focusWindow() {
  if (!browserSession || quitting) return;
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function action(channel, value) {
  focusWindow();
  if (!connection || !win) {
    if (channel === 'noah:open-conversation') pendingConversation = value;
    return;
  }
  const target = win.webContents;
  if (target.isLoadingMainFrame()) target.once('did-finish-load', () => { if (!target.isDestroyed()) target.send(channel, value); });
  else target.send(channel, value);
}
function showNativeNotification(options, clicked) {
  return new Promise(resolve => {
    const notice = new Notification(options);
    visibleNotifications.set(options.id, notice);
    let settled = false;
    const finish = status => { if (!settled) { settled = true; clearTimeout(timer); resolve({ status }); } };
    const timer = setTimeout(() => finish('submitted'), 3000);
    timer.unref?.();
    notice.once('show', () => finish('shown'));
    notice.once('failed', () => { visibleNotifications.delete(options.id); finish('failed'); });
    notice.on('click', clicked);
    notice.once('close', () => visibleNotifications.delete(options.id));
    try { notice.show(); }
    catch { visibleNotifications.delete(options.id); finish('failed'); }
  });
}
async function restoreNativeNotifications() {
  if (!notifications.settings().enabled || !Notification.isSupported() || typeof Notification.getHistory !== 'function') return;
  try {
    for (const notice of await Notification.getHistory()) {
      const conversationId = notifications.conversationForNotification(notice.id);
      if (!conversationId) continue;
      visibleNotifications.set(notice.id, notice);
      notice.on('click', () => action('noah:open-conversation', conversationId));
      notice.once('close', () => visibleNotifications.delete(notice.id));
    }
  } catch { /* System permission or signature support is not assumed. */ }
}
function currentReleaseInfo() {
  return readReleaseInfo({ version: app.getVersion(), packaged: app.isPackaged, platform: process.platform, arch: process.arch,
    bundlePath: process.platform === 'darwin' ? join(dirname(process.execPath), '..', '..') : undefined });
}
function showReleaseInfo() {
  const info = currentReleaseInfo();
  const signing = { 'ad-hoc': 'Ad-hoc 本机签名', 'developer-id': 'Developer ID 签名', unsigned: '未签名', other: '其他签名', unknown: '未验证签名' }[info.signing];
  return showMessage({ type: 'info', title: 'Noah 版本与发行状态', message: `Noah ${info.version}`,
    detail: `${info.platform} · ${info.arch}\n${info.packaged ? '本机安装构建' : '开发运行'} · ${signing}\n\nApple 公证：未配置\n自动更新：未配置\n\n本机签名不等于正式发行许可。应用更新与回退不会替换你的讨论数据；打开旧版本前应确认数据库兼容性。\n\n通知默认关闭，系统投递还取决于 macOS 的通知设置与应用签名。` });
}
function resizeWindow(width, height) {
  focusWindow();
  if (!win) return;
  const target = win;
  const resize = () => {
    if (target.isDestroyed()) return;
    target.setSize(width, height, false); target.center();
    writeState(windowStateFile, target.getNormalBounds());
  };
  if (target.isFullScreen()) { target.once('leave-full-screen', resize); target.setFullScreen(false); }
  else if (target.isMaximized()) { target.once('unmaximize', resize); target.unmaximize(); }
  else resize();
}
function showMessage(options) {
  return win && !win.isDestroyed() ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}
function setMenu() {
  const mac = process.platform === 'darwin';
  const items = [
    ...(mac ? [{ label: 'Noah', submenu: [
      { label: '关于 Noah', role: 'about' }, { type: 'separator' },
      { label: '隐藏 Noah', role: 'hide' }, { label: '隐藏其他', role: 'hideOthers' }, { label: '显示全部', role: 'unhide' },
      { type: 'separator' }, { label: '退出 Noah', role: 'quit' },
    ] }] : []),
    { label: '文件', submenu: [
      { label: '新建讨论', accelerator: 'CmdOrCtrl+N', click: () => action('noah:new-conversation') },
      { label: '输入消息', accelerator: 'CmdOrCtrl+L', click: () => action('noah:focus-composer') },
      { type: 'separator' }, { label: '关闭窗口', role: 'close' },
      ...(!mac ? [{ label: '退出 Noah', role: 'quit' }] : []),
    ] },
    { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    { label: '显示', submenu: [{ role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { type: 'separator' }, { role: 'togglefullscreen', label: '进入全屏幕' }] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' },
      { type: 'separator' }, { label: '紧凑窗口', accelerator: 'CmdOrCtrl+Alt+1', click: () => resizeWindow(920, 680) },
      { label: '默认窗口', accelerator: 'CmdOrCtrl+Alt+2', click: () => resizeWindow(1320, 860) },
      ...(mac ? [{ type: 'separator' }, { role: 'front', label: '全部置于顶层' }] : [])] },
    { label: '帮助', submenu: [
      { label: '查看运行说明', click: () => shell.openPath(join(app.getAppPath(), 'README.md')) },
      { label: '打开数据文件夹', click: () => shell.openPath(dataDir) },
      { label: '版本与发行状态', click: showReleaseInfo },
      { label: '关于本机连接', click: () => showMessage({ type: 'info', title: 'Noah', message: '独立的 Agent，共享一场讨论', detail: '新建 Grok 与 pi 会话使用 Grok 模型配置；已连接的原 pi 会话保留自己的模型与工具。\n\n默认自主协作，可选择设置上限。关闭窗口后后台继续工作；退出 Noah 会停止受管服务并保存讨论，原 pi 工作进程保留。重新打开后需要手动继续讨论。\n\n数据目录：' + dataDir }) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(items));
}
function createWindow() {
  const saved = readState(windowStateFile) || {};
  const width = Number.isFinite(saved.width) ? Math.min(2400, Math.max(920, saved.width)) : 1320;
  const height = Number.isFinite(saved.height) ? Math.min(1600, Math.max(680, saved.height)) : 860;
  const appearance = windowAppearance();
  const window = new BrowserWindow({
    width, height, minWidth: 920, minHeight: 680, show: false, title: 'Noah',
    backgroundColor: windowBackground(appearance), titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Allocate the translucent backing even when accessibility disables the
    // material, so it can be restored in-place. Vibrancy already makes this
    // translucent; transparent:true would discard the native window highlight.
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 13 }, vibrancy: navigationVibrancy, visualEffectState: 'followWindow' } : {}),
    icon: join(__dirname, 'assets/icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      // Keep live collaboration updates and draft saves responsive behind other windows.
      backgroundThrottling: false, sandbox: true, session: browserSession,
      additionalArguments: [`--noah-version=${app.getVersion()}`, `--noah-window-appearance=${JSON.stringify(appearance)}`] },
  });
  win = window;
  syncWindowAppearance();
  window.once('ready-to-show', () => { if (!quitting && !window.isDestroyed()) window.show(); });
  window.on('close', event => {
    if (!window.isFullScreen()) writeState(windowStateFile, window.getNormalBounds());
    // Keep the renderer subscribed to actionable events while macOS keeps the
    // app running. Quitting still closes the window and stops managed work.
    if (!quitting && process.platform === 'darwin') { event.preventDefault(); window.hide(); }
  });
  window.on('closed', () => { if (win === window) win = undefined; });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => {
    if (!connection || new URL(target).origin !== connection.url) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { if (!quitting) void fatal(new Error('界面进程已退出；已保存的任务仍在本机。')); });
  if (connection) void window.loadURL(connection.url);
  else void window.loadFile(join(__dirname, 'loading.html'));
}
async function fatal(error) {
  if (fatalShowing || quitting) return;
  fatalShowing = true;
  const result = await showMessage({ type: 'error', title: 'Noah 需要重新打开',
    message: '暂时无法打开协作空间', detail: String(error.message || error).slice(0, 2500),
    buttons: ['重新启动', '退出'], defaultId: 0, cancelId: 1 });
  if (result.response === 0) app.relaunch();
  app.quit();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('ready', (_event, launchInfo) => {
    const conversationId = notifications.conversationFromLaunchInfo(launchInfo);
    if (conversationId) pendingConversation = conversationId;
  });
  app.on('second-instance', () => { if (app.isReady()) focusWindow(); });
  app.on('activate', () => { if (!quitting) focusWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (readyToQuit) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => {
      await backend?.stop();
      readyToQuit = true; app.quit();
    })();
  });
  app.whenReady().then(async () => {
    mkdirSync(userData, { recursive: true, mode: 0o700 });
    try { nativeTheme.themeSource = validateUiState(readState(uiStateFile)).appearance || 'system'; }
    catch { nativeTheme.themeSource = 'system'; }
    if (process.platform === 'darwin') app.dock.setIcon(join(__dirname, 'assets/icon.png'));
    app.setAboutPanelOptions({ applicationName: 'Noah', applicationVersion: app.getVersion(),
      copyright: 'Independent minds, a shared direction.', iconPath: join(__dirname, 'assets/icon.png') });
    browserSession = session.fromPartition('persist:noah');
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ title: '导出 Noah 对话', defaultPath: join(app.getPath('downloads'), item.getFilename()) });
    });
    setMenu(); createWindow();
    void restoreNativeNotifications();
    // The macOS Helper has its own bundle ID and LSUIElement, keeping one foreground app identity.
    const helperName = app.isPackaged ? 'Noah Helper' : 'Electron Helper';
    const execPath = process.platform === 'darwin'
      ? join(dirname(process.execPath), '..', 'Frameworks', helperName + '.app', 'Contents', 'MacOS', helperName)
      : process.execPath;
    backend = new Backend({ root: app.getAppPath(), dataDir, execPath });
    backend.on('lost', error => { void fatal(error); });
    connection = await backend.start();
    if (quitting) return;
    await browserSession.cookies.set({ url: connection.url, name: 'noah_owner', value: connection.token, httpOnly: true, sameSite: 'strict', path: '/' });
    if (win && !win.isDestroyed()) await win.loadURL(connection.url);
    if (pendingConversation) { const target = pendingConversation; pendingConversation = undefined; action('noah:open-conversation', target); }
  }).catch(error => { void fatal(error); });
}
