import vm from 'node:vm';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const html = fs.readFileSync(root + '/public/index.html', 'utf8');
const source = fs.readFileSync(root + '/public/app.js', 'utf8');
const maturitySource = fs.readFileSync(root + '/public/maturity.js', 'utf8');
const saved = { version: 1, selectedTaskId: 'task-b', drafts: [{ conversationId: 'task-b', content: '保留的草稿', recipient: 'pi', updatedAt: 20, replyTo: { id: 'reply-one', sender: 'pi' } }] };
const baseState = { config: { alias: 'deepseek-v4-flash', models: [{ alias: 'deepseek-v4-flash', model: 'deepseek-v4-flash' }] }, conversations: [{ id: 'task-a', title: '第一场协作', status: 'active', used_runs: 0, max_runs: 12 }, { id: 'task-b', title: '桌面验证', status: 'active', used_runs: 0, max_runs: 12 }],
  sessions: ['task-a', 'task-b'].flatMap(conversation_id => ['grok', 'pi'].map(harness => ({ conversation_id, agent: harness, harness, label: harness === 'grok' ? 'Grok' : 'pi', mode: 'managed', binding_id: `managed:${conversation_id}:${harness}`, status: 'idle', native_id: null, native_file: null, capabilities: null }))),
  messages: [], messageCounts: [], deliveries: [], runs: [], materials: [], nativeSessions: [], nativeWakes: [],
};

// A small DOM model for stateful interactions. Rendering and pixel layout are
// checked separately in the actual macOS window; this does not emulate layout.
function mount({ desktop = true, desktopOverrides = {}, restore = saved, failSend = false, failCreate = false, compact = false, dark = false, storedTheme, initialState = baseState, sendGate, loadGate, discoveryResponses = [], discoveryGate, historyMessages = [], historyDeliveries = [], failHistory = false, searchGate, diagnosticResult, materialDocuments = [], failMaterialOffsets = [], materialGate, maturity = false, outcomeGate, outcomeResponseGate, createGate, controlGate, createResponseGate, controlResponseGate, stateGate, pairGate, initialHash = '' } = {}) {
  let active, submitCount = 0;
  const callbacks = {}, stored = [], requests = [], readRequests = [], windowListeners = {}, streams = [], richTextCalls = [], scrollCalls = [], clipboardWrites = [];
  const discoveryQueue = [...discoveryResponses];
  const currentState = structuredClone(initialState);
  const allMessages = [...new Map([...historyMessages, ...currentState.messages].map(message => [message.id, structuredClone(message)])).values()].sort((a, b) => a.seq - b.seq);
  const historyFailures = { enabled: failHistory };
  const materialFailures = new Set(failMaterialOffsets);
  const outcomeSubmissions = new Map();
  const createSubmissions = new Map(), controlSubmissions = new Map();
  const staticElements = [];
  const nested = element => typeof element === 'string' ? [] : [element, ...element.children.flatMap(nested)];
  const matches = (element, selector) => selector.split(',').some(part => {
    const value = part.trim(), tag = value.match(/^[a-z]+/)?.[0], cls = value.match(/\.([\w-]+)/)?.[1];
    if (tag && element.tagName !== tag) return false;
    if (cls && !element.classList.contains(cls)) return false;
    if (value.includes(':checked') && !element.checked) return false;
    if (value.includes('[open]') && !element.open) return false;
    if (value.includes('[data-close]') && !element.dataset.close) return false;
    return true;
  });
  const messageCounts = () => currentState.conversations.map(conversation => ({ conversation_id: conversation.id, count: allMessages.filter(message => message.conversation_id === conversation.id).length }));
  currentState.messageCounts = messageCounts();
  class Element {
    constructor(tag, id) {
      Object.assign(this, { tagName: tag, id, value: '', checked: false, _text: '', children: [], listeners: {}, attributes: {}, dataset: {}, style: {}, className: '', hidden: false, open: false, scrollHeight: 56, scrollTop: 0, clientHeight: 600, files: [] });
      const tokens = () => new Set(this.className.split(/\s+/).filter(Boolean));
      this.classList = {
        add: (...values) => { const set = tokens(); values.forEach(value => set.add(value)); this.className = [...set].join(' '); },
        remove: (...values) => { const set = tokens(); values.forEach(value => set.delete(value)); this.className = [...set].join(' '); },
        contains: value => tokens().has(value),
        toggle: (value, force) => { const enable = force ?? !tokens().has(value); this.classList[enable ? 'add' : 'remove'](value); return enable; },
      };
    }
    set textContent(value) { this._text = String(value ?? ''); this.children = []; }
    get textContent() { return this._text + this.children.map(child => typeof child === 'string' ? child : child.textContent).join(''); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    append(...nodes) { for (const child of nodes) { if (typeof child !== 'string') { if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(c => c !== child); child.parentNode = this; } this.children.push(child); } }
    replaceChildren(...nodes) { this._text = ''; this.children = []; this.append(...nodes); }
    addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
    dispatch(type, event = {}) { for (const callback of this.listeners[type] || []) callback(event); }
    showModal() { this.open = true; }
    close() { if (!this.open) return; this.open = false; queueMicrotask(() => this.dispatch('close')); }
    focus() { active = this.id; document.activeElement = this; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    click() { if (!this.disabled) return this.onclick?.({ currentTarget: this, target: this, preventDefault() {} }); }
    requestSubmit() { submitCount++; const submitter = new Element('button'); submitter.parentNode = this; return this.onsubmit?.({ submitter, preventDefault() {} }); }
    closest(selector) { for (let current = this; current; current = current.parentNode) if (matches(current, selector)) return current; return null; }
    querySelectorAll(selector) {
      const descendants = new Set(nested(this).slice(1));
      for (const element of staticElements) for (let parent = element.parentNode; parent; parent = parent.parentNode) if (parent === this) { descendants.add(element); break; }
      return [...descendants].filter(element => matches(element, selector));
    }
    reset() { for (const element of this.querySelectorAll('input,select,textarea')) { element.value = element.defaultValue || ''; element.checked = element.defaultChecked || false; } }
    getBoundingClientRect() { return { left: 0, right: 360, top: 40, bottom: 680 }; }
    scrollIntoView(options) { scrollCalls.push({ id: this.id, options: structuredClone(options) }); }
  }
  const ids = new Map();
  for (const match of html.matchAll(/<([a-z0-9-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const el = new Element(match[1], match[2]);
    el.hidden = /\bhidden\b/.test(match[0]); el.disabled = /\bdisabled\b/.test(match[0]);
    el.value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || '';
    el.defaultValue = el.value;
    ids.set(match[2], el);
  }
  if (maturity) {
    // Establish only ownership needed for forms and dialog epochs. Layout and
    // the browser's HTML parser remain outside this bounded state harness.
    const stack = [], voidTags = new Set(['meta', 'link', 'input', 'img', 'br', 'hr', 'source', 'area', 'base', 'wbr']);
    for (const match of html.matchAll(/<\/?([a-z][a-z0-9-]*)\b[^>]*>/g)) {
      const tag = match[1], raw = match[0];
      if (raw.startsWith('</')) { const index = stack.findLastIndex(element => element.tagName === tag); if (index >= 0) stack.length = index; continue; }
      const id = raw.match(/\bid="([^"]+)"/)?.[1];
      const element = (id && ids.get(id)) || new Element(tag, id);
      element.parentNode = stack.at(-1); element.className = raw.match(/\bclass="([^"]+)"/)?.[1] || '';
      const close = raw.match(/\bdata-close="([^"]+)"/)?.[1]; if (close) element.dataset.close = close;
      element.defaultChecked = /\bchecked\b/.test(raw); element.checked = element.defaultChecked;
      staticElements.push(element);
      if (!voidTags.has(tag) && !raw.endsWith('/>')) stack.push(element);
    }
    for (const match of html.matchAll(/<select\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
      const element = ids.get(match[1]); if (!element) continue;
      element.defaultValue = match[2].match(/<option\b[^>]*\bvalue="([^"]*)"/)?.[1] || ''; element.value = element.defaultValue;
    }
  }
  ids.get('recipient').value = 'grok';
  const app = new Element('div', 'app'), documentElement = new Element('html'); app.append(ids.get('activity'));
  ids.get('notice').append(ids.get('notice-text'), ids.get('retry-connection'));
  const sendIcon = new Element('svg'); ids.get('send').append(sendIcon, ids.get('send-label'));
  const documentListeners = {};
  const staticGet = ids.get.bind(ids);
  const findId = (element, id) => {
    if (!element || typeof element === 'string') return undefined;
    if (element.id === id) return element;
    for (const child of element.children) { const found = findId(child, id); if (found) return found; }
  };
  // Dynamic timeline articles have IDs only after render, and detached articles
  // must not remain queryable when a discussion or search result changes.
  ids.get = id => staticGet(id) || [...ids.values()].map(element => findId(element, id)).find(Boolean);
  const document = { getElementById: id => ids.get(id), createElement: tag => new Element(tag), documentElement,
    querySelector: selector => selector === '.app' ? app : undefined,
    querySelectorAll: selector => [...new Set([...ids.values(), ...staticElements].flatMap(nested))].filter(element => matches(element, selector)),
    title: '', addEventListener: (type, listener) => (documentListeners[type] ||= []).push(listener) };
  const local = new Map([['noah-task', 'task-a'], ...(storedTheme ? [['noah-theme', storedTheme]] : [])]);
  const media = new Map();
  const matchMedia = query => {
    if (!media.has(query)) {
      const listeners = [];
      const result = { matches: query.includes('prefers-color-scheme') ? dark : compact, addEventListener: (_type, listener) => listeners.push(listener), change(value) { this.matches = value; for (const listener of listeners) listener({ matches: value }); } };
      media.set(query, result);
    }
    return media.get(query);
  };
  const bridge = { platform: 'darwin', version: '0.1.0', loadUiState: async () => { if (loadGate) await loadGate; return restore; }, saveUiState: async state => { stored.push(structuredClone(state)); }, onNewConversation: f => callbacks.new = f, onFocusComposer: f => callbacks.focus = f, ...desktopOverrides };
  let timerId = 0; const timers = new Map();
  const pageLocation = { hash: initialHash };
  const context = vm.createContext({
    document, navigator: { platform: 'MacIntel', clipboard: { writeText: async text => clipboardWrites.push(text) } },
    window: { ...(desktop ? { noahDesktop: bridge } : {}), noahRichText: { render(text) { richTextCalls.push(text); const paragraph = new Element('p'); paragraph.textContent = text; return paragraph; } }, addEventListener: (type, listener) => (windowListeners[type] ||= []).push(listener), location: {} },
    localStorage: { getItem: key => local.get(key), setItem: (key, value) => local.set(key, value), removeItem: key => local.delete(key) },
    matchMedia, location: pageLocation, history: { replaceState() { pageLocation.hash = ''; } }, URLSearchParams, TextEncoder, TextDecoder, crypto: { randomUUID },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    fetch: async (path, options = {}) => {
      const parsed = new URL(path, 'http://fixture.invalid');
      const method = options.method || 'GET';
      if (parsed.pathname === '/api/state') { readRequests.push({ path, method: options.method || 'GET' }); if (stateGate) await stateGate(); return { ok: true, json: async () => structuredClone(currentState) }; }
      if (parsed.pathname === '/api/pair') { readRequests.push({ path, method }); if (pairGate) await pairGate({ token: options.headers.Authorization }); return { ok: true, json: async () => ({ paired: true }) }; }
      if (path === '/api/harnesses') {
        readRequests.push({ path, method: options.method || 'GET' });
        if (discoveryGate) await discoveryGate;
        const report = discoveryQueue.shift();
        if (report instanceof Error) throw report;
        if (!report) throw new Error('Unexpected discovery request');
        currentState.discovery = structuredClone(report);
        return { ok: true, json: async () => structuredClone(report) };
      }
      const messageRoute = parsed.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      const messageDetail = parsed.pathname.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)$/);
      if (messageDetail && method === 'GET') {
        readRequests.push({ path, method });
        const message = allMessages.find(message => message.conversation_id === messageDetail[1] && message.id === messageDetail[2]);
        return { ok: !!message, json: async () => message ? { message: structuredClone(message) } : { error: '消息不属于本讨论' } };
      }
      const deliveryRoute = parsed.pathname.match(/^\/api\/conversations\/([^/]+)\/deliveries$/);
      if (deliveryRoute && method === 'GET') {
        readRequests.push({ path, method });
        const ids = parsed.searchParams.get('messageIds')?.split(',') || [];
        const rows = [...new Map([...historyDeliveries, ...currentState.deliveries].map(row => [row.id, row])).values()];
        return { ok: true, json: async () => ({ deliveries: structuredClone(rows.filter(row => row.conversation_id === deliveryRoute[1] && ids.includes(row.message_id))), hasOlder: false, nextBefore: null }) };
      }
      const outcomesRoute = parsed.pathname.match(/^\/api\/conversations\/([^/]+)\/outcomes$/);
      if (outcomesRoute && method === 'GET') {
        readRequests.push({ path, method });
        return { ok: true, json: async () => structuredClone({ outcomes: (currentState.outcomes || []).filter(row => row.conversation_id === outcomesRoute[1]), revisions: [], decisions: [] }) };
      }
      if (outcomesRoute && method === 'POST') {
        const data = JSON.parse(options.body); requests.push({ path, data });
        if (outcomeGate) await outcomeGate({ conversationId: outcomesRoute[1], data });
        const key = JSON.stringify([outcomesRoute[1], data.clientKey]), signature = JSON.stringify([data.kind, data.title, data.content, data.evidenceMessageIds]);
        const old = outcomeSubmissions.get(key);
        if (old && old.signature !== signature) return { ok: false, json: async () => ({ error: 'Outcome idempotency key conflict' }) };
        const outcome = old?.outcome || { id: randomUUID(), conversation_id: outcomesRoute[1], kind: data.kind, author: 'human', status: 'proposed', current_revision: 1,
          title: data.title, content: data.content, evidence_message_ids: data.evidenceMessageIds };
        if (!old) { outcomeSubmissions.set(key, { signature, outcome }); (currentState.outcomes ||= []).push(outcome); }
        if (outcomeResponseGate) await outcomeResponseGate({ conversationId: outcomesRoute[1], data, outcome });
        return { ok: true, json: async () => structuredClone(outcome) };
      }
      const removeRoute = parsed.pathname.match(/^\/api\/conversations\/([^/]+)\/participants\/([^/]+)\/remove$/);
      if (removeRoute && method === 'POST') {
        requests.push({ path, data: JSON.parse(options.body) });
        const member = currentState.sessions.find(row => row.conversation_id === removeRoute[1] && row.agent === removeRoute[2]);
        if (!member) return { ok: false, json: async () => ({ error: '成员不存在' }) };
        member.removed_at = Date.now();
        for (const delivery of currentState.deliveries) if (delivery.conversation_id === member.conversation_id && delivery.agent === member.agent && ['queued', 'transcript_observed'].includes(delivery.state)) delivery.state = 'cancelled';
        return { ok: true, json: async () => structuredClone(member) };
      }
      if (messageRoute && method === 'GET') {
        readRequests.push({ path, method });
        if (historyFailures.enabled) return { ok: false, json: async () => ({ error: '模拟历史加载失败' }) };
        const messages = allMessages.filter(message => message.conversation_id === messageRoute[1]);
        const limit = Number(parsed.searchParams.get('limit') || 100);
        const before = Number(parsed.searchParams.get('before') || Number.MAX_SAFE_INTEGER);
        const around = Number(parsed.searchParams.get('around') || 0);
        if (parsed.searchParams.has('around') && (!Number.isInteger(around) || around <= 0)) return { ok: false, json: async () => ({ error: 'around 必须是消息序号' }) };
        const page = around
          ? [...messages.filter(message => message.seq <= around).slice(-Math.ceil(limit / 2)), ...messages.filter(message => message.seq > around).slice(0, Math.floor(limit / 2))]
          : messages.filter(message => message.seq < before).slice(-limit);
        return { ok: true, json: async () => structuredClone({ messages: page, total: messages.length, hasOlder: page.length > 0 && messages[0].seq < page[0].seq, hasNewer: page.length > 0 && messages.at(-1).seq > page.at(-1).seq, before: page[0]?.seq ?? null }) };
      }
      if (parsed.pathname === '/api/search' && method === 'GET') {
        readRequests.push({ path, method });
        if (searchGate) await searchGate;
        const term = parsed.searchParams.get('q').toLocaleLowerCase(), conversationId = parsed.searchParams.get('conversationId');
        const found = allMessages.filter(message => (!conversationId || message.conversation_id === conversationId) && message.content.toLocaleLowerCase().includes(term)).reverse();
        return { ok: true, json: async () => ({ truncated: found.length > 50, results: found.slice(0, 50).map(message => ({ ...structuredClone(message), conversation_title: currentState.conversations.find(conversation => conversation.id === message.conversation_id)?.title, excerpt: message.content })) }) };
      }
      if (path === '/api/native-sessions' && method === 'GET') {
        readRequests.push({ path, method }); return { ok: true, json: async () => ({ sessions: structuredClone(currentState.nativeSessions || []) }) };
      }
      const materialRoute = parsed.pathname.match(/^\/api\/conversations\/([^/]+)\/materials\/([^/]+)$/);
      if (materialRoute && method === 'GET') {
        readRequests.push({ path, method });
        const offset = Number(parsed.searchParams.get('offset') || 0);
        if (materialGate) await materialGate({ conversationId: materialRoute[1], id: materialRoute[2], offset });
        if (materialFailures.has(offset)) return { ok: false, json: async () => ({ error: '模拟资料传输中断' }) };
        const material = materialDocuments.find(item => item.id === materialRoute[2] && item.conversation_id === materialRoute[1]);
        if (!material) return { ok: false, json: async () => ({ error: '资料未在本讨论共享' }) };
        return { ok: true, json: async () => ({ id: material.id, name: material.name, sha256: material.sha256, content: material.content.slice(offset, offset + 16000), nextOffset: offset + 16000 < material.content.length ? offset + 16000 : null }) };
      }
      if (path === '/api/diagnostics' && method === 'GET') {
        readRequests.push({ path, method });
        return { ok: true, json: async () => structuredClone(diagnosticResult || { database: 'ok', unresolved: [], unresolvedNativeWakes: [], nativeSessions: currentState.nativeSessions || [], discovery: currentState.discovery || installationReport(), guidance: '检查完成，不启动模型。', inferenceStarted: false }) };
      }
      if (path === '/api/bridge-grants' && method === 'POST') {
        requests.push({ path, data: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ grantPath: '/fixture/bridge-grant.json', expiresAt: Date.now() + 600000, extensionPath: '/fixture/noah/extensions/noah-pi.ts', connectCommand: '/noah-connect /fixture/bridge-grant.json' }) };
      }
      if (/^\/api\/native-sessions\/[^/]+\/revoke$/.test(path)) {
        requests.push({ path, data: JSON.parse(options.body) });
        const binding = currentState.nativeSessions.find(item => item.id === path.split('/')[3]);
        if (binding) binding.status = 'revoked';
        return { ok: true, json: async () => ({ revoked: true }) };
      }
      if (/^\/api\/(?:deliveries|native-wakes)\/[^/]+\/resolve$/.test(path)) {
        requests.push({ path, data: JSON.parse(options.body) });
        for (const row of [...currentState.deliveries, ...(currentState.nativeWakes || [])]) if (row.id === path.split('/')[3]) row.state = 'cancelled';
        return { ok: true, json: async () => ({ resolved: true }) };
      }
      if (messageRoute && method === 'POST') {
        requests.push({ path, data: JSON.parse(options.body) });
        if (sendGate) await sendGate;
        if (failSend) return { ok: false, json: async () => ({ error: '模拟网络中断' }) };
        const data = JSON.parse(options.body);
        const message = { id: 'sent-' + requests.length, seq: (allMessages.at(-1)?.seq || 0) + 1, conversation_id: messageRoute[1], sender: 'human', recipient: data.recipient, content: data.content, in_reply_to: data.inReplyTo || null, created_at: Date.now() };
        allMessages.push(message); currentState.messages.push(message); currentState.messageCounts = messageCounts();
        return { ok: true, json: async () => structuredClone(message) };
      }
      if (path.endsWith('/materials')) { requests.push({ path, data: JSON.parse(options.body) }); return { ok: true, json: async () => ({ id: 'material-one' }) }; }
      if (path === '/api/conversations') {
        const data = JSON.parse(options.body); requests.push({ path, data });
        if (createGate) await createGate({ data });
        if (failCreate) return { ok: false, json: async () => ({ error: '原会话刚刚断开，请重新连接。' }) };
        const { clientKey, ...payload } = data, signature = JSON.stringify(payload), old = clientKey && createSubmissions.get(clientKey);
        if (old && old.signature !== signature) return { ok: false, json: async () => ({ error: 'Create idempotency key conflict' }) };
        const conversation = old?.conversation || { id: `new-${requests.length}`, title: data.title, model_alias: data.modelAlias, status: 'active', limits_enabled: data.limitsEnabled ? 1 : 0, max_runs: data.maxRuns ?? 12, used_runs: 0 };
        if (!old) {
          currentState.conversations.unshift(conversation);
          currentState.sessions.push(...(data.participants || []).map(member => ({ conversation_id: conversation.id, agent: member.id, harness: member.harness, label: member.label, mode: member.mode, binding_id: member.bindingId || `managed:${conversation.id}:${member.id}`, status: 'idle', native_id: null })));
          if (clientKey) createSubmissions.set(clientKey, { signature, conversation });
        }
        if (createResponseGate) await createResponseGate({ data, conversation });
        return { ok: true, json: async () => conversation };
      }
      if (path.endsWith('/control')) {
        const data = JSON.parse(options.body); requests.push({ path, data }); if (controlGate) await controlGate({ path, data });
        const { clientKey, ...payload } = data, signature = JSON.stringify(payload), key = path + ':' + clientKey, old = clientKey && controlSubmissions.get(key);
        if (old && old.signature !== signature) return { ok: false, json: async () => ({ error: 'Control idempotency key conflict' }) };
        if (clientKey && !old) controlSubmissions.set(key, { signature });
        if (controlResponseGate) await controlResponseGate({ path, data, committed: !old });
        return { ok: true, json: async () => ({ ok: true }) };
      }
      throw new Error(path);
    },
    EventSource: class { constructor() { streams.push(this); } addEventListener() {} },
  });
  vm.runInContext(source, context);
  if (maturity) vm.runInContext(maturitySource, context);
  return {
    context, ids, app, document, documentElement, local, media, stored, requests, readRequests, bridge, callbacks, windowListeners, streams, richTextCalls, currentState, sendIcon, allMessages, scrollCalls, clipboardWrites, historyFailures, materialFailures,
    classes: { has: value => documentElement.classList.contains(value) },
    get active() { return active; }, get submitCount() { return submitCount; },
    evaluate: code => vm.runInContext(code, context),
    key(event) { for (const listener of documentListeners.keydown || []) listener(event); },
    async settle() { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); },
  };
}

