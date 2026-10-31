import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { serve, fixture } from '../test/helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const tempRoot = resolve(tmpdir());
const consumer = await mkdtemp(join(tempRoot, 'bono-export-consumer-'));
const run = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', data => out += data);
  child.stderr.on('data', data => err += data);
  child.on('error', reject);
  child.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}\n${out}\n${err}`)));
});
const npm = (args, cwd) => run(process.execPath, [process.env.npm_execpath, ...args], cwd);
let server;
try {
  const [packed] = JSON.parse(await npm(['pack', '--ignore-scripts', '--json', '--pack-destination', consumer], root));
  if (packed.files.some(file => /test\/|scripts\/|node_modules\//.test(file.path))) throw new Error('Unexpected package contents');
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  await npm(['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', join(consumer, packed.filename)], consumer);
  await writeFile(join(consumer, 'consumer.mts'), `
import { openUrl, type Database, type Value } from 'bono-export';
const db: Database = await openUrl('http://example.test/db');
const values: Value[] = [null, 1n, new Uint8Array()];
await db.query('SELECT ?', values);
await db.close();
`);
  await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--noEmit', '--target', 'ES2022',
    '--module', 'NodeNext', '--strict', '--skipLibCheck', 'consumer.mts'], consumer);
  server = await serve(await fixture('dictionary'));
  await writeFile(join(consumer, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { openUrl } from 'bono-export';
const db = await openUrl(process.argv[2]);
try { assert.deepEqual(await db.query('SELECT count(*) AS n FROM telemetry'), [{n:24000}]); }
finally { await db.close(); }
console.log('Installed package loaded both WASM engines and queried a real Rust export');
`);
  console.log((await run(process.execPath, ['consumer.mjs', server.url], consumer)).trim());
  // Verify package metadata is usable independently of the repository.
  await readFile(join(consumer, 'node_modules/bono-export/dist/index.d.ts'));
} finally {
  await server?.close();
  if (dirname(resolve(consumer)) !== tempRoot) throw new Error('Unexpected temporary consumer path');
  await rm(consumer, { recursive: true, force: true });
}
