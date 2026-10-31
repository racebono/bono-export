import factory from 'wa-sqlite/dist/wa-sqlite-async.mjs';
import sqliteWasm from './vendor/sqlite.wasm';
import zstdWasm from './vendor/zstd.wasm';
import { Module as zstd } from './vendor/zstd.js';
import { configureEngine } from './engine-common.js';
import { validateFrame, type Decoder } from './decoder.js';
import { createOpenUrl } from './core.js';

export type { Database, OpenOptions, Value, Row } from './core.js';

async function createEngine() {
  return configureEngine(await factory({
    locateFile: () => 'sqlite.wasm',
    instantiateWasm(imports: WebAssembly.Imports, receive: (instance: WebAssembly.Instance) => void) {
      const instance = new WebAssembly.Instance(sqliteWasm, imports);
      // The Asyncify receiver wraps exports. Calling it synchronously and then
      // returning raw exports overwrites those wrappers and hangs async VFS I/O.
      queueMicrotask(() => receive(instance));
      return {};
    },
  }));
}

let initialized = false;
async function createDecoder(): Promise<Decoder> {
  // Synchronous initialization shares no pending I/O from another request.
  if (!initialized) {
    zstd.instantiateWasm = (imports, receive) => {
      const instance = new WebAssembly.Instance(zstdWasm, imports);
      receive(instance);
      return instance.exports;
    };
    zstd.init();
    initialized = true;
  }
  let context = zstd._ZSTD_createDCtx();
  if (!context) throw new Error('Could not allocate zstd context');
  return {
    decode(data, dictionary) {
      if (!context) throw new Error('Decoder is closed');
      validateFrame(data);
      const allocations: number[] = [];
      const allocate = (size: number) => {
        const pointer = zstd._malloc(Math.max(1, size));
        if (!pointer) throw new Error('Could not allocate zstd buffer');
        allocations.push(pointer);
        return pointer;
      };
      try {
        const source = allocate(data.length), dest = allocate(8192);
        const dict = dictionary ? allocate(dictionary.length) : 0;
        zstd.HEAPU8.set(data, source);
        if (dictionary) zstd.HEAPU8.set(dictionary, dict);
        const size = zstd._ZSTD_decompress_usingDict(context, dest, 8192,
          source, data.length, dict, dictionary?.length ?? 0);
        if (zstd._ZSTD_isError(size) || size !== 8192) throw new Error('Could not decompress zstd page');
        return zstd.HEAPU8.slice(dest, dest + size);
      } finally { for (const pointer of allocations) zstd._free(pointer); }
    },
    close() { if (context) { zstd._ZSTD_freeDCtx(context); context = 0; } },
  };
}

/** Small caches leave room for WASM heaps in a Workers 128 MB isolate. */
export const openUrl = createOpenUrl({ createEngine, createDecoder }, {
  cacheBytes: 2 * 1024 * 1024,
  decodedCacheBytes: 2 * 1024 * 1024,
  sqliteCacheKiB: 2048,
});
export { openUrl as open_url };
