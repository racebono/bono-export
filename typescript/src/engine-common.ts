import * as SQLite from 'wa-sqlite';

export type Engine = ReturnType<typeof SQLite.Factory>;
export interface SQLiteModule {
  cwrap(name: string, result: string, args: string[]): (...args: number[]) => number;
  _sqlite3_malloc(bytes: number): number;
  _sqlite3_free(pointer: number): void;
  HEAPU8: Uint8Array;
}

export function configureEngine(module: SQLiteModule): Engine {
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
