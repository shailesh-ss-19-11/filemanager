// Compiles electron/native/mtp-helper.c against libmtp (macOS/Linux). Optional: the app works without it,
// only the "phone over USB" feature needs it.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

if (process.platform === 'win32') {
  console.log('MTP helper: skipped on Windows (Windows Explorer already mounts phones).');
  process.exit(0);
}
const src = path.join(__dirname, '..', 'electron', 'native', 'mtp-helper.c');
const out = path.join(__dirname, '..', 'electron', 'native', 'mtp-helper');
const flags = [];
try {
  const prefix = execFileSync('brew', ['--prefix', 'libmtp'], { encoding: 'utf8' }).trim();
  flags.push(`-I${prefix}/include`, `-L${prefix}/lib`, `-Wl,-rpath,${prefix}/lib`);
} catch {
  /* Linux or no brew: rely on system paths */
}
try {
  execFileSync('cc', ['-O2', src, '-o', out, ...flags, '-lmtp'], { stdio: 'inherit' });
  console.log('MTP helper built:', out);
} catch {
  console.warn('MTP helper not built. Install libmtp first (macOS: brew install libmtp) and run: npm run build:mtp');
}
