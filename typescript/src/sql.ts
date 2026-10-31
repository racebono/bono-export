import * as S from 'wa-sqlite';
import type { Engine } from './engines.js';

export type Value = null | string | number | bigint | Uint8Array;
export type Row = Record<string, Value>;

export function validateParameters(parameters: readonly Value[]): void {
  for (const value of parameters) {
    if (typeof value === 'bigint') {
      if (value < -(1n << 63n) || value >= 1n << 63n) throw new Error('Integer parameter is outside signed 64-bit range');
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        throw new Error('Use bigint for integers outside the safe number range; numbers must be finite');
      }
    } else if (value !== null && typeof value !== 'string' && !(value instanceof Uint8Array)) {
      throw new Error('Unsupported SQL parameter type');
    }
  }
}

/** Prepare the tail before stepping so multiple statements have no effects. */
export async function query(engine: Engine, db: number, sql: string, parameters: readonly Value[] = []): Promise<Row[]> {
  if (typeof sql !== 'string' || sql.includes('\0')) throw new Error('SQL must be a string without NUL bytes');
  validateParameters(parameters);
  const text = engine.str_new(db, sql);
  let statement: number | undefined;
  try {
    const first = await engine.prepare_v2(db, engine.str_value(text));
    if (!first) throw new Error('Expected exactly one SQL statement');
    statement = first.stmt;
    const second = await engine.prepare_v2(db, first.sql);
    if (second) {
      await engine.finalize(second.stmt);
      throw new Error('Expected exactly one SQL statement');
    }
    if (engine.bind_parameter_count(statement) !== parameters.length) throw new Error('SQL parameter count mismatch');
    parameters.forEach((value, i) => engine.bind(statement!, i + 1, value));
    const names = engine.column_names(statement);
    if (new Set(names).size !== names.length) throw new Error('Duplicate result column names; use SQL aliases');
    const result: Row[] = [];
    while (await engine.step(statement) === S.SQLITE_ROW) {
      const row: Row = {};
      names.forEach((name, i) => {
        let value: Value;
        switch (engine.column_type(statement!, i)) {
          case S.SQLITE_INTEGER: {
            const n = engine.column_int64(statement!, i);
            value = n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
            break;
          }
          case S.SQLITE_FLOAT: value = engine.column_double(statement!, i); break;
          case S.SQLITE_TEXT: value = engine.column_text(statement!, i); break;
          case S.SQLITE_BLOB: value = engine.column_blob(statement!, i).slice(); break;
          default: value = null;
        }
        // Define an own property even for names such as __proto__.
        Object.defineProperty(row, name, { value, enumerable: true, writable: true, configurable: true });
      });
      result.push(row);
    }
    return result;
  } finally {
    try { if (statement !== undefined) await engine.finalize(statement); }
    finally { engine.str_finish(text); }
  }
}
