#!/usr/bin/env node
// Stand-in for mtp-helper with a real folder as the phone's storage (FAKE_PHONE_ROOT).
// DROP_AFTER=<bytes>: the first `get` writes that many bytes and then the "cable is pulled" (process exits).
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.FAKE_PHONE_ROOT;
const dropFlag = process.env.DROP_FLAG; // file that exists once the drop already happened
if (process.argv[2] === 'detect') {
  console.log('DEV\tFake\tPhone');
  process.exit(0);
}
const ids = new Map([[4294967295, root]]);
const byPath = new Map([[root, 4294967295]]);
let nextObj = 100;
const idOf = (p) => {
  if (!byPath.has(p)) (byPath.set(p, nextObj), ids.set(nextObj, p), nextObj++);
  return byPath.get(p);
};
console.log('READY\tFake Phone');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const [id, op, a, b, c2, d] = buf.slice(0, i).split('\t');
    buf = buf.slice(i + 1);
    if (op === 'storages') console.log(`${id}\tD\t65537\tInternal shared storage\t1000000\t400000\n${id}\tOK\t`);
    else if (op === 'list') {
      const dir = ids.get(Number(b));
      for (const n of fs.readdirSync(dir)) {
        const p = path.join(dir, n);
        const st = fs.statSync(p);
        console.log(`${id}\tD\t${idOf(p)}\t${st.isDirectory() ? 'd' : 'f'}\t${st.size}\t${Math.floor(st.mtimeMs / 1000)}\t${n}`);
      }
      console.log(`${id}\tOK\t`);
    } else if (op === 'get') {
      const data = fs.readFileSync(ids.get(Number(a)));
      const drop = Number(process.env.DROP_AFTER || 0);
      if (drop && data.length > drop && !fs.existsSync(dropFlag)) {
        fs.writeFileSync(dropFlag, '1');
        fs.writeFileSync(b, data.subarray(0, drop));
        process.exit(1); // cable pulled mid-file
      }
      fs.writeFileSync(b, data);
      console.log(`${id}\tOK\t`);
    } else if (op === 'getrange') {
      const data = fs.readFileSync(ids.get(Number(a)));
      const off = Number(c2);
      fs.truncateSync(b, off);
      fs.appendFileSync(b, data.subarray(off, Number(d)));
      console.log(`${id}\tOK\t`);
    } else console.log(`${id}\tERR\tUnknown command.`);
  }
});
