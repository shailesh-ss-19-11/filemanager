// Detects code editors/IDEs installed on this machine and opens paths in them.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

const EDITORS = [
  { id: 'vscode', name: 'VS Code', mac: /^Visual Studio Code\.app$/, win: [['Microsoft VS Code', 'Code.exe']], cmd: 'code' },
  { id: 'intellij', name: 'IntelliJ IDEA', mac: /^IntelliJ IDEA.*\.app$/, win: [['JetBrains', /^IntelliJ IDEA/, 'bin', 'idea64.exe']], cmd: 'idea' },
];

const safeReaddir = (d) => {
  try {
    return fs.readdirSync(d);
  } catch {
    return [];
  }
};

const onPath = (cmd) =>
  new Promise((resolve) => {
    execFile(isWin ? 'where' : 'which', [cmd], { windowsHide: true }, (err, out) => resolve(err ? null : out.split(/\r?\n/)[0] || null));
  });

// Resolve a Windows pattern list like ['JetBrains', /^IntelliJ/, 'bin', 'x.exe'] under a root.
function resolveWin(root, parts) {
  let cands = [root];
  for (const part of parts) {
    const next = [];
    for (const c of cands) {
      if (part instanceof RegExp) safeReaddir(c).filter((n) => part.test(n)).forEach((n) => next.push(path.join(c, n)));
      else next.push(path.join(c, part));
    }
    cands = next;
  }
  return cands.find((c) => fs.existsSync(c)) || null;
}

async function locate(ed) {
  if (isMac) {
    const dirs = ['/Applications', path.join(os.homedir(), 'Applications')];
    for (const d of dirs) {
      const hit = safeReaddir(d).find((n) => ed.mac.test(n));
      if (hit) return path.join(d, hit);
    }
    return null;
  }
  if (isWin) {
    const roots = [process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    for (const r of roots) for (const w of ed.win) {
      const hit = resolveWin(r, w);
      if (hit) return hit;
    }
  }
  return onPath(ed.cmd);
}

let cache = null;
async function installed() {
  if (!cache) {
    const found = await Promise.all(EDITORS.map(async (ed) => ({ id: ed.id, name: ed.name, target: await locate(ed) })));
    cache = found.filter((f) => f.target);
  }
  return cache;
}

async function list() {
  return (await installed()).map(({ id, name }) => ({ id, name }));
}

async function open(id, paths) {
  const ed = (await installed()).find((e) => e.id === id);
  if (!ed) return { ok: false, error: 'That editor is not installed.' };
  const [cmd, args, opts] = isMac
    ? ['open', ['-a', ed.target, ...paths], {}]
    : isWin && /\.(cmd|bat)$/i.test(ed.target)
      ? [ed.target, paths.map((p) => `"${p}"`), { shell: true }]
      : [ed.target, paths, {}];
  return new Promise((resolve) =>
    execFile(cmd, args, { windowsHide: true, ...opts }, (err) => resolve(err ? { ok: false, error: `Could not launch ${ed.name}.` } : { ok: true }))
  );
}

module.exports = { list, open };
