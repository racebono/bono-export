import { createRequire } from 'node:module';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const target = new URL('../dist/vendor/', import.meta.url);
await mkdir(target, { recursive: true });
await copyFile(require.resolve('wa-sqlite/dist/wa-sqlite-async.wasm'), new URL('sqlite.wasm', target));
const zstd = dirname(require.resolve('@bokuweb/zstd-wasm'));
await copyFile(resolve(zstd, 'zstd.wasm'), new URL('zstd.wasm', target));
await copyFile(resolve(zstd, '../web/zstd.js'), new URL('zstd.js', target));
