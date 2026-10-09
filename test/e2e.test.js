/** Drives the real Electron app (UI) with Playwright. Run: npm run test:e2e */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { tmp, makeDocx, makePptx, makeXlsx, startFtp } = require('./helpers');

const SHOTS = process.env.FM_SHOTS || null;
let app, page, root;
const write = (p, c = 'x') => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, c));
const shot = async (name) => SHOTS && (fs.mkdirSync(SHOTS, { recursive: true }), page.screenshot({ path: path.join(SHOTS, name + '.png') }));
const row = (name) => page.locator(`.row[data-path$="/${name}"], .tile[data-path$="/${name}"]`).first();
const ctx = async (name, item) => {
  await row(name).click({ button: 'right' });
  await page.locator('.context-menu .cm-item', { hasText: item }).first().click();
};

const more = async (label) => {
  await page.locator('.dropdown', { hasText: 'More' }).locator('button').first().click();
  await page.locator('.dd-menu .dd-item', { hasText: label }).first().click();
};

test.before(async () => {
  root = fs.realpathSync(tmp());
  write(path.join(root, 'notes.txt'), 'hello notes');
  write(path.join(root, 'photo.jpg'), 'jpgdata');
  write(path.join(root, 'sub/notes.txt'), 'older');
  write(path.join(root, 'data/a.csv'), '1,2');
  app = await electron.launch({ args: ['.', `--user-data-dir=${tmp()}`], env: { ...process.env, FM_START_PATH: root } });
  page = await app.firstWindow();
  await page.waitForSelector('.row[data-path]', { timeout: 20000 });
});
test.after(async () => app && (await app.close()));

test('lists the folder and shows disk space in the status bar', async () => {
  await shot('01-list');
  assert.ok(await row('notes.txt').count());
  await page.waitForFunction(() => /free of .* used/.test(document.querySelector('.statusbar')?.innerText || ''), null, { timeout: 15000 });
});

test('file menu has an "Open with" submenu; folder menu offers installed editors', async () => {
  const editors = await page.evaluate(() => window.fsApi.editors());
  await row('notes.txt').click({ button: 'right' });
  await page.locator('.context-menu .cm-sub-wrap', { hasText: 'Open with' }).hover();
  const sub = page.locator('.cm-submenu');
  await sub.waitFor();
  assert.ok(await sub.locator('.cm-item', { hasText: 'Choose another app' }).count());
  for (const ed of editors) assert.ok(await sub.locator('.cm-item', { hasText: ed.name }).count(), ed.name);
  await page.mouse.click(5, 5);
  await page.locator('.context-menu').waitFor({ state: 'detached' });

  await row('sub').click({ button: 'right' });
  const items = await page.locator('.context-menu > .cm-item').allInnerTexts();
  for (const ed of editors) assert.ok(items.some((t) => t.includes(`Open folder in ${ed.name}`)), ed.name);
  await page.mouse.click(5, 5);
  await page.locator('.context-menu').waitFor({ state: 'detached' });
});

test('sidebar shows drives with a usage bar', async () => {
  await page.waitForSelector('.drive-bar', { timeout: 15000 });
  assert.match(await page.locator('.drive-text').first().innerText(), /free of/);
});

test('Properties dialog shows size and attributes', async () => {
  await ctx('notes.txt', 'Properties');
  await page.waitForSelector('.modal.props');
  const text = await page.locator('.modal.props').innerText();
  assert.match(text, /Size/);
  assert.match(text, /Read-only/);
  await shot('02-properties');
  await page.keyboard.press('Escape');
});

test('Compress to ZIP then Extract here', async () => {
  await ctx('data', 'Compress to ZIP');
  await page.waitForSelector('.row[data-path$="/data.zip"]');
  assert.ok(fs.existsSync(path.join(root, 'data.zip')));
  await ctx('data.zip', 'Extract here');
  await page.waitForSelector('.row[data-path$="/data 2"]');
  assert.ok(fs.existsSync(path.join(root, 'data 2/data/a.csv')));
});

test('Hide, then Undo brings it back', async () => {
  await ctx('photo.jpg', 'Hide');
  await page.waitForSelector('.row[data-path$="/photo.jpg"]', { state: 'detached' });
  await more('Undo'); // (menu accelerators like ⌘Z are handled by the native menu, which Playwright can't press)
  await page.waitForSelector('.row[data-path$="/photo.jpg"]');
});

