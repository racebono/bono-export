import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openUrl, open_url } from '../dist/index.js';
import { createEngine, createDecoder } from '../dist/engines.js';
import { MemoryVFS } from 'wa-sqlite/src/examples/MemoryVFS.js';
import { fixture, rangeTransport, serve } from './helpers.mjs';

test('opens real Rust exports, including raw, zstd and trained-dictionary pages', async () => {
  for (const [name, count] of [['small', 80], ['dictionary', 24000]]) {
    const transport = rangeTransport(await fixture(name));
    const db = await openUrl('http://test/export.db', transport);
    try {
      assert.deepEqual(await db.query('SELECT count(*) AS n, sum(x) AS total FROM telemetry'), [{ n: count, total: count * (count + 1) / 16 }]);
      assert.deepEqual(await db.query('SELECT id, label, x FROM telemetry WHERE id = ?', [7]), [{ id: 7, label: 'car 7', x: 0.875 }]);
      assert.deepEqual(await db.query('SELECT count(*) AS n FROM telemetry WHERE label = ?', ['car 7']), [{ n: count / 40 }]);
      assert.deepEqual(await db.query('PRAGMA user_version'), [{ user_version: 17 }]);
      await assert.rejects(db.query('CREATE TABLE nope(x)'), /read.?only/i);
      await assert.rejects(db.query('UPDATE telemetry SET x = 0'), /read.?only/i);
    } finally { await db.close(); }
  }
  assert.equal(open_url, openUrl);
});

test('actual HTTP point lookup downloads less than a quarter of the export and caches reads', async () => {
  const data = await fixture('dictionary'), server = await serve(data);
  let db;
  try {
    db = await openUrl(server.url);
    assert.deepEqual(await db.query('SELECT x FROM telemetry WHERE id = 7'), [{ x: 0.875 }]);
    assert.ok(server.stats.requests < 20, `${server.stats.requests} requests`);
    assert.ok(server.stats.bytes < data.length / 4, `${server.stats.bytes} of ${data.length} bytes`);
    const count = server.stats.requests;
    await db.query('SELECT x FROM telemetry WHERE id = 7');
    assert.equal(server.stats.requests, count);
  } finally { await db?.close(); await server.close(); }
});

test('SQL parameters, integer precision, blobs, NULL, unusual column names and errors', async () => {
  const db = await openUrl('http://test/db', rangeTransport(await fixture('small')));
  try {
    const input = [null, 'hello', 1.25, 9223372036854775807n, -9223372036854775808n, new Uint8Array([0, 255])];
    const [row] = await db.query('SELECT ? AS n, ? AS text, ? AS real, ? AS large, ? AS negative, ? AS bytes, 7 AS "__proto__"', input);
    assert.deepEqual([row.n, row.text, row.real, row.large, row.negative, row.bytes], input);
    assert.equal(row.__proto__, 7);
    assert.deepEqual(await db.query('SELECT 9007199254740991 AS safe, 9007199254740992 AS large'), [{ safe: Number.MAX_SAFE_INTEGER, large: 9007199254740992n }]);
    await assert.rejects(db.query('SELECT 1 AS x, 2 AS x'), /Duplicate/);
    await assert.rejects(db.query('SELECT 1; SELECT 2'), /exactly one/);
    await assert.rejects(db.query(''), /exactly one/);
    await assert.rejects(db.query('SELECT 1\0;'), /NUL/);
    await assert.rejects(db.query('SELECT ?'), /count mismatch/);
    await assert.rejects(db.query('SELECT ?', [1n << 63n]), /64-bit/);
    await assert.rejects(db.query('SELECT ?', [Number.MAX_SAFE_INTEGER + 1]), /bigint/);
    await assert.rejects(db.query('SELECT ?', [undefined]), /Unsupported/);
    await assert.rejects(db.query('nonsense SQL'), /syntax/i);
    assert.deepEqual(await db.query('PRAGMA cache_size'), [{ cache_size: -32768 }]);
    assert.deepEqual(await db.query('SELECT 1 AS ok; -- trailing comment'), [{ ok: 1 }]);
    assert.deepEqual(await db.query('SELECT payload FROM telemetry WHERE id < 3').then(rows => rows.map(r => r.payload.length)), [96, 96]);
    const strings = ['', 'a\0b', '\ufeffhello', 'España 🏎️', '☀'.repeat(30000)];
    for (const text of strings) assert.deepEqual(await db.query('SELECT ? AS text', [text]), [{ text }]);
    assert.deepEqual(await db.query("SELECT CAST(x'610062' AS TEXT) AS text"), [{ text: 'a\0b' }]);
    assert.deepEqual(await db.query('SELECT ? AS bytes, typeof(?) AS kind', [new Uint8Array(), new Uint8Array()]), [{ bytes: new Uint8Array(), kind: 'blob' }]);
  } finally { await db.close(); }
});

