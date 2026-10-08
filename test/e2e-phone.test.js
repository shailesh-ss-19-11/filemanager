/** UI test with a real Android phone attached over USB (File transfer mode). Skips when none is found. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { tmp, waitPhoneFree } = require('./helpers');
const mtp = require('../electron/mtp');

const SHOTS = process.env.FM_SHOTS || null;

test('phone in the app: sidebar, browse, thumbnails, preview, space', { timeout: 240000 }, async (t) => {
  if (!(await mtp.detect())) return t.skip('no Android phone attached');
  const app = await electron.launch({ args: ['.', `--user-data-dir=${tmp()}`], env: { ...process.env, FM_START_PATH: fs.realpathSync(tmp()) } });
  t.after(async () => {
    await app.close();
    await waitPhoneFree();
  });
  const page = await app.firstWindow();
  const shot = (n) => SHOTS && (fs.mkdirSync(SHOTS, { recursive: true }), page.screenshot({ path: path.join(SHOTS, n + '.png') }));
  await page.waitForSelector('.sidebar');

  const phone = page.locator('.sidebar .side-item.drive', { hasText: '(USB)' });
  await phone.waitFor({ timeout: 30000 });
  await page.waitForFunction(() => /free of/.test(document.querySelector('.side-item.drive[title*="free of"]')?.title || ''), null, { timeout: 30000 });
  await shot('p1-sidebar');

  await phone.click();
  await page.waitForSelector('.row[data-path^="mtp://phone/"]', { timeout: 60000 });
  await page.waitForFunction(() => /free of .* used/.test(document.querySelector('.statusbar')?.innerText || ''), null, { timeout: 30000 });

  await page.locator('.row[data-path$="/Internal shared storage"]').dblclick();
  await page.waitForSelector('.row[data-path$="/Internal shared storage/DCIM"]', { timeout: 60000 });
  await page.locator('.row[data-path$="/Internal shared storage/DCIM"]').dblclick();
  await page.waitForSelector('.row[data-path$="/DCIM/Camera"]', { timeout: 60000 });
  await page.locator('.row[data-path$="/DCIM/Camera"]').dblclick();
  await page.waitForSelector('.row[data-path*="/DCIM/Camera/"]', { timeout: 90000 });
  await shot('p2-camera-details');

  // phone files get the same Compress / Properties / Copy to… options as local files
  await page.locator('.row[data-path*="/DCIM/Camera/"]').first().click({ button: 'right' });
  const menu = await page.locator('.context-menu').innerText();
  for (const label of ['Compress to ZIP', 'Copy to', 'Properties', 'Rename']) assert.ok(menu.includes(label), `phone context menu has ${label}`);
  await shot('p5-phone-context-menu');
  await page.mouse.click(1400, 900);

  // icons view shows phone thumbnails
  await page.locator('.view-switch button[title="Icons"]').click();
  await page.waitForSelector('.tile .thumb img', { timeout: 60000 });
  await shot('p3-camera-thumbnails');
  await page.locator('.view-switch button[title="Details"]').click();

  // preview a photo (downloads it, then shows it)
  const photo = page.locator('.row[data-path$=".jpg"]').first();
  if (await photo.count()) {
    await photo.click();
    await page.keyboard.press(' ');
    await page.waitForSelector('img.preview-media', { timeout: 60000 });
    assert.ok(await page.locator('img.preview-media').evaluate((i) => i.complete && i.naturalWidth > 0));
    await shot('p4-preview');
    await page.keyboard.press('Escape');
  }

});

test('deleting a big folder on the phone shows the progress panel', { timeout: 300000 }, async (t) => {
  if (!(await mtp.detect())) return t.skip('no Android phone attached');
  const remote = require('../electron/remote');
  const transfer = require('../electron/transfer');
  const ST = 'mtp://phone/Internal shared storage/Download';
  await waitPhoneFree();
  // seed 150 tiny files on the phone, then free the phone for the app
  const src = tmp();
  for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(src, `f${String(i).padStart(3, '0')}.txt`), 'x');
  const made = await remote.newFolder(ST);
  assert.equal(made.ok, true, made.error);
  const r = await transfer.run({ id: 'seed', items: fs.readdirSync(src).map((n) => path.join(src, n)), dest: made.path, mode: 'copy' }, () => {});
  assert.equal(r.ok, true, r.errors.join());
  mtp.stopHelper();

  const app = await electron.launch({ args: ['.', `--user-data-dir=${tmp()}`], env: { ...process.env, FM_START_PATH: ST } });
  t.after(async () => {
    await app.close();
    await waitPhoneFree();
  });
  const page = await app.firstWindow();
  page.on('dialog', (d) => d.accept()); // "Permanently delete … from the phone?"
  const folder = page.locator(`.row[data-path$="/${made.name}"]`);
  await folder.waitFor({ timeout: 90000 });
  await folder.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Backspace' : 'Delete');
  await page.waitForSelector('.transfer', { timeout: 15000 });
  const text = await page.locator('.transfer').innerText();
  assert.match(text, /Deleting/);
  await page.waitForFunction(() => /\d+ of 1 item/.test(document.querySelector('.transfer')?.innerText || ''), null, { timeout: 15000 });
  await page.waitForSelector('.transfer', { state: 'detached', timeout: 120000 });
  assert.equal(await folder.count(), 0, 'folder is gone');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'p6-delete-done.png') });
});
