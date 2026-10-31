# TypeScript `open_url` library

Status: reviewed for planning completeness; awaiting user approval.

## Intent and decisions

Provide an npm-compatible TypeScript library equivalent to Rust's `open_url`:
open an existing bono export over HTTP(S), then run read-only SQL while fetching
only the portions needed by those queries. The user selected TypeScript with
WebAssembly SQLite, running on Node.js first, with possible browser support later.
Browser support is an architectural consideration, not a deliverable for this version.

The package lives in `typescript/`, alongside the existing Rust crate. Rust remains
the exporter and compatibility reference. No change to the export format is needed.

## Approaches

1. **TypeScript plus WebAssembly SQLite (selected).** Implement HTTP and nested
   compressed-page filesystems in TypeScript, using SQLite's WASM engine for SQL
   and a dictionary-capable Zstandard decoder. This needs more initial work but
   avoids native Node addons and allows future browser adaptation.
2. **TypeScript bindings to Rust (not selected).** Reuse the existing VFS code
   through a native addon. This would reuse more tested code, but require platform
   binaries and a different solution for browsers.

The user selected option 1 after being presented these tradeoffs.

## Scope

- Node.js 22+ ESM package with compiled JavaScript, declaration files, and examples.
- Open existing Rust-produced compressed exports, including dictionary-compressed
  pages and pages stored without compression.
- Parameterized read-only SQL, explicit resource disposal, and predictable async behavior.
- HTTP range validation, bounded caches, retries, timeout, and file-change detection.
- Tests against actual Rust-produced exports and a local HTTP range server.

Not included: exporting or writing databases, publishing to npm, a browser bundle,
ORM integrations, extension loading, or a performance parity guarantee with native Rust.
Downloading/decompressing the entire database on open is not an acceptable substitute
for lazy range reads. A mock SQL engine or decoder is not a completed implementation.

## Public API

```ts
import { openUrl } from 'bono-export';

const db = await openUrl('https://host/recording.db');
try {
  const rows = await db.query('SELECT * FROM laps WHERE id = ?', [7]);
} finally {
  await db.close();
}
```

Expose `open_url` as an alias of `openUrl` for callers matching the Rust name.
`query(sql, parameters?)` accepts exactly one statement and returns an array of
row objects. Reject duplicate result-column names rather than silently losing data;
callers can use SQL aliases. Parameters are positional: null, string, number,
bigint, or Uint8Array. Results preserve SQL NULL and blobs; integer conversion must
not silently lose precision (safe integers as numbers, larger integers as bigint).
Floating-point SQL values remain numbers. Reject integers outside SQLite's signed
64-bit range. SQL is caller-supplied trusted input, not a sandbox for hostile SQL.

`close()` is idempotent, queued after previously submitted work; operations submitted
after close are rejected. Operations on one connection are serialized. Different
connections own independent state and must not share an unsafe WASM execution context.
Opening failures dispose all partial resources.

An optional options object supports an injected Fetch-compatible function, per-request
timeout, and cache budgets. Defaults match Rust where practical. Node-specific WASM
file loading lives in a separate adapter; portable modules use Web APIs and typed arrays.
Exact option names, package version, and internal helper types are builder decisions.

## Architecture

### HTTP file

Use fetch with Range requests, starting with bytes 0-65535 to learn file size and ETag.
Require HTTP(S), status 206, valid Content-Range with the exact requested interval
clamped at EOF, a positive safe-integer total size, and an exact response body length.
Reject status 200 rather than accepting a full download. Reject non-identity content
encoding because byte offsets must refer to the stored file. Keep signed URL queries
unchanged in requests, remove fragments, and reject URL userinfo without leaking it.

Subsequent responses must have the same total size and ETag (including its absence).
An ETag change, disappearance, or appearance fails the read. With no ETag, size is
the only available validator; the server must keep the file immutable, as Rust requires.
Cached data need not be revalidated on every query.