test('supports a configurable SQLite cache and rejects invalid budgets before I/O', async () => {
  for (const sqliteCacheKiB of [0, 1.5, Infinity, 2147483648]) {
    await assert.rejects(openUrl('http://test/db', { sqliteCacheKiB, fetch() { throw new Error('must not fetch'); } }), /sqliteCacheKiB/);
  }
  const db = await openUrl('http://test/db', { ...rangeTransport(await fixture('small')), sqliteCacheKiB: 512 });
  try { assert.deepEqual(await db.query('PRAGMA cache_size'), [{ cache_size: -512 }]); }
  finally { await db.close(); }
});

test('serializes calls, copies queued parameters, isolates connections and closes idempotently', async () => {
  const data = await fixture('small');
  const a = await openUrl('http://test/a', rangeTransport(data));
  const b = await openUrl('http://test/b', rangeTransport(data));
  try {
    const bytes = new Uint8Array([1, 2]);
    const first = a.query('SELECT ? AS bytes', [bytes]);
    bytes[0] = 99;
    const second = a.query('SELECT id FROM telemetry WHERE id=80');
    const close = a.close();
    assert.equal(a.close(), close);
    await assert.rejects(a.query('SELECT 1'), /closed/);
    assert.deepEqual(await first, [{ bytes: new Uint8Array([1, 2]) }]);
    assert.deepEqual(await second, [{ id: 80 }]);
    await close;
    assert.deepEqual(await b.query('SELECT count(*) AS n FROM telemetry'), [{ n: 80 }]);
  } finally { await a.close(); await b.close(); }
});

// Mutate real outer databases using WASM SQLite, without a native dependency.
async function mutated(sql) {
  const s = await createEngine();
  const vfs = new MemoryVFS(); s.vfs_register(vfs, true);
  const db = await s.open_v2('fixture');
  await s.close(db);
  const data = await fixture('dictionary');
  const file = vfs.mapNameToFile.get('fixture'); file.data = data.slice().buffer; file.size = data.length;
  const reopened = await s.open_v2('fixture');
  await s.exec(reopened, sql);
  await s.close(reopened);
  return new Uint8Array(file.data, 0, file.size).slice();
}

for (const [name, sql, pattern] of [
  ['wrong format', 'PRAGMA application_id=0', /Not a bono/],
  ['missing dictionary', 'DELETE FROM nested_vfs_zstd_dicts', /dictionary/],
  ['corrupt frame', 'UPDATE nested_vfs_zstd_pages SET data=x\'000000000000\', meta1=-1 WHERE pageno=1', /zstd/],
  ['missing page', 'DELETE FROM nested_vfs_zstd_pages WHERE pageno=1', /page/],
  ['invalid metadata', "UPDATE nested_vfs_zstd_pages SET meta1='bad' WHERE pageno=1", /metadata/],
]) test(`rejects ${name} and a fresh open still works`, async () => {
  const data = await mutated(sql);
  const operation = async () => {
    const db = await openUrl('http://test/db?signature=secret', rangeTransport(data));
    try { await db.query('SELECT sum(x) FROM telemetry'); } finally { await db.close(); }
  };
  await assert.rejects(operation(), pattern);
  const db = await openUrl('http://test/good', rangeTransport(await fixture('small')));
  await db.close();
});

test('decoder rejects corrupt frame advertising oversized output', async () => {
  const decoder = await createDecoder();
  try {
    await assert.rejects(async () => decoder.decode(new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0xe0, 255, 255, 255, 255, 255, 255, 255, 127])), /size/);
  } finally { decoder.close(); }
});

test('remote read errors keep status and omit credentials on failed opens', async () => {
  await assert.rejects(openUrl('http://test/missing?signature=secret', { fetch: async () => new Response('secret', { status: 404 }) }), error => {
    assert.match(error.message, /404/); assert.doesNotMatch(error.stack, /secret/); return true;
  });
});
