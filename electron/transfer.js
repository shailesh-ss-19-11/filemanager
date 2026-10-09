/**
 * Copy / move engine: local <-> local, local <-> remote (FTP, phone over USB) with progress, cancel
 * and conflict handling (keep both / replace / skip).
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const remote = require('./remote');
const fileops = require('./fileops');

const isWin = process.platform === 'win32';
const active = new Map(); // id -> { cancelled }

const lower = (p) => (isWin ? p.toLowerCase() : p);
const samePath = (a, b) => lower(path.resolve(a)) === lower(path.resolve(b));
function isInside(child, parent) {
  const c = lower(path.resolve(child));
  const p = lower(path.resolve(parent));
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
const exists = (p) =>
  fsp.lstat(p).then(
    () => true,
    () => false
  );
const childOf = (vdir, name) => (vdir.endsWith('/') ? vdir + name : `${vdir}/${name}`);
const baseOf = (p) => (remote.isRemote(p) ? remote.driverFor(p).baseName(p) : path.basename(p));

class Cancelled extends Error {
  constructor() {
    super('Cancelled');
    this.cancelled = true;
  }
}

function copyName(base, taken, isDir) {
  const dot = base.lastIndexOf('.');
  const stem = !isDir && dot > 0 ? base.slice(0, dot) : base;
  const ext = !isDir && dot > 0 ? base.slice(dot) : '';
  for (let n = 1; ; n++) {
    const cand = isWin
      ? n === 1 ? `${stem} - Copy${ext}` : `${stem} - Copy (${n})${ext}`
      : n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`;
    if (!taken.has(cand)) return cand;
  }
}

/** Names that already exist in `dest` for the items about to be pasted. */
async function conflicts(items, dest) {
  const out = [];
  let names = null;
  for (const src of items) {
    const base = baseOf(src);
    if (!remote.isRemote(src) && !remote.isRemote(dest) && samePath(path.dirname(src), dest)) continue;
    if (remote.isRemote(dest)) {
      names = names || (await remote.driverFor(dest).names(dest));
      if (names.has(base)) out.push(base);
    } else if (await exists(path.join(dest, base))) out.push(base);
  }
  return out;
}

/* ---------------------------- local copy with progress ---------------------------- */

