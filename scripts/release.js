// Builds the macOS app and publishes it to GitHub Releases (the project's download hub).
//   npm run release            build + upload to release v<version> (creates it, or replaces the files)
//   npm run release -- --draft create the release as a draft instead of publishing it
// Needs the GitHub CLI signed in:  gh auth login
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const tag = `v${pkg.version}`;
const draft = process.argv.includes('--draft');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });

if (spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status !== 0) {
  console.error('GitHub CLI is not signed in. Run: gh auth login');
  process.exit(1);
}

console.log(`\n▶ Building ${pkg.productName} ${pkg.version}…`);
run('npm', ['run', 'dist:mac']);

const out = path.join(root, 'release');
const files = fs
  .readdirSync(out)
  .filter((f) => /\.(dmg|zip)$/.test(f) && !f.endsWith('.blockmap'))
  .map((f) => path.join(out, f));
if (!files.length) {
  console.error('No .dmg/.zip found in release/.');
  process.exit(1);
}

const exists = spawnSync('gh', ['release', 'view', tag], { cwd: root, stdio: 'ignore' }).status === 0;
if (exists) {
  console.log(`\n▶ Release ${tag} exists — replacing its files…`);
  run('gh', ['release', 'upload', tag, ...files, '--clobber']);
} else {
  console.log(`\n▶ Creating release ${tag}…`);
  run('gh', [
    'release', 'create', tag, ...files,
    '--title', `${pkg.productName} ${pkg.version}`,
    '--generate-notes',
    ...(draft ? ['--draft'] : []),
  ]);
}
const url = execFileSync('gh', ['release', 'view', tag, '--json', 'url', '-q', '.url'], { cwd: root }).toString().trim();
console.log(`\n✔ Download page: ${url}`);
