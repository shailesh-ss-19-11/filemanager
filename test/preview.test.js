const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tmp, makeDocx, makePptx, makeXlsx } = require('./helpers');
const preview = require('../electron/preview');
const fs = require('node:fs');

test('Word document -> HTML with its paragraphs', async () => {
  const f = path.join(tmp(), 'report.docx');
  await makeDocx(f, ['Quarterly report', 'Revenue grew 12% & margins held.']);
  const r = await preview.source(f);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.kind, 'docx');
  assert.match(r.html, /Quarterly report/);
  assert.match(r.html, /Revenue grew 12%/);
});

test('Excel workbook -> sheets with rows, formulas as values', async () => {
  const f = path.join(tmp(), 'budget.xlsx');
  await makeXlsx(f, { Q1: [['Item', 'Cost'], ['Rent', 1200], ['Food', 400]], Notes: [['hello']] });
  const r = await preview.source(f);
  assert.equal(r.kind, 'sheet');
  assert.deepEqual(r.sheets.map((s) => s.name), ['Q1', 'Notes']);
  assert.deepEqual(r.sheets[0].rows[1], ['Rent', '1200']);
  assert.equal(r.sheets[0].totalRows, 3);
});

test('PowerPoint -> text of every slide, in order', async () => {
  const f = path.join(tmp(), 'deck.pptx');
  await makePptx(f, [['Welcome', 'Agenda'], ['Numbers & plans']]);
  const r = await preview.source(f);
  assert.equal(r.kind, 'slides');
  assert.deepEqual(r.slides, [['Welcome', 'Agenda'], ['Numbers & plans']]);
});

test('a damaged document gives a readable error, not a crash', async () => {
  const f = path.join(tmp(), 'broken.docx');
  fs.writeFileSync(f, 'this is not a zip');
  const r = await preview.source(f);
  assert.equal(r.ok, false);
  assert.match(r.error, /Couldn’t read this document/);
});

test('unknown types report "none"; text and image keep working', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'a.xyz'), 'x');
  fs.writeFileSync(path.join(d, 'a.txt'), 'plain');
  assert.equal((await preview.source(path.join(d, 'a.xyz'))).kind, 'none');
  assert.equal((await preview.source(path.join(d, 'a.txt'))).text, 'plain');
});
