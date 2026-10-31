# bono-export for TypeScript

Read a compressed bono SQLite export directly from an HTTP(S) server in Node.js
22 or newer. Queries download only the portions they read, using HTTP byte ranges.
SQLite and dictionary-capable Zstandard run in WebAssembly; consumers need no Rust,
C++ compiler, native addon, or separately downloaded WASM assets.

## Usage

This package is not published to npm yet. From this checkout:

```sh
cd typescript
npm ci
npm pack
# In your application:
npm install /path/to/bono-export-0.1.0.tgz
```

```ts
import { openUrl } from 'bono-export';

const db = await openUrl('https://example.com/recording.db');
try {
  const rows = await db.query(
    'SELECT id, x, label FROM telemetry WHERE id = ?',
    [7],
  );
  console.log(rows);
} finally {
  await db.close();
}
```

`open_url` is an alias for `openUrl`. Open and query errors reject their promises.
Use an export made by the Rust crate in this repository, not a plain SQLite database.
Raw pages, zstd frames, and trained zstd dictionaries are supported.

`query(sql, parameters?)` executes exactly one SQL statement and returns row objects.
Parameters are positional: `null`, `string`, finite `number`, signed 64-bit `bigint`,
or `Uint8Array`. Use bigint for integers outside JavaScript's safe integer range.
SQL integer results are numbers when safe, otherwise bigint; real values are numbers,
blobs are copied Uint8Arrays, and SQL NULL is null. Use SQL aliases for duplicate column
names; duplicates are rejected. Bigint values need explicit conversion when using JSON.
SQL is trusted application input, not a security sandbox.

Calls on one connection are queued in submission order. Blob parameters are copied
when submitted. `close()` waits for already submitted queries, is idempotent, and
rejects further queries. A failed query does not block later queries.

## Options

```ts
const db = await openUrl(url, {
  timeoutMs: 60_000,
  cacheBytes: 64 * 1024 * 1024,
  decodedCacheBytes: 32 * 1024 * 1024,
  fetch: globalThis.fetch,
});
```

- `timeoutMs`: positive integer, at most 2147483647; covers headers and body of each attempt.
- `cacheBytes`: HTTP cache budget, at least 65536 bytes, rounded down to whole 64 KiB chunks.
- `decodedCacheBytes`: shared decoded-page/dictionary cache budget, at least 8192 bytes.
- `fetch`: optional Fetch-compatible transport, for custom authentication or testing.

The server must return `206 Partial Content` with a valid `Content-Range`, and
identity-encoded bytes. A server returning the entire file with status 200 is rejected.
Signed URL queries are preserved in requests and omitted from errors, along with
fragments and userinfo. URLs with userinfo are rejected; use a custom fetch transport
for header authentication. Injected fetch implementations must honor Fetch semantics;
the library enforces its timeout even if a custom transport ignores the abort signal,
but cannot forcibly stop that transport's own background activity.

Keep the remote file immutable while a connection is open. Size or ETag changes on
subsequent responses fail reads; without an ETag, same-size changes cannot be detected.
Cached pages are not revalidated. Retryable network failures, short responses, HTTP 429,
and 5xx receive at most three attempts, with 250 ms and 500 ms backoff.

The HTTP cache uses 64 KiB chunks, with sequential read-ahead capped at 4 MiB. There
are also 32 MiB SQLite page caches in each of the two isolated SQLite instances.
The WASM heaps, query result arrays, active reads, and dictionaries add memory beyond
the configured cache budgets; those budgets are not a total process memory cap.
Close connections to release their handles and cache references. The zstd WASM engine
is initialized once per process and retained; SQLite instances become eligible for GC.
Network I/O is asynchronous, but SQL and decompression run on the calling thread.
Use a Node worker thread if you need CPU isolation.

## Development

```sh
npm ci
npm test
npm run test:package
```

The package smoke test installs the tarball into a temporary consumer outside the
repository, checks TypeScript imports, and runs a query over HTTP with the installed
WASM assets. It reuses npm's cache when possible and may access the registry for
dependency metadata, so it needs the same registry access as a normal npm install.

See [fixture provenance and regeneration](test/fixtures/README.md).
The Node asset loader is isolated in `src/engines.ts`; the HTTP and VFS layers use
Web APIs. Browser loading and browser testing are future work.

MIT; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
