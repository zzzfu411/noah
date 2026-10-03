#!/usr/bin/env node
const { resolve } = require('node:path');
const { inspectMacBundle } = require('../desktop/release.cjs');
try {
  if (process.platform !== 'darwin') throw new Error('发行检查只用于 macOS');
  const bundle = process.argv[2] || resolve(__dirname, '../release/mac-arm64/Noah.app');
  const info = inspectMacBundle(bundle);
  const blockers = [];
  if (!info.signatureValid) blockers.push('应用签名完整性未通过');
  if (info.signing !== 'developer-id') blockers.push('尚无 Developer ID Application 发行签名');
  blockers.push('未配置并验证 Apple 公证', '未配置更新地址和已签名更新产物');
  process.stdout.write(JSON.stringify({ ...info, publicReleaseReady: false, blockers, checksAreReadOnly: true }, null, 2) + '\n');
  // A correctly signed local build is usable even though publication gates remain.
  if (!info.signatureValid) process.exitCode = 1;
} catch (error) { process.stderr.write(String(error.message || error) + '\n'); process.exitCode = 1; }