Use 64 KiB chunks and a 64 MiB LRU budget, coalescing missing chunks into requests.
Retain Rust's sequential read-ahead policy, up to 64 extra chunks (4 MiB). Evict after
servicing a read; active reads may temporarily exceed the cache budget. Make up to
three attempts for network errors, short bodies, 429, and 5xx responses, with bounded
backoff. Do not retry protocol errors or changed-file errors. Default request timeout
is 60 seconds and covers body consumption as well as receiving response headers.
Bound streamed response consumption to the expected length plus one byte; cancel
rejected bodies so a bad server cannot force an unbounded allocation/download.

All public errors, including nested causes, must omit userinfo, URL queries, fragments,
and raw fetch errors that could expose credentials. Do not include response bodies
in errors. Use structured local reasons such as status codes and protocol failures.

### Outer SQLite database

Use wa-sqlite's async WASM build with a TypeScript read-only HTTP VFS. SQLite reads
the outer database's B-tree through HTTP chunks. Query its nested page table and
dictionary table rather than writing a second SQLite file-format parser.

### Inner SQLite database

A second WASM SQLite instance opens a read-only TypeScript VFS backed by decoded
pages from the outer database. Separate instances avoid reentering the same SQLite
WASM/Asyncify context while an inner filesystem callback queries the outer database.

Follow the vendored SQLiteNestedVFS and zstd_vfs format exactly: one-based page
numbers, the `nested_vfs_zstd_pages` table, stored page metadata, raw-page handling,
and dictionary lookup. Validate the outer application ID `0x7a737464`. `meta1`
NULL means raw bytes; a negative integer means zstd without a dictionary; a
nonnegative integer refers to `nested_vfs_zstd_dicts`. Missing pages/dictionaries,
invalid metadata, decompression errors, or a decoded size other than 8192 fail.
Derive logical file size from `MAX(pageno)` times page size and validate page-one header.

Use a Zstandard decoder with full trained-dictionary support; a decoder limited to
dictionary-free frames cannot read real exports and is unsuitable. The builder
selects and pins the decoder after verifying the actual dictionary API and assets.
Prefer a ready-to-use WASM decoder; if none is suitable, include a small reproducible
libzstd WASM build with source/license provenance. A native-only decoder is outside
the selected architecture. This dependency feasibility check is the first plan step.

Both VFS layers reject writes and expose no WAL/journal sidecars. Validate the inner
page size is 8192 and it is not in WAL mode, matching Rust's `check_format`.
Use SQLite read-only open flags and query-only configuration. Keep inner and outer
SQLite page-cache defaults near Rust's 32 MiB each and bound any extra decoded-page
or dictionary caches. Per-connection memory includes two WASM heaps in addition to
the caches; document that overhead rather than claiming a strict total memory cap.
Closing frees statements, database handles, caches, and decoder resources and drops
references to WASM instances. CPU work runs on the calling thread in this version;
async HTTP avoids network blocking but is not a guarantee of event-loop isolation.

## Package, verification, and completion

Keep source, tests, package manifest, lockfile, build/typecheck configuration, and
usage documentation under `typescript/`; link it from the root README. Include
WASM distribution/loading instructions and third-party licenses as required.
Do not require Rust or a C++ toolchain for library consumers.

Generate and retain small reproducible fixtures using the existing Rust exporter:
cover dictionary-free frames, trained dictionaries, and raw pages. Include a larger
fixture or generation path for selective-download tests. Document provenance and
generation commands. Compare query results to the source database/Rust reader.

Tests cover schema and parameterized lookups/aggregates, SQL value types and large
integers, read-only enforcement, multiple connections, concurrent calls, close and
failed-open cleanup. HTTP tests cover caching and limited bytes transferred for a
point lookup, read-ahead, ranges across chunk boundaries and EOF, malformed ranges,
200/404/429/5xx, short/oversized/encoded bodies, network failures, timeouts, changes
to ETag/size, and credential-safe errors. Format tests cover missing dictionaries,
invalid headers and corrupt compressed pages. A packed-package smoke test must load
WASM assets and query a fixture from outside the source tree.

Completion requires typechecking/building, passing meaningful tests including actual
Rust export compatibility, and reporting any checks blocked by the environment.
Leave the Rust export behavior unchanged. Commit only the design at this stage;
implementation follows approval and a written plan.
