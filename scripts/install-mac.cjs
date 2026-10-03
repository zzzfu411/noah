#!/usr/bin/env node
const { join, resolve } = require('node:path');
const { homedir } = require('node:os');
const { installLocal, rollbackLocal } = require('../desktop/install.cjs');
const { inspectMacBundle } = require('../desktop/release.cjs');

try {
  if (process.platform !== 'darwin') throw new Error('本机安装工具只用于 macOS');
  const args = process.argv.slice(2);
  let apply = false, source = resolve(__dirname, '../release/mac-arm64/Noah.app');
  let destination = join(homedir(), 'Applications/Noah.app'), rollback;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--apply') apply = true;
    else if (['--source', '--destination', '--rollback'].includes(flag) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const value = resolve(args[++i]);
      if (flag === '--source') source = value;
      if (flag === '--destination') destination = value;
      if (flag === '--rollback') rollback = value;
    } else throw new Error('用法：node scripts/install-mac.cjs [--source Noah.app] [--destination ~/Applications/Noah.app] [--apply]，或 --rollback receipt.json [--apply]');
  }
  const verify = path => {
    const result = inspectMacBundle(path);
    if (result.signatureValid !== true) throw new Error('应用签名完整性检查未通过，未替换现有应用');
  };
  const result = rollback ? rollbackLocal(rollback, { apply }) : installLocal(source, destination, { apply, verify });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!apply) process.stdout.write('以上仅预览；确认目标后加 --apply 执行。用户数据不会随应用替换或回退。\n');
  else process.stdout.write('已完成本机应用操作。此构建尚未配置 Developer ID、公证或自动更新，不等于正式发行。\n');
} catch (error) { process.stderr.write(String(error.message || error) + '\n'); process.exitCode = 1; }