test('copy into a folder with the same name asks Replace / Keep both / Skip', async () => {
  await ctx('notes.txt', 'Copy');
  await row('sub').dblclick();
  await page.waitForSelector('.row[data-path$="/sub/notes.txt"]');
  await page.locator('.commandbar button', { hasText: 'Paste' }).click();
  await page.waitForSelector('.modal.confirm');
  await shot('03-conflict');
  await page.locator('.conflict-actions button', { hasText: 'Keep both' }).click();
  await page.waitForSelector('.row[data-path$="/sub/notes copy.txt"]');
  assert.equal(fs.readFileSync(path.join(root, 'sub/notes.txt'), 'utf8'), 'older');
});

test('More menu lists the Explorer-style actions', async () => {
  await page.locator('.dropdown', { hasText: 'More' }).locator('button').first().click();
  const menu = await page.locator('.dd-menu').innerText();
  for (const label of ['Compress to ZIP', 'Extract here', 'Hide', 'Unhide', 'Copy to', 'Move to', 'Properties', 'Invert selection']) {
    assert.ok(menu.includes(label), `More menu has ${label}`);
  }
  await shot('04-more-menu');
  await page.keyboard.press('Escape');
});

test('drag a file onto a folder moves it; Alt-drag copies it', async () => {
  await page.locator('.breadcrumbs, .crumbs').getByRole('button').nth(-2).click(); // back to the test root
  await page.waitForSelector('.row[data-path$="/notes.txt"]');
  write(path.join(root, 'moveme.txt'), 'm');
  write(path.join(root, 'copyme.txt'), 'c');
  await page.locator('button[aria-label="Refresh"]').click();
  await page.waitForSelector('.row[data-path$="/moveme.txt"]');
  await row('moveme.txt').dragTo(row('data'));
  await page.waitForSelector('.row[data-path$="/moveme.txt"]', { state: 'detached' });
  assert.ok(fs.existsSync(path.join(root, 'data/moveme.txt')));
  assert.ok(!fs.existsSync(path.join(root, 'moveme.txt')));

  await page.keyboard.down('Alt');
  await row('copyme.txt').dragTo(row('data'));
  await page.keyboard.up('Alt');
  await page.waitForFunction((p) => true, 0);
  await new Promise((r) => setTimeout(r, 600));
  assert.ok(fs.existsSync(path.join(root, 'data/copyme.txt')));
  assert.ok(fs.existsSync(path.join(root, 'copyme.txt')), 'Alt-drag keeps the original');
  await shot('05-after-drag');
});

