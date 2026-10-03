import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL('../desktop/', import.meta.url));
const mainSource = readFileSync(join(desktop, 'main.cjs'), 'utf8');
const preloadSource = readFileSync(join(desktop, 'preload.cjs'), 'utf8');
const plain = (value: any) => JSON.parse(JSON.stringify(value));

async function mount(t: any, platform: string, reduced = false) {
  const directory = mkdtempSync(join(tmpdir(), 'noah-material-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'ui-state.json'), JSON.stringify({ version: 1, drafts: [], appearance: 'dark' }));
  const nativeTheme = Object.assign(new EventEmitter(), { prefersReducedTransparency: reduced, source: 'system', systemDark: false });
  Object.defineProperties(nativeTheme, {
    themeSource: { get() { return this.source; }, set(value) { this.source = value; this.emit('updated'); } },
    shouldUseDarkColors: { get() { return this.source === 'dark' || this.source === 'system' && this.systemDark; } },
  });
  const handlers = new Map<string, (...args: any[]) => any>();
  let startup!: () => Promise<void>, window: any;
  class BrowserWindow extends EventEmitter {
    options: any; background: string; vibrancy: any; sent: any[] = [];
    webContents = Object.assign(new EventEmitter(), { mainFrame: { url: '' },
      send: (channel: string, value: any) => this.sent.push([channel, plain(value)]),
      setWindowOpenHandler: () => {}, isDestroyed: () => false, isLoadingMainFrame: () => false });
    constructor(options: any) { super(); this.options = options; this.background = options.backgroundColor; this.vibrancy = options.vibrancy; window = this; }
    isDestroyed() { return false; }
    setVibrancy(value: any) { this.vibrancy = value; }
    setBackgroundColor(value: string) { this.background = value; }
    async loadURL(url: string) { this.webContents.mainFrame.url = url + '/'; }
    async loadFile() { this.webContents.mainFrame.url = 'file:///loading.html'; }
  }
  const app = Object.assign(new EventEmitter(), { setName() {}, setPath() {}, getPath: () => directory,
    requestSingleInstanceLock: () => true, getVersion: () => '0.4.0', getAppPath: () => desktop,
    whenReady: () => ({ then: (callback: () => Promise<void>) => { startup = callback; return { catch() {} }; } }),
    dock: { setIcon() {} }, setAboutPanelOptions() {} });
  const browserSession = Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    cookies: { async set() {} } });
  const electron = { app, BrowserWindow, nativeTheme,
    ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler), on() {} },
    Menu: { buildFromTemplate: (value: any) => value, setApplicationMenu() {} },
    session: { fromPartition: () => browserSession }, Notification: { isSupported: () => true } };
  class Backend extends EventEmitter { async start() { return { url: 'http://127.0.0.1:45678', token: 'isolated-fixture' }; } }
  runInNewContext(mainSource, { __dirname: desktop, URL, setTimeout, clearTimeout,
    process: { platform, arch: 'arm64', execPath: '/fixture/Noah', env: { NOAH_DESKTOP_USER_DATA: directory } },
    require: (name: string) => name === 'electron' ? electron : name === './backend.cjs' ? { Backend }
      : name.startsWith('./') ? require(join(desktop, name)) : require(name) });
  await startup();
  return { window, nativeTheme: nativeTheme as any, handlers,
    event: { sender: window.webContents, senderFrame: window.webContents.mainFrame } };
}