// A small counting semaphore keeps thousands of parallel file operations from exhausting file handles.
function makeLimiter(max) {
  let running = 0;
  const waiting = [];
  const release = () => {
    running--;
    const next = waiting.shift();
    if (next) next();
  };
  return async (fn) => {
    if (running >= max) await new Promise((r) => waiting.push(r));
    running++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}
const fileLimit = makeLimiter(16);
const statLimit = makeLimiter(64);

async function sizeOfLocal(p) {
  const st = await statLimit(() => fsp.lstat(p));
  if (!st.isDirectory()) return st.size;
  const kids = await fsp.readdir(p);
  return (await Promise.all(kids.map((c) => sizeOfLocal(path.join(p, c))))).reduce((a, b) => a + b, 0);
}

function copyFileProgress(src, dest, ctl, onBytes) {
  return new Promise((resolve, reject) => {
    const rs = fs.createReadStream(src, { highWaterMark: 1 << 20 });
    const ws = fs.createWriteStream(dest, { flags: 'wx' });
    const fail = (err) => {
      rs.destroy();
      ws.destroy();
      fsp.rm(dest, { force: true }).finally(() => reject(err));
    };
    rs.on('data', (chunk) => {
      if (ctl.cancelled) return fail(new Cancelled());
      onBytes(chunk.length);
    });
    rs.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', resolve);
    rs.pipe(ws);
  });
}

async function copyTree(src, dest, ctl, onBytes) {
  if (ctl.cancelled) throw new Cancelled();
  const st = await fsp.lstat(src);
  if (st.isSymbolicLink()) {
    await fsp.symlink(await fsp.readlink(src), dest);
  } else if (st.isDirectory()) {
    await fsp.mkdir(dest);
    const kids = await fsp.readdir(src);
    await Promise.all(kids.map((c) => copyTree(path.join(src, c), path.join(dest, c), ctl, onBytes)));
    await fsp.chmod(dest, st.mode).catch(() => {});
    await fsp.utimes(dest, st.atime, st.mtime).catch(() => {});
  } else {
    await fileLimit(async () => {
      await copyFileProgress(src, dest, ctl, onBytes);
      await fsp.chmod(dest, st.mode).catch(() => {});
      await fsp.utimes(dest, st.atime, st.mtime).catch(() => {});
    });
  }
}

/* ---------------------------------- main entry ---------------------------------- */

async function run({ id, items, dest, mode, policy = 'keep', sizes = {}, resume = false, targets = {} }, send) {
  const ctl = { cancelled: false, interrupted: false };
  const usedTargets = {}; // phone item -> local copy, so a resume carries on into the same place
  const unfinished = new Set();
  active.set(id, ctl);
  remote.invalidate();
  const errors = [];
  const pasted = [];
  const list = items || [];

  // total bytes (remote -> remote counts twice: download + upload)
  let total = 0;
  for (const src of list) {
    let n = 0;
    try {
      if (remote.isRemote(src)) {
        n = sizes[src] ?? 0;
        if (!n) {
          const r = await remote.folderSize(src);
          n = r.ok ? r.size : 0;
        }
      } else n = await sizeOfLocal(src);
    } catch {
      /* unknown size: indeterminate */
    }
    total += remote.isRemote(src) && remote.isRemote(dest) ? n * 2 : n;
  }

  let done = 0;
  let current = '';
  const started = Date.now();
  let lastSend = 0;
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastSend < 120) return;
    lastSend = now;
    send({ id, state: 'running', current, done, total, items: list.length, elapsed: now - started });
  };
  const onBytes = (n) => {
    const first = done === 0;
    done += n;
    emit(first);
  };

  const takenCache = new Map();
  const takenFor = (dir) => {
    if (!takenCache.has(dir)) takenCache.set(dir, fsp.readdir(dir).then((n) => new Set(n)));
    return takenCache.get(dir);
  };
  const pastedAt = new Array(list.length);

  const processOne = async (i) => {
    const src = list[i];
    const base = baseOf(src);
    current = base;
    emit(false);
    try {
      if (ctl.cancelled) throw new Cancelled();
      const srcRemote = remote.isRemote(src);
      const destRemote = remote.isRemote(dest);

      if (!srcRemote && !destRemote) {
        /* ---------- local -> local ---------- */
        // (cheap string test first: only stat the source when dest could be inside it)
        if (isInside(dest, src) && (await fsp.stat(src)).isDirectory()) {
          errors.push(`Can't paste "${base}" into itself.`);
          return;
        }
        const sameDir = samePath(path.dirname(src), dest);
        if (mode === 'cut' && sameDir) {
          (pastedAt[i] = src);
          return;
        }
        let target = path.join(dest, base);
        if (await exists(target)) {
          if (sameDir || policy === 'keep') {
            const isDir = (await fsp.stat(src)).isDirectory();
            const taken = await takenFor(dest);
            const name = copyName(base, taken, isDir);
            taken.add(name);
            target = path.join(dest, name);
          } else if (policy === 'skip') return;
          else await fsp.rm(target, { recursive: true, force: true }); // replace
        }
        if (mode === 'cut') {
          try {
            await fsp.rename(src, target);
          } catch (err) {
            if (err.code !== 'EXDEV') throw err;
            await copyTree(src, target, ctl, onBytes);
            await fsp.rm(src, { recursive: true, force: true });
          }
        } else {
          try {
            await copyTree(src, target, ctl, onBytes);
          } catch (err) {
            await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
            throw err;
          }
        }
        (pastedAt[i] = target);
      } else if (!srcRemote && destRemote) {
        /* ---------- local -> remote ---------- */
        const d = remote.driverFor(dest);
        const name = await resolveRemoteName(d, dest, base, policy, (await fsp.stat(src)).isDirectory());
        if (name === null) return;
        (pastedAt[i] = await d.upload(src, dest, name, onBytes));
        if (mode === 'cut') await fsp.rm(src, { recursive: true, force: true });
      } else if (srcRemote && !destRemote) {
        /* ---------- remote -> local ---------- */
        const sd = remote.driverFor(src);
        const resuming = resume && !!targets[src];
        let target = resuming ? targets[src] : path.join(dest, base);
        try {
          if (!resuming) {
            const isDir = await sd.isDir(src);
            if (await exists(target)) {
              if (policy === 'skip') return;
              if (policy === 'replace') await fsp.rm(target, { recursive: true, force: true });
              else {
                const taken = await takenFor(dest);
                const name = copyName(base, taken, isDir);
                taken.add(name);
                target = path.join(dest, name);
              }
            }
          }
          usedTargets[src] = target;
          await sd.download(src, target, onBytes, { resume: resuming });
        } catch (err) {
          if (sd.isInterruption && sd.isInterruption(err) && !ctl.cancelled) {
            // phone unplugged / locked: keep what arrived so far so it can be resumed
            ctl.interrupted = true;
            unfinished.add(i);
            if (sd.reset) sd.reset();
            errors.push(`${base}: ${(err && err.message) || 'The phone was disconnected.'}`);
            return;
          }
          await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
          throw err;
        }
        (pastedAt[i] = target);
        if (mode === 'cut') await sd.remove(src);
      } else {
        /* ---------- remote -> remote (staged through a temp folder) ---------- */
        if (src === dest) {
          errors.push(`Can't paste "${base}" into itself.`);
          return;
        }
        const sd = remote.driverFor(src);
        const dd = remote.driverFor(dest);
        const name = await resolveRemoteName(dd, dest, base, policy, await sd.isDir(src));
        if (name === null) return;
        const tmp = await remote.tempDir();
        try {
          const staged = path.join(tmp, base);
          await sd.download(src, staged, onBytes);
          (pastedAt[i] = await dd.upload(staged, dest, name, onBytes));
        } finally {
          fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
        }
        if (mode === 'cut') await sd.remove(src);
      }
    } catch (err) {
      if ((err && err.cancelled) || ctl.cancelled) {
        ctl.cancelled = true;
        return;
      }
      errors.push(`${base}: ${(err && err.message) || 'Something went wrong.'}`);
    }
  };

  // Local-to-local copies/moves of many items run several at a time; phone/FTP transfers stay
  // one at a time (they share a single connection).
  const allLocal = !remote.isRemote(dest) && !list.some((p) => remote.isRemote(p));
  let next = 0;
  const worker = async () => {
    while (next < list.length && !ctl.cancelled && !ctl.interrupted) await processOne(next++);
  };
  emit(true);
  await Promise.all(Array.from({ length: allLocal ? Math.min(8, list.length) : 1 }, worker));
  for (const p of pastedAt) if (p) pasted.push(p);
  if (ctl.cancelled) {
    send({ id, state: 'cancelled', done, total });
    active.delete(id);
    remote.invalidate();
    return { ok: false, cancelled: true, pasted, errors };
  }

  if (ctl.interrupted) {
    // everything from the interrupted item onward still has to be copied
    const first = Math.min(...unfinished);
    const rest = list.slice(first);
    const resumeInfo = { items: rest, dest, mode, policy, targets: usedTargets, done, total };
    send({ id, state: 'interrupted', done, total, resume: resumeInfo });
    active.delete(id);
    remote.invalidate();
    return { ok: false, interrupted: true, pasted, errors, resume: resumeInfo };
  }

  active.delete(id);
  remote.invalidate();
  send({ id, state: 'done', done, total });
  return { ok: errors.length === 0, pasted, errors };
}