test('Space previews a text file and an image; arrows move; Esc closes', async () => {
  await page.locator('button[aria-label="Refresh"]').click();
  write(path.join(root, 'readme.md'), '# Hello preview');
  // a real 1x1 PNG
  fs.writeFileSync(path.join(root, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'));
  await page.locator('button[aria-label="Refresh"]').click();
  await row('readme.md').click();
  await page.keyboard.press(' ');
  await page.waitForSelector('.preview-text');
  assert.match(await page.locator('.preview-text').innerText(), /Hello preview/);
  await shot('06-preview-text');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.preview-modal', { state: 'detached' });

  await row('pixel.png').click();
  await page.keyboard.press(' ');
  await page.waitForSelector('img.preview-media');
  const ok = await page.locator('img.preview-media').evaluate((img) => img.complete && img.naturalWidth === 1);
  assert.ok(ok, 'image loaded through fmfile://');
  await page.keyboard.press(' ');
  await page.waitForSelector('.preview-modal', { state: 'detached' });
});

test('Pin a folder to the sidebar, navigate via it, unpin', async () => {
  await ctx('data', 'Pin to sidebar');
  const pinned = page.locator('.sidebar .side-row', { hasText: 'data' });
  await pinned.waitFor();
  await pinned.locator('.side-item').click();
  await page.waitForSelector('.row[data-path$="/data/a.csv"]');
  await shot('07-pinned');
  await pinned.hover();
  await pinned.locator('.side-x').click();
  await pinned.waitFor({ state: 'detached' });
});

test('Clean up: finds a large file, filters by type, deletes it (to the Trash)', async () => {
  // sparse 150 MB video-ish file + two identical 2 MB files
  const big = path.join(root, 'huge-clip.mp4');
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, 150 * 1024 * 1024);
  write(path.join(root, 'dup1.bin'), Buffer.alloc(2 * 1024 * 1024, 9));
  write(path.join(root, 'dup2.bin'), Buffer.alloc(2 * 1024 * 1024, 9));
  await page.locator('button[aria-label="Up one level"]').click(); // previous test left us inside data/
  await page.waitForSelector('.row[data-path$="/notes.txt"]');
  await page.locator('.sidebar .side-item', { hasText: 'Clean up' }).click();
  await page.waitForSelector('.cleanup-row');
  assert.match(await page.locator('.cleanup-body').innerText(), /huge-clip\.mp4/);
  await shot('08-cleanup-large');
  // type filter chips
  await page.locator('.cleanup-filters .chip', { hasText: 'Videos' }).click();
  assert.equal(await page.locator('.cleanup-row').count(), 1);
  await page.locator('.cleanup-filters .chip', { hasText: 'Images' }).count(); // chip only exists for present kinds
  // duplicates tab groups the identical files
  await page.locator('.cleanup-tabs button', { hasText: 'Duplicates' }).click();
  await page.waitForSelector('.cleanup-row');
  const dupText = await page.locator('.cleanup-body').innerText();
  assert.match(dupText, /dup1\.bin/);
  assert.match(dupText, /dup2\.bin/);
  await page.locator('.cleanup-actions button', { hasText: 'extra copies' }).click();
  assert.equal(await page.locator('.cleanup-row input:checked').count(), 1);
  // caches tab loads
  await page.locator('.cleanup-tabs button', { hasText: 'Caches' }).click();
  await page.waitForSelector('.cleanup-note');
  // back to large files and delete the clip
  await page.locator('.cleanup-tabs button', { hasText: 'Large files' }).click();
  await page.locator('.cleanup-row', { hasText: 'huge-clip.mp4' }).locator('.icon-btn').click();
  await page.waitForFunction(() => !document.body.innerText.includes('huge-clip.mp4') || document.querySelectorAll('.cleanup-row').length === 0, null, { timeout: 15000 });
  assert.ok(!fs.existsSync(big), 'moved to the Trash');
  await page.keyboard.press('Escape');
});

test('Space previews Word, Excel, PowerPoint and RTF documents', async () => {
  await page.locator('.dropdown', { hasText: 'More' }).count();
  await makeDocx(path.join(root, 'report.docx'), ['Quarterly report', 'Revenue grew 12 percent.']);
  await makeXlsx(path.join(root, 'budget.xlsx'), { Q1: [['Item', 'Cost'], ['Rent', 1200], ['Food', 400]], Notes: [['second sheet']] });
  await makePptx(path.join(root, 'deck.pptx'), [['Welcome', 'Agenda'], ['Numbers and plans']]);
  write(path.join(root, 'letter.rtf'), '{\\rtf1\\ansi Hello from an RTF letter}');
  await page.locator('button[aria-label="Refresh"]').click();

  await row('report.docx').click();
  await page.keyboard.press(' ');
  await page.waitForSelector('.preview-doc');
  assert.match(await page.locator('.preview-doc').innerText(), /Revenue grew 12 percent/);
  await shot('09-preview-docx');
  await page.keyboard.press('Escape');

  await row('budget.xlsx').click();
  await page.keyboard.press(' ');
  await page.waitForSelector('.preview-sheet table');
  assert.match(await page.locator('.preview-sheet').innerText(), /Rent/);
  await page.locator('.sheet-tabs button', { hasText: 'Notes' }).click();
  assert.match(await page.locator('.preview-sheet').innerText(), /second sheet/);
  await shot('10-preview-xlsx');
  await page.keyboard.press('Escape');

  await row('deck.pptx').click();
  await page.keyboard.press(' ');
  await page.waitForSelector('.preview-slides');
  assert.match(await page.locator('.preview-slides').innerText(), /Welcome[\s\S]*Numbers and plans/);
  await shot('11-preview-pptx');
  await page.keyboard.press('Escape');

  await row('letter.rtf').click();
  await page.keyboard.press(' ');
  // Quick Look renders the first page; wait for the image itself, not the "Loading…" message
  await page.waitForSelector('.preview-modal img.preview-media', { timeout: 30000 });
  assert.ok(await page.locator('img.preview-media').evaluate((i) => i.complete && i.naturalWidth > 100), 'RTF page image loaded');
  await shot('12-preview-rtf');
  await page.keyboard.press('Escape');
});

test('deleting a big folder shows the progress panel, then the folder is gone', async () => {
  await page.locator('button[aria-label="Refresh"]').click();
  const big = path.join(root, 'many-files');
  fs.mkdirSync(big);
  for (let i = 0; i < 60000; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), 'x');
  await page.locator('button[aria-label="Refresh"]').click();
  await row('many-files').click();
  page.once('dialog', (d) => d.accept());
  await ctx('many-files', 'Delete immediately');
  await page.waitForSelector('.transfer', { timeout: 10000 });
  assert.match(await page.locator('.transfer').innerText(), /Deleting[\s\S]*0 of 1 item/);
  await shot('13-delete-progress');
  await page.waitForSelector('.transfer', { state: 'detached', timeout: 60000 });
  assert.ok(!fs.existsSync(big), 'folder removed');
  assert.equal(await row('many-files').count(), 0);
});

