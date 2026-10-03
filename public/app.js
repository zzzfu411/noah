const $ = id => document.getElementById(id);
const names = { grok: 'Grok', pi: 'pi', human: '你', all: '全部参与者' };
const harnessAssets = { grok: 'grok.svg', pi: 'pi.svg', codex: 'codex.png', claude: 'claude.png', gemini: 'gemini.png', opencode: 'opencode.svg' };
const labels = { offline: '未启动', starting: '正在连接', idle: '等待消息', running: '正在思考', busy: '原会话工作中', waiting_user: '原会话等待你', paused: '连接已暂停', error: '需要处理', queued: '已保存，等待处理', dispatching: '正在投递', context_accepted: '会话已接收', completed: '本次处理完成', failed: '处理失败', uncertain: '执行结果待核对', cancelled: '已取消' };
const deliveryLabels = { queued: '待处理', dispatching: '投递中', context_accepted: '会话接口已接收', completed: '本次处理完成', failed: '处理失败', uncertain: '结果待核对', cancelled: '已停止', transcript_observed: '原会话已观察到正文', fetched: '已返回全文片段', agent_reported: 'Agent 已报告处理', monitor_notified: '已通知监视器，待原会话领取正文' };
const desktop = window.noahDesktop;
const isMac = desktop ? desktop.platform === 'darwin' : /Mac|iPhone|iPad/.test(navigator.platform || '');
let state, selected, refreshTimer, refreshPromise, refreshRequested = false;
let creating = false, createGeneration = 0, resumeGeneration = 0, creationSubmission;
const resuming = new Set();
const resumeSubmissions = new Map();
let newMembers = [], bridgeSetup, historyLoading = false, searchGeneration = 0;
const messageHistory = new Map();
const deliveryHistory = new Map();
const historyStatus = new Map();
try { selected = localStorage.getItem('noah-task'); } catch { /* The desktop bridge also retains the selection. */ }
let timelineVersion = '', taskVersion = '', modelVersion = '', discoveryVersion = '', connectionError = '', bootFailure = '', uiStateError = '', uiSaveWarning = '', resumeTaskId;
const openDetails = new Set();
const drafts = new Map();
const sending = new Map();
let uiSaveTimer, uiWritePromise, uiWriteRequested = false;
let uiStateLoaded = typeof desktop?.loadUiState !== 'function';
const maxUiStateBytes = 1_800_000;
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const themes = ['system', 'light', 'dark'];
const themeNames = { system: '跟随系统', light: '浅色', dark: '深色' };
let theme = 'system', themeChosen = false, toastTimer;
try { const savedTheme = localStorage.getItem('noah-theme'); if (themes.includes(savedTheme)) theme = savedTheme; } catch { /* Follow the system when browser storage is unavailable. */ }

function applyTheme() {
  document.documentElement.dataset.theme = theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : theme;
  const nextTheme = themes[(themes.indexOf(theme) + 1) % themes.length];
  const label = `外观：${themeNames[theme]}，点击切换${themeNames[nextTheme]}`;
  $('theme-toggle').dataset.preference = theme;
  $('theme-toggle').setAttribute('aria-label', label);
  $('theme-toggle').title = label;
}
$('theme-toggle').onclick = () => {
  themeChosen = true;
  theme = themes[(themes.indexOf(theme) + 1) % themes.length];
  try { localStorage.setItem('noah-theme', theme); } catch { /* The selected appearance still applies to this window. */ }
  applyTheme(); scheduleUiSave();
};
systemTheme.addEventListener('change', () => { if (theme === 'system') applyTheme(); });
applyTheme();

if (desktop) {
  document.documentElement.classList.add('desktop-app');
  if (isMac) document.documentElement.classList.add('desktop-macos');
  $('new-task-shortcut').textContent = isMac ? '⌘ N' : 'Ctrl N';
  $('new-task').title = isMac ? '新建讨论（⌘N）' : '新建讨论（Ctrl+N）';
}
$('send-shortcut').textContent = isMac ? '⌘ Enter 发送' : 'Ctrl Enter 发送';
$('message').setAttribute('aria-keyshortcuts', isMac ? 'Meta+Enter' : 'Control+Enter');
$('message').title = 'Enter 换行，' + (isMac ? '⌘ Enter' : 'Ctrl Enter') + '发送';
$('task-search').setAttribute('aria-keyshortcuts', isMac ? 'Meta+K' : 'Control+K');
$('task-search').title = '搜索任务（' + (isMac ? '⌘K' : 'Ctrl+K') + '）';

function messageData(draft) {
  return { recipient: draft.recipient, content: draft.content, ...(draft.replyTo ? { inReplyTo: draft.replyTo.id } : {}) };
}
function uiSnapshot() {
  const snapshot = { version: 1, selectedTaskId: selected || null, appearance: theme, drafts: [] };
  const candidates = [...drafts].filter(([, draft]) => draft.content || draft.replyTo || draft.pendingSend)
    .sort(([a, left], [b, right]) => a === selected ? -1 : b === selected ? 1 : (right.updatedAt || 0) - (left.updatedAt || 0));
  let omitted = candidates.length > 100;
  for (const [conversationId, draft] of candidates.slice(0, 100)) {
    const saved = { conversationId, content: draft.content, recipient: draft.recipient, updatedAt: draft.updatedAt || 0 };
    if (draft.replyTo) saved.replyTo = { id: draft.replyTo.id, sender: draft.replyTo.sender };
    if (draft.pendingSend?.signature === JSON.stringify(messageData(draft))) saved.pendingSend = { key: draft.pendingSend.key };
    snapshot.drafts.push(saved);
    if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > maxUiStateBytes) { snapshot.drafts.pop(); omitted = true; }
  }
  uiSaveWarning = omitted ? '草稿较多，关闭后仅恢复最近保存的草稿。请先发送或保留仍需使用的旧草稿。' : '';
  return snapshot;
}
function scheduleUiSave() {
  if (typeof desktop?.saveUiState !== 'function') return;
  uiWriteRequested = true;
  if (!uiSaveTimer && !uiWritePromise) uiSaveTimer = setTimeout(() => { uiSaveTimer = undefined; void persistUiState(); }, 250);
}
function persistUiState() {
  if (uiSaveTimer) { clearTimeout(uiSaveTimer); uiSaveTimer = undefined; }
  if (typeof desktop?.saveUiState !== 'function' || !uiStateLoaded) return Promise.resolve();
  uiWriteRequested = true;
  if (uiWritePromise) return uiWritePromise;
  uiWritePromise = (async () => {
    do {
      uiWriteRequested = false;
      try { await desktop.saveUiState(uiSnapshot()); uiStateError = ''; }
      catch { uiStateError = '草稿暂未保存，关闭应用前请保留消息内容。'; }
      renderNotice();
    } while (uiWriteRequested);
  })().finally(() => { uiWritePromise = undefined; });
  return uiWritePromise;
}
async function restoreUiState() {
  if (typeof desktop?.loadUiState !== 'function') return;
  try {
    const saved = await desktop.loadUiState();
    const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 200;
    if (saved?.version === 1) {
      if (!themeChosen && themes.includes(saved.appearance)) {
        theme = saved.appearance;
        try { localStorage.setItem('noah-theme', theme); } catch { /* The native state remains the durable source. */ }
        applyTheme();
      }
      if (validId(saved.selectedTaskId)) selected = saved.selectedTaskId;
      if (Array.isArray(saved.drafts)) {
        for (const entry of saved.drafts.slice(0, 100)) {
          if (!entry || !validId(entry.conversationId) || typeof entry.content !== 'string' || entry.content.length > 64000 || !validRecipient(entry.recipient)) continue;
          const draft = draftFor(entry.conversationId);
          draft.content = entry.content; draft.recipient = entry.recipient;
          draft.updatedAt = Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0;
          if (validId(entry.replyTo?.id) && validRecipient(entry.replyTo.sender)) draft.replyTo = { id: entry.replyTo.id, sender: entry.replyTo.sender };
          if (validId(entry.pendingSend?.key)) draft.pendingSend = { key: entry.pendingSend.key, signature: JSON.stringify(messageData(draft)) };
        }
      }
    }
  } catch { uiStateError = '暂时无法恢复草稿，你仍可以查看对话和发送消息。'; }
  finally { uiStateLoaded = true; if (uiWriteRequested) scheduleUiSave(); }
}

