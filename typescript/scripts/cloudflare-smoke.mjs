import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { fixture, serve } from '../test/helpers.mjs';

/** Run the actual packed/installed Cloudflare entry on workerd, without Node polyfills. */
export async function smokeCloudflare(consumer) {
  const entry = join(consumer, 'cloudflare-worker.mjs');
  await copyFile(new URL('../test/cloudflare-worker.mjs', import.meta.url), entry);
  const bundle = await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'browser',
    external: ['*.wasm', 'cloudflare:workers'], write: false, metafile: true });
  assert.ok(!Object.keys(bundle.metafile.inputs).some(path => /(?:src|dist)\/(?:index|engines)\.js$/.test(path)), 'Worker bundle must not include the Node loader');
  const assets = join(consumer, 'node_modules/bono-export/dist/vendor');
  const server = await serve(await fixture('dictionary'));
  let runtime;
  try {
    runtime = new Miniflare({
      compatibilityDate: '2026-07-30',
      modulesRoot: consumer,
      modules: [
        { type: 'ESModule', path: join(consumer, 'worker.mjs'), contents: bundle.outputFiles[0].text },
        { type: 'CompiledWasm', path: join(consumer, 'vendor/sqlite.wasm'), contents: await readFile(join(assets, 'sqlite.wasm')) },
        { type: 'CompiledWasm', path: join(consumer, 'vendor/zstd.wasm'), contents: await readFile(join(assets, 'zstd.wasm')) },
      ],
      bindings: { EXPORT_URL: server.url },
      durableObjects: { READERS: { className: 'ExportReader', useSQLite: true } },
    });
    const request = async path => {
      const response = await runtime.dispatchFetch(`http://worker.test${path}`);
      assert.equal(response.status, 200, await response.clone().text());
      return response;
    };
    const expected = [{ id: 7, x: 0.875, label: 'car 7' }];
    assert.deepEqual(await (await request('/point')).json(), expected);
    assert.ok(server.stats.bytes < 3932160 / 4, 'point read should remain selective');
    assert.deepEqual(await (await request('/values')).json(), { text: 'a\0b', bytes: [], large: '9223372036854775807' });
    assert.deepEqual(await (await request('/cache')).json(), [{ cache_size: -2048 }]);
    assert.equal(await (await request('/readonly')).text(), 'read-only');
    assert.deepEqual(await (await request('/sum')).json(), [{ n: 24000, total: 36001500 }]);
    const parallel = await Promise.all([request('/point'), request('/point')]);
    for (const response of parallel) assert.deepEqual(await response.json(), expected);

    assert.deepEqual(await (await request('/do/point')).json(), { opens: 1, rows: expected });
    assert.deepEqual(await (await request('/do/point?id=24000')).json(), {
      opens: 1, rows: [{ id: 24000, x: 3000, label: 'car 0' }],
    });
    const sameObject = await Promise.all([request('/do/point?id=1'), request('/do/point?id=2')]);
    for (const [index, response] of sameObject.entries()) {
      const result = await response.json();
      assert.equal(result.opens, 1); assert.equal(result.rows[0].id, index + 1);
    }
    assert.deepEqual(await (await request('/do/sum')).json(), { opens: 1, rows: [{ n: 24000, total: 36001500 }] });
    assert.deepEqual(await (await request('/do/close')).json(), { closed: true });
    assert.deepEqual(await (await request('/do/point')).json(), { opens: 2, rows: expected });
    await request('/do/close');
    console.log('Installed Cloudflare package passed workerd Worker and Durable Object lifecycle tests');
  } finally { await runtime?.dispose(); await server.close(); }
}