async function resolveRemoteName(driver, vdir, base, policy, isDir) {
  const names = await driver.names(vdir);
  if (!names.has(base)) return base;
  if (policy === 'skip') return null;
  if (policy === 'replace') {
    await driver.remove(childOf(vdir, base));
    return base;
  }
  return copyName(base, names, isDir);
}

/**
 * Delete (or trash) items with progress by item count. `trashFn(path)` moves a local item to the Trash;
 * with `permanent` local items are removed outright. Phone/FTP items are always deleted for good.
 */
async function deleteItems({ id, paths, permanent }, send, trashFn) {
  const ctl = { cancelled: false };
  active.set(id, ctl);
  remote.invalidate();
  const errors = [];
  const started = Date.now();
  let done = 0;
  let inner = 0; // objects removed inside the current folder (phone)
  let current = '';
  let lastSend = 0;
  const emit = (force) => {
    const now = Date.now();
    if (!force && now - lastSend < 120) return;
    lastSend = now;
    send({ id, state: 'running', label: 'Deleting', unit: 'items', current, done, total: paths.length, sub: inner, items: paths.length, elapsed: now - started });
  };
  const deleteOne = async (p) => {
    current = baseOf(p);
    emit(false);
    try {
      if (remote.isRemote(p)) {
        inner = 0;
        await remote.driverFor(p).remove(p, () => {
          inner++;
          emit(false);
        });
      } else if (permanent) {
        await fsp.rm(p, { recursive: true, force: true });
      } else {
        await trashFn(p);
      }
    } catch (err) {
      if (!ctl.cancelled) errors.push(`${baseOf(p)}: ${(err && err.message) || 'Something went wrong.'}`);
    }
    done++;
    emit(false);
  };
  // local items go several at a time; phone/FTP items share one connection, so one at a time
  const parallel = paths.every((p) => !remote.isRemote(p)) ? 8 : 1;
  let nextIdx = 0;
  emit(true);
  await Promise.all(
    Array.from({ length: Math.min(parallel, paths.length) }, async () => {
      while (nextIdx < paths.length && !ctl.cancelled) await deleteOne(paths[nextIdx++]);
    })
  );
  const cancelled = ctl.cancelled;
  active.delete(id);
  remote.invalidate();
  send({ id, state: cancelled ? 'cancelled' : 'done', done, total: paths.length });
  return { ok: errors.length === 0, errors, cancelled, deleted: done };
}

