export const CHUNK = 65536;

export interface OpenOptions {
  /** Fetch-compatible transport. Must return the raw, unencoded range bytes. */
  fetch?: typeof globalThis.fetch;
  /** Covers headers and body; default 60 seconds per attempt. */
  timeoutMs?: number;
  /** HTTP chunk cache budget, at least 64 KiB. Default 64 MiB. */
  cacheBytes?: number;
  /** Decoded page/dictionary cache budget, at least 8 KiB. Default 32 MiB. */
  decodedCacheBytes?: number;
  /** Page cache for each SQLite instance, in KiB. Default 32768 on Node. */
  sqliteCacheKiB?: number;
}

class RequestError extends Error {
  constructor(message: string, readonly retry = false) { super(message); }
}

/** HTTP file operations are serialized by the owning SQLite connection. */
export class RemoteFile {
  size = 0;
  private etag: string | null = null;
  private chunks = new Map<number, Uint8Array>();
  private next = 0;
  private ahead = 0;
  private closed = false;
  private constructor(private url: string, private fetcher: typeof fetch,
    private timeout: number, private limit: number) {}

  static async open(input: string, options: OpenOptions = {}): Promise<RemoteFile> {
    let url: URL;
    try { url = new URL(input); } catch { throw new Error('Expected an absolute HTTP(S) URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Expected an HTTP(S) URL without userinfo');
    }
    url.hash = '';
    const timeout = options.timeoutMs ?? 60000;
    const cache = options.cacheBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) {
      throw new Error('timeoutMs must be a positive integer no greater than 2147483647');
    }
    if (!Number.isSafeInteger(cache) || cache < CHUNK) throw new Error('cacheBytes must be at least 65536');
    const file = new RemoteFile(url.href, options.fetch ?? globalThis.fetch, timeout, Math.floor(cache / CHUNK));
    const got = await file.get(0, CHUNK - 1);
    file.size = got.size;
    file.etag = got.etag;
    file.chunks.set(0, got.data);
    return file;
  }

  private async get(first: number, last: number) {
    for (let attempt = 1; ; attempt++) {
      try { return await this.request(first, last); }
      catch (error) {
        const safe = error instanceof RequestError ? error : new RequestError('HTTP request failed', true);
        if (!safe.retry || attempt === 3) throw new Error(safe.message);
        await new Promise(resolve => setTimeout(resolve, 250 * attempt));
      }
    }
  }

  private async request(first: number, last: number) {
    const controller = new AbortController();
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let expired = false;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        if (reader) void reader.cancel().catch(() => {});
        reject(new RequestError('HTTP request timed out', true));
      }, this.timeout);
    });
    const operation = async () => {
      response = await this.fetcher.call(globalThis, this.url, { headers: {
        Range: `bytes=${first}-${last}`, 'Accept-Encoding': 'identity',
      }, signal: controller.signal });
      if (expired) {
        void response.body?.cancel().catch(() => {});
        throw new RequestError('HTTP request timed out', true);
      }
      if (response.status === 200) throw new RequestError("The server doesn't answer range requests");
      if (response.status !== 206) throw new RequestError(`The server answered HTTP ${response.status}`,
        response.status === 429 || response.status >= 500);
      const encoding = response.headers.get('content-encoding');
      if (encoding && encoding.toLowerCase() !== 'identity') throw new RequestError('Encoded range responses are unsupported');
      const etag = response.headers.get('etag');
      if (this.size && etag !== this.etag) throw new RequestError('The file changed while it was open');
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      if (!match) throw new RequestError('Unexpected Content-Range');
      const [from, to, size] = match.slice(1).map(Number) as [number, number, number];
      if (![from, to, size].every(Number.isSafeInteger) || size <= 0 || from !== first ||
          to !== Math.min(last, size - 1) || to < from || (this.size && size !== this.size)) {
        throw new RequestError('Unexpected Content-Range or changed file size');
      }
      const length = to - from + 1;
      const data = new Uint8Array(length);
      if (!response.body) throw new RequestError('The response was cut short', true);
      reader = response.body.getReader();
      let offset = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (expired) throw new RequestError('HTTP request timed out', true);
        if (done) break;
        if (value.length > length - offset) throw new RequestError('The response exceeded the requested range');
        data.set(value, offset);
        offset += value.length;
      }
      if (offset !== length) throw new RequestError('The response was cut short', true);
      return { data, size, etag };
    };
    try { return await Promise.race([operation(), timeout]); }
    finally {
      clearTimeout(timer!);
      if (reader) void reader.cancel().catch(() => {});
      else if (response) void response.body?.cancel().catch(() => {});
      controller.abort();
    }
  }

  async read(target: Uint8Array, offset: number): Promise<number> {
    if (this.closed) throw new Error('HTTP file is closed');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + target.length)) {
      throw new Error('Invalid read offset');
    }
    const end = Math.min(offset + target.length, this.size);
    if (offset >= end) return 0;
    const first = Math.floor(offset / CHUNK), last = Math.floor((end - 1) / CHUNK);
    this.ahead = offset === this.next ? Math.min(64, Math.max(1, this.ahead * 2)) : 0;
    this.next = end;
    const missing = [];
    for (let i = first; i <= last; i++) if (!this.chunks.has(i)) missing.push(i);
    if (missing.length) {
      const from = missing[0]!;
      let to = missing.at(-1)!;
      const count = Math.ceil(this.size / CHUNK);
      while (to + 1 < count && to < last + this.ahead && !this.chunks.has(to + 1)) to++;
      const { data } = await this.get(from * CHUNK, Math.min(this.size, (to + 1) * CHUNK) - 1);
      for (let i = from; i <= to; i++) this.chunks.set(i, data.slice((i - from) * CHUNK, (i - from + 1) * CHUNK));
    }
    for (let i = first; i <= last; i++) {
      const chunk = this.chunks.get(i)!;
      this.chunks.delete(i); this.chunks.set(i, chunk);
      const start = Math.max(offset, i * CHUNK), stop = Math.min(end, (i + 1) * CHUNK);
      target.set(chunk.subarray(start - i * CHUNK, stop - i * CHUNK), start - offset);
    }
    while (this.chunks.size > this.limit) this.chunks.delete(this.chunks.keys().next().value!);
    return end - offset;
  }

  close(): void { this.closed = true; this.chunks.clear(); this.url = ''; }
}
