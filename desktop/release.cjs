const { readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { execFileSync } = require('node:child_process');

const APP_ID = 'com.yeuxark.noah';
function bundleInfo(path) {
  const bundle = resolve(path);
  const plistPath = join(bundle, 'Contents/Info.plist');
  const packagePath = join(bundle, 'Contents/Resources/app/package.json');
  if (!existsSync(plistPath) || !existsSync(packagePath)) throw new Error('所选路径不是完整的 Noah.app');
  const plist = readFileSync(plistPath, 'utf8');
  const appId = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/)?.[1];
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (appId !== APP_ID || pkg.name !== 'noah-local' || typeof pkg.version !== 'string') throw new Error('应用标识不是 Noah，未执行替换');
  return { appId, version: pkg.version, path: bundle };
}
function inspectMacBundle(path, { verify = true, run = execFileSync } = {}) {
  const info = bundleInfo(path);
  let signing = 'unknown', signatureValid = null;
  try {
    // codesign reports identity on stderr, even on success.
    const { spawnSync } = require('node:child_process');
    const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', info.path], { encoding: 'utf8', timeout: 10000 });
    const details = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (result.status === 0) signing = /Signature=adhoc/.test(details) ? 'ad-hoc' : /Authority=Developer ID Application:/.test(details) ? 'developer-id' : 'other';
    else if (/not signed at all/.test(details)) signing = 'unsigned';
    if (verify) {
      try { run('/usr/bin/codesign', ['--verify', '--deep', '--strict', info.path], { stdio: 'pipe', timeout: 30000 }); signatureValid = true; }
      catch { signatureValid = false; }
    }
  } catch { /* Missing platform tools remain unknown; never call this a signed release. */ }
  return { ...info, signing, signatureValid, notarization: 'not-configured', automaticUpdates: 'not-configured', distribution: 'local-build' };
}
function releaseInfo({ version, packaged, platform, arch, bundlePath }) {
  const base = { version, platform, arch, packaged, distribution: packaged ? 'local-build' : 'development',
    signing: 'unknown', signatureValid: null, notarization: 'not-configured', automaticUpdates: 'not-configured' };
  if (platform === 'darwin' && packaged && bundlePath) {
    try { return { ...base, ...inspectMacBundle(bundlePath, { verify: false }) }; } catch { return base; }
  }
  return base;
}

module.exports = { APP_ID, bundleInfo, inspectMacBundle, releaseInfo };
