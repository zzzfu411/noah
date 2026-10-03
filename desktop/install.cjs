const { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, closeSync } = require('node:fs');
const { dirname, join, resolve, basename } = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { bundleInfo } = require('./release.cjs');

function assertStopped(bundlePath) {
  const executable = join(resolve(bundlePath), 'Contents/MacOS/Noah');
  const commands = execFileSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8', timeout: 5000 });
  if (commands.split('\n').some(command => command.trim() === executable)) throw new Error('请先退出所选 Noah 应用，再安装或回退');
}
function installPlan(source, destination) {
  const incoming = bundleInfo(source);
  const target = resolve(destination);
  if (basename(target) !== 'Noah.app') throw new Error('目标应用名称必须是 Noah.app');
  if (target === incoming.path || target.startsWith(incoming.path + '/') || incoming.path.startsWith(target + '/')) throw new Error('源应用与安装目标必须分开');
  const existing = existsSync(target) ? bundleInfo(target) : null;
  return { source: incoming.path, destination: target, version: incoming.version, replacingVersion: existing?.version || null,
    dataAction: 'preserve', backupDirectory: join(dirname(target), '.noah-install-backups'), applied: false };
}
function withLock(directory, run) {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, '.Noah-install.lock');
  let fd;
  try { fd = openSync(path, 'wx', 0o600); }
  catch { throw new Error('已有安装或回退正在进行；如操作曾异常退出，请先核对 .Noah-install.lock'); }
  try { return run(); }
  finally { closeSync(fd); rmSync(path); }
}
function writeReceipt(path, value) {
  const temporary = path + '.tmp';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temporary, path);
}
function installLocal(source, destination, { apply = false, stopped = assertStopped, verify = () => {} } = {}) {
  const plan = installPlan(source, destination);
  if (!apply) return plan;
  stopped(plan.source); stopped(plan.destination);
  verify(plan.source);
  return withLock(dirname(plan.destination), () => {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    const directory = join(plan.backupDirectory, id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const staged = join(dirname(plan.destination), `.Noah-install-${id}.app`);
    const previous = plan.replacingVersion ? join(directory, 'previous-Noah.app') : null;
    const receiptPath = join(directory, 'receipt.json');
    const receipt = { schemaVersion: 1, ...plan, previous, receiptPath, state: 'prepared', applied: false };
    writeReceipt(receiptPath, receipt);
    try {
      cpSync(plan.source, staged, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
      verify(staged);
      stopped(plan.destination);
      if (previous) renameSync(plan.destination, previous);
      let swapped = false;
      try {
        renameSync(staged, plan.destination); swapped = true;
        receipt.state = 'installed'; receipt.applied = true;
        writeReceipt(receiptPath, receipt);
      } catch (error) {
        if (swapped) renameSync(plan.destination, staged);
        if (previous && existsSync(previous)) renameSync(previous, plan.destination);
        throw error;
      }
      return receipt;
    } catch (error) {
      // Only remove the staging copy created by this transaction. Existing apps
      // and all user data remain in place or in the recorded backup directory.
      rmSync(staged, { recursive: true, force: true });
      throw error;
    }
  });
}
function rollbackLocal(path, { apply = false, stopped = assertStopped } = {}) {
  const receiptPath = resolve(path);
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  if (receipt?.schemaVersion !== 1 || receipt.state !== 'installed' || receipt.receiptPath !== receiptPath ||
      typeof receipt.destination !== 'string' || basename(receipt.destination) !== 'Noah.app' ||
      dirname(dirname(receiptPath)) !== join(dirname(receipt.destination), '.noah-install-backups') ||
      (receipt.previous !== null && receipt.previous !== join(dirname(receiptPath), 'previous-Noah.app'))) throw new Error('不是可回退的 Noah 安装记录');
  const current = bundleInfo(receipt.destination);
  if (receipt.previous) bundleInfo(receipt.previous);
  const retained = join(dirname(receiptPath), 'reverted-Noah.app');
  if (existsSync(retained)) throw new Error('回退目录已存在，请核对已有安装记录');
  const plan = { destination: receipt.destination, removingVersion: current.version, restore: receipt.previous,
    retained, dataAction: 'preserve', applied: false };
  if (!apply) return plan;
  stopped(receipt.destination);
  return withLock(dirname(receipt.destination), () => {
    renameSync(receipt.destination, retained);
    try { if (receipt.previous) renameSync(receipt.previous, receipt.destination); }
    catch (error) { renameSync(retained, receipt.destination); throw error; }
    receipt.state = 'rolled-back'; receipt.retained = retained;
    writeReceipt(receiptPath, receipt);
    return { ...plan, applied: true };
  });
}

module.exports = { assertStopped, installPlan, installLocal, rollbackLocal };
