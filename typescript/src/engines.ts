// Keep Node's asset resolution out of the portable HTTP/VFS implementation.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import factory from 'wa-sqlite/dist/wa-sqlite-async.mjs';
import * as SQLite from 'wa-sqlite';
import * as zstd from '@bokuweb/zstd-wasm';

export type Engine = ReturnType<typeof SQLite.Factory>;
let binary: Promise<Uint8Array> | undefined;
export async function createEngine(): Promise<Engine> {
  binary ??= readFile(createRequire(import.meta.url).resolve('wa-sqlite/dist/wa-sqlite-async.wasm'));
  const module = await factory({ wasmBinary: await binary });
  const engine = SQLite.Factory(module);
  // wa-sqlite 1.0.0's text helpers use NUL termination, and its blob binder
  // maps a zero-byte allocation to SQL NULL. Use explicit lengths and a
  // nonnull pointer even for empty values; SQLITE_TRANSIENT copies before free.
  const bindText = module.cwrap('sqlite3_bind_text', 'number', ['number', 'number', 'number', 'number', 'number']);
  const bindBlob = module.cwrap('sqlite3_bind_blob', 'number', ['number', 'number', 'number', 'number', 'number']);
  const bindBytes = (stmt: number, index: number, bytes: Uint8Array, text: boolean): number => {
    const pointer = module._sqlite3_malloc(Math.max(1, bytes.length));
    if (!pointer) throw new Error('Could not allocate SQLite parameter');
    try {
      module.HEAPU8.set(bytes, pointer);
      const code = (text ? bindText : bindBlob)(stmt, index, pointer, bytes.length, -1);
      if (code !== SQLite.SQLITE_OK) throw new Error(`SQLite parameter binding failed (${code})`);
      return code;
    } finally { module._sqlite3_free(pointer); }
  };
  const utf8 = new TextEncoder(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  engine.bind_text = (stmt, index, value) => bindBytes(stmt, index, utf8.encode(value), true);
  engine.bind_blob = (stmt, index, value) => bindBytes(stmt, index, value instanceof Uint8Array ? value : new Uint8Array(value), false);
  engine.column_text = (stmt, index) => decoder.decode(engine.column_blob(stmt, index));
  return engine;
}

let initialized: Promise<void> | undefined;
export async function createDecoder() {
  initialized ??= zstd.init();
  await initialized;
  let context = zstd.createDCtx();
  if (!context) throw new Error('Could not allocate zstd context');
  return {
    decode(data: Uint8Array, dictionary?: Uint8Array): Uint8Array {
      // The dependency allocates the advertised frame size. Validate it first,
      // so a corrupt page cannot request a huge WASM allocation.
      if (data.length < 5 || new DataView(data.buffer, data.byteOffset).getUint32(0, true) !== 0xfd2fb528) {
        throw new Error('Invalid zstd page frame');
      }
      const descriptor = data[4]!;
      if (descriptor & 0x18) throw new Error('Invalid zstd frame descriptor');
      const single = !!(descriptor & 0x20), flag = descriptor >>> 6;
      const dictLength = [0, 1, 2, 4][descriptor & 3]!;
      const offset = 5 + (single ? 0 : 1) + dictLength;
      const bytes = flag ? 1 << flag : single ? 1 : 0;
      if (data.length < offset + bytes) throw new Error('Truncated zstd frame header');
      if (bytes) {
        let size = 0n;
        for (let i = bytes - 1; i >= 0; i--) size = (size << 8n) | BigInt(data[offset + i]!);
        if (bytes === 2) size += 256n;
        if (size !== 8192n) throw new Error('Invalid decoded page size');
      }
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
