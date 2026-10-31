// Keep Node's asset resolution out of the portable HTTP/VFS implementation.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import factory from 'wa-sqlite/dist/wa-sqlite-async.mjs';
import * as zstd from '@bokuweb/zstd-wasm';

import { configureEngine } from './engine-common.js';
import { validateFrame } from './decoder.js';
export type { Engine } from './engine-common.js';

let binary: Promise<Uint8Array> | undefined;
export async function createEngine() {
  binary ??= readFile(createRequire(import.meta.url).resolve('wa-sqlite/dist/wa-sqlite-async.wasm'));
  return configureEngine(await factory({ wasmBinary: await binary }));
}

let initialized: Promise<void> | undefined;
export async function createDecoder() {
  initialized ??= zstd.init();
  await initialized;
  let context = zstd.createDCtx();
  if (!context) throw new Error('Could not allocate zstd context');
  return {
    decode(data: Uint8Array, dictionary?: Uint8Array): Uint8Array {
      validateFrame(data);
      try {
        const page = dictionary ? zstd.decompressUsingDict(context, data, dictionary, { defaultHeapSize: 8192 })
          : zstd.decompress(data, { defaultHeapSize: 8192 });
        if (page.length !== 8192) throw new Error();
        return page;
      } catch { throw new Error('Could not decompress zstd page'); }
    },
    close() { if (context) { zstd.freeDCtx(context); context = 0; } },
  };
}