let checks = 0;
function check(name, fn) { try { fn(); checks++; } catch (error) { error.message = `${name}: ${error.message}`; throw error; } }
const app = mount(); await app.settle();
check('desktop draft restore', () => { assert(app.classes.has('desktop-app')); assert(app.classes.has('desktop-macos')); assert.equal(app.ids.get('task-title').textContent, '桌面验证'); assert.equal(app.ids.get('message').value, '保留的草稿'); assert.equal(app.ids.get('recipient').value, 'pi'); });
app.callbacks.new(); app.callbacks.new();
check('native new conversation', () => { assert(app.ids.get('create-dialog').open); assert.equal(app.active, 'new-title'); });
app.callbacks.focus();
check('native focus composer', () => { assert(!app.ids.get('create-dialog').open); assert.equal(app.active, 'message'); });
let prevented = false;
app.ids.get('message').dispatch('keydown', { key: 'Enter', preventDefault() { prevented = true; } });
app.ids.get('message').dispatch('keydown', { key: 'Enter', metaKey: true, isComposing: true, preventDefault() { prevented = true; } });
check('newline and composition', () => { assert.equal(app.submitCount, 0); assert.equal(prevented, false); });
app.ids.get('message').dispatch('keydown', { key: 'Enter', metaKey: true, preventDefault() { prevented = true; } }); await app.settle();
check('command enter sends and preserves icon', () => { assert.equal(app.submitCount, 1); assert.equal(app.requests[0].data.content, '保留的草稿'); assert.equal(app.requests[0].data.recipient, 'pi'); assert.equal(app.requests[0].data.inReplyTo, 'reply-one'); assert.equal(app.ids.get('message').value, ''); assert(app.ids.get('send').children.includes(app.sendIcon)); assert.equal(app.ids.get('send-label').textContent, '发送'); assert.equal(app.ids.get('send').disabled, true); });
app.ids.get('message').value = '任务 B 新草稿'; app.ids.get('message').oninput(); app.evaluate("choose('task-a')"); app.ids.get('message').value = '任务 A 草稿'; app.ids.get('message').oninput(); app.evaluate("choose('task-b')"); await app.evaluate('persistUiState()');
check('separate task drafts', () => { assert.equal(app.ids.get('message').value, '任务 B 新草稿'); const last = app.stored.at(-1); assert.equal(last.selectedTaskId, 'task-b'); assert.equal(last.drafts.find(d => d.conversationId === 'task-a').content, '任务 A 草稿'); });
app.evaluate("for (let i = 0; i < 100; i++) { const draft = draftFor('large-' + i); draft.content = '汉'.repeat(64000); draft.updatedAt = i; }");
const snapshot = app.evaluate('uiSnapshot()');
check('bounded UTF-8 UI state', () => { assert(Buffer.byteLength(JSON.stringify(snapshot)) <= 1800000); assert.equal(snapshot.drafts[0].conversationId, 'task-b'); assert(!JSON.stringify(snapshot).includes('signature')); });
const retry = mount({ failSend: true }); await retry.settle(); retry.ids.get('composer').requestSubmit(); await retry.settle(); await retry.evaluate('persistUiState()');
const retrySaved = retry.stored.at(-1); const retryKey = retry.requests[0].data.clientKey;
const reopened = mount({ restore: retrySaved }); await reopened.settle(); reopened.ids.get('composer').requestSubmit(); await reopened.settle();
check('retry idempotency after reopen', () => assert.equal(reopened.requests[0].data.clientKey, retryKey));
const web = mount({ desktop: false }); await web.settle();
check('web development entry', () => { assert(!web.classes.has('desktop-app')); assert.equal(web.ids.get('task-title').textContent, '第一场协作'); assert.equal(web.ids.get('message').value, ''); assert.equal(web.ids.get('send-shortcut').textContent, '⌘ Enter 发送'); });
const malformed = mount({ restore: { version: 1, selectedTaskId: {}, drafts: [null, { conversationId: 'bad', content: 12, recipient: 'human' }, { conversationId: 'ok', content: '可恢复', recipient: 'grok' }] } }); await malformed.settle();
check('malformed stored drafts', () => { assert.equal(malformed.evaluate('drafts.has("bad")'), false); assert.equal(malformed.evaluate('draftFor("ok").content'), '可恢复'); });
app.bridge.saveUiState = async () => { throw new Error('disk full'); }; await app.evaluate('persistUiState()');
check('save failure is visible', () => assert.match(app.ids.get('notice').textContent, /草稿暂未保存/));
app.bridge.saveUiState = async state => app.stored.push(structuredClone(state)); await app.evaluate('persistUiState()');
check('save failure clears after recovery', () => assert(!app.ids.get('notice').textContent.includes('草稿暂未保存')));

