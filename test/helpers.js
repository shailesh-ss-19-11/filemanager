const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const FtpSrv = require('ftp-srv');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fm-test-'));

/** Starts an FTP server serving `root` (user "u", password "pw"); resolves { port, close }. */
async function startFtp(root) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const srv = new FtpSrv({
    url: `ftp://127.0.0.1:${port}`,
    anonymous: false,
    pasv_url: '127.0.0.1',
    pasv_min: port + 1,
    pasv_max: port + 60,
    log: require('bunyan').createLogger({ name: 'x', level: 100 }),
  });
  srv.on('login', ({ password }, ok, bad) => (password === 'pw' ? ok({ root }) : bad(new Error('bad login'))));
  await srv.listen();
  return { port, close: () => srv.close() };
}

const JSZip = require('jszip');
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');

/** Minimal but valid Office files for tests. */
async function makeDocx(file, paragraphs) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t>${esc(p)}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}

async function makePptx(file, slides) {
  const z = new JSZip();
  z.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>');
  slides.forEach((paras, i) =>
    z.file(`ppt/slides/slide${i + 1}.xml`, `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree>${paras.map((t) => `<p:sp><p:txBody><a:p><a:r><a:t>${esc(t)}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`)
  );
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer' }));
}

async function makeXlsx(file, sheets) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) wb.addWorksheet(name).addRows(rows);
  await wb.xlsx.writeFile(file);
}

/** Waits until no mtp-helper process holds the phone (a previous test's app may still be shutting down). */
async function waitPhoneFree(ms = 15000) {
  const { execSync } = require('node:child_process');
  const end = Date.now() + ms;
  for (;;) {
    let busy = '';
    try {
      busy = execSync('pgrep -f "mtp-helper serve" || true').toString().trim();
    } catch {
      /* none */
    }
    if (!busy || Date.now() > end) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}

const isWin = process.platform === 'win32';
/** Name the app gives a pasted duplicate: "f copy.txt" (macOS/Linux) or "f - Copy.txt" (Windows). */
const copyOf = (stem, ext = '') => (isWin ? `${stem} - Copy${ext}` : `${stem} copy${ext}`);
/** Windows CI disks are slow: scale time limits */
const slow = (ms) => (isWin ? ms * 15 : ms);

module.exports = { copyOf, slow, isWin, tmp, startFtp, makeDocx, makePptx, makeXlsx, waitPhoneFree };
