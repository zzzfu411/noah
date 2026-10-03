/* Daily collaboration surfaces. app.js owns connection, drafts, and the timeline. */
(() => {
  let memberDiscussion, outcomeDiscussion, workspaceDiscussion, budgetDiscussion, outcomeEdit, outcomeSubmission;
  let outcomeData = { outcomes: [], revisions: [], decisions: [] }, outcomeKey = '', outcomeGeneration = 0;
  let workspaceData, workspaceGeneration = 0, runsContext, grokSetup;
  let initialAttention = true;
  const activeNotificationKeys = new Set();
  const dialogEpoch = new Map();
  const kindNames = { conclusion: '结论', disagreement: '异议', open_question: '未决问题' };
  const closeDialogs = () => closeOpenDialogs();
  const openDialog = id => { setInspector(false); closeDialogs(); dialogEpoch.set(id, (dialogEpoch.get(id) || 0) + 1); $(id).showModal(); };
  const error = (id, value) => { $(id).textContent = value || ''; $(id).hidden = !value; };
  const button = (label, action, cls = 'text-button') => { const b = node('button', cls, label); b.type = 'button'; b.onclick = action; return b; };
  const archived = id => !!state?.conversations.find(c => c.id === id)?.archived_at;
  async function change(errorId, control, fn) {
    const dialog = control?.closest('dialog'), epoch = dialogEpoch.get(dialog?.id);
    const current = () => !dialog || (dialog.open && dialogEpoch.get(dialog.id) === epoch);
    error(errorId, ''); if (control) control.disabled = true;
    try { await fn(current); await refresh(); return current(); }
    catch (e) { if (current()) error(errorId, e.message); return false; }
    finally { if (control) control.disabled = false; }
  }
  document.querySelectorAll('[data-close]').forEach(b => { b.onclick = () => $(b.dataset.close).close(); });
  $('task-filter').onchange = () => { taskVersion = ''; renderTasks(); };
  $('archive-discussion').onclick = async () => {
    const id = selected, restoring = archived(id);
    if (!id) return;
    await act(async () => {
      await api(`/api/conversations/${id}/control`, { action: restoring ? 'restore' : 'archive' });
      $('task-filter').value = restoring ? 'current' : 'archived';
      toast(restoring ? '已恢复，讨论保持暂停' : '已归档，历史仍可搜索与导出');
    }, id);
  };
  const describe = s => `${names[s.harness] || s.harness} · ${s.mode === 'external' ? '原工作会话' : 'Noah 新建'}`;
  function renderMembers() {
    if (!memberDiscussion) return;
    const list = $('member-list'); list.replaceChildren();
    for (const s of members(memberDiscussion, true)) {
      const row = node('div', 'maturity-row'); row.append(harnessAvatar(s.harness));
      const info = node('div', 'maturity-row-main'); info.append(node('strong', '', s.label), node('p', 'muted', s.removed_at ? '已退出 · 历史保留' : describe(s, memberDiscussion))); row.append(info);
      if (!s.removed_at && !archived(memberDiscussion)) row.append(button('移除', event => change('member-error', event.currentTarget, async () => { await api(`/api/conversations/${memberDiscussion}/participants/${s.agent}/remove`, {}); renderMembers(); })));
      list.append(row);
    }
    $('invite-form').hidden = archived(memberDiscussion) || members(memberDiscussion).length >= 16;
  }
  function inviteSourceChanged() {
    const source = $('invite-source').value, managed = source.startsWith('managed:');
    $('invite-model-label').hidden = !managed; $('invite-model').required = managed;
    const binding = state.nativeSessions?.find(b => 'external:' + b.id === source);
    $('invite-label').value = managed ? names[source.split(':')[1]] : binding?.label || '原工作会话';
  }
  $('manage-members').onclick = () => {
    if (!selected) return; memberDiscussion = selected; error('member-error', '');
    const inUse = new Set(members(memberDiscussion).map(s => 'external:' + s.binding_id));
    const options = sourceOptions().filter(o => !inUse.has(o.value));
    $('invite-source').replaceChildren(...options.map(o => { const n = node('option', '', o.label); n.value = o.value; n.disabled = o.disabled; return n; }));
    $('invite-source').value = options.find(o => !o.disabled)?.value || '';
    $('invite-model').replaceChildren(...(state.config.models || []).map(m => { const o = node('option', '', m.alias); o.value = m.alias; return o; }));
    $('invite-model').value = state.conversations.find(c => c.id === memberDiscussion)?.model_alias || state.config.alias || $('invite-model').value;
    $('invite-history').checked = true; $('invite-details').open = false;
    inviteSourceChanged(); renderMembers(); openDialog('members-dialog');
  };
  $('invite-source').onchange = inviteSourceChanged;
  $('invite-form').onsubmit = async event => {
    event.preventDefault(); const id = memberDiscussion;
    const value = participantInput({ id: 'p-' + crypto.randomUUID(), source: $('invite-source').value, label: $('invite-label').value });
    const ok = await change('member-error', event.submitter, () => api(`/api/conversations/${id}/participants`, { participant: value, shareHistory: $('invite-history').checked, ...(value.mode === 'managed' ? { modelAlias: $('invite-model').value } : {}) }));
    if (ok) { $('invite-details').open = false; renderMembers(); toast('成员已加入；没有因此启动模型'); }
  };
  function attentionItems() {
    const items = [], seen = new Set();
    const add = item => { if (!seen.has(item.id)) { seen.add(item.id); items.push(item); } };
    for (const c of state?.conversations || []) {
      if (!c.archived_at && c.status !== 'active' && /Agent.*决定|请求你|waiting_human/.test(c.reason || '')) add({ id: `human:${c.id}:${c.reason}`, stableId: `human:${c.id}:${c.created_at}:${(state.messages || []).filter(m => m.conversation_id === c.id && m.recipient === 'human').at(-1)?.seq || 0}`, kind: 'human_input', conversationId: c.id, title: 'Agent 等待你的决定', detail: c.title });
      if (!c.archived_at) for (const s of members(c.id)) {
        if (s.status === 'waiting_user') add({ id: `waiting:${c.id}:${s.agent}`, kind: 'human_input', conversationId: c.id, title: `${s.label} 等待你在原会话操作`, detail: c.title, native: true });
        if (s.mode === 'external' && ['offline', 'paused'].includes(s.status)) add({ id: `offline:${c.id}:${s.agent}`, kind: 'failed', conversationId: c.id, title: `${s.label} 的原会话需要连接`, detail: c.title, native: true });
        if (s.status === 'error') add({ id: `error:${c.id}:${s.agent}`, kind: 'failed', conversationId: c.id, title: `${s.label} 处理失败`, detail: c.title });
      }
    }
    for (const d of state?.deliveries || []) if (d.state === 'uncertain') add({ id: `delivery:${d.id}`, kind: 'uncertain', conversationId: d.conversation_id, title: `${memberName(d.agent, d.conversation_id)} 的执行结果待核对`, detail: state.conversations.find(c => c.id === d.conversation_id)?.title, messageId: d.message_id, native: members(d.conversation_id, true).find(s => s.agent === d.agent)?.mode === 'external' });
    for (const w of state?.nativeWakes || []) if (w.state === 'uncertain') add({ id: `wake:${w.id}`, kind: 'uncertain', conversationId: w.conversation_id, title: '原会话的一次处理需要核对', detail: state.conversations.find(c => c.id === w.conversation_id)?.title, native: true });
    for (const o of state?.outcomes || []) if (o.status === 'proposed' && !archived(o.conversation_id)) add({ id: `proposal:${o.id}:${o.current_revision}`, kind: 'proposal', conversationId: o.conversation_id, title: `${kindNames[o.kind]}待审阅：${o.title}`, detail: `${memberName(o.author, o.conversation_id)} · ${state.conversations.find(c => c.id === o.conversation_id)?.title}`, outcome: true });
    return items;
  }
  async function locate(id, messageId) {
    closeDialogs(); $('task-filter').value = archived(id) ? 'archived' : 'current'; choose(id);
    if (messageId) {
      try { const known = sharedMessages(id).find(m => m.id === messageId) || (await api(`/api/conversations/${id}/messages/${messageId}`)).message; await loadHistory(id, { around: String(known.seq) }); const element = $('message-' + messageId); element?.scrollIntoView({ block: 'center' }); element?.classList.add('search-target'); }
      catch (e) { notice(`暂时无法定位依据：${e.message}。请重试。`); }
    }
  }
  function renderAttention() {
    const items = attentionItems(); $('attention-count').textContent = String(items.length);
    if ($('attention-dialog').open) {
      const list = $('attention-list'); list.replaceChildren();
      if (!items.length) list.append(node('p', 'maturity-empty', '目前没有需要你介入的事项。你仍可随时加入讨论。'));
      for (const item of items) {
        const row = node('div', 'maturity-row'); const info = node('div', 'maturity-row-main'); info.append(node('strong', '', item.title), node('p', 'muted', item.detail)); row.append(info);
        row.append(button(item.native ? '核对原会话' : item.outcome ? '审阅提议' : '打开讨论', async () => { await locate(item.conversationId, item.messageId); if (item.native) $('show-harnesses').click(); else if (item.outcome) openOutcomes(); })); list.append(row);
      }
    }
    const currentKeys = new Set(items.map(item => item.stableId || item.id));
    for (const key of activeNotificationKeys) if (!currentKeys.has(key)) activeNotificationKeys.delete(key);
    for (const item of items) {
      const key = item.stableId || item.id; if (activeNotificationKeys.has(key)) continue; activeNotificationKeys.add(key);
      // A recurrence after recovery is a new event. Keep logical keys local;
      // each appearance sends only an opaque metadata ID to the desktop host.
      if (!initialAttention && typeof desktop?.notifyActionable === 'function') void desktop.notifyActionable({ id: `attention:${crypto.randomUUID()}`, kind: item.kind, conversationId: item.conversationId }).then(result => { if (result.status === 'failed') $('notification-help').textContent = '系统未能显示提醒；请在待处理中查看，并检查 macOS 通知设置。'; }).catch(() => {});
    }
    initialAttention = false;
  }
  $('show-attention').onclick = () => { openDialog('attention-dialog'); renderAttention(); };
  const testNotification = $('test-notification'), testNotificationStatus = $('notification-test-status');
  let testingNotification = false;
  testNotification.disabled = true;
  if (typeof desktop?.notificationSettings === 'function') desktop.notificationSettings().then(s => {
    $('system-notifications').checked = s.enabled; $('system-notifications').disabled = !s.supported;
    testNotification.disabled = !s.supported || typeof desktop.testNotification !== 'function';
    if (!s.supported) testNotificationStatus.textContent = '当前系统不支持桌面提醒。';
    else if (typeof desktop.testNotification !== 'function') testNotificationStatus.textContent = '请重新打开更新后的 Noah，再测试系统提醒。';
  }).catch(() => { $('system-notifications').disabled = true; testNotificationStatus.textContent = '无法读取提醒设置，请重新打开 Noah 后重试。'; });
  else { $('system-notifications').disabled = true; $('notification-help').textContent = '系统提醒仅在 macOS 桌面应用中可用。'; testNotification.hidden = true; testNotificationStatus.hidden = true; }
  $('system-notifications').onchange = async () => {
    try { const s = await desktop.setNotificationsEnabled($('system-notifications').checked); $('system-notifications').checked = s.enabled; $('notification-help').textContent = s.enabled ? '已启用。只提醒新的待处理事项，实际显示受 macOS 通知设置影响。' : '已关闭系统提醒；待处理中心继续保留事项。'; }
    catch (e) { $('system-notifications').checked = !$('system-notifications').checked; $('notification-help').textContent = e.message; }
  };
  testNotification.onclick = async () => {
    if (testingNotification || testNotification.disabled || typeof desktop?.testNotification !== 'function') return;
    testingNotification = true; testNotification.disabled = true;
    testNotification.textContent = '正在发送…'; testNotificationStatus.textContent = '正在请求 macOS 显示一次测试提醒…';
    try {
      const result = await desktop.testNotification(selected || null);
      const statusText = {
        shown: '系统已返回显示回执。点击测试提醒可回到 Noah；若未看到，可查看通知中心。',
        submitted: '已向 macOS 提交，尚未收到显示确认。请查看通知中心或系统通知设置。',
        unsupported: '当前系统不支持桌面提醒。',
        failed: '系统未能显示测试提醒。请检查 macOS「系统设置 → 通知」中的 Noah 设置。',
      };
      testNotificationStatus.textContent = statusText[result?.status] || statusText.submitted;
    } catch { testNotificationStatus.textContent = '测试提醒未能发出。可以重试，或检查 macOS 通知设置。'; }
    finally { testingNotification = false; testNotification.disabled = false; testNotification.textContent = '发送测试提醒'; }
  };
  if (typeof desktop?.onOpenConversation === 'function') desktop.onOpenConversation(async id => {
    try { await uiReady; await refresh(); if (state.conversations.some(c => c.id === id)) await locate(id); }
    catch { notice('暂时无法打开提醒对应的讨论，请在讨论列表重试。'); }
  });
  if (typeof desktop?.releaseInfo === 'function') desktop.releaseInfo().then(info => { $('release-info').textContent = `Noah ${info.version || ''} · 本机开发构建。正式发行签名、公证和自动更新尚未配置。`; }).catch(() => {});

  function resetOutcome(evidenceId) {
    outcomeEdit = undefined; outcomeSubmission = undefined; $('outcome-form').reset(); $('outcome-kind').disabled = false; $('outcome-editor-title').textContent = '提出新的判断'; $('outcome-editor').open = !!evidenceId;
    const container = $('outcome-evidence'); container.replaceChildren();
    const messages = sharedMessages(outcomeDiscussion), candidates = messages.slice(-100);
    const selectedEvidence = messages.find(m => m.id === evidenceId);
    if (selectedEvidence && !candidates.some(m => m.id === evidenceId)) candidates.unshift(selectedEvidence);
    for (const m of candidates) {
      const label = node('label', 'evidence-option'), input = node('input'); input.type = 'checkbox'; input.value = m.id; input.checked = m.id === evidenceId;
      label.append(input, node('span', '', `${memberName(m.sender, outcomeDiscussion)}：${m.content.replace(/\s+/g, ' ').slice(0, 140)}`)); container.append(label);
    }
    if (!container.children.length) container.append(node('p', 'muted', '先发表共享消息，再引用它作为依据。'));
  }
  async function loadOutcomes() {
    const id = outcomeDiscussion, generation = ++outcomeGeneration;
    try { const data = await api(`/api/conversations/${id}/outcomes`); if (generation !== outcomeGeneration || id !== outcomeDiscussion) return; outcomeData = data; renderOutcomes(); }
    catch (e) { if (generation === outcomeGeneration) error('outcome-error', e.message); }
  }
  function renderOutcomes() {
    const list = $('outcome-list'); list.replaceChildren();
    const outcomes = outcomeData.outcomes || [];
    if (!outcomes.length) list.append(node('p', 'maturity-empty', '还没有结构化提议。引用一段讨论，记录你的判断或仍需解决的问题。'));
    for (const o of outcomes) {
      const row = node('section', 'outcome-record'); row.append(node('p', 'record-meta', `${kindNames[o.kind]} · ${memberName(o.author, outcomeDiscussion)} · v${o.current_revision} · ${o.status === 'confirmed' ? '你已确认此版本' : '待你确认'}`), node('h3', '', o.title), node('p', 'record-content', o.content));
      const evidence = node('div', 'inline-actions'); (o.evidence_message_ids || []).forEach((id, i) => evidence.append(button(`依据 ${i + 1}`, () => locate(outcomeDiscussion, id)))); row.append(evidence);
      if (!archived(outcomeDiscussion)) {
        const actions = node('div', 'inline-actions');
        actions.append(button(o.status === 'confirmed' ? '重新讨论' : '确认此提议', e => change('outcome-error', e.currentTarget, async () => { await api(`/api/conversations/${outcomeDiscussion}/outcomes/${o.id}/decision`, { decision: o.status === 'confirmed' ? 'reopened' : 'confirmed', expectedRevision: o.current_revision }); await loadOutcomes(); })));
        if (o.author === 'human') actions.append(button('修订我的提议', () => {
          resetOutcome(); outcomeEdit = o; $('outcome-kind').value = o.kind; $('outcome-kind').disabled = true; $('outcome-title').value = o.title; $('outcome-content').value = o.content; $('outcome-editor-title').textContent = `修订 v${o.current_revision}（保留旧版本）`; $('outcome-editor').open = true;
          const inputs = [...$('outcome-evidence').querySelectorAll('input')];
          for (const id of o.evidence_message_ids) { let input = inputs.find(n => n.value === id); if (!input) { const label = node('label', 'evidence-option'); input = node('input'); input.type = 'checkbox'; input.value = id; label.append(input, node('span', '', '此前引用的共享消息（保留引用）')); $('outcome-evidence').append(label); } input.checked = true; }
          $('outcome-title').focus();
        })); row.append(actions);
      }
      const versions = (outcomeData.revisions || outcomeData.outcomeRevisions || []).filter(r => r.outcome_id === o.id);
      const decisions = (outcomeData.decisions || outcomeData.outcomeDecisions || []).filter(r => r.outcome_id === o.id);
      if (versions.length > 1 || decisions.length) {
        const history = node('details', 'record-history'); history.append(node('summary', '', `版本与决定记录 · ${versions.length} 个版本`));
        for (const r of versions) history.append(node('strong', '', `v${r.revision} · ${r.title}`), node('p', 'record-content', r.content));
        for (const d of decisions) history.append(node('p', 'record-meta', `v${d.revision} · ${d.decision === 'confirmed' ? '用户确认' : '用户重新讨论'} · ${new Date(d.created_at).toLocaleString('zh-CN')}`)); row.append(history);
      }
      list.append(row);
    }
    $('outcome-form').hidden = archived(outcomeDiscussion);
  }
  function openOutcomes(evidenceId) {
    if (!selected) return; outcomeDiscussion = selected; outcomeKey = ''; error('outcome-error', '');
    outcomeData = { outcomes: (state.outcomes || []).filter(o => o.conversation_id === selected) }; resetOutcome(evidenceId); renderOutcomes(); openDialog('outcomes-dialog'); void loadOutcomes();
  }
  $('show-outcomes').onclick = () => openOutcomes(); $('cancel-outcome-edit').onclick = () => resetOutcome();
  function outcomeDraft() {
    return { kind: $('outcome-kind').value, title: $('outcome-title').value, content: $('outcome-content').value,
      evidenceMessageIds: [...$('outcome-evidence').querySelectorAll('input:checked')].map(n => n.value) };
  }
  $('outcome-form').onsubmit = async event => {
    event.preventDefault(); const id = outcomeDiscussion, editing = outcomeEdit;
    const draft = outcomeDraft(), { kind, ...data } = draft;
    if (!data.evidenceMessageIds.length) { error('outcome-error', '请至少选择一条共享消息作为依据。'); return; }
    const signature = JSON.stringify({ discussionId: id, outcomeId: editing?.id, revision: editing?.current_revision, ...draft });
    // An ambiguous response must not turn a retry into another proposal.
    if (outcomeSubmission?.signature !== signature) outcomeSubmission = { signature, key: crypto.randomUUID() };
    const submitted = outcomeSubmission;
    const ok = await change('outcome-error', event.submitter, () => api(`/api/conversations/${id}/outcomes${editing ? `/${editing.id}/revisions` : ''}`, editing ? { ...data, expectedRevision: editing.current_revision } : { ...data, kind, clientKey: submitted.key }));
    if (ok) {
      if (outcomeSubmission === submitted && JSON.stringify(outcomeDraft()) === JSON.stringify(draft)) resetOutcome();
      await loadOutcomes();
    }
  };

  async function loadWorkspaces() {
    const id = workspaceDiscussion, generation = ++workspaceGeneration;
    try { const data = await api(`/api/conversations/${id}/workspaces`); if (id !== workspaceDiscussion || generation !== workspaceGeneration) return; workspaceData = data; renderWorkspaces(); }
    catch (e) { if (generation === workspaceGeneration) error('workspace-error', e.message); }
  }
  function renderWorkspaces() {
    const list = $('workspace-list'); list.replaceChildren(); if (!workspaceData) { list.append(node('p', 'muted', '正在读取…')); return; }
    const grants = workspaceData.grants || [], current = grants.filter(g => !g.revoked_at);
    if (!current.length) list.append(node('p', 'maturity-empty', '尚未分享工作区路径。讨论消息与资料不受影响。'));
    for (const g of grants) {
      const row = node('div', 'maturity-row'), info = node('div', 'maturity-row-main'); info.append(node('strong', '', g.label + (g.revoked_at ? ' · 已撤销' : '')), node('p', 'path-label', g.root)); row.append(info);
      if (!g.revoked_at && !archived(workspaceDiscussion)) row.append(button('撤销', e => change('workspace-error', e.currentTarget, async () => { await api(`/api/conversations/${workspaceDiscussion}/workspaces/${g.id}/revoke`, {}); await loadWorkspaces(); }))); list.append(row);
    }
    if (workspaceData.conflicts?.length) list.append(node('p', 'conflict-note', `有 ${workspaceData.conflicts.length} 处可能重叠的修改，请先与相关成员协调。`));
    for (const i of workspaceData.intents || []) {
      const row = node('div', 'maturity-row'), info = node('div', 'maturity-row-main');
      const status = ({ active: '生效中', expired: '已到期', released: '已释放', revoked: '授权已撤销', left: '成员已退出', archived: '讨论已归档' })[i.state] || i.state;
      const overlap = workspaceData.conflicts?.some(c => c.intentIds.includes(i.id));
      info.append(node('strong', '', `${memberName(i.agent, workspaceDiscussion)} · ${status}${overlap ? ' · 路径重叠' : ''}`), node('p', 'path-label', i.path), node('p', 'muted', `${i.description} · ${new Date(i.expires_at).toLocaleTimeString('zh-CN')} 到期`)); row.append(info);
      if (i.agent === 'human' && i.state === 'active') row.append(button('释放', e => change('workspace-error', e.currentTarget, async () => { await api(`/api/conversations/${workspaceDiscussion}/work-intents/${i.id}/release`, {}); await loadWorkspaces(); }))); list.append(row);
    }
    $('intent-workspace').replaceChildren(...current.map(g => { const o = node('option', '', g.label); o.value = g.id; return o; }));
    $('workspace-form').hidden = archived(workspaceDiscussion); $('intent-form').hidden = !current.length || archived(workspaceDiscussion);
    list.append(node('p', 'muted', workspaceData.scope));
  }
  $('show-workspaces').onclick = () => { if (!selected) return; workspaceDiscussion = selected; workspaceData = undefined; error('workspace-error', ''); renderWorkspaces(); openDialog('workspaces-dialog'); void loadWorkspaces(); };
  $('workspace-form').onsubmit = async event => { event.preventDefault(); const id = workspaceDiscussion; await change('workspace-error', event.submitter, async current => { await api(`/api/conversations/${id}/workspaces`, { path: $('workspace-path').value }); if (current() && id === workspaceDiscussion) { $('workspace-path').value = ''; await loadWorkspaces(); } }); };
  $('intent-form').onsubmit = async event => { event.preventDefault(); const id = workspaceDiscussion; await change('workspace-error', event.submitter, async current => { await api(`/api/conversations/${id}/work-intents`, { workspace_id: $('intent-workspace').value, path: $('intent-path').value, description: $('intent-description').value, ttl_seconds: 900 }); if (current() && id === workspaceDiscussion) { $('intent-path').value = ''; $('intent-description').value = ''; await loadWorkspaces(); } }); };
  $('show-input-budget').onclick = () => {
    const c = state.conversations.find(c => c.id === selected); if (!c) return; budgetDiscussion = c.id; error('input-budget-error', '');
    $('input-budget-used').textContent = `已累计预留 ${(c.context_used_bytes / 1024).toFixed(1)} KiB；实际提交与观察指标见通信记录。`;
    $('input-budget-enabled').checked = c.context_budget_bytes != null; $('input-budget-value').value = String(Math.ceil((c.context_budget_bytes || 1048576) / 1024)); $('input-budget-enabled').onchange(); openDialog('input-budget-dialog');
  };
  $('input-budget-enabled').onchange = () => { $('input-budget-value-label').hidden = !$('input-budget-enabled').checked; $('input-budget-value').required = $('input-budget-enabled').checked; };
  $('input-budget-form').onsubmit = async event => {
    event.preventDefault(); const ok = await change('input-budget-error', event.submitter, () => api(`/api/conversations/${budgetDiscussion}/context-budget`, { contextBudgetBytes: $('input-budget-enabled').checked ? Number($('input-budget-value').value) * 1024 : null }));
    if (ok) { $('input-budget-dialog').close(); toast('输入预算已保存；没有自动继续讨论'); }
  };
  function materialVersions(material) {
    const all = state.materials.filter(m => m.conversation_id === material.conversation_id && (m.family_id || m.id) === (material.family_id || material.id)).sort((a, b) => (b.revision || 1) - (a.revision || 1));
    $('material-version').replaceChildren(...all.map(m => { const o = node('option', '', `v${m.revision || 1} · ${m.name}${m.id === all[0].id ? ' · 最新' : ''}`); o.value = m.id; return o; }));
    $('material-version').value = material.id; $('material-revise').disabled = archived(material.conversation_id) || all[0]?.id !== material.id;
  }
  $('material-version').onchange = () => { const m = state.materials.find(m => m.id === $('material-version').value); if (m) openMaterial(m); };
  $('material-revise').onclick = () => $('material-revision-file').click();
  $('material-revision-file').onchange = async () => {
    const file = $('material-revision-file').files[0], target = materialPreview; $('material-revision-file').value = ''; if (!file || !target) return;
    await change('material-error', $('material-revise'), async () => {
      const content = await materialText(file); const next = await api(`/api/conversations/${target.conversationId}/materials/${target.id}/revisions`, { name: file.name, content }); await refresh();
      if (selected === target.conversationId && materialPreview?.id === target.id && $('material-dialog').open) openMaterial(state.materials.find(m => m.id === next.id) || next);
    });
  };
  async function loadRuns() {
    const target = runsContext; if (!target || target.loading) return; target.loading = true; $('runs-more').disabled = true; error('runs-error', '');
    try {
      const query = new URLSearchParams({ agent: target.agent, limit: '20' }); if (target.before) query.set('before', target.before);
      const page = await api(`/api/conversations/${target.id}/runs?${query}`); if (target !== runsContext) return;
      for (const run of page.runs) { const detail = node('details', 'record-history'); detail.append(node('summary', '', `${new Date(run.started_at).toLocaleString('zh-CN')} · ${labels[run.status] || run.status}`), node('pre', 'private-output', run.output || '此次没有私有文本输出。')); $('runs-list').append(detail); }
      target.before = page.nextBefore; $('runs-more').hidden = !page.hasOlder;
      if (!$('runs-list').children.length) $('runs-list').append(node('p', 'maturity-empty', '此成员还没有受管运行记录。'));
    } catch (e) { if (target === runsContext) error('runs-error', e.message); }
    finally { target.loading = false; if (target === runsContext) $('runs-more').disabled = false; }
  }
  $('runs-more').onclick = () => void loadRuns();
  function privateOutput(session, container) {
    if (session.mode === 'external') return;
    container.append(button('查看私有运行输出', () => { runsContext = { id: session.conversation_id, agent: session.agent }; $('runs-heading').textContent = `${session.label} 的私有输出`; $('runs-list').replaceChildren(); $('runs-more').hidden = false; openDialog('runs-dialog'); void loadRuns(); }));
  }
  $('connect-grok').onclick = async () => {
    $('connect-grok').disabled = true; error('harness-error', '');
    try { grokSetup = await api('/api/grok-bridge-grants', {}); $('grok-bridge-setup').hidden = false; $('grok-hook-path').textContent = grokSetup.hookPath; $('grok-join-prompt').textContent = grokSetup.joinPrompt; $('grok-setup-instruction').textContent = grokSetup.setupInstruction; }
    catch (e) { error('harness-error', e.message); } finally { $('connect-grok').disabled = false; }
  };
  $('copy-grok-prompt').onclick = async () => { try { await navigator.clipboard.writeText(grokSetup.joinPrompt); toast('原会话连接请求已复制'); } catch { toast('请选择上方文字手动复制'); } };
  function renderMaturity() {
    if (!state) return;
    const c = state.conversations.find(c => c.id === selected), isArchived = !!c?.archived_at;
    for (const id of ['manage-members', 'show-outcomes', 'show-workspaces', 'archive-discussion']) $(id).disabled = !c;
    $('show-input-budget').disabled = !c || isArchived;
    $('archive-discussion').textContent = isArchived ? '恢复讨论（保持暂停）' : '归档讨论';
    const outcomes = (state.outcomes || []).filter(o => o.conversation_id === selected);
    $('outcome-count').textContent = String(outcomes.length); $('outcome-summary').textContent = outcomes[0] ? outcomes[0].title : '从共同依据中形成判断。';
    const metric = state.runMetrics?.find(m => m.conversation_id === selected);
    if (metric) $('usage-summary').textContent = (metric.measured_runs > 0 ? `${metric.prompt_starts} 次已计量受管提交 · ${(metric.input_bytes / 1024).toFixed(1)} KiB 新增输入。${metric.run_count - metric.measured_runs > 0 ? '部分旧运行没有输入计量。' : ''}` : metric.run_count > 0 ? '旧版运行未记录输入计量。' : '尚无受管输入提交。') + '原生正文观察与通知另行记录；字节不是 token，不推算费用。';
    renderAttention(); if ($('members-dialog').open) renderMembers();
    if ($('outcomes-dialog').open) { const key = JSON.stringify((state.outcomes || []).filter(o => o.conversation_id === outcomeDiscussion)); if (key !== outcomeKey) { outcomeKey = key; void loadOutcomes(); } }
  }
  window.noahMaturity = { render: renderMaturity, openOutcomes, privateOutput, materialVersions };
  if (state) renderMaturity();
})();