test('performance: paste 1500 copies and delete them while the window stays responsive', async () => {
  const dir = path.join(root, 'perf');
  fs.mkdirSync(dir);
  for (let i = 0; i < 1500; i++) fs.writeFileSync(path.join(dir, `p${i}.txt`), 'x');
  await page.locator('button[aria-label="Refresh"]').click();
  await row('perf').dblclick();
  await page.waitForFunction(() => document.querySelectorAll('.row[data-path*="/perf/p"]').length >= 1500, null, { timeout: 20000 });
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(e.duration))).observe({ entryTypes: ['longtask'] });
  });
  await more('Select all');
  await page.locator('.commandbar button', { hasText: 'Copy' }).first().click();
  const t0 = Date.now();
  await page.locator('.commandbar button', { hasText: 'Paste' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.row[data-path*="/perf/p"]').length >= 3000, null, { timeout: 30000 });
  const pasteMs = Date.now() - t0;
  assert.ok(pasteMs < 5000, `pasting 1500 files took ${pasteMs} ms`);

  const t1 = Date.now();
  await more('Select all');
  page.once('dialog', (d) => d.accept());
  await more('Delete immediately');
  await page.waitForFunction(() => document.querySelectorAll('.row[data-path*="/perf/p"]').length === 0, null, { timeout: 30000 });
  const deleteMs = Date.now() - t1;
  assert.ok(deleteMs < 5000, `deleting 3000 files took ${deleteMs} ms`);
  const longest = await page.evaluate(() => Math.max(0, ...window.__long));
  assert.ok(longest < 700, `no UI freeze longer than 700 ms (worst ${Math.round(longest)} ms)`);
  await page.locator('button[aria-label="Up one level"]').click();
});

test('the app logo is shown in the sidebar', async () => {
  const ok = await page.locator('.brand img').evaluate((i) => i.complete && i.naturalWidth > 100);
  assert.ok(ok, 'logo image loaded');
  assert.match(await page.locator('.brand').innerText(), /File Manager/);
});

test('Refresh button, F5 and the Refresh menu item (⌘R) all reload a folder that cannot be watched (FTP)', async () => {
  const server = tmp();
  write(path.join(server, 'first.txt'), '1');
  const ftp = await startFtp(server);
  try {
    const conn = await page.evaluate((port) => window.fsApi.ftpAdd({ name: 'Reload test', host: '127.0.0.1', port, user: 'u', password: 'pw' }), ftp.port);
    assert.equal(conn.ok, true, conn.error);
    await page.locator('button[aria-label="Refresh"]').click(); // sidebar picks up the new connection
    await page.locator('.sidebar .side-row', { hasText: 'Reload test' }).locator('.side-item').click();
    await page.waitForSelector('.row[data-path$="/first.txt"]');

    write(path.join(server, 'by-button.txt'), '2');
    await new Promise((r) => setTimeout(r, 1200)); // no auto-refresh for FTP within this time
    assert.equal(await page.locator('.row[data-path$="/by-button.txt"]').count(), 0, 'not there before refreshing');
    await page.locator('button[aria-label="Refresh"]').click();
    await page.waitForSelector('.row[data-path$="/by-button.txt"]', { timeout: 10000 });

    write(path.join(server, 'by-f5.txt'), '3');
    await page.keyboard.press('F5');
    await page.waitForSelector('.row[data-path$="/by-f5.txt"]', { timeout: 10000 });

    write(path.join(server, 'by-cmd-r.txt'), '4');
    await app.evaluate(({ Menu }) => {
      const find = (items) => {
        for (const it of items) {
          if (it.label === 'Refresh') return it;
          if (it.submenu) {
            const r = find(it.submenu.items);
            if (r) return r;
          }
        }
      };
      const it = find(Menu.getApplicationMenu().items);
      if (!it || !/R$/.test(it.accelerator)) throw new Error('Refresh menu item with an R accelerator not found');
      it.click(); // exactly what pressing ⌘R / Ctrl+R does
    });
    await page.waitForSelector('.row[data-path$="/by-cmd-r.txt"]', { timeout: 10000 });
    await shot('14-refreshed-ftp');
  } finally {
    await page.evaluate(async () => { for (const c of await window.fsApi.ftpList()) await window.fsApi.ftpRemove(c.id); });
    ftp.close();
  }
});