/** Shared plumbing for tasks on phone/FTP files: temp folder, byte progress, cancel. */
async function task({ id, label, items }, send, work) {
  const ctl = { cancelled: false };
  active.set(id, ctl);
  remote.invalidate();
  const started = Date.now();
  let done = 0;
  let lastSend = 0;
  const emit = (current, force) => {
    const now = Date.now();
    if (!force && now - lastSend < 120) return;
    lastSend = now;
    send({ id, state: 'running', label, current, done, total: 0, items, elapsed: now - started });
  };
  const tmp = await remote.tempDir();
  try {
    const out = await work(tmp, (n) => {
      done += n;
      emit('', false);
    }, (current) => emit(current, true), ctl);
    send({ id, state: 'done', done, total: 0 });
    return { ok: true, path: out };
  } catch (err) {
    send({ id, state: ctl.cancelled ? 'cancelled' : 'error', done, total: 0 });
    return { ok: false, cancelled: ctl.cancelled, error: ctl.cancelled ? 'Cancelled.' : (err && err.message) || 'Something went wrong.' };
  } finally {
    active.delete(id);
    remote.invalidate();
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** Zip files that live on the phone / FTP server and put the .zip next to them. */
function compressRemote({ id, paths }, send) {
  const dir = paths[0].replace(/\/[^/]*$/, '') || paths[0];
  const d = remote.driverFor(paths[0]);
  const parent = dir.endsWith(':') ? dir + '/' : dir;
  return task({ id, label: 'Compressing', items: paths.length }, send, async (tmp, onBytes, say) => {
    const names = [];
    for (const p of paths) {
      say(d.baseName(p));
      await d.download(p, path.join(tmp, d.baseName(p)), onBytes);
      names.push(path.join(tmp, d.baseName(p)));
    }
    say('Creating the ZIP…');
    const zip = await fileops.compress(names);
    const taken = await d.names(parent);
    const stem = path.basename(zip, '.zip');
    let name = `${stem}.zip`;
    for (let n = 2; taken.has(name); n++) name = `${stem} ${n}.zip`;
    say(name);
    return d.upload(zip, parent, name, onBytes);
  });
}

/** Extract a .zip/.tar.* stored on the phone / FTP server into a new folder next to it. */
function extractRemote({ id, path: vp }, send) {
  const d = remote.driverFor(vp);
  const parent = vp.replace(/\/[^/]*$/, '') || vp;
  return task({ id, label: 'Extracting', items: 1 }, send, async (tmp, onBytes, say) => {
    const base = d.baseName(vp);
    say(base);
    const local = path.join(tmp, base);
    await d.download(vp, local, onBytes);
    say('Unpacking…');
    const out = await fileops.extract(local);
    const taken = await d.names(parent);
    let name = path.basename(out);
    for (let n = 2; taken.has(name); n++) name = `${path.basename(out)} ${n}`;
    say(name);
    return d.upload(out, parent, name, onBytes);
  });
}

/** Throw away the half-copied files of an interrupted transfer. */
async function discard(targets) {
  for (const t of Object.values(targets || {})) {
    if (typeof t === 'string' && t) await fsp.rm(t, { recursive: true, force: true }).catch(() => {});
  }
}

function cancel(id) {
  const ctl = active.get(id);
  if (!ctl) return;
  ctl.cancelled = true;
  remote.cancelAll(); // interrupts a phone/FTP transfer that is mid-file
}

module.exports = { run, cancel, discard, conflicts, compressRemote, extractRemote, deleteItems };
