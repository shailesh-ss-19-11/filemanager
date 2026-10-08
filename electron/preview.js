/** Quick-look style preview: decides how to show a file and serves local files through fmfile://. */
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const remote = require('./remote');
let nativeImage = null;
try {
  ({ nativeImage } = require('electron'));
} catch {
  /* running outside Electron (tests) */
}

const KINDS = {
  image: 'png jpg jpeg gif webp svg bmp ico avif',
  video: 'mp4 m4v mov webm ogv',
  audio: 'mp3 wav m4a aac ogg oga flac',
  pdf: 'pdf',
  docx: 'docx docm dotx',
  sheet: 'xlsx xlsm',
  slides: 'pptx pptm',
  thumb: 'doc dot xls xlt ppt pps odt ods odp rtf rtfd pages numbers key epub',
  text: 'txt md markdown json jsonc csv tsv log js jsx mjs cjs ts tsx css scss html htm xml yml yaml ini conf cfg sh zsh bash py rb go rs java kt c h cpp hpp cs swift toml sql env gitignore properties plist svg-text',
};
const EXT = new Map();
for (const [kind, list] of Object.entries(KINDS)) for (const e of list.split(' ')) EXT.set(e, kind);

const TEXT_LIMIT = 1024 * 1024;
const DOC_LIMIT = 40 * 1024 * 1024;
const MAX_SHEETS = 10;
const MAX_ROWS = 300;
const MAX_COLS = 30;
const approved = new Set(); // local paths the renderer is allowed to load through fmfile://

const kindOf = (name) => {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return /^(readme|makefile|dockerfile|license)$/i.test(name) ? 'text' : 'none';
  return EXT.get(name.slice(dot + 1).toLowerCase()) || 'none';
};

const urlFor = (p) => 'fmfile://local' + pathToFileURL(p).pathname;
const pathFromUrl = (u) => fileURLToPath('file://' + new URL(u).pathname);

const cellText = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v.toLocaleDateString();
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return cellText(v.result);
    if ('text' in v) return cellText(v.text);
    if ('error' in v) return String(v.error);
    return '';
  }
  return String(v);
};

async function docxHtml(file) {
  const mammoth = require('mammoth');
  const r = await mammoth.convertToHtml({ path: file });
  // mammoth never emits scripts, but drop any anyway before the renderer shows it
  return r.value.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/ on\w+="[^"]*"/gi, '');
}

async function sheetsOf(file) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const sheets = [];
  wb.eachSheet((ws) => {
    if (sheets.length >= MAX_SHEETS) return;
    const rows = [];
    const cols = Math.min(ws.columnCount || 0, MAX_COLS);
    for (let r = 1; r <= Math.min(ws.rowCount || 0, MAX_ROWS); r++) {
      const row = ws.getRow(r);
      const cells = [];
      for (let c = 1; c <= cols; c++) cells.push(cellText(row.getCell(c).value));
      rows.push(cells);
    }
    sheets.push({ name: ws.name, rows, totalRows: ws.rowCount || 0, totalCols: ws.columnCount || 0 });
  });
  return sheets;
}

async function slideTexts(file) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(await fsp.readFile(file));
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => parseInt(a.match(/(\d+)\.xml/)[1], 10) - parseInt(b.match(/(\d+)\.xml/)[1], 10));
  const slides = [];
  for (const n of names.slice(0, 200)) {
    const xml = await zip.files[n].async('string');
    const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
      .map((m) => [...m[1].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((t) => t[1]).join(''))
      .map((t) => t.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"))
      .filter(Boolean);
    slides.push(paras);
  }
  return slides;
}

/** First-page image from the OS (Quick Look on macOS, Explorer thumbnails on Windows). */
async function osThumbnail(file) {
  if (!nativeImage || typeof nativeImage.createThumbnailFromPath !== 'function') return null;
  try {
    const img = await nativeImage.createThumbnailFromPath(file, { width: 1100, height: 1400 });
    return img.isEmpty() ? null : img.toDataURL();
  } catch {
    return null;
  }
}

/** -> { ok, kind, url?, text?, truncated?, name, size } */
async function source(p, meta = {}) {
  const name = remote.isRemote(p) ? remote.driverFor(p).baseName(p) : path.basename(p);
  const kind = kindOf(name);
  if (kind === 'none') return { ok: true, kind, name, size: meta.size };
  try {
    let local = p;
    if (remote.isRemote(p)) local = await remote.fetchForOpen(p, meta);
    const st = await fsp.stat(local);
    if (kind === 'text') {
      const fh = await fsp.open(local, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, TEXT_LIMIT));
        await fh.read(buf, 0, buf.length, 0);
        return { ok: true, kind, name, size: st.size, text: buf.toString('utf8'), truncated: st.size > TEXT_LIMIT };
      } finally {
        await fh.close();
      }
    }
    if (['docx', 'sheet', 'slides', 'thumb'].includes(kind)) {
      if (st.size > DOC_LIMIT) return { ok: true, kind: 'none', name, size: st.size, note: 'This document is too large to preview here.' };
      const base = { ok: true, kind, name, size: st.size };
      try {
        if (kind === 'docx') return { ...base, html: await docxHtml(local) };
        if (kind === 'sheet') return { ...base, sheets: await sheetsOf(local) };
        if (kind === 'slides') return { ...base, slides: await slideTexts(local), image: await osThumbnail(local) };
      } catch (err) {
        const image = await osThumbnail(local); // damaged / unusual file: fall back to the OS preview
        if (image) return { ok: true, kind: 'thumb', name, size: st.size, image };
        return { ok: false, error: `Couldn’t read this document (${(err && err.message) || 'unsupported format'}).` };
      }
      const image = await osThumbnail(local);
      return image ? { ...base, kind: 'thumb', image } : { ok: true, kind: 'none', name, size: st.size, note: 'No preview is available for this document type.' };
    }
    approved.add(local);
    return { ok: true, kind, name, size: st.size, url: urlFor(local) };
  } catch (err) {
    return { ok: false, error: (err && err.message) || 'Could not load the preview.' };
  }
}

module.exports = { source, kindOf, approved, pathFromUrl };