function node(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function harnessAvatar(id) {
  const avatar = node('span', 'avatar ' + id);
  avatar.setAttribute('aria-hidden', 'true');
  if (!Object.hasOwn(harnessAssets, id)) return avatar;
  const logo = node('img', 'harness-logo');
  logo.src = '/assets/harnesses/' + harnessAssets[id]; logo.alt = ''; logo.dataset.harness = id;
  avatar.append(logo);
  if (id === 'opencode') {
    logo.classList.add('logo-light');
    const dark = node('img', 'harness-logo logo-dark');
    dark.src = '/assets/harnesses/opencode-dark.svg'; dark.alt = ''; avatar.append(dark);
  }
  return avatar;
}
function validRecipient(value) { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value) && value !== 'human'; }
function members(id = selected, includeRemoved = false) { return (state?.sessions || []).filter(member => member.conversation_id === id && (includeRemoved || !member.removed_at)); }
function memberName(id, conversationId = selected) { return members(conversationId, true).find(member => member.agent === id)?.label || names[id] || id; }
function memberHarness(id, conversationId = selected) { return members(conversationId, true).find(member => member.agent === id)?.harness || id; }
function sharedMessages(id = selected) {
  const merged = new Map((messageHistory.get(id) || []).map(message => [message.id, message]));
  for (const message of state?.messages || []) if (message.conversation_id === id) merged.set(message.id, message);
  return [...merged.values()].sort((a, b) => a.seq - b.seq);
}
async function loadHistory(id = selected, options = {}) {
  if (!id) return;
  historyLoading = true; $('load-older').disabled = true;
  try {
    const query = new URLSearchParams({ limit: '200', ...options });
    const page = await api(`/api/conversations/${id}/messages?${query}`);
    const merged = new Map(sharedMessages(id).map(message => [message.id, message]));
    for (const message of page.messages) merged.set(message.id, message);
    messageHistory.set(id, [...merged.values()].sort((a, b) => a.seq - b.seq));
    const receipts = new Map((deliveryHistory.get(id) || []).map(d => [d.id, d]));
    for (let start = 0; start < page.messages.length; start += 100) {
      const ids = page.messages.slice(start, start + 100).map(m => m.id).join(',');
      const batch = await api(`/api/conversations/${id}/deliveries?messageIds=${encodeURIComponent(ids)}`);
      for (const d of batch.deliveries || []) receipts.set(d.id, d);
    }
    deliveryHistory.set(id, [...receipts.values()]);
    historyStatus.set(id, { ...historyStatus.get(id), total: page.total, error: '', ...(!options.around ? { nextBefore: page.before, hasOlder: page.hasOlder } : {}) }); timelineVersion = '';
  } catch (error) { historyStatus.set(id, { ...historyStatus.get(id), error: '旧消息暂时无法加载，请重试。' }); }
  finally { historyLoading = false; $('load-older').disabled = false; if (selected === id) render(); }
}
function renderHistoryBar() {
  const status = historyStatus.get(selected);
  const loaded = sharedMessages().length;
  const count = state?.messageCounts?.find(row => row.conversation_id === selected)?.count ?? status?.total ?? loaded;
  $('history-bar').hidden = !selected || (loaded >= count && !status?.error);
  $('history-status').textContent = status?.error || `已显示 ${loaded} / ${count} 条公开消息`;
  $('load-older').disabled = historyLoading;
}
function notice(text) { $('notice-text').textContent = text || ''; $('notice').hidden = !text; }
function toast(text) {
  if (toastTimer) clearTimeout(toastTimer);
  $('toast').textContent = text; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; toastTimer = undefined; }, 4000);
}
function closeOpenDialogs(exceptId) {
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    if (dialog.id === exceptId) continue;
    if (dialog.id === 'search-dialog') searchGeneration++;
    if (dialog.id === 'material-dialog') materialGeneration++;
    dialog.close();
  }
}
function connection(status) {
  $('connection').dataset.state = status;
  $('connection').textContent = { connected: '已连接', reconnecting: '重新连接中', offline: '未连接' }[status];
}
function draftFor(id) {
  if (!drafts.has(id)) drafts.set(id, { content: '', recipient: 'all', replyTo: undefined, revision: 0, pendingSend: undefined, error: '', updatedAt: 0 });
  return drafts.get(id);
}
function captureDraft() {
  if (!selected) return;
  const draft = draftFor(selected);
  const content = $('message').value, recipient = $('recipient').value;
  if (draft.content !== content || draft.recipient !== recipient) {
    draft.content = content; draft.recipient = recipient; draft.revision++; draft.updatedAt = Date.now(); scheduleUiSave();
  }
}
function renderNotice() {
  const c = state?.conversations.find(c => c.id === selected);
  notice(bootFailure || connectionError || (selected && draftFor(selected).error) || uiStateError || uiSaveWarning || c?.reason || state?.config.error || '');
}
function renderComposer() {
  if (!selected) return;
  const draft = draftFor(selected);
  if ($('message').value !== draft.content) $('message').value = draft.content;
  const recipients = [{ agent: 'all', label: '全部参与者' }, ...members()];
  $('recipient').replaceChildren(...recipients.map(member => { const option = node('option', '', member.label || memberName(member.agent)); option.value = member.agent; return option; }));
  const available = recipients.some(member => member.agent === draft.recipient);
  if (!available) { const option = node('option', '', `${draft.recipient}（成员不可用）`); option.value = draft.recipient; option.disabled = true; $('recipient').append(option); }
  $('recipient').value = draft.recipient;
  const image = harnessAssets[memberHarness(draft.recipient)];
  $('recipient-logo').hidden = !image;
  if (image) $('recipient-logo').src = '/assets/harnesses/' + image;
  $('reply-label').textContent = draft.replyTo ? `回复 ${memberName(draft.replyTo.sender)} 的消息` : '';
  $('clear-reply').hidden = !draft.replyTo;
  $('send').disabled = sending.has(selected) || !draft.content.trim() || !available;
  $('send-label').textContent = sending.has(selected) ? '发送中…' : '发送';
  $('send').setAttribute('aria-label', sending.has(selected) ? '正在发送消息' : '发送消息');
  resizeComposer();
}
function resizeComposer() {
  const textarea = $('message');
  textarea.style.height = 'auto';
  const height = Math.min(180, Math.max(56, textarea.scrollHeight));
  textarea.style.height = height + 'px';
  textarea.style.overflowY = textarea.scrollHeight > 180 ? 'auto' : 'hidden';
}
function rememberSelection() {
  try {
    if (selected) localStorage.setItem('noah-task', selected);
    else localStorage.removeItem('noah-task');
  } catch { /* The native UI state remains available when browser storage is disabled. */ }
  scheduleUiSave();
}
async function api(path, data, token) {
  const response = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || '请求失败');
  return body;
}
function scheduleRefresh() {
  if (refreshPromise) { refreshRequested = true; return; }
  if (!refreshTimer) refreshTimer = setTimeout(() => { refreshTimer = undefined; void refresh(); }, 200);
}
function refresh() {
  if (refreshPromise) { refreshRequested = true; return refreshPromise; }
  if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = undefined; }
  refreshPromise = (async () => {
    do {
      refreshRequested = false;
      try {
        const nextState = await api('/api/state?compact=1'); connectionError = '';
        for (const id of messageHistory.keys()) {
          const seen = new Map(sharedMessages(id).map(m => [m.id, m]));
          for (const m of nextState.messages) if (m.conversation_id === id) seen.set(m.id, m);
          messageHistory.set(id, [...seen.values()].sort((a, b) => a.seq - b.seq));
        }
        state = nextState;
        for (const [id, previous] of deliveryHistory) { const rows = new Map(previous.map(d => [d.id, d])); for (const d of state.deliveries) if (d.conversation_id === id) rows.set(d.id, d); deliveryHistory.set(id, [...rows.values()]); }
        connection('connected'); render();
      } catch (error) {
        connection('offline'); connectionError = error.message; renderNotice();
      }
    } while (refreshRequested);
  })().finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}
