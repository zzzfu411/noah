const { mkdirSync, readFileSync, writeFileSync, renameSync } = require('node:fs');
const { dirname } = require('node:path');

function validateUiState(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.drafts) || value.drafts.length > 1000) throw new Error('Invalid desktop UI state');
  if (value.selectedTaskId !== undefined && value.selectedTaskId !== null && (typeof value.selectedTaskId !== 'string' || value.selectedTaskId.length > 100)) throw new Error('Invalid selected task');
  if (value.appearance !== undefined && !['system', 'light', 'dark'].includes(value.appearance)) throw new Error('Invalid desktop appearance');
  for (const draft of value.drafts) {
    if (!draft || typeof draft.conversationId !== 'string' || draft.conversationId.length > 100 ||
        typeof draft.content !== 'string' || draft.content.length > 64000 || typeof draft.recipient !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(draft.recipient) || draft.recipient === 'human' ||
        !Number.isFinite(draft.updatedAt)) throw new Error('Invalid task draft');
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw new Error('Desktop UI state exceeds 2 MiB');
  return JSON.parse(json);
}
function readState(path, fallback = {}) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}
function writeState(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.tmp';
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
}
module.exports = { validateUiState, readState, writeState };