const interaction = mount(); await interaction.settle();
interaction.ids.get('task-search').value = '桌面'; interaction.ids.get('task-search').oninput();
check('task title filter preserves selection', () => { assert.equal(interaction.ids.get('task-count').textContent, '1/2'); assert.equal(interaction.ids.get('task-list').children.length, 1); assert.equal(interaction.ids.get('task-list').children[0].children[0].className, 'task-link-title'); assert.equal(interaction.ids.get('task-list').children[0].attributes['aria-current'], 'page'); assert.equal(interaction.ids.get('task-title').textContent, '桌面验证'); });
interaction.ids.get('task-search').value = '不存在的任务'; interaction.ids.get('task-search').oninput();
check('search empty state', () => { assert.equal(interaction.ids.get('search-empty').hidden, false); assert.equal(interaction.ids.get('task-list').children.length, 0); });
interaction.ids.get('task-search').dispatch('keydown', { key: 'Escape', preventDefault() {} });
check('escape clears search', () => { assert.equal(interaction.ids.get('task-search').value, ''); assert.equal(interaction.ids.get('task-list').children.length, 2); assert.equal(interaction.ids.get('search-empty').hidden, true); });
interaction.callbacks.new(); interaction.key({ key: 'k', metaKey: true, preventDefault() {} });
check('command k focuses search', () => { assert.equal(interaction.active, 'task-search'); assert.equal(interaction.ids.get('create-dialog').open, false); });
interaction.ids.get('message').value = ' \n\t '; interaction.ids.get('message').oninput(); interaction.ids.get('composer').requestSubmit(); await interaction.settle();
check('whitespace cannot send', () => { assert.equal(interaction.ids.get('send').disabled, true); assert.equal(interaction.requests.length, 0); });
interaction.ids.get('message').value = '继续讨论'; interaction.ids.get('message').scrollHeight = 500; interaction.ids.get('message').oninput();
check('draft restores send and caps height', () => { assert.equal(interaction.ids.get('send').disabled, false); assert.equal(interaction.ids.get('message').style.height, '180px'); assert.equal(interaction.ids.get('message').style.overflowY, 'auto'); });
interaction.ids.get('message').scrollHeight = 30; interaction.ids.get('message').oninput();
check('short composer height', () => assert.equal(interaction.ids.get('message').style.height, '56px'));
check('system appearance default', () => { assert.equal(interaction.documentElement.dataset.theme, 'light'); assert.match(interaction.ids.get('theme-toggle').title, /跟随系统/); });
interaction.media.get('(prefers-color-scheme: dark)').change(true);
check('system appearance updates', () => assert.equal(interaction.documentElement.dataset.theme, 'dark'));
interaction.ids.get('theme-toggle').click(); interaction.media.get('(prefers-color-scheme: dark)').change(false);
check('explicit light appearance persists', () => { assert.equal(interaction.documentElement.dataset.theme, 'light'); assert.equal(interaction.local.get('noah-theme'), 'light'); });
interaction.ids.get('theme-toggle').click();
check('explicit dark appearance', () => { assert.equal(interaction.documentElement.dataset.theme, 'dark'); assert.match(interaction.ids.get('theme-toggle').attributes['aria-label'], /深色/); });
const darkReload = mount({ storedTheme: 'dark' }); await darkReload.settle();
check('appearance restored from storage', () => assert.equal(darkReload.documentElement.dataset.theme, 'dark'));
await interaction.evaluate('persistUiState()');
check('appearance saved through native bridge', () => assert.equal(interaction.stored.at(-1).appearance, 'dark'));
const newOrigin = mount({ restore: interaction.stored.at(-1) }); await newOrigin.settle();
check('appearance survives a new origin without local storage', () => { assert.equal(newOrigin.documentElement.dataset.theme, 'dark'); assert.equal(newOrigin.local.get('noah-theme'), 'dark'); });
const systemAppearance = mount({ restore: { ...saved, appearance: 'system' }, dark: true }); await systemAppearance.settle(); await systemAppearance.evaluate('persistUiState()');
check('native state retains system preference rather than resolved color', () => { assert.equal(systemAppearance.documentElement.dataset.theme, 'dark'); assert.equal(systemAppearance.stored.at(-1).appearance, 'system'); });
const invalidAppearance = mount({ restore: { ...saved, appearance: 'sepia' }, storedTheme: 'light' }); await invalidAppearance.settle();
check('invalid native appearance cannot become a DOM theme', () => { assert.equal(invalidAppearance.documentElement.dataset.theme, 'light'); assert.equal(invalidAppearance.ids.get('theme-toggle').dataset.preference, 'light'); });
let releaseRestore;
const earlyChoice = mount({ restore: { ...saved, appearance: 'dark' }, loadGate: new Promise(resolve => { releaseRestore = resolve; }) });
earlyChoice.ids.get('theme-toggle').click(); releaseRestore(); await earlyChoice.settle(); await earlyChoice.evaluate('persistUiState()');
check('explicit appearance selection wins over a late native restore', () => { assert.equal(earlyChoice.documentElement.dataset.theme, 'light'); assert.equal(earlyChoice.stored.at(-1).appearance, 'light'); });

check('inspector starts closed', () => { assert.equal(interaction.ids.get('activity').hidden, true); assert.equal(interaction.ids.get('toggle-activity').attributes['aria-expanded'], 'false'); });
interaction.ids.get('toggle-activity').click();
check('wide inspector is a third column', () => { assert(interaction.classes.has('inspector-open')); assert.equal(interaction.ids.get('activity').parentNode, interaction.app); assert.equal(interaction.ids.get('activity-dialog').open, false); });
interaction.media.get('(max-width: 1179px)').change(true);
check('compact inspector becomes drawer', () => { assert(!interaction.classes.has('inspector-open')); assert.equal(interaction.ids.get('activity-dialog').open, true); assert.equal(interaction.ids.get('activity').parentNode, interaction.ids.get('activity-dialog')); });
interaction.media.get('(max-width: 1179px)').change(false); await interaction.settle();
check('responsive dialog close preserves wide intent', () => { assert(interaction.classes.has('inspector-open')); assert.equal(interaction.ids.get('toggle-activity').attributes['aria-expanded'], 'true'); assert.equal(interaction.ids.get('activity').parentNode, interaction.app); });
interaction.ids.get('close-activity').click(); await interaction.settle();
check('inspector close state', () => { assert(!interaction.classes.has('inspector-open')); assert.equal(interaction.ids.get('activity').hidden, true); assert.equal(interaction.ids.get('toggle-activity').attributes['aria-expanded'], 'false'); });
interaction.media.get('(max-width: 1179px)').change(true); interaction.ids.get('toggle-activity').click(); interaction.ids.get('activity-dialog').close(); await interaction.settle();
check('native drawer dismissal', () => assert.equal(interaction.ids.get('toggle-activity').attributes['aria-expanded'], 'false'));
interaction.streams[0].onerror();
check('connection state communicates reconnecting', () => assert.equal(interaction.ids.get('connection').dataset.state, 'reconnecting'));
interaction.streams[0].onopen();
check('connection state recovers', () => assert.equal(interaction.ids.get('connection').dataset.state, 'connected'));

const richState = structuredClone(baseState);
richState.messages = [{ id: 'message-one', seq: 1, conversation_id: 'task-b', sender: 'grok', recipient: 'human', content: '**结论**\n继续讨论', created_at: '2026-09-23T02:00:00Z' }];
richState.sessions.find(session => session.conversation_id === 'task-b' && session.agent === 'grok').native_id = 'native-session-one';
richState.materials = [{ id: 'material-one', conversation_id: 'task-b', name: '讨论.md', sha256: 'a'.repeat(64) }];
const rich = mount({ initialState: richState }); await rich.settle();
check('safe rich text integration and message shape', () => { assert.deepEqual([...new Set(rich.richTextCalls)], ['**结论**\n继续讨论']); assert.equal(rich.ids.get('timeline').children.length, 1, 'history hydration must not duplicate the displayed message'); assert.match(rich.ids.get('timeline').children[0].className, /sender-grok/); assert.equal(rich.ids.get('timeline').children[0].children[1].className, 'message-body'); assert.equal(rich.ids.get('timeline').children[0].children[1].children[0].children[1].textContent, '给你'); });
check('inspector keeps native details folded and hash in tooltip', () => { const details = rich.ids.get('agents').children[0].children.find(child => child.className === 'session-details'); assert.equal(details.open, false); assert.equal(rich.ids.get('materials').children[0].textContent, '讨论.md'); assert.match(rich.ids.get('materials').children[0].title, /SHA-256/); assert.equal(rich.ids.get('material-count').textContent, '1'); });

let releaseSend;
const race = mount({ sendGate: new Promise(resolve => { releaseSend = resolve; }) }); await race.settle(); race.ids.get('composer').requestSubmit();
race.ids.get('message').value = '发送期间新增的草稿'; race.ids.get('message').oninput(); releaseSend(); await race.settle();
check('send completion preserves newer draft', () => assert.equal(race.ids.get('message').value, '发送期间新增的草稿'));
const files = mount(); await files.settle();
const eventFor = (types, list = []) => ({ dataTransfer: { types, files: list }, prevented: false, preventDefault() { this.prevented = true; } });
const textDrop = eventFor(['text/plain']); files.ids.get('composer-region').dispatch('drop', textDrop);
check('internal text dragging remains native', () => assert.equal(textDrop.prevented, false));
const sourceFile = new File(['const answer = 42;'], 'answer.ts', { type: 'video/mp2t' });
files.ids.get('composer-region').dispatch('drop', eventFor(['Files'], [sourceFile])); await files.settle();
check('text files share through existing API', () => { assert.equal(files.requests[0].path, '/api/conversations/task-b/materials'); assert.equal(files.requests[0].data.content, 'const answer = 42;'); assert.match(files.ids.get('toast').textContent, /已共享 answer.ts/); });
const beforeInvalid = files.requests.length;
files.ids.get('composer-region').dispatch('drop', eventFor(['Files'], [new File([new Uint8Array([0, 1, 2])], 'binary.md')])); await files.settle();
check('binary text disguise rejected', () => { assert.equal(files.requests.length, beforeInvalid); assert.match(files.ids.get('notice').textContent, /二进制/); });
files.ids.get('composer-region').dispatch('drop', eventFor(['Files'], [new File(['image'], 'image.png')])); await files.settle();
check('unsupported file type rejected', () => { assert.equal(files.requests.length, beforeInvalid); assert.match(files.ids.get('notice').textContent, /暂不支持/); });
files.ids.get('composer-region').dispatch('drop', eventFor(['Files'], [{ name: 'huge.md', size: 10 * 1024 * 1024 + 1 }])); await files.settle();
check('file size limit', () => assert.match(files.ids.get('notice').textContent, /10 MiB/));
let releaseFile;
const pendingFile = { name: 'captured.md', size: 7, arrayBuffer: () => new Promise(resolve => { releaseFile = () => resolve(new TextEncoder().encode('资料').buffer); }) };
files.ids.get('composer-region').dispatch('drop', eventFor(['Files'], [pendingFile])); files.evaluate("choose('task-a')"); releaseFile(); await files.settle();
check('upload remains scoped to task captured at drop', () => { assert.equal(files.requests.at(-1).path, '/api/conversations/task-b/materials'); assert.match(files.ids.get('toast').textContent, /桌面验证/); });

const knownIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
check('all DOM bindings exist', () => { for (const match of (source + maturitySource).matchAll(/\$\('([^']+)'\)/g)) assert(knownIds.has(match[1]), `Unknown ID ${match[1]}`); });

const autonomy = mount(); await autonomy.settle(); autonomy.callbacks.new();
check('new discussion starts with optional limits off', () => {
  assert.equal(autonomy.ids.get('limits-enabled').checked, false);
  assert.equal(autonomy.ids.get('create-limits').hidden, true);
  assert.equal(autonomy.ids.get('max-runs').disabled, true);
  assert.equal(autonomy.ids.get('minutes').disabled, true);
});
autonomy.ids.get('new-title').value = '自主讨论';
// Invalid values in disabled optional inputs must never reintroduce a budget.
autonomy.ids.get('max-runs').value = ''; autonomy.ids.get('minutes').value = '';
autonomy.ids.get('create-form').requestSubmit(); await autonomy.settle();
check('default create sends autonomous policy without hidden bounds', () => {
  const { participants, clientKey, ...policy } = autonomy.requests[0].data;
  assert.match(clientKey, /^[a-f0-9-]{36}$/);
  assert.deepEqual(policy, { title: '自主讨论', modelAlias: 'deepseek-v4-flash', limitsEnabled: false });
  assert.deepEqual(participants.map(({ id, ...member }) => member), [{ harness: 'grok', label: 'Grok', mode: 'managed' }, { harness: 'pi', label: 'pi', mode: 'managed' }]);
  assert.equal(new Set(participants.map(member => member.id)).size, 2); participants.forEach(member => assert.match(member.id, /^p-[a-f0-9-]{36}$/));
  assert.equal(autonomy.ids.get('budget').textContent, '自主讨论 · 按消息继续');
});
autonomy.callbacks.new(); autonomy.ids.get('limits-enabled').checked = true; autonomy.ids.get('limits-enabled').onchange();
check('limits are revealed and enabled only after opting in', () => {
  assert.equal(autonomy.ids.get('create-limits').hidden, false);
  assert.equal(autonomy.ids.get('max-runs').disabled, false);
  assert.equal(autonomy.ids.get('minutes').disabled, false);
});
autonomy.ids.get('new-title').value = '限制测试'; autonomy.ids.get('max-runs').value = '30'; autonomy.ids.get('minutes').value = '60';
autonomy.ids.get('create-form').requestSubmit(); await autonomy.settle();
check('explicit limits are submitted and do not become the next create default', () => {
  const { participants, clientKey, ...policy } = autonomy.requests[1].data;
  assert.match(clientKey, /^[a-f0-9-]{36}$/);
  assert.deepEqual(policy, { title: '限制测试', modelAlias: 'deepseek-v4-flash', limitsEnabled: true, maxRuns: 30, minutes: 60 });
  assert.deepEqual(participants.map(member => member.harness), ['grok', 'pi']);
  assert.equal(autonomy.ids.get('limits-enabled').checked, false);
});
const resumeView = mount(); await resumeView.settle(); resumeView.ids.get('resume').click();
check('legacy resume preserves policy and explains how to disable it without dispatch', () => {
  assert.equal(resumeView.ids.get('resume-limits-enabled').checked, true);
  assert.equal(resumeView.ids.get('resume-settings').open, true);
  assert.match(resumeView.ids.get('resume-description').textContent, /取消勾选/);
  assert.equal(resumeView.requests.length, 0);
});
resumeView.ids.get('resume-limits-enabled').checked = false; resumeView.ids.get('resume-limits-enabled').onchange();
resumeView.ids.get('resume-form').requestSubmit(); await resumeView.settle();
check('explicit resume can remove old bounds without silently adding runs', () => {
  const { clientKey, ...data } = resumeView.requests[0].data;
  assert.match(clientKey, /^[a-f0-9-]{36}$/);
  assert.deepEqual({ path: resumeView.requests[0].path, data }, { path: '/api/conversations/task-b/control', data: { action: 'resume', limitsEnabled: false } });
  assert.equal(resumeView.ids.get('extra-runs').disabled, true);
});
resumeView.currentState.conversations[1].limits_enabled = 0; await resumeView.evaluate('refresh()');
resumeView.ids.get('resume').click();
check('autonomous resume keeps limits off with no top-up requirement', () => {
  assert.equal(resumeView.ids.get('resume-limits-enabled').checked, false);
  assert.equal(resumeView.ids.get('resume-settings').open, false);
});
resumeView.ids.get('resume-limits-enabled').checked = true; resumeView.ids.get('resume-limits-enabled').onchange();
resumeView.ids.get('resume-form').requestSubmit(); await resumeView.settle();
check('owner can opt an autonomous discussion into bounded continuation', () => {
  assert.equal(resumeView.ids.get('extra-runs-label').textContent, '最多再唤醒次数');
  const { clientKey, ...data } = resumeView.requests[1].data;
  assert.match(clientKey, /^[a-f0-9-]{36}$/);
  assert.deepEqual(data, { action: 'resume', limitsEnabled: true, additionalRuns: 4, minutes: 20 });
});

function installationReport({ grok = false, embeddedPi = false, piCli = false, configured = false, codexConfig = false } = {}) {
  return {
    schemaVersion: 1,
    harnesses: ['grok', 'pi', 'codex', 'claude', 'gemini', 'opencode'].map(id => {
      const executableInstalled = id === 'grok' ? grok : id === 'pi' ? piCli : false;
      const configPresent = (id === 'grok' && configured) || (id === 'codex' && codexConfig);
      return {
        id, label: id === 'grok' ? 'Grok' : id === 'codex' ? 'Codex' : id,
        executableInstalled, executablePath: executableInstalled ? `/fixture/bin/${id}` : null,
        configPresent, configPaths: configPresent ? [`/fixture/${id}/config`] : [],
        bundledRuntime: id === 'pi' ? { kind: 'pi_sdk', present: embeddedPi } : null,
        managedCreation: { supported: id === 'grok' || id === 'pi', runtimePresent: id === 'grok' ? grok : id === 'pi' && embeddedPi, modelConfigPresent: configured },
        liveAttach: { capability: id === 'grok' || id === 'pi' ? 'bridge_required' : 'unknown', explanation: '未验证外部会话连接能力。' },
      };
    }),
  };
}
const inventoryState = (report, config = baseState.config) => ({ ...structuredClone(baseState), config: structuredClone(config), discovery: report });
const statusFor = (view, label) => view.ids.get('harness-list').children
  .map(row => row.children.find(child => child.className === 'harness-row-heading'))
  .find(heading => heading?.children[0].textContent === label)?.children[1].textContent;

const absent = mount({ initialState: inventoryState(installationReport()) }); await absent.settle();
absent.ids.get('show-harnesses').click();
check('empty discovery leaves creation unavailable without dispatching or rescanning', () => {
  assert.equal(absent.ids.get('harness-dialog').open, true);
  assert.equal(absent.ids.get('harness-list').children.length, 6);
  assert.equal(absent.ids.get('create-submit').disabled, true);
  assert.match(absent.ids.get('harness-count').textContent, /^0\b/);
  assert.equal(absent.requests.length, 0);
  assert.deepEqual(absent.readRequests.map(r => r.path), ['/api/state?compact=1', '/api/conversations/task-b/messages?limit=200']);
});
const configOnly = mount({ initialState: inventoryState(installationReport({ configured: true, codexConfig: true })) }); await configOnly.settle();
check('configuration files alone never become installed CLI or usable peers', () => {
  assert.match(configOnly.ids.get('harness-count').textContent, /^0\b/);
  assert.equal(configOnly.ids.get('create-submit').disabled, true);
  assert.match(statusFor(configOnly, 'Grok'), /配置/);
  assert.match(statusFor(configOnly, 'Codex'), /配置/);
  assert.doesNotMatch(statusFor(configOnly, 'Codex'), /CLI|连接/);
});
const embeddedOnly = mount({ initialState: inventoryState(installationReport({ embeddedPi: true, configured: true })) }); await embeddedOnly.settle();
check('bundled pi is distinct from installed CLI and can independently form a discussion', () => {
  assert.match(embeddedOnly.ids.get('harness-count').textContent, /^0\b/);
  assert.match(statusFor(embeddedOnly, 'pi'), /内置/);
  assert.doesNotMatch(statusFor(embeddedOnly, 'pi'), /CLI/);
  assert.equal(embeddedOnly.ids.get('create-submit').disabled, false);
  embeddedOnly.callbacks.new();
  assert.equal(embeddedOnly.ids.get('new-participants').children.length, 1);
  assert.equal(embeddedOnly.ids.get('new-participants').children[0].children[1].children[0].value, 'managed:pi');
});
const readyReport = installationReport({ grok: true, embeddedPi: true, configured: true });
const readyInventory = mount({ initialState: inventoryState(readyReport) }); await readyInventory.settle();
check('one installed CLI plus bundled pi unlocks creation without claiming two CLIs', () => {
  assert.match(readyInventory.ids.get('harness-count').textContent, /^1\b/);
  assert.equal(readyInventory.ids.get('create-submit').disabled, false);
  assert.match(statusFor(readyInventory, 'Grok'), /CLI/);
  assert.match(statusFor(readyInventory, 'pi'), /内置/);
});
const externalPiOnly = mount({ initialState: inventoryState(installationReport({ grok: true, piCli: true, configured: true })) }); await externalPiOnly.settle();
check('external pi CLI does not satisfy Noah embedded SDK requirement', () => {
  assert.match(externalPiOnly.ids.get('harness-count').textContent, /^2\b/);
  assert.equal(externalPiOnly.ids.get('create-submit').disabled, false, 'the separately available Grok runtime can still create its own discussion');
  externalPiOnly.callbacks.new();
  const source = externalPiOnly.ids.get('new-participants').children[0].children[1].children[0];
  assert.equal(source.value, 'managed:grok');
  assert.equal(source.children.find(option => option.value === 'managed:pi').disabled, true);
});

const retryInventory = mount({
  initialState: inventoryState(installationReport({ embeddedPi: true }), { error: '尚未配置模型', models: [] }),
  discoveryResponses: [new Error('临时检测失败'), readyReport],
});
await retryInventory.settle(); retryInventory.ids.get('show-harnesses').click();
retryInventory.ids.get('refresh-harnesses').click(); await retryInventory.settle();
check('failed refresh leaves inventory and drafts intact and re-enables retry', () => {
  assert.equal(retryInventory.ids.get('harness-error').hidden, false);
  assert.equal(retryInventory.ids.get('refresh-harnesses').disabled, false);
  assert.equal(retryInventory.ids.get('harness-dialog').open, true);
  assert.match(retryInventory.ids.get('harness-count').textContent, /^0\b/);
  assert.equal(retryInventory.ids.get('message').value, saved.drafts[0].content);
});
// The user supplied configuration outside Noah after opening the application.
// A successful rescan must rehydrate /api/state, not keep the old config error.
retryInventory.currentState.config = structuredClone(baseState.config);
retryInventory.ids.get('refresh-harnesses').click(); await retryInventory.settle();
check('successful retry reloads model availability after installation and preserves the current task', () => {
  assert.equal(retryInventory.ids.get('harness-error').hidden, true);
  assert.equal(retryInventory.ids.get('refresh-harnesses').disabled, false);
  assert.equal(retryInventory.ids.get('create-submit').disabled, false);
  assert.equal(retryInventory.ids.get('new-model').disabled, false);
  assert.equal(retryInventory.ids.get('task-title').textContent, '桌面验证');
  assert.equal(retryInventory.ids.get('message').value, saved.drafts[0].content);
  assert.equal(retryInventory.requests.length, 0);
  assert(retryInventory.readRequests.every(request => request.method === 'GET'));
  assert.equal(retryInventory.readRequests.at(-1).path, '/api/state?compact=1');
});

let finishDiscovery;
const duringScan = mount({ initialState: inventoryState(readyReport), discoveryResponses: [readyReport], discoveryGate: new Promise(resolve => { finishDiscovery = resolve; }) });
await duringScan.settle(); duringScan.ids.get('show-harnesses').click(); duringScan.ids.get('refresh-harnesses').click(); duringScan.ids.get('refresh-harnesses').click();
check('pending scan cannot be duplicated through the disabled control', () => {
  assert.equal(duringScan.ids.get('refresh-harnesses').disabled, true);
  assert.equal(duringScan.readRequests.filter(request => request.path === '/api/harnesses').length, 1);
});
duringScan.callbacks.new(); finishDiscovery(); await duringScan.settle();
check('command n leaves inventory modal even during a pending scan', () => {
  assert.equal(duringScan.ids.get('harness-dialog').open, false);
  assert.equal(duringScan.ids.get('create-dialog').open, true);
  assert.equal(duringScan.active, 'new-title');
});
duringScan.ids.get('show-harnesses').click(); duringScan.callbacks.focus(); await duringScan.settle();
check('command l closes inventory modal and returns to the existing draft', () => {
  assert.equal(duringScan.ids.get('harness-dialog').open, false);
  assert.equal(duringScan.ids.get('create-dialog').open, false);
  assert.equal(duringScan.active, 'message');
  assert.equal(duringScan.ids.get('message').value, saved.drafts[0].content);
});
duringScan.ids.get('show-harnesses').click(); duringScan.key({ key: 'k', metaKey: true, preventDefault() {} }); await duringScan.settle();
check('command k leaves inventory modal and focuses search without side effects', () => {
  assert.equal(duringScan.ids.get('harness-dialog').open, false);
  assert.equal(duringScan.active, 'task-search');
  assert.equal(duringScan.requests.length, 0);
});
const noTasks = mount({ initialState: { ...inventoryState(readyReport), conversations: [] } }); await noTasks.settle();
noTasks.ids.get('show-harnesses').click(); noTasks.callbacks.focus(); await noTasks.settle();
check('command l with no task exits inventory into creation instead of hidden composer', () => {
  assert.equal(noTasks.ids.get('harness-dialog').open, false);
  assert.equal(noTasks.ids.get('create-dialog').open, true);
  assert.equal(noTasks.active, 'new-title');
});

const pickerSource = (view, index) => view.ids.get('new-participants').children[index].children[1].children[0];
const pickerLabel = (view, index) => view.ids.get('new-participants').children[index].children[1].children[1];
const selectSource = (view, index, value) => { const control = pickerSource(view, index); control.value = value; control.onchange(); };
const setMemberLabel = (view, index, value) => { const control = pickerLabel(view, index); control.value = value; control.oninput(); };
const descendants = element => typeof element === 'string' ? [] : [element, ...element.children.flatMap(descendants)];
const byClass = (element, value) => descendants(element).find(child => child.classList.contains(value));
const samePiState = structuredClone(baseState);
samePiState.sessions = samePiState.sessions.filter(member => member.conversation_id !== 'task-b').concat([
  { conversation_id: 'task-b', agent: 'pi-writer', harness: 'pi', label: '作者', mode: 'managed', binding_id: 'managed:task-b:pi-writer', status: 'idle' },
  { conversation_id: 'task-b', agent: 'pi-reviewer', harness: 'pi', label: '审阅者', mode: 'managed', binding_id: 'managed:task-b:pi-reviewer', status: 'idle' },
]);
const samePiDraft = { version: 1, selectedTaskId: 'task-b', drafts: [{ conversationId: 'task-b', content: '请审阅者继续检查', recipient: 'pi-reviewer', updatedAt: 30, replyTo: { id: 'prior-writer-message', sender: 'pi-writer' } }] };
const participants = mount({ initialState: samePiState, restore: samePiDraft }); await participants.settle();
check('same-harness identities restore their own labels, recipient and reply reference', () => {
  assert.equal(participants.ids.get('participant-count').textContent, '2');
  assert.equal(participants.ids.get('header-peers').attributes['aria-label'], '参与者：作者、审阅者');
  assert.deepEqual(participants.ids.get('recipient').children.map(option => [option.value, option.textContent]), [['all', '全部参与者'], ['pi-writer', '作者'], ['pi-reviewer', '审阅者']]);
  assert.equal(participants.ids.get('recipient').value, 'pi-reviewer');
  assert.equal(participants.ids.get('reply-label').textContent, '回复 作者 的消息');
  assert.equal(participants.ids.get('recipient-logo').src, '/assets/harnesses/pi.svg');
  assert.equal(participants.ids.get('send').disabled, false);
});
participants.ids.get('composer').requestSubmit(); await participants.settle();
check('same-harness messages address the selected instance rather than the harness name', () => {
  assert.equal(participants.requests[0].data.recipient, 'pi-reviewer');
  assert.equal(participants.requests[0].data.inReplyTo, 'prior-writer-message');
  assert.equal(participants.ids.get('message').value, '');
});
participants.ids.get('recipient').value = 'all'; participants.ids.get('recipient').onchange();
participants.ids.get('message').value = '请所有参与者讨论'; participants.ids.get('message').oninput();
await participants.evaluate('persistUiState()');
const broadcastReload = mount({ initialState: samePiState, restore: participants.stored.at(-1) }); await broadcastReload.settle();
broadcastReload.ids.get('composer').requestSubmit(); await broadcastReload.settle();
check('broadcast is a persistent recipient choice and sends one explicit all message', () => {
  assert.equal(broadcastReload.ids.get('recipient').value, 'all');
  assert.equal(broadcastReload.ids.get('recipient-logo').hidden, true);
  assert.equal(broadcastReload.requests.length, 1);
  assert.equal(broadcastReload.requests[0].data.recipient, 'all');
  assert.equal(broadcastReload.requests[0].data.content, '请所有参与者讨论');
});
const unavailableDraft = mount({ initialState: samePiState, restore: { ...samePiDraft, drafts: [{ ...samePiDraft.drafts[0], recipient: 'removed-member' }] } }); await unavailableDraft.settle();
unavailableDraft.ids.get('message').dispatch('keydown', { key: 'Enter', metaKey: true, preventDefault() {} }); await unavailableDraft.settle();
check('a removed recipient preserves the draft and cannot be bypassed with command enter', () => {
  assert.equal(unavailableDraft.ids.get('recipient').value, 'removed-member');
  assert.equal(unavailableDraft.ids.get('recipient').children.at(-1).disabled, true);
  assert.equal(unavailableDraft.ids.get('send').disabled, true);
  assert.equal(unavailableDraft.ids.get('message').value, '请审阅者继续检查');
  assert.equal(unavailableDraft.requests.length, 0);
});

const samePiCreate = mount({ initialState: inventoryState(readyReport) }); await samePiCreate.settle(); samePiCreate.callbacks.new();
selectSource(samePiCreate, 0, 'managed:pi'); selectSource(samePiCreate, 1, 'managed:pi');
setMemberLabel(samePiCreate, 0, '研究员'); setMemberLabel(samePiCreate, 1, '审稿人');
samePiCreate.ids.get('new-title').value = '不同会话，同一 harness'; samePiCreate.ids.get('create-form').requestSubmit(); await samePiCreate.settle();
check('creation supports two independently named pi instances and renders their new recipients', () => {
  const payload = samePiCreate.requests[0].data;
  assert.deepEqual(payload.participants.map(({ id, ...member }) => member), [{ harness: 'pi', label: '研究员', mode: 'managed' }, { harness: 'pi', label: '审稿人', mode: 'managed' }]);
  assert.equal(new Set(payload.participants.map(member => member.id)).size, 2);
  assert.equal(samePiCreate.ids.get('participant-count').textContent, '2');
  assert.deepEqual(samePiCreate.ids.get('recipient').children.map(option => option.textContent), ['全部参与者', '研究员', '审稿人']);
});
const nativeState = inventoryState(readyReport);
nativeState.nativeSessions = [{ id: 'binding-live', harness: 'pi', label: '正在写论文', nativeSessionId: 'native-original', projectDir: '/fixture/paper', status: 'idle', generation: 1 }];
const mixed = mount({ initialState: nativeState }); await mixed.settle(); mixed.callbacks.new();
selectSource(mixed, 1, 'external:binding-live'); mixed.ids.get('new-title').value = '邀请原工作会话';
check('mixed creation makes the native source and retained work environment visible', () => {
  assert.match(pickerSource(mixed, 1).children.find(option => option.value === 'external:binding-live').textContent, /已有 pi.*正在写论文/);
  assert.equal(pickerLabel(mixed, 1).value, '正在写论文');
  assert.match(mixed.ids.get('creation-availability').textContent, /1 个已有工作会话/);
  assert.equal(mixed.ids.get('create-submit').disabled, false);
});
mixed.ids.get('create-form').requestSubmit(); await mixed.settle();
check('mixed creation submits the native binding separately from managed model configuration', () => {
  const payload = mixed.requests[0].data;
  assert.deepEqual(payload.participants.map(({ id, ...member }) => member), [{ harness: 'grok', label: 'Grok', mode: 'managed' }, { harness: 'pi', label: '正在写论文', mode: 'external', bindingId: 'binding-live' }]);
  assert.equal(payload.modelAlias, 'deepseek-v4-flash');
  assert.equal(mixed.ids.get('task-model').textContent, 'deepseek-v4-flash');
  assert.match(mixed.ids.get('agents').children[1].textContent, /原工作会话.*保留模型和工具/);
});
const externalOnly = mount({ initialState: { ...nativeState, config: { error: '尚未配置新会话模型', models: [] } } }); await externalOnly.settle(); externalOnly.callbacks.new();
selectSource(externalOnly, 0, 'external:binding-live'); selectSource(externalOnly, 1, 'external:binding-live');
check('one native session cannot be selected twice in the same discussion', () => assert.equal(externalOnly.ids.get('create-submit').disabled, true));
externalOnly.ids.get('new-participants').children[1].children.at(-1).click();
externalOnly.ids.get('new-title').value = '只连接原会话'; externalOnly.ids.get('create-form').requestSubmit(); await externalOnly.settle();
check('native-only creation neither requires nor replaces the existing model configuration', () => {
  assert.equal(externalOnly.ids.get('new-model-label').hidden, true);
  assert.equal(externalOnly.ids.get('new-model').disabled, true);
  assert.equal(externalOnly.requests.length, 1);
  assert.equal('modelAlias' in externalOnly.requests[0].data, false);
  assert.equal(externalOnly.requests[0].data.participants[0].bindingId, 'binding-live');
});
// An existing native-only discussion may coexist with a configured Grok
// default, and older discussion rows may retain that default model alias.
const externalDiscussion = externalOnly.currentState.conversations[0];
externalOnly.currentState.config = structuredClone(baseState.config);
externalDiscussion.model_alias = 'legacy-grok-default';
await externalOnly.evaluate('refresh()');
check('native-only discussion models stay truthful in the header and task list despite Grok defaults', () => {
  assert.equal(externalOnly.ids.get('task-model').textContent, '沿用原会话模型');
  const task = externalOnly.ids.get('task-list').children.find(item => item.title === externalDiscussion.title);
  assert.equal(byClass(task, 'task-link-meta').textContent, '等待消息 · 原会话模型');
  assert.doesNotMatch(task.textContent, /legacy-grok-default|deepseek-v4-flash/);
  assert.equal(externalOnly.requests.length, 1, 'refreshing must not start a native turn');
});
const externalMember = externalOnly.currentState.sessions.find(member => member.conversation_id === externalDiscussion.id);
for (const [status, taskLabel, memberLabel, nativeLabel] of [
  ['busy', '原会话工作中', '原会话工作中', '工作中'],
  ['waiting_user', '原会话等待你', '原会话等待你', '等待你'],
  ['offline', '原会话已断开', '原会话已断开', '原会话已断开'],
  ['paused', '连接需要核对', '连接已暂停', '连接已暂停'],
  ['idle', '等待消息', '等待消息', '可接收讨论'],
]) {
  externalMember.status = status;
  externalOnly.currentState.nativeSessions[0].status = status;
  await externalOnly.evaluate('refresh()');
  check(`native heartbeat ${status} updates discussion, participant and source status without dispatch`, () => {
    assert.equal(externalOnly.ids.get('task-status').textContent, taskLabel);
    const task = externalOnly.ids.get('task-list').children.find(item => item.title === externalDiscussion.title);
    assert.equal(byClass(task, 'task-link-meta').textContent, `${taskLabel} · 原会话模型`);
    const memberStatus = byClass(externalOnly.ids.get('agents').children[0], 'agent-status');
    assert.equal(memberStatus.textContent, memberLabel);
    assert.equal(memberStatus.dataset.state, status);
    assert.equal(byClass(externalOnly.ids.get('native-session-list').children[0], 'muted').textContent, `${nativeLabel} · /fixture/paper`);
    assert.equal(externalOnly.ids.get('task-model').textContent, '沿用原会话模型');
    assert.equal(externalOnly.requests.length, 1, 'heartbeat state refresh must stay read-only');
  });
}
const nativeCreateFailure = mount({ initialState: { ...nativeState, config: { error: '尚未配置新会话模型', models: [] } }, failCreate: true }); await nativeCreateFailure.settle(); nativeCreateFailure.callbacks.new();
selectSource(nativeCreateFailure, 0, 'external:binding-live'); nativeCreateFailure.ids.get('new-participants').children[1].children.at(-1).click();
nativeCreateFailure.ids.get('new-title').value = '创建期间断线'; nativeCreateFailure.ids.get('create-form').requestSubmit(); await nativeCreateFailure.settle();
check('native-only creation failures remain visible outside the hidden model controls', () => {
  assert.equal(nativeCreateFailure.ids.get('model-help').hidden, true);
  assert.equal(nativeCreateFailure.ids.get('create-error').hidden, false);
  assert.match(nativeCreateFailure.ids.get('create-error').textContent, /原会话刚刚断开/);
  assert.equal(nativeCreateFailure.ids.get('create-dialog').open, true);
  assert.equal(nativeCreateFailure.ids.get('new-title').value, '创建期间断线');
});
externalOnly.currentState.nativeSessions[0].status = 'offline'; await externalOnly.evaluate('refresh()'); externalOnly.callbacks.new();
check('an offline original session is disabled instead of being advertised as joinable', () => {
  assert.equal(pickerSource(externalOnly, 0).children.find(option => option.value === 'external:binding-live').disabled, true);
  assert.equal(externalOnly.ids.get('create-submit').disabled, true);
});

const receiptState = structuredClone(samePiState);
receiptState.messages = [{ id: 'receipt-message', seq: 1, conversation_id: 'task-b', sender: 'human', recipient: 'pi-writer', content: '请作者先处理', created_at: 1700000000000 }];
receiptState.deliveries = [
  { id: 'delivery-writer', message_id: 'receipt-message', conversation_id: 'task-b', agent: 'pi-writer', wake: 1, state: 'context_accepted' },
  { id: 'delivery-reviewer', message_id: 'receipt-message', conversation_id: 'task-b', agent: 'pi-reviewer', wake: 0, state: 'queued' },
];
const receipts = mount({ initialState: receiptState, restore: samePiDraft }); await receipts.settle();
check('directed and passive delivery receipts remain distinct for each same-harness member', () => {
  const article = receipts.ids.get('message-receipt-message');
  assert.equal(byClass(article, 'delivery-status').textContent, '作者 · 会话接口已接收');
  const details = byClass(article, 'delivery-details');
  assert.equal(details.children[0].textContent, '查看 2 位成员的投递状态');
  assert.match(details.textContent, /审阅者 · 待同步/);
  assert.doesNotMatch(details.textContent, /已读|共识|讨论已完成/);
});
let receiptDetail = byClass(receipts.ids.get('message-receipt-message'), 'delivery-details');
receiptDetail.open = true; receiptDetail.dispatch('toggle');
receipts.currentState.deliveries[1].state = 'uncertain'; await receipts.evaluate('refresh()');
check('receipt expansion survives updates and does not silently resolve uncertain execution', () => {
  receiptDetail = byClass(receipts.ids.get('message-receipt-message'), 'delivery-details');
  assert.equal(receiptDetail.open, true);
  assert.match(receiptDetail.textContent, /审阅者 · 结果待核对/);
  assert.equal(receipts.requests.length, 0);
});
descendants(receiptDetail).find(element => element.tagName === 'button' && /已核对/.test(element.textContent)).click(); await receipts.settle();
check('explicit receipt acknowledgement resolves only the selected delivery and never resends its message', () => {
  assert.deepEqual(receipts.requests, [{ path: '/api/deliveries/delivery-reviewer/resolve', data: {} }]);
  assert.equal(receipts.currentState.deliveries[1].state, 'cancelled');
  assert.equal(receipts.currentState.deliveries[0].state, 'context_accepted');
});

const archive = Array.from({ length: 1210 }, (_, index) => ({ id: 'archive-' + index, seq: index + 1, conversation_id: 'task-b', sender: 'grok', recipient: 'pi', content: index === 4 ? '旧记录的字面 %_\\ 匹配' : `公开历史 ${index}`, created_at: 1700000000000 + index }));
archive.push({ id: 'other-thread', seq: 1211, conversation_id: 'task-a', sender: 'pi', recipient: 'grok', content: '跨讨论的唯一定位点', created_at: 1700000010000 });
const historicalState = { ...structuredClone(baseState), messages: archive.filter(message => message.conversation_id === 'task-b').slice(-10) };
const history = mount({ initialState: historicalState, historyMessages: archive }); await history.settle();
check('history loads a bounded page beyond the recent snapshot and advertises the remaining records', () => {
  assert.equal(history.ids.get('timeline').children.length, 200);
  assert.equal(history.ids.get('history-bar').hidden, false);
  assert.match(history.ids.get('history-status').textContent, /200 \/ 1210/);
});
history.ids.get('load-older').click(); await history.settle();
check('loading earlier history uses a cursor, retains ordering and does not duplicate records', () => {
  assert.equal(history.ids.get('timeline').children.length, 400);
  assert.equal(new Set(history.ids.get('timeline').children.map(article => article.id)).size, 400);
  assert.equal(history.ids.get('timeline').children[0].id, 'message-archive-810');
  assert.ok(history.readRequests.some(request => request.path.includes('before=1011')));
});
history.key({ key: 'f', metaKey: true, preventDefault() {} });
history.ids.get('message-query').value = '%_\\'; history.ids.get('message-search-form').requestSubmit(); await history.settle();
check('message search uses the selected discussion and literal encoded query without changing its draft', () => {
  assert.equal(history.ids.get('search-dialog').open, true);
  assert.equal(history.ids.get('message-search-results').children.length, 1);
  const path = history.readRequests.at(-1).path;
  const params = new URL(path, 'http://fixture.invalid').searchParams;
  assert.equal(params.get('q'), '%_\\'); assert.equal(params.get('conversationId'), 'task-b');
  assert.equal(history.ids.get('message').value, saved.drafts[0].content);
});
history.ids.get('message-search-results').children[0].click(); await history.settle();
check('a search result loads and scrolls to its original older message', () => {
  assert.equal(history.ids.get('search-dialog').open, false);
  assert.ok(history.readRequests.some(request => request.path.includes('around=5')));
  assert.equal(history.scrollCalls.at(-1).id, 'message-archive-4');
  assert.equal(history.scrollCalls.at(-1).options.block, 'center');
  assert.equal(history.ids.get('message-archive-4').classList.contains('search-target'), true);
});
const beforeFurtherPage = history.ids.get('timeline').children.length;
history.ids.get('load-older').click(); await history.settle();
check('searching an old message does not move the regular pagination cursor past an unloaded gap', () => {
  const pageRequest = history.readRequests.findLast(request => new URL(request.path, 'http://fixture.invalid').pathname.endsWith('/messages'));
  assert.equal(new URL(pageRequest.path, 'http://fixture.invalid').searchParams.get('before'), '811');
  assert.equal(history.ids.get('timeline').children.length, beforeFurtherPage + 200);
  assert.ok(history.ids.get('message-archive-610'));
  assert.ok(history.ids.get('message-archive-809'));
  assert.ok(history.ids.get('message-archive-4'), 'the separately located search result remains visible');
});
history.ids.get('find-messages').click(); history.ids.get('search-scope').value = 'all';
history.ids.get('message-query').value = '跨讨论'; history.ids.get('message-search-form').requestSubmit(); await history.settle();
history.ids.get('message-search-results').children[0].click(); await history.settle();
check('global search navigates to another discussion while retaining the original per-discussion draft', () => {
  assert.equal(history.ids.get('task-title').textContent, '第一场协作');
  assert.equal(history.scrollCalls.at(-1).id, 'message-other-thread');
  history.evaluate("choose('task-b')");
  assert.equal(history.ids.get('message').value, saved.drafts[0].content);
  assert.equal(history.requests.length, 0);
});
const historyRetry = mount({ initialState: historicalState, historyMessages: archive, failHistory: true }); await historyRetry.settle();
check('history failure leaves visible records and draft intact with a retry action', () => {
  assert.match(historyRetry.ids.get('history-status').textContent, /无法加载.*重试/);
  assert.equal(historyRetry.ids.get('load-older').disabled, false);
  assert.equal(historyRetry.ids.get('timeline').children.length, 10);
  assert.equal(historyRetry.ids.get('message').value, saved.drafts[0].content);
});
historyRetry.historyFailures.enabled = false; historyRetry.ids.get('load-older').click(); await historyRetry.settle();
check('history retry adds missing records instead of replacing the existing tail', () => {
  assert.equal(historyRetry.ids.get('timeline').children.length, 200);
  assert.equal(historyRetry.ids.get('timeline').children.at(-1).id, 'message-archive-1209');
  assert.doesNotMatch(historyRetry.ids.get('history-status').textContent, /无法加载/);
});
let releaseSearch;
const lateSearch = mount({ initialState: historicalState, historyMessages: archive, searchGate: new Promise(resolve => { releaseSearch = resolve; }) }); await lateSearch.settle();
lateSearch.ids.get('find-messages').click(); lateSearch.ids.get('message-query').value = '旧记录'; lateSearch.ids.get('message-search-form').requestSubmit();
lateSearch.ids.get('close-search').click(); releaseSearch(); await lateSearch.settle();
check('a completed request cannot repopulate a search the owner has dismissed', () => {
  assert.equal(lateSearch.ids.get('search-dialog').open, false);
  assert.equal(lateSearch.ids.get('message-search-results').children.length, 0);
  assert.equal(lateSearch.scrollCalls.length, 0);
});
lateSearch.ids.get('find-messages').click(); lateSearch.callbacks.new();
check('native new discussion leaves message search instead of stacking modal dialogs', () => {
  assert.equal(lateSearch.ids.get('search-dialog').open, false);
  assert.equal(lateSearch.ids.get('create-dialog').open, true);
  assert.equal(lateSearch.active, 'new-title');
});

const nativeControls = mount({ initialState: nativeState }); await nativeControls.settle();
nativeControls.ids.get('show-harnesses').click(); nativeControls.ids.get('connect-pi').click(); nativeControls.ids.get('connect-pi').click(); await nativeControls.settle();
check('bridge setup issues a single explicit grant and explains the extension and native connect command', () => {
  assert.deepEqual(nativeControls.requests, [{ path: '/api/bridge-grants', data: {} }]);
  assert.equal(nativeControls.ids.get('bridge-setup').hidden, false);
  assert.equal(nativeControls.ids.get('bridge-extension-path').textContent, '/fixture/noah/extensions/noah-pi.ts');
  assert.equal(nativeControls.ids.get('bridge-connect-command').textContent, '/noah-connect /fixture/bridge-grant.json');
  assert.equal(nativeControls.ids.get('connect-pi').disabled, false);
});
nativeControls.ids.get('copy-bridge-command').click(); await nativeControls.settle();
check('bridge setup copies the scoped native command rather than an owner credential', () => assert.deepEqual(nativeControls.clipboardWrites, ['/noah-connect /fixture/bridge-grant.json']));
nativeControls.ids.get('run-diagnostics').click(); await nativeControls.settle();
check('desktop diagnostics is a read-only query and provides actionable local state', () => {
  assert.equal(nativeControls.readRequests.at(-1).path, '/api/diagnostics');
  assert.equal(nativeControls.requests.length, 1);
  assert.match(nativeControls.ids.get('diagnostic-result').textContent, /本地数据库：正常/);
  assert.match(nativeControls.ids.get('diagnostic-result').textContent, /不启动模型/);
});
const wakeState = structuredClone(nativeState);
wakeState.nativeWakes = [
  { id: 'native-uncertain', binding_id: 'binding-live', conversation_id: 'task-b', state: 'uncertain', reason: 'PRIVATE_INTERNAL_WAKE_DETAIL /private/native.jsonl', input_bytes: 1024, message_count: 3 },
  { id: 'native-completed', binding_id: 'binding-live', conversation_id: 'task-b', state: 'completed', reason: null, input_bytes: 512, message_count: 1 },
];
const nativeWake = mount({ initialState: wakeState }); await nativeWake.settle(); nativeWake.ids.get('show-harnesses').click();
check('uncertain native execution is visibly waiting for owner review without exposing internal details', () => {
  const reviews = descendants(nativeWake.ids.get('native-session-list')).filter(element => element.classList.contains('native-wake-review'));
  assert.equal(reviews.length, 1);
  assert.match(reviews[0].textContent, /桌面验证.*需要核对/);
  assert.match(reviews[0].textContent, /无法确认.*不会重发/);
  assert.doesNotMatch(reviews[0].textContent, /PRIVATE_INTERNAL_WAKE_DETAIL|\/private\/native/);
  assert.equal(nativeWake.requests.length, 0);
  assert.match(nativeWake.ids.get('usage-summary').textContent, /字节不是 token/);
});
descendants(nativeWake.ids.get('native-session-list')).find(element => element.dataset.resolveNativeWake === 'native-uncertain').click(); await nativeWake.settle();
check('native wake review clears only that wake and cannot replay the original batch', () => {
  assert.deepEqual(nativeWake.requests, [{ path: '/api/native-wakes/native-uncertain/resolve', data: {} }]);
  assert.equal(nativeWake.currentState.nativeWakes[0].state, 'cancelled');
  assert.equal(nativeWake.currentState.nativeWakes[1].state, 'completed');
  assert.equal(descendants(nativeWake.ids.get('native-session-list')).filter(element => element.classList.contains('native-wake-review')).length, 0);
});

const materialDocuments = [
  { id: 'long-material', conversation_id: 'task-b', name: '公开研究资料.md', sha256: 'b'.repeat(64), content: '汉'.repeat(16000) + '后续的资料正文' },
  { id: 'other-material', conversation_id: 'task-a', name: '另一个讨论.md', sha256: 'c'.repeat(64), content: '另一场讨论的独立资料内容' },
];
const materialState = { ...structuredClone(baseState), materials: materialDocuments.map(({ content, ...metadata }) => metadata) };
const materialView = mount({ initialState: materialState, materialDocuments, failMaterialOffsets: [16000] }); await materialView.settle();
materialView.ids.get('materials').children[0].click(); await materialView.settle();
check('shared-material preview opens the chosen snapshot and fetches a bounded first page', () => {
  assert.equal(materialView.ids.get('material-dialog').open, true);
  assert.equal(materialView.ids.get('material-heading').textContent, '公开研究资料.md');
  assert.equal(materialView.ids.get('material-content').textContent, '汉'.repeat(16000));
  assert.equal(materialView.ids.get('material-more').hidden, false);
  assert.match(materialView.ids.get('material-meta').textContent, /SHA-256 b{64}/);
  assert.equal(materialView.readRequests.at(-1).path, '/api/conversations/task-b/materials/long-material?offset=0');
});
materialView.ids.get('material-more').click(); await materialView.settle();
check('material transfer failure preserves the first page and leaves a retry at the same offset', () => {
  assert.equal(materialView.ids.get('material-content').textContent, '汉'.repeat(16000));
  assert.equal(materialView.ids.get('material-more').disabled, false);
  assert.equal(materialView.ids.get('material-error').hidden, false);
  assert.match(materialView.ids.get('material-error').textContent, /加载失败.*重试/);
  assert.equal(materialView.readRequests.at(-1).path, '/api/conversations/task-b/materials/long-material?offset=16000');
});
materialView.materialFailures.clear(); materialView.ids.get('material-more').click(); await materialView.settle();
check('material retry appends the missing page once and reports complete text', () => {
  assert.equal(materialView.ids.get('material-content').textContent, materialDocuments[0].content);
  assert.equal(materialView.ids.get('material-more').hidden, true);
  assert.equal(materialView.ids.get('material-error').hidden, true);
  assert.match(materialView.ids.get('material-meta').textContent, /全文/);
  assert.equal(materialView.readRequests.at(-1).path, '/api/conversations/task-b/materials/long-material?offset=16000');
});
materialView.ids.get('copy-material-reference').click(); await materialView.settle();
check('copying a material reference preserves identity and hash without duplicating its whole body', () => {
  assert.deepEqual(materialView.clipboardWrites, [`公开研究资料.md\nmaterial_id: long-material\nsha256: ${'b'.repeat(64)}`]);
  assert.equal(materialView.requests.length, 0);
});
let releaseMaterial;
const delayedMaterial = mount({ initialState: materialState, materialDocuments, materialGate: ({ id }) => id === 'long-material' ? new Promise(resolve => { releaseMaterial = resolve; }) : undefined }); await delayedMaterial.settle();
delayedMaterial.ids.get('materials').children[0].click();
delayedMaterial.ids.get('close-material').click(); delayedMaterial.evaluate("choose('task-a')"); delayedMaterial.ids.get('materials').children[0].click(); await delayedMaterial.settle();
releaseMaterial(); await delayedMaterial.settle();
check('a delayed material response cannot overwrite another discussion snapshot after switching', () => {
  assert.equal(delayedMaterial.ids.get('task-title').textContent, '第一场协作');
  assert.equal(delayedMaterial.ids.get('material-heading').textContent, '另一个讨论.md');
  assert.equal(delayedMaterial.ids.get('material-content').textContent, materialDocuments[1].content);
  assert.match(delayedMaterial.ids.get('material-meta').textContent, /SHA-256 c{64}/);
  assert.equal(delayedMaterial.ids.get('material-more').hidden, true);
  assert.equal(delayedMaterial.requests.length, 0);
});
// Four v0.4 paths use both shipped modules. These are state/contract checks;
// macOS rendering, window size and system notification delivery remain CUA QA.
const evidenceMessages = Array.from({ length: 230 }, (_, index) => ({ id: randomUUID(), seq: index + 1, conversation_id: 'task-b',
  sender: 'human', recipient: 'pi', content: `依据正文 ${index + 1}`, created_at: 1700000020000 + index }));
const oldEvidence = evidenceMessages[4];
const evidenceOutcome = { id: randomUUID(), conversation_id: 'task-b', kind: 'conclusion', author: 'pi', status: 'proposed', current_revision: 1,
  title: '由旧消息形成的提议', content: '该提议必须可以回到最初的公开依据。', evidence_message_ids: [oldEvidence.id] };
const evidenceView = mount({ maturity: true, initialState: { ...structuredClone(baseState), messages: evidenceMessages.slice(-10), outcomes: [evidenceOutcome] },
  historyMessages: evidenceMessages, historyDeliveries: [{ id: randomUUID(), message_id: oldEvidence.id, conversation_id: 'task-b', agent: 'pi', wake: 1, state: 'completed' }] });
await evidenceView.settle(); evidenceView.ids.get('show-outcomes').click(); await evidenceView.settle();
descendants(evidenceView.ids.get('outcome-list')).find(element => element.tagName === 'button' && element.textContent === '依据 1').click(); await evidenceView.settle();
check('v0.4 outcome evidence resolves UUID to sequence and restores the historical delivery receipt', () => {
  assert.equal(typeof evidenceView.context.window.noahMaturity.render, 'function');
  assert.ok(evidenceView.readRequests.some(request => request.path.endsWith('/messages/' + oldEvidence.id)));
  assert.ok(evidenceView.readRequests.some(request => new URL(request.path, 'http://fixture.invalid').searchParams.get('around') === '5'));
  assert.equal(evidenceView.scrollCalls.at(-1).id, 'message-' + oldEvidence.id);
  const article = evidenceView.ids.get('message-' + oldEvidence.id);
  assert.equal(byClass(article, 'delivery-status').textContent, 'pi · 本次处理完成');
  assert.equal(byClass(article, 'delivery-details').children[0].textContent, '查看 1 位成员的投递状态');
  assert.equal(evidenceView.requests.length, 0);
});

const historicalProposal = mount({ maturity: true, initialState: { ...structuredClone(baseState), messages: evidenceMessages, outcomes: [] } });
await historicalProposal.settle();
descendants(historicalProposal.ids.get('message-' + oldEvidence.id)).find(element => element.tagName === 'button' && element.textContent === '提为结论').click();
await historicalProposal.settle();
const historicalSelection = historicalProposal.ids.get('outcome-evidence').querySelectorAll('input:checked').map(input => input.value);
historicalProposal.ids.get('outcome-title').value = '保留早期依据'; historicalProposal.ids.get('outcome-content').value = '引用刚才点选的原始消息。';
await historicalProposal.ids.get('outcome-form').requestSubmit(); await historicalProposal.settle();
check('v0.4 proposing from an explicit old message keeps its evidence outside the recent 100 choices', () => {
  assert.equal(evidenceMessages.length, 230);
  assert.deepEqual(historicalSelection, [oldEvidence.id]);
  assert.equal(historicalProposal.requests.length, 1);
  assert.deepEqual(historicalProposal.requests[0].data.evidenceMessageIds, [oldEvidence.id]);
  assert.deepEqual(historicalProposal.currentState.outcomes[0].evidence_message_ids, [oldEvidence.id]);
});

const outcomeMessages = ['task-a', 'task-b'].map((conversation_id, index) => ({ id: randomUUID(), seq: index + 1, conversation_id,
  sender: 'human', recipient: 'pi', content: `讨论 ${conversation_id} 的独立依据`, created_at: 1700000030000 + index }));
let finishOutcome;
const outcomeRace = mount({ maturity: true, restore: { version: 1, selectedTaskId: 'task-a', drafts: [] },
  initialState: { ...structuredClone(baseState), messages: outcomeMessages, outcomes: [] },
  outcomeGate: () => new Promise(resolve => { finishOutcome = resolve; }) });
await outcomeRace.settle(); outcomeRace.ids.get('show-outcomes').click(); await outcomeRace.settle();
outcomeRace.ids.get('outcome-title').value = 'A 的明确提议'; outcomeRace.ids.get('outcome-content').value = 'A 的提议正文';
outcomeRace.ids.get('outcome-evidence').querySelectorAll('input')[0].checked = true;
outcomeRace.ids.get('outcome-form').requestSubmit(); await outcomeRace.settle();
outcomeRace.ids.get('outcomes-dialog').close(); outcomeRace.evaluate("choose('task-b')"); await outcomeRace.settle();
outcomeRace.ids.get('show-outcomes').click(); await outcomeRace.settle();
outcomeRace.ids.get('outcome-title').value = 'B 尚未提交的提议'; outcomeRace.ids.get('outcome-content').value = 'B 需要保留的草稿正文';
finishOutcome(); await outcomeRace.settle();
check('v0.4 an outcome saved in A cannot clear the later B dialog draft', () => {
  assert.equal(outcomeRace.ids.get('task-title').textContent, '桌面验证');
  assert.equal(outcomeRace.ids.get('outcomes-dialog').open, true);
  assert.equal(outcomeRace.ids.get('outcome-title').value, 'B 尚未提交的提议');
  assert.equal(outcomeRace.ids.get('outcome-content').value, 'B 需要保留的草稿正文');
  assert.equal(outcomeRace.requests.length, 1);
  assert.equal(outcomeRace.requests[0].path, '/api/conversations/task-a/outcomes');
  assert.deepEqual(outcomeRace.requests[0].data.evidenceMessageIds, [outcomeMessages[0].id]);
  assert.equal(outcomeRace.currentState.outcomes[0].conversation_id, 'task-a');
});

let outcomeResponseCount = 0, releaseOutcomeResponse;
const outcomeRetry = mount({ maturity: true, restore: { version: 1, selectedTaskId: 'task-a', drafts: [] },
  initialState: { ...structuredClone(baseState), messages: outcomeMessages, outcomes: [] },
  outcomeResponseGate: async () => {
    outcomeResponseCount++;
    if ([1, 3].includes(outcomeResponseCount)) throw new Error('提议已提交，但响应丢失');
    if (outcomeResponseCount === 5) await new Promise(resolve => { releaseOutcomeResponse = resolve; });
  } });
await outcomeRetry.settle(); outcomeRetry.ids.get('show-outcomes').click(); await outcomeRetry.settle();
const fillOutcomeRetry = (title, content) => {
  outcomeRetry.ids.get('outcome-title').value = title; outcomeRetry.ids.get('outcome-content').value = content;
  outcomeRetry.ids.get('outcome-evidence').querySelectorAll('input')[0].checked = true;
};
fillOutcomeRetry('可重试的提议', '同一份提交正文');
await outcomeRetry.ids.get('outcome-form').requestSubmit(); await outcomeRetry.settle();
const failedOutcomeDraft = outcomeRetry.ids.get('outcome-content').value;
await outcomeRetry.ids.get('outcome-form').requestSubmit(); await outcomeRetry.settle();
const outcomesAfterRetry = structuredClone(outcomeRetry.currentState.outcomes);
fillOutcomeRetry('另一份提议', '修改前的正文');
await outcomeRetry.ids.get('outcome-form').requestSubmit(); await outcomeRetry.settle();
outcomeRetry.ids.get('outcome-content').value = '响应丢失后改过的正文';
await outcomeRetry.ids.get('outcome-form').requestSubmit(); await outcomeRetry.settle();
const changedOutcomeError = outcomeRetry.ids.get('outcome-error').textContent;
fillOutcomeRetry('稍后返回的提议', '保留该次已提交正文');
outcomeRetry.ids.get('outcome-form').requestSubmit(); await outcomeRetry.settle();
outcomeRetry.ids.get('outcomes-dialog').close(); await outcomeRetry.settle();
outcomeRetry.ids.get('show-outcomes').click(); await outcomeRetry.settle();
fillOutcomeRetry('同一讨论的新草稿', '旧提交完成后也必须保留');
releaseOutcomeResponse(); await outcomeRetry.settle();
check('v0.4 committed outcome retries reuse their key, changed payloads get a new key, and stale returns preserve reopened drafts', () => {
  assert.equal(failedOutcomeDraft, '同一份提交正文');
  assert.equal(outcomeRetry.requests[0].data.clientKey, outcomeRetry.requests[1].data.clientKey);
  assert.equal(outcomesAfterRetry.length, 1);
  assert.equal(outcomesAfterRetry[0].content, '同一份提交正文');
  assert.notEqual(outcomeRetry.requests[2].data.clientKey, outcomeRetry.requests[3].data.clientKey);
  assert.equal(changedOutcomeError, '');
  assert.equal(outcomeRetry.currentState.outcomes.length, 4);
  assert.equal(outcomeRetry.currentState.outcomes[2].content, '响应丢失后改过的正文');
  assert.equal(outcomeRetry.ids.get('outcomes-dialog').open, true);
  assert.equal(outcomeRetry.ids.get('outcome-title').value, '同一讨论的新草稿');
  assert.equal(outcomeRetry.ids.get('outcome-content').value, '旧提交完成后也必须保留');
});

const removedNativeState = structuredClone(nativeState), nativeMessageId = randomUUID();
Object.assign(removedNativeState.sessions.find(member => member.conversation_id === 'task-b' && member.agent === 'pi'), { mode: 'external', binding_id: 'binding-live' });
removedNativeState.messages = [{ id: nativeMessageId, seq: 1, conversation_id: 'task-b', sender: 'human', recipient: 'pi', content: '需在原会话核对的执行', created_at: 1700000040000 }];
removedNativeState.deliveries = [{ id: randomUUID(), message_id: nativeMessageId, conversation_id: 'task-b', agent: 'pi', wake: 1, state: 'uncertain' }];
const removedNativeView = mount({ maturity: true, initialState: removedNativeState }); await removedNativeView.settle();
removedNativeView.ids.get('manage-members').click();
const nativeRow = removedNativeView.ids.get('member-list').children.find(row => byClass(row, 'maturity-row-main').children[0].textContent === 'pi');
nativeRow.children.find(element => element.tagName === 'button' && element.textContent === '移除').click(); await removedNativeView.settle();
const nativeReceipt = byClass(removedNativeView.ids.get('message-' + nativeMessageId), 'delivery-details');
descendants(nativeReceipt).find(element => element.tagName === 'button' && element.textContent === '核对原会话').click(); await removedNativeView.settle();
check('v0.4 removed native members keep the native receipt review path without resolving managed deliveries', () => {
  assert.ok(removedNativeView.currentState.sessions.find(member => member.conversation_id === 'task-b' && member.agent === 'pi').removed_at);
  assert.equal(removedNativeView.ids.get('harness-dialog').open, true);
  assert.equal(removedNativeView.currentState.deliveries[0].state, 'uncertain');
  assert.deepEqual(removedNativeView.requests, [{ path: '/api/conversations/task-b/participants/pi/remove', data: {} }]);
});

const rollingMessages = Array.from({ length: 600 }, (_, index) => ({ id: randomUUID(), seq: index + 1, conversation_id: 'task-b',
  sender: 'grok', recipient: 'pi', content: `实时公开消息 ${index + 1}`, created_at: 1700000050000 + index }));
const rollingView = mount({ maturity: true, initialState: { ...structuredClone(baseState), messages: rollingMessages.slice(0, 200) } }); await rollingView.settle();
for (const end of [400, 600]) {
  rollingView.allMessages.push(...structuredClone(rollingMessages.slice(end - 200, end)));
  rollingView.currentState.messages = structuredClone(rollingMessages.slice(end - 200, end));
  rollingView.currentState.messageCounts = [{ conversation_id: 'task-b', count: end }];
  await rollingView.evaluate('refresh()'); await rollingView.settle();
}
check('v0.4 compact snapshot rollover preserves every already-seen message and the current draft', () => {
  assert.equal(rollingView.ids.get('timeline').children.length, 600);
  assert.deepEqual(rollingView.ids.get('timeline').children.map(article => article.id), rollingMessages.map(message => 'message-' + message.id));
  assert.equal(rollingView.ids.get('message').value, saved.drafts[0].content);
  assert.equal(rollingView.requests.length, 0);
});

// Exercise renderer-to-preload event identity, not macOS notification delivery.
const notificationConversationId = randomUUID(), attentionStatuses = ['waiting_user', 'offline', 'error'];
const notificationState = { ...structuredClone(baseState),
  conversations: [{ id: notificationConversationId, title: 'PRIVATE_DISCUSSION_TITLE', status: 'active', used_runs: 0 }],
  sessions: attentionStatuses.map((status, index) => ({ conversation_id: notificationConversationId, agent: `participant-${index}`, harness: 'pi',
    label: `PRIVATE_MEMBER_LABEL_${index}`, mode: 'external', binding_id: `binding-${index}`, status })),
};
const notificationRestore = { version: 1, selectedTaskId: notificationConversationId, drafts: [] };
const recurrenceEvents = [], recurrenceCounts = [];
const recurringAttention = mount({ maturity: true, initialState: notificationState, restore: notificationRestore, desktopOverrides: {
  notificationSettings: async () => ({ enabled: true, supported: true }),
  notifyActionable: async event => { recurrenceEvents.push(structuredClone(event)); return { status: 'shown' }; },
} });
await recurringAttention.settle(); recurrenceCounts.push(recurrenceEvents.length);
await recurringAttention.evaluate('refresh()'); recurringAttention.ids.get('show-attention').click(); await recurringAttention.settle(); recurrenceCounts.push(recurrenceEvents.length);
for (let cycle = 0; cycle < 2; cycle++) {
  for (const member of recurringAttention.currentState.sessions) member.status = 'idle';
  await recurringAttention.evaluate('refresh()'); await recurringAttention.settle();
  recurringAttention.currentState.sessions.forEach((member, index) => { member.status = attentionStatuses[index]; });
  await recurringAttention.evaluate('refresh()'); await recurringAttention.settle(); recurrenceCounts.push(recurrenceEvents.length);
  await recurringAttention.evaluate('refresh()'); recurringAttention.ids.get('show-attention').click(); await recurringAttention.settle(); recurrenceCounts.push(recurrenceEvents.length);
}
check('v0.4 initial attention stays silent while each post-recovery occurrence notifies exactly once with metadata only', () => {
  assert.deepEqual(recurrenceCounts, [0, 0, 3, 3, 6, 6]);
  assert.equal(new Set(recurrenceEvents.map(event => event.id)).size, 6);
  assert.deepEqual(recurrenceEvents.map(event => event.kind), ['human_input', 'failed', 'failed', 'human_input', 'failed', 'failed']);
  for (const event of recurrenceEvents) {
    assert.deepEqual(Object.keys(event).sort(), ['conversationId', 'id', 'kind']);
    assert.match(event.id, /^attention:[a-f0-9-]{36}$/); assert.ok(event.id.length <= 160);
    assert.equal(event.conversationId, notificationConversationId);
    assert.doesNotMatch(JSON.stringify(event), /PRIVATE_DISCUSSION_TITLE|PRIVATE_MEMBER_LABEL/);
  }
  assert.equal(recurringAttention.requests.length, 0);
});

const policyEvents = [], policyCounts = [], notificationPolicy = { enabled: false, foreground: false };
const policyState = structuredClone(notificationState); policyState.sessions = [{ ...policyState.sessions[0], status: 'idle' }];
const policyAttention = mount({ maturity: true, initialState: policyState, restore: notificationRestore, desktopOverrides: {
  notificationSettings: async () => ({ enabled: notificationPolicy.enabled, supported: true }),
  setNotificationsEnabled: async enabled => { notificationPolicy.enabled = enabled; return { enabled, supported: true }; },
  notifyActionable: async event => {
    const status = !notificationPolicy.enabled ? 'disabled' : notificationPolicy.foreground ? 'foreground' : 'shown';
    policyEvents.push({ ...structuredClone(event), status }); return { status };
  },
} });
await policyAttention.settle(); const notificationDefault = policyAttention.ids.get('system-notifications').checked;
const updateAttentionStatus = async status => {
  policyAttention.currentState.sessions[0].status = status;
  await policyAttention.evaluate('refresh()'); await policyAttention.settle();
};
await updateAttentionStatus('waiting_user'); policyCounts.push(policyEvents.length);
policyAttention.ids.get('system-notifications').checked = true;
await policyAttention.ids.get('system-notifications').onchange(); await updateAttentionStatus('waiting_user'); policyCounts.push(policyEvents.length);
await updateAttentionStatus('idle'); notificationPolicy.foreground = true;
await updateAttentionStatus('waiting_user'); policyCounts.push(policyEvents.length);
notificationPolicy.foreground = false; await updateAttentionStatus('waiting_user'); policyCounts.push(policyEvents.length);
await updateAttentionStatus('idle'); await updateAttentionStatus('waiting_user'); policyCounts.push(policyEvents.length);
check('v0.4 enabling notifications or backgrounding does not replay observed attention but a new occurrence reaches IPC', () => {
  assert.equal(notificationDefault, false);
  assert.deepEqual(policyCounts, [1, 1, 2, 2, 3]);
  assert.deepEqual(policyEvents.map(event => event.status), ['disabled', 'foreground', 'shown']);
  assert.equal(new Set(policyEvents.map(event => event.id)).size, 3);
  assert.equal(policyAttention.requests.length, 0);
});

const notificationTestTargets = []; let releaseNotificationTest;
const notificationTestView = mount({ maturity: true, initialState: policyState, restore: notificationRestore, desktopOverrides: {
  notificationSettings: async () => ({ enabled: false, supported: true }),
  setNotificationsEnabled: async () => { throw new Error('A one-time test must not change the notification preference'); },
  testNotification: async conversationId => {
    notificationTestTargets.push(conversationId);
    if (notificationTestTargets.length === 1) return await new Promise(resolve => { releaseNotificationTest = resolve; });
    return { status: notificationTestTargets.length === 2 ? 'failed' : 'shown' };
  },
} });
await notificationTestView.settle(); notificationTestView.ids.get('show-attention').click();
const notificationTestButton = notificationTestView.ids.get('test-notification');
const firstNotificationTest = notificationTestButton.onclick();
const testButtonPending = notificationTestButton.disabled;
await notificationTestButton.onclick();
const notificationTestsWhilePending = notificationTestTargets.length;
releaseNotificationTest({ status: 'submitted' }); await firstNotificationTest;
const submittedNotificationText = notificationTestView.ids.get('notification-test-status').textContent;
await notificationTestButton.onclick();
const failedNotificationText = notificationTestView.ids.get('notification-test-status').textContent;
await notificationTestButton.onclick();
check('v0.4 one-time notification tests keep preferences and discussions intact and distinguish system feedback', () => {
  assert.equal(testButtonPending, true); assert.equal(notificationTestsWhilePending, 1);
  assert.match(submittedNotificationText, /尚未收到显示确认/);
  assert.match(failedNotificationText, /系统未能显示/);
  assert.match(notificationTestView.ids.get('notification-test-status').textContent, /系统已返回显示回执/);
  assert.deepEqual(notificationTestTargets, [notificationConversationId, notificationConversationId, notificationConversationId]);
  assert.equal(notificationTestView.ids.get('system-notifications').checked, false);
  assert.equal(notificationTestButton.disabled, false);
  assert.equal(notificationTestView.requests.length, 0);
});

let releaseNotificationBoot, openNotificationTarget;
const notificationBootGate = new Promise(resolve => { releaseNotificationBoot = resolve; });
const notificationBootView = mount({ maturity: true, loadGate: notificationBootGate, desktopOverrides: {
  onOpenConversation: callback => { openNotificationTarget = callback; },
} });
const notificationNavigation = openNotificationTarget('task-a');
await notificationBootView.settle();
const readsBeforeNotificationRestore = notificationBootView.readRequests.length;
releaseNotificationBoot(); await notificationNavigation; await notificationBootView.settle();
check('v0.4 notification navigation waits for startup restore and preserves the other discussion draft', () => {
  assert.equal(readsBeforeNotificationRestore, 0);
  assert.equal(notificationBootView.ids.get('task-title').textContent, '第一场协作');
  assert.equal(notificationBootView.evaluate("draftFor('task-b').content"), saved.drafts[0].content);
  assert.equal(notificationBootView.requests.length, 0);
});
// Daily-use audit: only the submission races and blocked first-run path.
let releaseCreate;
const createRace = mount({ createGate: () => new Promise(resolve => { releaseCreate = resolve; }) });
await createRace.settle(); createRace.callbacks.new(); createRace.ids.get('new-title').value = '已提交的讨论';
createRace.ids.get('create-form').requestSubmit(); await createRace.settle();
createRace.ids.get('cancel-create').click(); createRace.evaluate("choose('task-a')"); createRace.callbacks.new();
createRace.ids.get('new-title').value = '后来填写的讨论'; releaseCreate(); await createRace.settle();
check('audit a late create preserves reopened form content and the current discussion', () => {
  assert.equal(createRace.requests.length, 1);
  assert.equal(createRace.requests[0].data.title, '已提交的讨论');
  assert.equal(createRace.ids.get('task-title').textContent, '第一场协作');
  assert.equal(createRace.ids.get('create-dialog').open, true);
  assert.equal(createRace.ids.get('new-title').value, '后来填写的讨论');
  assert.equal(createRace.ids.get('create-submit').disabled, false);
  assert.match(createRace.ids.get('toast').textContent, /已创建.*已提交的讨论.*保留/);
});

let releaseResume, resumeAttempts = 0;
const resumeRace = mount({ controlGate: async () => {
  resumeAttempts++;
  if (resumeAttempts === 1) await new Promise(resolve => { releaseResume = resolve; });
  if (resumeAttempts === 2) throw new Error('暂时无法继续，请重试');
} });
await resumeRace.settle(); resumeRace.ids.get('resume').click();
resumeRace.ids.get('resume-form').requestSubmit(); resumeRace.ids.get('resume-form').requestSubmit(); await resumeRace.settle();
const resumeLocked = resumeRace.ids.get('resume-submit').disabled;
resumeRace.ids.get('cancel-resume').click(); resumeRace.evaluate("choose('task-a')"); resumeRace.ids.get('resume').click();
releaseResume(); await resumeRace.settle();
const newerResumeOpen = resumeRace.ids.get('resume-dialog').open;
await resumeRace.ids.get('resume-form').requestSubmit(); await resumeRace.settle();
const resumeFailure = resumeRace.ids.get('resume-error').textContent;
await resumeRace.ids.get('resume-form').requestSubmit(); await resumeRace.settle();
check('audit resume coalesces repeated submits, scopes late completion, and exposes retryable errors', () => {
  assert.equal(resumeLocked, true);
  assert.equal(newerResumeOpen, true);
  assert.equal(resumeRace.requests.filter(request => request.path.includes('task-b')).length, 1);
  assert.equal(resumeRace.requests.length, 3);
  assert.match(resumeFailure, /暂时无法继续/);
  assert.equal(resumeRace.requests[2].data.additionalRuns, 4);
  assert.equal(resumeRace.ids.get('resume-dialog').open, false);
  assert.equal(resumeRace.ids.get('resume-submit').disabled, false);
});

const firstRun = mount({ initialState: inventoryState(installationReport({ embeddedPi: true }), { error: '尚未配置模型', models: [] }) });
await firstRun.settle(); firstRun.callbacks.new(); firstRun.ids.get('new-title').value = '先保留这个主题';
const blockedCreation = firstRun.ids.get('create-submit').disabled;
const blockedExplanation = firstRun.ids.get('creation-availability').textContent;
firstRun.ids.get('creation-diagnostics').click(); await firstRun.settle();
const diagnosticShown = firstRun.ids.get('harness-dialog').open;
firstRun.callbacks.new();
check('audit unavailable creation explains its prerequisite and opens read-only diagnostics without losing the draft', () => {
  assert.equal(blockedCreation, true);
  assert.match(blockedExplanation, /Grok 模型配置/);
  assert.equal(firstRun.ids.get('creation-diagnostics').hidden, false);
  assert.equal(diagnosticShown, true);
  assert.ok(firstRun.readRequests.some(request => request.path === '/api/diagnostics'));
  assert.equal(firstRun.ids.get('new-title').value, '先保留这个主题');
  assert.equal(firstRun.requests.length, 0);
});
const modalNavigation = mount({ maturity: true }); await modalNavigation.settle();
modalNavigation.ids.get('show-outcomes').click(); await modalNavigation.settle(); modalNavigation.callbacks.new();
const soleCreationDialog = modalNavigation.document.querySelectorAll('dialog[open]').map(dialog => dialog.id);
modalNavigation.ids.get('manage-members').click(); modalNavigation.key({ key: 'k', metaKey: true, preventDefault() {} });
const searchFocused = modalNavigation.active === 'task-search' && !modalNavigation.document.querySelectorAll('dialog[open]').length;
modalNavigation.ids.get('show-input-budget').click(); modalNavigation.callbacks.focus();
check('audit desktop shortcuts dismiss every feature dialog before moving focus', () => {
  assert.deepEqual(soleCreationDialog, ['create-dialog']);
  assert.equal(searchFocused, true);
  assert.equal(modalNavigation.document.querySelectorAll('dialog[open]').length, 0);
  assert.equal(modalNavigation.active, 'message');
  assert.equal(modalNavigation.ids.get('message').value, saved.drafts[0].content);
  assert.equal(modalNavigation.requests.length, 0);
});
// Ambiguous local responses reuse an operation key; edited intent starts a new one.
let createResponses = 0;
const createRetry = mount({ createResponseGate: () => { if ([1, 3].includes(++createResponses)) throw new Error('讨论已创建，但响应丢失'); } });
await createRetry.settle(); createRetry.callbacks.new(); createRetry.ids.get('new-title').value = '同一创建请求';
await createRetry.ids.get('create-form').requestSubmit(); createRetry.ids.get('cancel-create').click(); createRetry.callbacks.new();
await createRetry.ids.get('create-form').requestSubmit(); await createRetry.settle();
const countAfterCreateRetry = createRetry.currentState.conversations.length;
createRetry.callbacks.new(); createRetry.ids.get('new-title').value = '同一创建请求'; await createRetry.ids.get('create-form').requestSubmit();
createRetry.ids.get('new-title').value = '修改后的创建请求'; await createRetry.ids.get('create-form').requestSubmit(); await createRetry.settle();
check('audit create retries reuse unresolved keys across dialog reopen, and success or editing creates fresh intent', () => {
  assert.equal(createRetry.requests[0].data.clientKey, createRetry.requests[1].data.clientKey);
  assert.equal(countAfterCreateRetry, baseState.conversations.length + 1);
  assert.notEqual(createRetry.requests[1].data.clientKey, createRetry.requests[2].data.clientKey);
  assert.notEqual(createRetry.requests[2].data.clientKey, createRetry.requests[3].data.clientKey);
  assert.equal(createRetry.currentState.conversations.length, baseState.conversations.length + 3);
  assert.equal(createRetry.ids.get('task-title').textContent, '修改后的创建请求');
  assert.equal(createRetry.ids.get('create-error').hidden, true);
});

let resumeResponses = 0, committedRuns = 0;
const resumeRetry = mount({ controlResponseGate: ({ data, committed }) => {
  if (committed) committedRuns += data.additionalRuns || 0;
  if ([1, 3].includes(++resumeResponses)) throw new Error('继续请求已提交，但响应丢失');
} });
await resumeRetry.settle(); resumeRetry.ids.get('resume').click();
resumeRetry.ids.get('extra-runs').value = '7'; resumeRetry.ids.get('extra-minutes').value = '35';
await resumeRetry.ids.get('resume-form').requestSubmit(); resumeRetry.ids.get('cancel-resume').click(); resumeRetry.ids.get('resume').click();
const pendingRuns = resumeRetry.ids.get('extra-runs').value, pendingMinutes = resumeRetry.ids.get('extra-minutes').value;
await resumeRetry.ids.get('resume-form').requestSubmit(); resumeRetry.ids.get('resume').click();
resumeRetry.ids.get('extra-runs').value = '7'; resumeRetry.ids.get('extra-minutes').value = '35';
await resumeRetry.ids.get('resume-form').requestSubmit(); resumeRetry.ids.get('extra-runs').value = '9';
await resumeRetry.ids.get('resume-form').requestSubmit(); await resumeRetry.settle();
check('audit resume retries preserve unresolved limits and key while changed or successful intent gets a new key', () => {
  assert.equal(pendingRuns, '7'); assert.equal(pendingMinutes, '35');
  assert.equal(resumeRetry.requests[0].data.clientKey, resumeRetry.requests[1].data.clientKey);
  assert.notEqual(resumeRetry.requests[1].data.clientKey, resumeRetry.requests[2].data.clientKey);
  assert.notEqual(resumeRetry.requests[2].data.clientKey, resumeRetry.requests[3].data.clientKey);
  assert.equal(committedRuns, 23);
  assert.equal(resumeRetry.ids.get('resume-dialog').open, false);
});

let bootRestores = 0, pairAttempts = 0, stateAttempts = 0;
const pairTokens = [];
const bootRetry = mount({ initialHash: '#token=fixture-owner-token',
  desktopOverrides: { loadUiState: async () => { bootRestores++; return structuredClone(saved); } },
  pairGate: ({ token }) => { pairTokens.push(token); if (++pairAttempts === 1) throw new Error('临时配对失败'); },
  stateGate: () => { if (++stateAttempts === 1) throw new Error('临时读取失败'); },
});
await bootRetry.settle();
const pairingRetryVisible = !bootRetry.ids.get('retry-connection').hidden && /临时配对失败/.test(bootRetry.ids.get('notice').textContent);
bootRetry.ids.get('retry-connection').click(); bootRetry.ids.get('retry-connection').click(); await bootRetry.settle();
const stateRetryVisible = !bootRetry.ids.get('retry-connection').hidden && /临时读取失败/.test(bootRetry.ids.get('notice').textContent);
bootRetry.ids.get('retry-connection').click(); await bootRetry.settle();
bootRetry.ids.get('message').value = '恢复连接后编辑的草稿'; bootRetry.ids.get('message').oninput(); bootRetry.evaluate("choose('task-a')");
await bootRetry.evaluate('Promise.all([boot(), boot()])'); await bootRetry.settle();
check('audit startup retry recovers pairing and state, restoring drafts once and keeping a single event stream', () => {
  assert.equal(pairingRetryVisible, true); assert.equal(stateRetryVisible, true);
  assert.deepEqual(pairTokens, ['Bearer fixture-owner-token', 'Bearer fixture-owner-token']);
  assert.equal(bootRetry.evaluate('location.hash'), '');
  assert.equal(bootRestores, 1); assert.equal(stateAttempts, 3); assert.equal(bootRetry.streams.length, 1);
  assert.equal(bootRetry.ids.get('retry-connection').hidden, true);
  assert.equal(bootRetry.ids.get('connection').dataset.state, 'connected');
  assert.equal(bootRetry.ids.get('task-title').textContent, '第一场协作');
  assert.equal(bootRetry.evaluate("draftFor('task-b').content"), '恢复连接后编辑的草稿');
  assert.equal(bootRetry.requests.length, 0);
});
console.log(`PASS ${checks} desktop and browser UI simulations`);