function choose(id) {
  const changed = selected !== id;
  captureDraft(); selected = id; rememberSelection(); timelineVersion = ''; render(); if (changed || !messageHistory.has(id)) void loadHistory(id);
}
function taskStatus(task, sessions = members(task.id)) {
  if (task.archived_at || task.status === 'archived') return '已归档';
  if (task.status !== 'active') return '已暂停';
  if (sessions.some(session => session.status === 'waiting_user')) return '原会话等待你';
  if (sessions.some(session => session.mode === 'external' && session.status === 'offline')) return '原会话已断开';
  if (sessions.some(session => session.status === 'paused')) return '连接需要核对';
  if (sessions.some(session => session.status === 'running')) return '正在交流';
  if (sessions.some(session => session.status === 'busy')) return '原会话工作中';
  if (sessions.some(session => session.status === 'starting')) return '正在连接';
  if (sessions.some(session => session.status === 'error')) return '需要处理';
  return '等待消息';
}
function renderTasks() {
  if (!state) return;
  const query = $('task-search').value.trim().toLocaleLowerCase();
  const scope = $('task-filter')?.value || 'current';
  const visible = state.conversations.filter(task => (scope === 'all' || (scope === 'archived' ? !!task.archived_at : !task.archived_at)) && task.title.toLocaleLowerCase().includes(query));
  $('task-count').textContent = query ? `${visible.length}/${state.conversations.length}` : String(state.conversations.length);
  $('search-empty').hidden = !query || visible.length > 0;
  const version = JSON.stringify(state.conversations) + selected + query + scope + JSON.stringify(state.sessions.map(session => [session.conversation_id, session.agent, session.status, session.removed_at]));
  if (taskVersion === version) return;
  taskVersion = version; $('task-list').replaceChildren();
  visible.forEach(task => {
    const b = node('button', 'task-link' + (task.id === selected ? ' active' : ''));
    b.type = 'button'; b.title = task.title;
    if (task.id === selected) b.setAttribute('aria-current', 'page');
    b.append(node('span', 'task-link-title', task.title));
    const taskMembers = members(task.id);
    const model = taskMembers.length && taskMembers.every(s => s.mode === 'external') ? '原会话模型' : task.model_alias || state.config.alias || state.config.model;
    b.append(node('span', 'task-link-meta', taskStatus(task) + (model ? ` · ${model}` : '')));
    b.onclick = () => choose(task.id); $('task-list').append(b);
  });
}
function renderModels() {
  const config = state.config;
  $('model-label').textContent = config.error || `默认 ${config.alias || config.model} · 来自 Grok 配置`;
  const models = config.models || [];
  const version = JSON.stringify(models) + config.alias + config.error;
  if (version !== modelVersion) {
    modelVersion = version;
    const previous = $('new-model').value;
    $('new-model').replaceChildren();
    models.forEach(model => {
      const label = model.alias + (model.model !== model.alias ? `（${model.model}）` : '') + (model.alias === config.alias ? ' · 默认' : '');
      const option = node('option', '', label); option.value = model.alias; $('new-model').append(option);
    });
    $('new-model').value = models.some(model => model.alias === previous) ? previous : config.alias || models[0]?.alias || '';
    $('new-model').disabled = !models.length;
    $('model-help').textContent = config.error || (models.length ? '新建会话共用所选模型；已有会话保留原模型和工具。' : 'Grok 配置中暂无可用模型。');
  }
  $('create-submit').disabled = creating || !canCreate();
}
function ensureNewMembers() {
  if (newMembers.length || !state) return;
  const ready = ['grok', 'pi'].filter(id => !state.discovery || state.discovery.harnesses.some(h => h.id === id && h.managedCreation.supported && h.managedCreation.runtimePresent));
  newMembers = (ready.length ? ready : ['pi']).map(harness => ({ id: 'p-' + crypto.randomUUID(), source: 'managed:' + harness, label: names[harness] }));
}
function sourceOptions() {
  const options = ['grok', 'pi'].map(harness => {
    const runtime = state?.discovery?.harnesses.find(h => h.id === harness)?.managedCreation;
    return { value: 'managed:' + harness, label: `新建 ${names[harness]} 会话`, disabled: !!state?.discovery && !runtime?.runtimePresent };
  });
  for (const binding of state?.nativeSessions || []) options.push({ value: 'external:' + binding.id, label: `已有 ${names[binding.harness] || 'pi'} · ${binding.label || binding.nativeSessionId}`, disabled: !['idle', 'busy', 'waiting_user'].includes(binding.status) });
  return options;
}
function participantInput(member) {
  const [mode, id] = member.source.split(':');
  return { id: member.id, harness: mode === 'external' ? (state?.nativeSessions || []).find(binding => binding.id === id)?.harness || 'pi' : id, label: member.label.trim(), mode, ...(mode === 'external' ? { bindingId: id } : {}) };
}
function canCreate() {
  ensureNewMembers();
  if (!newMembers.length || newMembers.length > 16) return false;
  const options = sourceOptions();
  const external = newMembers.filter(member => member.source.startsWith('external:')).map(member => member.source);
  if (new Set(external).size !== external.length) return false;
  return newMembers.every(member => member.label.trim() && options.some(option => option.value === member.source && !option.disabled))
    && (!newMembers.some(member => member.source.startsWith('managed:')) || !!(state?.config.models || []).length);
}
function renderNewMembers() {
  ensureNewMembers(); $('new-participants').replaceChildren();
  for (const member of newMembers) {
    const row = node('div', 'participant-picker-row');
    row.append(harnessAvatar(participantInput(member).harness));
    const fields = node('div', 'participant-picker-fields');
    const source = node('select'); source.setAttribute('aria-label', '成员会话来源');
    const options = sourceOptions();
    if (!options.some(option => option.value === member.source)) options.push({ value: member.source, label: '原会话已断开', disabled: true });
    for (const value of options) { const option = node('option', '', value.label); option.value = value.value; option.disabled = value.disabled; source.append(option); }
    source.value = member.source;
    source.onchange = () => { member.source = source.value; member.label = participantInput(member).mode === 'external' ? (state.nativeSessions.find(b => b.id === participantInput(member).bindingId)?.label || '原 pi 会话') : names[participantInput(member).harness]; renderNewMembers(); };
    const label = node('input'); label.value = member.label; label.maxLength = 80; label.required = true; label.setAttribute('aria-label', '成员名称');
    label.oninput = () => { member.label = label.value; updateCreationState(); };
    fields.append(source, label); row.append(fields);
    const remove = node('button', 'text-button', '移除'); remove.type = 'button'; remove.disabled = newMembers.length <= 1;
    remove.onclick = () => { newMembers = newMembers.filter(value => value !== member); renderNewMembers(); };
    row.append(remove); $('new-participants').append(row);
  }
  $('add-participant').disabled = newMembers.length >= 16; updateCreationState();
}
function updateCreationState() {
  const managed = newMembers.some(member => member.source.startsWith('managed:'));
  $('new-model-label').hidden = !managed; $('new-model').required = managed; $('model-help').hidden = !managed;
  $('new-model').disabled = !managed || !(state?.config.models || []).length;
  const external = newMembers.filter(member => member.source.startsWith('external:')).length;
  const duplicate = new Set(newMembers.filter(member => member.source.startsWith('external:')).map(member => member.source)).size !== external;
  const unavailable = newMembers.some(member => !sourceOptions().some(option => option.value === member.source && !option.disabled));
  const missingConfig = managed && !(state?.config.models || []).length;
  $('creation-availability').textContent = canCreate()
    ? `${newMembers.length} 位成员${external ? `，其中 ${external} 个已有工作会话` : ''}。公开讨论完整共享，只唤醒需要处理消息的成员。`
    : !state ? '还未连接到本地工作区，正在等待配置与会话信息。'
      : duplicate ? '同一个原工作会话只能加入一次。请选择其他会话或移除重复成员。'
        : unavailable ? '所选会话暂不可用。请检查运行环境与原会话连接，或选择另一种可用会话。'
          : missingConfig ? '新建会话需要 Grok 模型配置。可检查配置位置，或选择已连接的原工作会话。'
            : '请为每位成员填写名称。';
  $('creation-diagnostics').hidden = !state || (!unavailable && !missingConfig);
  $('create-submit').disabled = creating || !canCreate();
  $('create-submit').textContent = creating ? '正在创建…' : '创建讨论';
}
function renderNativeSessions() {
  $('native-session-list').replaceChildren();
  const list = state?.nativeSessions || [];
  if (!list.length) $('native-session-list').append(node('p', 'muted', '还没有原工作会话连接到 Noah。'));
  for (const binding of list) {
    const row = node('div', 'native-session-row');
    const status = binding.harness === 'grok' && ['idle', 'busy', 'joining'].includes(binding.status) ? ({ idle: '连接可用 · 暂无通知批次', busy: '通知批次待原 Agent 处理', joining: '等待原生监视器' })[binding.status] : ({ idle: '可接收讨论', busy: '工作中', waiting_user: '等待你', offline: '原会话已断开', paused: '连接已暂停', disconnected: '已断开', expired: '连接已过期', revoked: '已撤销' })[binding.status] || binding.status;
    const info = node('div'); info.append(node('strong', '', binding.label || `${names[binding.harness] || 'pi'} 工作会话`), node('p', 'muted', `${status} · ${binding.projectDir || '未共享项目位置'}`), node('p', 'muted', binding.harness === 'grok' ? 'Grok 原生通知 · 由原 Agent 完整读取' : 'pi 原生扩展 · 正文被动追加')); row.append(info);
    const revoke = node('button', 'text-button', '断开'); revoke.type = 'button'; revoke.disabled = ['revoked', 'disconnected', 'expired'].includes(binding.status);
    revoke.onclick = () => act(() => api(`/api/native-sessions/${binding.id}/revoke`, {})); row.append(revoke); $('native-session-list').append(row);
  }
  for (const wake of state?.nativeWakes || []) {
    if (wake.state !== 'uncertain') continue;
    const row = node('div', 'native-wake-review');
    const title = state.conversations.find(c => c.id === wake.conversation_id)?.title || '原工作会话';
    row.append(node('strong', '', `${title} · 需要核对`), node('p', 'muted', '无法确认这次处理是否完成。请先查看原工作会话，解除阻塞后不会重发这批消息；仍需处理时再发送新消息。'));
    const resolve = node('button', 'text-button', '我已核对原会话'); resolve.type = 'button'; resolve.dataset.resolveNativeWake = wake.id;
    resolve.onclick = () => act(() => api(`/api/native-wakes/${wake.id}/resolve`, {})); row.append(resolve); $('native-session-list').append(row);
  }
}
function renderDiscovery() {
  const report = state?.discovery;
  if (!report) {
    $('harness-count').textContent = '待检测';
    $('creation-availability').textContent = '本次创建 Grok 与 pi 的新会话。';
    return;
  }
  const installed = report.harnesses.filter(h => h.executableInstalled).length;
  $('harness-count').textContent = `${installed} 个已检测到`;
  updateCreationState(); renderNativeSessions();
  const version = JSON.stringify(report);
  if (version === discoveryVersion) return;
  discoveryVersion = version;
  const embedded = report.harnesses.some(h => h.bundledRuntime?.present);
  $('harness-summary').textContent = `检测到 ${installed} 个本机命令行${embedded ? '，另有 Noah 内置 pi' : ''}。仅检查文件位置，不读取会话内容。`;
  $('harness-list').replaceChildren();
  for (const harness of report.harnesses) {
    const row = node('section', 'harness-row');
    row.append(harnessAvatar(harness.id));
    const heading = node('div', 'harness-row-heading');
    heading.append(node('h3', '', harness.label));
    const status = harness.executableInstalled ? '已检测到 CLI' : harness.bundledRuntime?.present ? 'Noah 内置' : harness.configPresent ? '仅发现配置' : '未检测到';
    const statusLabel = node('span', 'harness-status', status);
    statusLabel.dataset.installed = String(harness.executableInstalled || !!harness.bundledRuntime?.present);
    heading.append(statusLabel); row.append(heading);
    const support = harness.managedCreation;
    row.append(node('p', 'harness-description', !support.supported ? '当前仅支持发现'
      : !support.runtimePresent ? '新建会话还需要运行环境'
        : !support.modelConfigPresent ? '新建会话还需要 Grok 模型配置'
          : '支持在 Noah 中新建会话；连接时验证模型配置'));
    const details = node('details', 'harness-details');
    details.append(node('summary', '', '检测详情'));
    if (harness.executablePath) details.append(node('p', '', `命令位置：${harness.executablePath}`));
    if (harness.bundledRuntime?.present) details.append(node('p', '', 'pi SDK 随 Noah 提供，不代表电脑上另有 pi 命令行。'));
    if (harness.configPaths.length) details.append(node('p', '', `配置位置：${harness.configPaths.join('；')}`));
    else details.append(node('p', '', '未在已知位置发现配置文件。'));
    details.append(node('p', '', harness.liveAttach.explanation));
    row.append(details); $('harness-list').append(row);
  }
}
function render() {
  if (!state) return;
  if (!state.conversations.some(c => c.id === selected)) {
    captureDraft(); selected = state.conversations[0]?.id; rememberSelection(); timelineVersion = '';
  }
  const c = state.conversations.find(c => c.id === selected);
  const sessions = members();
  renderModels();
  renderDiscovery();
  renderTasks();
  $('task-title').textContent = c?.title || '让想法相遇';
  $('task-title').title = c?.title || '';
  if (desktop) document.title = c ? `${c.title} — Noah` : 'Noah';
  $('task-model').hidden = !c;
  $('task-model').textContent = c ? (sessions.length && sessions.every(s => s.mode === 'external') ? '沿用原会话模型' : c.model_alias || state.config.alias || state.config.model || '未配置') : '';
  $('task-status').hidden = !c;
  $('task-status').textContent = c ? taskStatus(c, sessions) : '';
  $('header-peers').hidden = !c;
  $('header-peers').replaceChildren(...sessions.slice(0, 4).map(session => harnessAvatar(session.harness || session.agent)));
  $('header-peers').setAttribute('aria-label', '参与者：' + sessions.map(s => s.label || names[s.agent] || s.agent).join('、'));
  $('participant-count').textContent = String(sessions.length);
  $('empty').hidden = !!c; $('composer').hidden = !c || !!c.archived_at; $('budget').hidden = !c;
  $('composer-region').hidden = !c;
  $('export').hidden = !c; $('pause').hidden = !c || c.status !== 'active'; $('resume').hidden = !c || !!c.archived_at || c.status === 'active';
  $('stop').hidden = !c || !sessions.some(s => s.status === 'starting' || s.status === 'running');
  if (c) $('budget').textContent = c.limits_enabled === 0
    ? (c.status === 'active' ? '自主讨论 · 按消息继续' : '自主讨论 · 已暂停')
    : `${c.status === 'active' ? '已设上限' : '已暂停'} · ${c.used_runs}/${c.max_runs} 次唤醒`;
  renderNotice(); renderComposer();
  const messages = sharedMessages();
  renderHistoryBar();
  const receiptMap = new Map((deliveryHistory.get(selected) || []).map(d => [d.id, d]));
  for (const d of state.deliveries) if (d.conversation_id === selected) receiptMap.set(d.id, d);
  const deliveries = [...receiptMap.values()];
  const version = selected + JSON.stringify(messages) + JSON.stringify(deliveries) + JSON.stringify(sessions);
  if (timelineVersion !== version) {
    timelineVersion = version;
    const scroll = $('timeline'), bottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 100;
    scroll.replaceChildren();
    if (c && !messages.length) scroll.append(node('p', 'task-welcome', '成员已选定。共享资料后，把问题发给某位成员或所有人，即可开始讨论。'));
    messages.forEach(m => {
      const article = node('article', 'message sender-' + (m.sender === 'human' ? 'human' : memberHarness(m.sender))); article.id = 'message-' + m.id; article.append(harnessAvatar(memberHarness(m.sender)));
      const body = node('div', 'message-body'), head = node('div', 'message-head');
      head.append(node('strong', '', memberName(m.sender)), node('span', 'message-recipient', m.recipient === 'human' ? '给你' : `→ ${memberName(m.recipient)}`));
      const created = new Date(m.created_at);
      if (!Number.isNaN(created.getTime())) {
        const time = node('time', '', created.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
        time.dateTime = created.toISOString(); time.title = created.toLocaleString('zh-CN'); head.append(time);
      }
      body.append(head);
      const parent = messages.find(p => p.id === m.in_reply_to);
      if (parent) body.append(node('div', 'reply-reference', `${memberName(parent.sender)}：${parent.content.replace(/\s+/g, ' ').slice(0, 100)}`));
      let content;
      try {
        if (typeof window.noahRichText?.render === 'function') content = window.noahRichText.render(m.content);
      } catch { /* Plain text remains readable if rich-text rendering fails. */ }
      body.append(content || node('div', 'message-content', m.content));
      const receipts = deliveries.filter(d => d.message_id === m.id);
      const actions = node('div', 'message-actions');
      const addressed = receipts.filter(d => m.recipient === 'all' || d.agent === m.recipient);
      const statusText = addressed.length ? addressed.map(d => `${memberName(d.agent)} · ${deliveryLabels[d.state] || d.state}`).join(' / ') : '已保存到共享讨论';
      const deliveryStatus = node('span', 'delivery-status', statusText);
      deliveryStatus.dataset.state = addressed.find(d => ['failed', 'uncertain'].includes(d.state))?.state || addressed[0]?.state || 'persisted'; actions.append(deliveryStatus);
      if (m.sender !== 'human') {
        const b = node('button', '', '回复');
        b.onclick = () => {
          captureDraft(); const draft = draftFor(selected);
          draft.replyTo = m; draft.recipient = m.sender; draft.revision++; draft.updatedAt = Date.now(); scheduleUiSave(); renderComposer(); $('message').focus();
        };
        actions.append(b);
      }
      if (!c?.archived_at && window.noahMaturity) { const propose = node('button', '', '提为结论'); propose.onclick = () => window.noahMaturity.openOutcomes(m.id); actions.append(propose); }
      if (receipts.length) {
        const detail = node('details', 'delivery-details'); const key = 'delivery:' + m.id; detail.open = openDetails.has(key);
        detail.addEventListener('toggle', () => { if (detail.open) openDetails.add(key); else openDetails.delete(key); });
        detail.append(node('summary', '', `查看 ${receipts.length} 位成员的投递状态`));
        for (const receipt of receipts) {
          const passive = receipt.wake === 0 && receipt.state === 'queued';
          const line = node('div', 'delivery-line'); line.append(node('span', '', `${memberName(receipt.agent)} · ${passive ? '待同步，下一次定向处理时接收' : deliveryLabels[receipt.state] || receipt.state}`));
          if (receipt.state === 'uncertain') {
            const external = members(selected, true).find(s => s.agent === receipt.agent)?.mode === 'external';
            const resolve = node('button', 'text-button', external ? '核对原会话' : '已核对，结束旧投递');
            resolve.onclick = external ? () => $('show-harnesses').click() : () => act(() => api(`/api/deliveries/${receipt.id}/resolve`, {})); line.append(resolve);
          }
          if (receipt.error) line.append(node('p', 'message-error', receipt.error));
          detail.append(line);
        }
        body.append(detail);
      }
      body.append(actions); article.append(body); scroll.append(article);
    });
    if (bottom) scroll.scrollTop = scroll.scrollHeight;
  }
  $('agents').replaceChildren();
  sessions.forEach(session => {
    const agent = session.agent;
    const a = node('section', 'agent'), head = node('div', 'agent-heading');
    head.append(harnessAvatar(session.harness || agent));
    const title = node('div'), status = session?.status || 'offline';
    const statusLabel = node('span', 'agent-status', session.mode === 'external' && status === 'offline' ? '原会话已断开' : labels[status] || status); statusLabel.dataset.state = status;
    title.append(node('div', 'agent-name', memberName(agent)), statusLabel); head.append(title); a.append(head);
    a.append(node('p', 'agent-mode', session.mode === 'external' ? '原工作会话 · 保留模型和工具' : 'Noah 新建 · 独立上下文'));
    if (session?.native_id) {
      const details = node('details', 'session-details'), key = selected + agent + ':session'; details.open = openDetails.has(key);
      details.addEventListener('toggle', () => { if (details.open) openDetails.add(key); else openDetails.delete(key); });
      details.append(node('summary', '', '会话信息'), node('p', 'session-id', session.native_id)); a.append(details);
    }
    if (session?.error) a.append(node('p', 'message-error', session.error));
    const runs = state.runs.filter(r => deliveries.find(d => d.id === r.id)?.agent === agent);
    if (window.noahMaturity) window.noahMaturity.privateOutput(session, a);
    else if (runs.length) {
      const details = node('details'), k = selected + agent; details.open = openDetails.has(k);
      details.addEventListener('toggle', () => { if (details.open) openDetails.add(k); else openDetails.delete(k); });
      details.append(node('summary', '', '查看私有输出'));
      details.append(node('div', 'private-output', runs.map(r => r.output || '等待输出…').join('\n\n'))); a.append(details);
    }
    $('agents').append(a);
  });
  const runIds = new Set(deliveries.map(delivery => delivery.id));
  const measured = state.runs.filter(run => runIds.has(run.id) && Number.isFinite(run.input_bytes) && run.prompt_starts > 0);
  const starts = measured.reduce((sum, run) => sum + (run.prompt_starts || 0), 0);
  const bytes = measured.reduce((sum, run) => sum + (run.input_bytes || 0), 0);
  const nativeWakes = (state.nativeWakes || []).filter(wake => wake.conversation_id === selected && wake.input_bytes > 0);
  const nativeBytes = nativeWakes.reduce((sum, wake) => sum + wake.input_bytes, 0);
  $('usage-summary').textContent = (measured.length ? `${starts} 次受管提交 · ${(bytes / 1024).toFixed(1)} KiB 新增输入。` : '尚无本版受管输入计量。')
    + (nativeWakes.length ? `原会话最近记录：${nativeWakes.length} 次处理请求 · ${(nativeBytes / 1024).toFixed(1)} KiB 唤醒文本；公开正文另行写入。` : '') + '字节不是 token，不推算费用。';
  $('export-json').disabled = !c;
  $('materials').replaceChildren();
  const allMaterials = state.materials.filter(m => m.conversation_id === selected);
  const materials = allMaterials.filter(m => !allMaterials.some(next => next.family_id === (m.family_id || m.id) && next.revision > (m.revision || 1)));
  $('material-count').textContent = String(materials.length);
  $('add-material').disabled = !c || !!c.archived_at;
  if (!materials.length) $('materials').append(node('p', 'muted', '仅共享你为这次任务选择的资料。'));
  materials.forEach(m => {
    const button = node('button', 'material material-open', m.name + ((m.revision || 1) > 1 ? ` · v${m.revision}` : '')); button.type = 'button'; button.title = `查看 ${m.name}\n资料快照 SHA-256：${m.sha256}`;
    button.onclick = () => openMaterial(m); $('materials').append(button);
  });
  window.noahMaturity?.render();
}
let materialPreview, materialGeneration = 0;
async function loadMaterialPage() {
  const target = materialPreview, generation = materialGeneration;
  if (!target) return;
  $('material-more').disabled = true; $('material-error').hidden = true;
  try {
    const page = await api(`/api/conversations/${target.conversationId}/materials/${target.id}?offset=${target.offset}`);
    if (generation !== materialGeneration) return;
    target.content += page.content; target.offset = page.nextOffset;
    $('material-content').textContent = target.content;
    $('material-more').hidden = page.nextOffset === null;
    $('material-meta').textContent = `已显示 ${new TextEncoder().encode(target.content).byteLength.toLocaleString()} 字节${page.nextOffset === null ? '（全文）' : ''} · SHA-256 ${target.sha256}`;
  } catch (error) { if (generation === materialGeneration) { $('material-error').textContent = `加载失败：${error.message}，可重试。`; $('material-error').hidden = false; } }
  finally { if (generation === materialGeneration) $('material-more').disabled = false; }
}
function openMaterial(material) {
  materialGeneration++; materialPreview = { ...material, conversationId: selected, offset: 0, content: '' };
  closeOpenDialogs('material-dialog');
  $('material-heading').textContent = material.name; $('material-content').textContent = ''; $('material-meta').textContent = '正在加载…'; $('material-more').hidden = false;
  if (!$('material-dialog').open) $('material-dialog').showModal();
  window.noahMaturity?.materialVersions(material);
  void loadMaterialPage();
}
$('material-more').onclick = () => void loadMaterialPage();
$('close-material').onclick = () => { materialGeneration++; $('material-dialog').close(); };
$('copy-material-reference').onclick = async () => {
  if (!materialPreview) return;
  try { await navigator.clipboard.writeText(`${materialPreview.name}\nmaterial_id: ${materialPreview.id}\nsha256: ${materialPreview.sha256}`); toast('资料引用已复制'); }
  catch { toast('无法访问剪贴板，可手动复制资料信息'); }
};
async function act(fn, conversationId = selected) {
  if (conversationId) draftFor(conversationId).error = '';
  try { await fn(); await refresh(); }
  catch (error) {
    if (conversationId) { draftFor(conversationId).error = error.message; renderNotice(); }
    else notice(error.message);
  }
}
function openCreate() {
  createGeneration++;
  $('create-error').hidden = true; $('create-error').textContent = '';
  closeOpenDialogs('create-dialog');
  $('model-help').textContent = state?.config.error || ((state?.config.models || []).length ? '新建会话共用所选模型；已有会话保留原模型和工具。' : 'Grok 配置中暂无可用模型。');
  renderNewMembers();
  if (!$('create-dialog').open) $('create-dialog').showModal();
  $('new-title').focus();
  $('create-content').scrollTop = 0;
}
function renderLimitSettings(resume = false) {
  const enabled = $(resume ? 'resume-limits-enabled' : 'limits-enabled').checked;
  $(resume ? 'resume-limits' : 'create-limits').hidden = !enabled;
  $(resume ? 'resume-autonomy-help' : 'create-autonomy-help').hidden = enabled;
  $(resume ? 'resume-policy' : 'create-policy').textContent = enabled ? '已设置上限' : '自主讨论';
  for (const id of resume ? ['extra-runs', 'extra-minutes'] : ['max-runs', 'minutes']) $(id).disabled = !enabled;
}
$('limits-enabled').onchange = () => renderLimitSettings();
$('resume-limits-enabled').onchange = () => renderLimitSettings(true);
renderLimitSettings(); renderLimitSettings(true);
$('new-task').onclick = $('empty-start').onclick = openCreate;
$('cancel-create').onclick = () => $('create-dialog').close();
$('creation-diagnostics').onclick = () => { $('show-harnesses').click(); $('run-diagnostics').click(); };
for (const form of ['create-form', 'resume-form']) $(form).addEventListener('invalid', event => {
  const details = event.target.closest('details.advanced-settings');
  if (details && !details.open) details.open = true;
}, true);
function creationData() {
  const limitsEnabled = $('limits-enabled').checked;
  return { title: $('new-title').value, participants: newMembers.map(participantInput), ...(newMembers.some(member => member.source.startsWith('managed:')) ? { modelAlias: $('new-model').value } : {}), limitsEnabled,
    ...(limitsEnabled ? { maxRuns: Number($('max-runs').value), minutes: Number($('minutes').value) } : {}) };
}
$('create-form').onsubmit = async event => {
  event.preventDefault();
  if (creating || !canCreate()) return;
  $('create-error').hidden = true;
  const generation = createGeneration, submitted = creationData();
  const signature = JSON.stringify(submitted);
  if (creationSubmission?.signature !== signature) creationSubmission = { signature, key: crypto.randomUUID() };
  const request = creationSubmission;
  const sameDialog = () => $('create-dialog').open && generation === createGeneration;
  creating = true; updateCreationState();
  try {
    const c = await api('/api/conversations', { ...submitted, clientKey: request.key });
    if (creationSubmission === request) creationSubmission = undefined;
    await refresh();
    if (sameDialog() && JSON.stringify(creationData()) === JSON.stringify(submitted)) {
      $('task-search').value = ''; $('task-filter').value = 'current';
      choose(c.id); $('create-dialog').close(); $('new-title').value = '';
      $('limits-enabled').checked = false; renderLimitSettings();
    } else toast(`已创建「${c.title || submitted.title}」，当前填写内容已保留`);
  } catch (error) {
    if (sameDialog()) { $('create-error').textContent = error.message; $('create-error').hidden = false; }
    else toast(`「${submitted.title}」创建失败：${error.message}`);
  } finally { creating = false; updateCreationState(); }
};
$('show-harnesses').onclick = () => {
  closeOpenDialogs('harness-dialog');
  if (!$('harness-dialog').open) $('harness-dialog').showModal();
  $('close-harnesses').focus();
};
$('close-harnesses').onclick = () => $('harness-dialog').close();
$('add-participant').onclick = () => {
  if (newMembers.length >= 16) return;
  const source = sourceOptions().find(option => !option.disabled)?.value || 'managed:pi';
  newMembers.push({ id: 'p-' + crypto.randomUUID(), source, label: `${source.startsWith('external:') ? '原 pi 会话' : names[source.split(':')[1]]} ${newMembers.length + 1}` });
  renderNewMembers();
};
$('connect-pi').onclick = async () => {
  $('connect-pi').disabled = true;
  try {
    bridgeSetup = await api('/api/bridge-grants', {});
    $('bridge-setup').hidden = false;
    $('bridge-extension-path').textContent = bridgeSetup.extensionPath;
    $('bridge-connect-command').textContent = bridgeSetup.connectCommand;
  } catch (error) { $('harness-error').textContent = error.message; $('harness-error').hidden = false; }
  finally { $('connect-pi').disabled = false; }
};
$('copy-bridge-command').onclick = async () => {
  try { await navigator.clipboard.writeText(bridgeSetup.connectCommand); toast('连接命令已复制'); }
  catch { toast('请选中上方连接命令复制'); }
};
$('run-diagnostics').onclick = async () => {
  $('diagnostic-result').textContent = '正在检查…';
  try {
    const result = await api('/api/diagnostics');
    const missing = result.discovery.harnesses.filter(h => h.managedCreation.supported && (!h.managedCreation.runtimePresent || !h.managedCreation.modelConfigPresent));
    $('diagnostic-result').textContent = [`本地数据库：${result.database === 'ok' ? '正常' : '需要检查'}。`,
      `待核对投递：${result.unresolved.length} 条。`,
      ...missing.map(h => `${h.label}：${h.managedCreation.explanation}`),
      `原会话连接：${result.nativeSessions.length} 个登记项；${(result.nativeWakes || []).filter(w => w.state === 'uncertain').length} 次处理需要核对。`,
      ...(result.nativeMetrics ? [`原会话累计观察到 ${result.nativeMetrics.observed_messages} 条公开投递 · ${(result.nativeMetrics.shared_body_bytes / 1024).toFixed(1)} KiB 正文；${result.nativeMetrics.wake_start_requests} 次处理请求。模型 token 未知。`] : []), result.guidance].join('\n\n');
  } catch (error) { $('diagnostic-result').textContent = `检查失败：${error.message}。可以重新展开重试。`; }
};
$('load-older').onclick = () => { const cursor = historyStatus.get(selected)?.nextBefore; void loadHistory(selected, cursor ? { before: String(cursor) } : {}); };
$('export-json').onclick = () => { if (selected) window.location.href = `/api/conversations/${selected}/export?format=json`; };
function openMessageSearch() {
  closeOpenDialogs('search-dialog');
  $('search-scope').value = selected ? 'current' : 'all';
  if (!$('search-dialog').open) $('search-dialog').showModal();
  $('message-query').focus();
}
$('find-messages').onclick = openMessageSearch;
$('close-search').onclick = () => { searchGeneration++; $('search-dialog').close(); };
$('message-search-form').onsubmit = async event => {
  event.preventDefault();
  const generation = ++searchGeneration;
  const query = $('message-query').value.trim();
  if (!query) return;
  const params = new URLSearchParams({ q: query });
  if ($('search-scope').value === 'current' && selected) params.set('conversationId', selected);
  $('message-search-status').textContent = '正在搜索…'; $('message-search-results').replaceChildren();
  try {
    const result = await api(`/api/search?${params}`);
    if (generation !== searchGeneration) return;
    $('message-search-status').textContent = result.results.length ? `${result.truncated ? '显示最近 ' : '找到 '}${result.results.length} 条消息${result.truncated ? '，请增加关键词缩小范围' : ''}` : '没有找到匹配的公开消息。试试另一个关键词或全部讨论。';
    for (const item of result.results) {
      const button = node('button', 'message-search-result'); button.type = 'button';
      button.append(node('strong', '', item.conversation_title), node('span', 'muted', `${memberName(item.sender, item.conversation_id)} · ${new Date(item.created_at).toLocaleString('zh-CN')}`), node('p', '', item.excerpt));
      button.onclick = async () => {
        choose(item.conversation_id); await loadHistory(item.conversation_id, { around: String(item.seq) });
        $('search-dialog').close();
        const message = $('message-' + item.id); if (message) { message.scrollIntoView({ block: 'center' }); message.classList.add('search-target'); }
      };
      $('message-search-results').append(button);
    }
  } catch (error) { if (generation === searchGeneration) $('message-search-status').textContent = `搜索失败：${error.message}。请重试。`; }
};
document.addEventListener('keydown', event => {
  if (event.isComposing || event.altKey || (!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== 'f') return;
  event.preventDefault(); openMessageSearch();
});
$('refresh-harnesses').onclick = async () => {
  $('refresh-harnesses').disabled = true; $('refresh-harnesses').textContent = '正在检测…'; $('harness-error').hidden = true;
  try {
    const report = await api('/api/harnesses');
    if (state) { state.discovery = report; renderDiscovery(); renderModels(); }
    await refresh();
  } catch (error) { $('harness-error').textContent = error.message; $('harness-error').hidden = false; }
  finally { $('refresh-harnesses').disabled = false; $('refresh-harnesses').textContent = '重新检测'; }
};
$('message').oninput = $('recipient').onchange = () => { captureDraft(); if (selected) draftFor(selected).error = ''; renderComposer(); renderNotice(); };
$('message').addEventListener('keydown', event => {
  if (event.key !== 'Enter' || event.isComposing || (!event.metaKey && !event.ctrlKey) || event.altKey) return;
  event.preventDefault();
  if (selected && !sending.has(selected) && !$('composer').hidden && $('message').value.trim()) $('composer').requestSubmit();
});
$('composer').onsubmit = async event => {
  event.preventDefault();
  const conversationId = selected;
  if (!conversationId || sending.has(conversationId)) return;
  captureDraft();
  const draft = draftFor(conversationId), revision = draft.revision;
  if (!draft.content.trim()) { renderComposer(); return; }
  if (draft.recipient !== 'all' && !members(conversationId).some(member => member.agent === draft.recipient)) {
    draft.error = '收件成员已不可用，请重新选择；草稿已保留。'; renderComposer(); renderNotice(); return;
  }
  const data = messageData(draft);
  const signature = JSON.stringify(data);
  if (draft.pendingSend?.signature !== signature) draft.pendingSend = { signature, key: crypto.randomUUID() };
  const request = draft.pendingSend;
  sending.set(conversationId, request); draft.error = ''; scheduleUiSave(); renderComposer(); renderNotice();
  try {
    await api(`/api/conversations/${conversationId}/messages`, { ...data, clientKey: request.key });
    if (draft.revision === revision) { draft.content = ''; draft.replyTo = undefined; draft.revision++; }
    if (draft.pendingSend === request) draft.pendingSend = undefined;
    scheduleUiSave(); renderComposer();
    await refresh();
  } catch (error) { draft.error = error.message; }
  finally { sending.delete(conversationId); renderComposer(); renderNotice(); }
};
$('clear-reply').onclick = () => {
  if (!selected) return;
  const draft = draftFor(selected); draft.replyTo = undefined; draft.revision++; draft.updatedAt = Date.now(); scheduleUiSave(); renderComposer();
};
$('pause').onclick = () => { const id = selected; void act(() => api(`/api/conversations/${id}/control`, { action: 'pause' }), id); };
$('stop').onclick = () => { const id = selected; void act(() => api(`/api/conversations/${id}/control`, { action: 'stop' }), id); };
$('resume').onclick = () => {
  resumeTaskId = selected;
  const c = state.conversations.find(c => c.id === resumeTaskId);
  if (!c) return;
  resumeGeneration++; $('resume-error').hidden = true; $('resume-error').textContent = '';
  $('resume-submit').disabled = resuming.has(resumeTaskId);
  $('resume-submit').textContent = resuming.has(resumeTaskId) ? '正在继续…' : '继续协作';
  const bounded = c.limits_enabled !== 0;
  $('resume-limits-enabled').checked = bounded;
  $('resume-settings').open = bounded;
  $('extra-runs').value = '4'; $('extra-minutes').value = '20';
  $('resume-description').textContent = bounded
    ? '这场讨论保留了原来的上限。取消勾选，即可改为自主讨论。'
    : 'Agent 将继续处理排队的消息，自主决定是否继续交流。';
  $('extra-runs-label').textContent = bounded ? '增加唤醒次数' : '最多再唤醒次数';
  $('resume-limits-help').textContent = bounded
    ? `原额度剩余 ${Math.max(0, c.max_runs - c.used_runs)} 次，再增加所填次数；时限从继续时重新计算。`
    : '一位 Agent 开始一次处理计为一次唤醒，多条消息可以合并。达到任一上限后暂停。';
  const pending = resumeSubmissions.get(resumeTaskId)?.data;
  if (pending) {
    $('resume-limits-enabled').checked = pending.limitsEnabled;
    if (pending.limitsEnabled) { $('extra-runs').value = String(pending.additionalRuns); $('extra-minutes').value = String(pending.minutes); }
  }
  renderLimitSettings(true); $('resume-dialog').showModal();
};
$('cancel-resume').onclick = () => $('resume-dialog').close();
$('resume-form').onsubmit = async event => {
  event.preventDefault();
  const id = resumeTaskId, generation = resumeGeneration;
  if (!id || resuming.has(id)) return;
  const current = () => $('resume-dialog').open && id === resumeTaskId && generation === resumeGeneration;
  const limitsEnabled = $('resume-limits-enabled').checked;
  const data = { action: 'resume', limitsEnabled,
    ...(limitsEnabled ? { additionalRuns: Number($('extra-runs').value), minutes: Number($('extra-minutes').value) } : {}) };
  const signature = JSON.stringify(data);
  if (resumeSubmissions.get(id)?.signature !== signature) resumeSubmissions.set(id, { signature, data, key: crypto.randomUUID() });
  const request = resumeSubmissions.get(id);
  resuming.add(id); $('resume-submit').disabled = true; $('resume-submit').textContent = '正在继续…';
  $('resume-error').hidden = true; draftFor(id).error = '';
  try {
    await api(`/api/conversations/${id}/control`, { ...data, clientKey: request.key });
    if (resumeSubmissions.get(id) === request) resumeSubmissions.delete(id);
    if (current()) $('resume-dialog').close();
    await refresh();
  } catch (error) {
    draftFor(id).error = error.message;
    if (current()) { $('resume-error').textContent = error.message; $('resume-error').hidden = false; }
    renderNotice();
  } finally {
    resuming.delete(id);
    if (resumeTaskId === id) { $('resume-submit').disabled = false; $('resume-submit').textContent = '继续协作'; }
  }
};
$('export').onclick = () => { window.location.href = `/api/conversations/${selected}/export`; };
$('attach').onclick = $('add-material').onclick = () => { if (selected) $('file').click(); };
const textExtension = /\.(?:txt|md|json|csv|ts|js|py|html|css|toml|yaml|yml)$/i;
async function materialText(file) {
  if (file.size > 10 * 1024 * 1024) throw new Error('请分享不超过 10 MiB 的文本资料。');
  if (!textExtension.test(file.name)) throw new Error('请选择文本、Markdown、JSON、CSV 或代码资料，暂不支持图片和其他二进制文件。');
  let content;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
  catch { throw new Error('无法读取这份资料，请选择 UTF-8 编码的文本文件。'); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(content)) throw new Error('这份资料含有二进制内容，请选择纯文本文件。');
  return content;
}
function shareMaterial(conversationId, file) {
  const title = state?.conversations.find(task => task.id === conversationId)?.title;
  return act(async () => {
    const content = await materialText(file);
    await api(`/api/conversations/${conversationId}/materials`, { name: file.name, content });
    toast(selected === conversationId ? `已共享 ${file.name}` : `已将资料共享到「${title || '原任务'}」`);
  }, conversationId);
}
$('file').onchange = () => {
  const id = selected, file = $('file').files[0];
  $('file').value = '';
  if (!id || !file) return;
  void shareMaterial(id, file);
};
let fileDragDepth = 0;
const isFileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files');
$('composer-region').addEventListener('dragenter', event => {
  if (!isFileDrag(event) || !selected) return;
  event.preventDefault(); fileDragDepth++; $('composer-region').classList.add('drag-over');
});
$('composer-region').addEventListener('dragover', event => {
  if (!isFileDrag(event) || !selected) return;
  event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
});
$('composer-region').addEventListener('dragleave', event => {
  if (!isFileDrag(event)) return;
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (!fileDragDepth) $('composer-region').classList.remove('drag-over');
});
$('composer-region').addEventListener('drop', event => {
  if (!isFileDrag(event)) return;
  event.preventDefault(); fileDragDepth = 0; $('composer-region').classList.remove('drag-over');
  const conversationId = selected, files = Array.from(event.dataTransfer.files || []);
  if (!conversationId) return;
  void (async () => { for (const file of files) await shareMaterial(conversationId, file); })();
});

const compactLayout = matchMedia('(max-width: 1179px)');
let inspectorOpen = false, expectedDialogCloses = 0;
function renderInspector() {
  const dialog = $('activity-dialog');
  document.documentElement.classList.toggle('inspector-open', inspectorOpen && !compactLayout.matches);
  $('activity').hidden = !inspectorOpen;
  if (inspectorOpen && compactLayout.matches) {
    dialog.append($('activity'));
    if (!dialog.open) dialog.showModal();
  } else {
    if (dialog.open) { expectedDialogCloses++; dialog.close(); }
    document.querySelector('.app').append($('activity'));
  }
  $('toggle-activity').setAttribute('aria-expanded', String(inspectorOpen));
  $('close-activity').setAttribute('aria-expanded', String(inspectorOpen));
  const label = inspectorOpen ? '隐藏 Agent 与资料' : '显示 Agent 与资料';
  $('toggle-activity').setAttribute('aria-label', label); $('toggle-activity').title = label;
  resizeComposer();
}
function setInspector(open) { inspectorOpen = open; renderInspector(); }
$('toggle-activity').onclick = () => setInspector(!inspectorOpen);
$('close-activity').onclick = () => setInspector(false);
$('activity-dialog').addEventListener('close', () => {
  if (expectedDialogCloses) { expectedDialogCloses--; return; }
  setInspector(false);
});
$('activity-dialog').addEventListener('cancel', () => { inspectorOpen = false; });
$('activity-dialog').addEventListener('click', event => {
  if (event.target !== $('activity-dialog')) return;
  const bounds = $('activity-dialog').getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) setInspector(false);
});
compactLayout.addEventListener('change', renderInspector);
renderInspector();

$('task-search').oninput = renderTasks;
$('task-search').addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.isComposing) return;
  if ($('task-search').value) {
    event.preventDefault(); $('task-search').value = ''; renderTasks();
  } else if (selected) $('message').focus();
});
document.addEventListener('keydown', event => {
  if (event.isComposing || event.altKey || (!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
  event.preventDefault();
  closeOpenDialogs();
  $('task-search').focus(); $('task-search').select();
});
window.addEventListener('resize', resizeComposer);

if (typeof desktop?.onNewConversation === 'function') desktop.onNewConversation(openCreate);
if (typeof desktop?.onFocusComposer === 'function') desktop.onFocusComposer(() => {
  if (!selected || $('composer').hidden) { openCreate(); return; }
  closeOpenDialogs();
  $('message').focus();
});
window.addEventListener('beforeunload', () => {
  captureDraft();
  if (uiSaveTimer) { clearTimeout(uiSaveTimer); uiSaveTimer = undefined; }
  // The preload bridge commits this final snapshot before the native window closes.
  // Submit it directly even when an earlier asynchronous save is still pending.
  if (uiStateLoaded && typeof desktop?.saveUiState === 'function') {
    try { Promise.resolve(desktop.saveUiState(uiSnapshot())).catch(() => {}); } catch { /* A prior save failure remains visible while the window is open. */ }
  }
});

let bootPromise, eventStream;
const uiRestore = restoreUiState();
let pairingToken = new URLSearchParams(location.hash.slice(1)).get('token');
if (pairingToken) history.replaceState(null, '', '/');
function boot() {
  if (bootPromise) return bootPromise;
  bootPromise = (async () => {
    $('retry-connection').disabled = true;
    try {
      // Restoring once prevents a reconnect from overwriting newly edited drafts.
      await uiRestore;
      if (pairingToken) { await api('/api/pair', {}, pairingToken); pairingToken = undefined; }
      await refresh();
      if (connectionError || !state) throw new Error(connectionError || '本地工作区暂不可用');
      bootFailure = ''; $('retry-connection').hidden = true; renderNotice();
      if (selected && !messageHistory.has(selected)) void loadHistory(selected);
      if (!eventStream) {
        eventStream = new EventSource('/api/events');
        eventStream.addEventListener('changed', scheduleRefresh);
        eventStream.onerror = () => { connection('reconnecting'); };
        eventStream.onopen = () => { connection('connected'); scheduleRefresh(); };
      }
      return true;
    } catch (error) {
      connection('offline'); bootFailure = `连接暂未完成：${error.message}。可以重新连接，草稿会保留。`;
      $('retry-connection').hidden = false; renderNotice(); return false;
    } finally { $('retry-connection').disabled = false; }
  })().finally(() => { bootPromise = undefined; });
  return bootPromise;
}
$('retry-connection').onclick = () => void boot();
// Native notification navigation must wait until the saved discussion/drafts
// have been restored, otherwise that restoration can overwrite its target.
const uiReady = boot();
