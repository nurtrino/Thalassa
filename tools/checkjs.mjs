// Syntax-check ES modules without resolving imports:
//   node tools/checkjs.mjs static/scene.js [more files...]
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

let bad = 0;
for (const f of process.argv.slice(2)) {
  const src = readFileSync(f, 'utf8');
  const r = spawnSync(process.execPath, ['--input-type=module', '--check', '-'],
                      { input: src, encoding: 'utf8' });
  if (r.status === 0) {
    console.log(`ok      ${f}`);
  } else {
    bad++;
    console.error(`SYNTAX  ${f}\n${r.stderr}`);
  }
}
process.exit(bad ? 1 : 0);
