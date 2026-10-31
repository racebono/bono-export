import * as S from 'wa-sqlite';
import { createEngine, createDecoder } from './engines.js';
import { RemoteFile, type OpenOptions } from './http.js';
import { ReadOnlyVFS } from './vfs.js';
import { ExportFile } from './export.js';
import { query, validateParameters, type Value, type Row } from './sql.js';

export type { OpenOptions, Value, Row };
export interface Database {
  query(sql: string, parameters?: readonly Value[]): Promise<Row[]>;
  close(): Promise<void>;
}

export async function openUrl(url: string, options: OpenOptions = {}): Promise<Database> {
  const decodedBudget = options.decodedCacheBytes ?? 32 * 1024 * 1024;
  if (!Number.isSafeInteger(decodedBudget) || decodedBudget < 8192) throw new Error('decodedCacheBytes must be at least 8192');
  const remote = await RemoteFile.open(url, options);
  let outerVFS: ReadOnlyVFS | undefined = new ReadOnlyVFS(remote);
  let innerVFS: ReadOnlyVFS | undefined;
  let outer: Awaited<ReturnType<typeof createEngine>> | undefined;
  let inner: typeof outer;
  let outerDb: number | undefined, innerDb: number | undefined;
  let decoder: Awaited<ReturnType<typeof createDecoder>> | undefined;
  let file: ExportFile | undefined;
  const cleanup = async () => {
    // Attempt every cleanup even when a database close fails.
    try { if (innerDb !== undefined) await inner!.close(innerDb); }
    finally {
      innerDb = undefined;
      try { file?.close(); decoder?.close(); }
      finally {
        try { if (outerDb !== undefined) await outer!.close(outerDb); }
        finally {
          outerDb = undefined; remote.close(); inner = outer = undefined;
          file = undefined; innerVFS = outerVFS = undefined; decoder = undefined;
        }
      }
    }
  };
  const filesystemError = () => outerVFS?.error ?? innerVFS?.error;
  try {
    outer = await createEngine();
    outer.vfs_register(outerVFS, false);
    outerDb = await outer.open_v2('/database', S.SQLITE_OPEN_READONLY, outerVFS.name);
    await outer.exec(outerDb, 'PRAGMA cache_size=-32768; PRAGMA query_only=ON; PRAGMA temp_store=MEMORY');
    decoder = await createDecoder();
    file = new ExportFile(outer, outerDb, decoder, decodedBudget);
    await file.init();
    inner = await createEngine();
    innerVFS = new ReadOnlyVFS(file);
    inner.vfs_register(innerVFS, false);
    innerDb = await inner.open_v2('/database', S.SQLITE_OPEN_READONLY, innerVFS.name);
    await inner.exec(innerDb, 'PRAGMA cache_size=-32768; PRAGMA query_only=ON; PRAGMA temp_store=MEMORY');
    let pending = Promise.resolve();
    let closing: Promise<void> | undefined;
    return {
      query(sql, parameters = []) {
        if (closing) return Promise.reject(new Error('Database is closed'));
        let copied: Value[];
        try {
          validateParameters(parameters);
          copied = parameters.map(value => value instanceof Uint8Array ? value.slice() : value);
        } catch (error) { return Promise.reject(error); }
        const operation = pending.then(async () => {
          outerVFS!.error = undefined;
          if (innerVFS) innerVFS.error = undefined;
          try { return await query(inner!, innerDb!, sql, copied); }
          catch (error) { throw filesystemError() ?? error; }
        });
        pending = operation.then(() => {}, () => {});
        return operation;
      },
      close() {
        closing ??= pending.then(cleanup);
        return closing;
      },
    };
  } catch (error) {
    const failure = filesystemError() ?? error;
    await cleanup().catch(() => {});
    throw failure;
  }
}

export { openUrl as open_url };
