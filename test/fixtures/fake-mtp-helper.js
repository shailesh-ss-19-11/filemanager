#!/usr/bin/env node
// Stand-in for electron/native/mtp-helper: the first FAIL_TIMES "storages" requests fail like a locked phone.
const fs = require('node:fs');
const state = process.env.FAKE_STATE;
const failTimes = Number(process.env.FAIL_TIMES || 0);
if (process.argv[2] === 'detect') {
  console.log('DEV\tFake\tPhone');
  process.exit(0);
}
console.log('READY\tFake Phone');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const [id, op] = buf.slice(0, i).split('\t');
    buf = buf.slice(i + 1);
    if (op === 'storages') {
      let n = 0;
      try { n = Number(fs.readFileSync(state, 'utf8')); } catch { /* first call */ }
      fs.writeFileSync(state, String(n + 1));
      if (n < failTimes) console.log(`${id}\tERR\tCould not read the phone's storage. Unlock the phone and allow access.`);
      else console.log(`${id}\tD\t65537\tInternal shared storage\t1000000\t400000\n${id}\tOK\t`);
    } else console.log(`${id}\tERR\tUnknown command.`);
  }
});
