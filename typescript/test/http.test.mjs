import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RemoteFile, CHUNK } from '../dist/http.js';
import { rangeTransport } from './helpers.mjs';

const data = Uint8Array.from({ length: CHUNK * 8 + 17 }, (_, i) => (i * 13) % 251);

test('cached reads, chunk boundaries, EOF and LRU eviction', async () => {
  const { fetch, stats } = rangeTransport(data);
  const file = await RemoteFile.open('https://example.test/db?signature=secret#fragment', { fetch, cacheBytes: CHUNK });
  const small = new Uint8Array(100);
  assert.equal(await file.read(small, 20), 100);
  assert.deepEqual(small, data.slice(20, 120));
  assert.equal(stats.requests, 1);
  assert.equal(stats.urls[0], 'https://example.test/db?signature=secret');
  const across = new Uint8Array(CHUNK + 20);
  assert.equal(await file.read(across, CHUNK - 10), across.length);
  assert.deepEqual(across, data.slice(CHUNK - 10, 2 * CHUNK + 10));
  const last = new Uint8Array(100);
  assert.equal(await file.read(last, data.length - 17), 17);
  assert.deepEqual(last.slice(0, 17), data.slice(-17));
  assert.equal(await file.read(last, data.length + 100), 0);
  const before = stats.requests;
  await file.read(small, 0);
  assert.equal(stats.requests, before + 1, 'first chunk was evicted');
  file.close();
  await assert.rejects(file.read(small, 0), /closed/);
});

test('sequential reads trigger bounded read-ahead', async () => {
  const { fetch, stats } = rangeTransport(data);
  const file = await RemoteFile.open('http://test/db', { fetch });
  for (let i = 0; i < 4; i++) await file.read(new Uint8Array(CHUNK), i * CHUNK);
  assert.equal(stats.requests, 2);
  assert.deepEqual(stats.ranges[1], [CHUNK, 4 * CHUNK - 1]);
  file.close();
});

for (const [name, transform, pattern] of [
  ['ignores ranges', () => new Response('secret', { status: 200 }), /range requests/],
  ['not found', () => new Response('secret', { status: 404 }), /404/],
  ['bad range', () => new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/9007199254740993' } }), /Content-Range/],
  ['encoded body', r => { r.headers.set('content-encoding', 'gzip'); return r; }, /Encoded/],
  ['oversized body', () => new Response(new Uint8Array(CHUNK + 1), { status: 206, headers: { 'content-range': `bytes 0-${CHUNK - 1}/${data.length}` } }), /exceeded/],
]) {
  test(`rejects ${name} without leaking credentials`, async () => {
    const { fetch, stats } = rangeTransport(data, transform);
    await assert.rejects(RemoteFile.open('https://test/db?secret=123#secret', { fetch }), error => {
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.stack, /secret|123/);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(stats.requests, 1);
  });
}

for (const status of [429, 503]) test(`retries HTTP ${status}`, async () => {
  const { fetch, stats } = rangeTransport(data, (r, s) => s.requests < 3 ? new Response('', { status }) : r);
  const file = await RemoteFile.open('http://test/db', { fetch });
  assert.equal(stats.requests, 3);
  file.close();
});

test('retries short bodies and redacts raw transport failures', async () => {
  const transport = rangeTransport(data, (r, s) => s.requests < 3 ? new Response('x', { status: 206, headers: r.headers }) : r);
  const file = await RemoteFile.open('http://test/db', transport);
  assert.equal(transport.stats.requests, 3);
  file.close();
  await assert.rejects(RemoteFile.open('https://test/db?secret', { fetch: () => { throw new Error('https://test/db?secret'); } }), /^Error: HTTP request failed$/);
});

for (const change of ['etag', 'missing-etag', 'new-etag', 'size']) test(`detects changed ${change}`, async () => {
  const { fetch } = rangeTransport(data, (r, s) => {
    if (change === 'new-etag' && s.requests === 1) r.headers.delete('etag');
    if (s.requests > 1) {
      if (change === 'etag') r.headers.set('etag', 'changed');
      if (change === 'missing-etag') r.headers.delete('etag');
      if (change === 'size') r.headers.set('content-range', r.headers.get('content-range').replace(`/${data.length}`, `/${data.length + 1}`));
    }
    return r;
  });
  const file = await RemoteFile.open('http://test/db', { fetch });
  await assert.rejects(file.read(new Uint8Array(100), 5 * CHUNK), /changed/);
  file.close();
});

test('timeout covers fetch and body even with a transport ignoring abort', async () => {
  for (const fetch of [() => new Promise(() => {}), async () => new Response(new ReadableStream({ start() {} }), {
    status: 206, headers: { 'content-range': `bytes 0-${CHUNK - 1}/${data.length}` },
  })]) {
    await assert.rejects(RemoteFile.open('http://test/db', { fetch, timeoutMs: 5 }), /timed out/);
  }
});

test('validates URL and options without exposing invalid URLs', async () => {
  for (const url of ['garbage?secret', 'file:///secret', 'http://user:secret@test/db']) {
    await assert.rejects(RemoteFile.open(url), error => !error.message.includes('secret'));
  }
  await assert.rejects(RemoteFile.open('http://test/db', { timeoutMs: Infinity }), /timeoutMs/);
  await assert.rejects(RemoteFile.open('http://test/db', { cacheBytes: 1 }), /cacheBytes/);
});

test('invokes native-style fetch with the global receiver', async () => {
  const transport = rangeTransport(data);
  const file = await RemoteFile.open('http://test/db', {
    fetch: function (...args) {
      assert.equal(this, globalThis);
      return transport.fetch(...args);
    },
  });
  file.close();
});
