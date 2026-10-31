import { query, type Row } from './sql.js';
import type { Engine, createDecoder } from './engines.js';
import type { ReadableFile } from './vfs.js';

/** One byte-budgeted LRU shared by dictionaries and decoded pages. */
export class ExportFile implements ReadableFile {
  private cache = new Map<string, Uint8Array>();
  private used = 0;
  size = 0;
  constructor(private engine: Engine, private db: number,
    private decoder: Awaited<ReturnType<typeof createDecoder>>, private budget: number) {}

  private remember(key: string, value: Uint8Array) {
    if (value.length > this.budget) return;
    while (this.used + value.length > this.budget) {
      const oldest = this.cache.keys().next().value!;
      this.used -= this.cache.get(oldest)!.length;
      this.cache.delete(oldest);
    }
    this.cache.set(key, value); this.used += value.length;
  }
  private cached(key: string) {
    const value = this.cache.get(key);
    if (value) { this.cache.delete(key); this.cache.set(key, value); }
    return value;
  }
  private async rows(sql: string, params: number[] = []): Promise<Row[]> { return query(this.engine, this.db, sql, params); }

  async init() {
    const [id] = await this.rows('PRAGMA application_id');
    if (id?.application_id !== 0x7a737464) throw new Error('Not a bono zstd export');
    const [count] = await this.rows('SELECT MAX(pageno) AS n FROM nested_vfs_zstd_pages');
    if (typeof count?.n !== 'number' || !Number.isSafeInteger(count.n) || count.n <= 0 ||
        !Number.isSafeInteger(count.n * 8192)) throw new Error('Invalid export page count');
    this.size = count.n * 8192;
    const header = await this.page(1);
    if (new TextDecoder().decode(header.subarray(0, 16)) !== 'SQLite format 3\0' ||
        new DataView(header.buffer, header.byteOffset).getUint16(16) !== 8192) {
      throw new Error('Invalid export header or page size (expected 8192)');
    }
    if (header[18] === 2 || header[19] === 2) throw new Error('The export is in WAL mode');
  }

  private async page(number: number): Promise<Uint8Array> {
    const key = `p${number}`, cached = this.cached(key);
    if (cached) return cached;
    const [row] = await this.rows('SELECT data, meta1 FROM nested_vfs_zstd_pages WHERE pageno = ?', [number]);
    if (!row || !(row.data instanceof Uint8Array) || !row.data.length || row.data.length > 8192) throw new Error('Missing or invalid export page');
    let page: Uint8Array;
    if (row.meta1 === null) page = row.data;
    else {
      if (typeof row.meta1 !== 'number' || !Number.isSafeInteger(row.meta1)) throw new Error('Invalid page compression metadata');
      let dictionary: Uint8Array | undefined;
      if (row.meta1 >= 0) {
        const dictKey = `d${row.meta1}`;
        dictionary = this.cached(dictKey);
        if (!dictionary) {
          const [dict] = await this.rows('SELECT dict FROM nested_vfs_zstd_dicts WHERE id = ?', [row.meta1]);
          if (!(dict?.dict instanceof Uint8Array) || !dict.dict.length) throw new Error('Missing or invalid zstd dictionary');
          dictionary = dict.dict;
          this.remember(dictKey, dictionary);
        }
      }
      page = this.decoder.decode(row.data, dictionary);
    }
    if (page.length !== 8192) throw new Error('Invalid decoded page size');
    this.remember(key, page);
    return page;
  }

  async read(target: Uint8Array, offset: number) {
    const end = Math.min(offset + target.length, this.size);
    let start = offset;
    while (start < end) {
      const index = Math.floor(start / 8192), within = start % 8192;
      const count = Math.min(8192 - within, end - start);
      const page = await this.page(index + 1);
      target.set(page.subarray(within, within + count), start - offset);
      start += count;
    }
    return Math.max(0, end - offset);
  }
  close() { this.cache.clear(); this.used = 0; this.decoder.close(); }
}