test('macOS navigation uses under-window vibrancy, follows saved appearance, and switches to solid for reduced transparency', async t => {
  const { window, nativeTheme, handlers, event } = await mount(t, 'darwin');
  assert.equal(nativeTheme.themeSource, 'dark');
  assert.equal(window.options.vibrancy, 'under-window');
  assert.equal(window.options.visualEffectState, 'followWindow');
  assert.equal(window.options.transparent, undefined);
  assert.equal(window.vibrancy, 'under-window');
  assert.equal(window.background, '#00000000');
  assert.equal(window.options.titleBarStyle, 'hiddenInset');
  assert.deepEqual(plain(window.options.trafficLightPosition), { x: 16, y: 13 });
  assert.equal(window.options.minWidth, 920); assert.equal(window.options.minHeight, 680);
  nativeTheme.prefersReducedTransparency = true; nativeTheme.emit('updated');
  assert.equal(window.vibrancy, null); assert.equal(window.background, '#202124');
  assert.deepEqual(window.sent.at(-1), ['noah:window-appearance-changed', { material: 'solid', reducedTransparency: true, themeSource: 'dark', dark: true }]);
  handlers.get('noah:save-ui-state')!(event, { version: 1, drafts: [], appearance: 'light' });
  assert.equal(nativeTheme.themeSource, 'light'); assert.equal(window.background, '#f1f2f4');
  handlers.get('noah:save-ui-state')!(event, { version: 1, drafts: [], appearance: 'system' });
  nativeTheme.systemDark = true; nativeTheme.emit('updated'); assert.equal(window.background, '#202124');
  nativeTheme.prefersReducedTransparency = false; nativeTheme.emit('updated');
  assert.equal(window.vibrancy, 'under-window'); assert.equal(window.background, '#00000000');
  assert.deepEqual(plain(handlers.get('noah:window-appearance')!(event)), { material: 'sidebar', reducedTransparency: false, themeSource: 'system', dark: true });
  assert.throws(() => handlers.get('noah:window-appearance')!({ sender: {} }), /Invalid desktop sender/);
  assert.throws(() => handlers.get('noah:save-ui-state')!(event, { version: 1, drafts: [], appearance: 'invalid' }), /appearance/);
  assert.equal(nativeTheme.themeSource, 'system');
});

test('non-macOS windows stay opaque and macOS reduced transparency starts opaque without changing native controls', async t => {
  const mac = await mount(t, 'darwin', true);
  assert.equal(mac.window.vibrancy, null); assert.equal(mac.window.background, '#202124');
  mac.nativeTheme.prefersReducedTransparency = false; mac.nativeTheme.emit('updated');
  assert.equal(mac.window.vibrancy, 'under-window');
  const other = await mount(t, 'win32');
  assert.equal(other.window.options.vibrancy, undefined); assert.equal(other.window.vibrancy, undefined);
  assert.equal(other.window.background, '#202124'); assert.equal(other.window.options.titleBarStyle, 'default');
  assert.equal(other.handlers.get('noah:window-appearance')!(other.event).material, 'solid');
});

test('preload applies initial material metadata and live accessibility changes to the actual renderer attributes', async () => {
  const listeners = new EventEmitter(), lifecycle = new EventEmitter();
  const document: any = { documentElement: undefined };
  let bridge: any;
  const initial = { material: 'sidebar', reducedTransparency: false, themeSource: 'dark', dark: true };
  let latest = { ...initial };
  runInNewContext(preloadSource, { document,
    window: { location: { protocol: 'http:' }, addEventListener: (event: string, fn: () => void) => lifecycle.on(event, fn) },
    process: { platform: 'darwin', argv: ['--noah-version=0.4.0', '--noah-window-appearance=' + JSON.stringify(initial)] },
    require: () => ({ contextBridge: { exposeInMainWorld: (_name: string, value: any) => { bridge = value; } },
      ipcRenderer: { on: (name: string, fn: any) => listeners.on(name, fn), removeListener: (name: string, fn: any) => listeners.removeListener(name, fn),
        invoke: async () => latest } }) });
  document.documentElement = { dataset: {} };
  lifecycle.emit('DOMContentLoaded'); await Promise.resolve();
  assert.equal(document.documentElement.dataset.windowMaterial, 'sidebar');
  assert.equal(document.documentElement.dataset.reducedTransparency, 'false');
  let received: any;
  const unsubscribe = bridge.onWindowAppearance((value: any) => { received = value; });
  latest = { ...initial, material: 'solid', reducedTransparency: true };
  listeners.emit('noah:window-appearance-changed', {}, latest);
  assert.equal(document.documentElement.dataset.windowMaterial, 'solid');
  assert.equal(document.documentElement.dataset.reducedTransparency, 'true');
  assert.deepEqual(plain(received), latest);
  assert.deepEqual(plain(await bridge.windowAppearance()), latest);
  unsubscribe(); received = undefined;
  listeners.emit('noah:window-appearance-changed', {}, initial);
  assert.equal(received, undefined); assert.equal(document.documentElement.dataset.windowMaterial, 'sidebar');
  assert.equal(typeof bridge.testNotification, 'function'); assert.equal(typeof bridge.saveUiState, 'function');
});
