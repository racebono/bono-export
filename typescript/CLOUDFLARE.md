# Cloudflare Workers and Durable Objects

Import the explicit Cloudflare entry, which bundles precompiled SQLite and zstd
WebAssembly modules and uses no Node filesystem APIs or Node compatibility polyfills:

```ts
import { openUrl } from 'bono-export/cloudflare';
```

`open_url` is also exported. The API and SQL values match the Node entry. Install the
package tarball as described in the main README; it is not published to npm yet.
Keep Wrangler's default `.wasm` module bundling rule enabled. Both WASM assets are
included in the package. Do not configure them as text/data or load them with fetch:
Workers instantiates precompiled modules and cannot compile WASM bytes at runtime.

## A regular Worker

Open and close a connection inside each request. Cache compiled modules globally,
as the package does, but do not cache a live database or an in-flight opening promise
across unrelated Worker requests. Pending I/O belongs to its request context.

```ts
import { openUrl } from 'bono-export/cloudflare';

interface Env { EXPORT_URL: string }

export default {
  async fetch(_request: Request, env: Env) {
    const db = await openUrl(env.EXPORT_URL);
    try {
      const rows = await db.query('SELECT count(*) AS n FROM telemetry');
      return new Response(JSON.stringify(rows, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value), {
        headers: { 'content-type': 'application/json' },
      });
    } finally {
      await db.close();
    }
  },
};
```

Configure `EXPORT_URL` as a binding to an immutable HTTP(S) export which supports
range requests. It can be a signed URL; use a secret binding if it contains credentials.
Example `wrangler.jsonc`:

```jsonc
{
  "name": "bono-export-reader",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-30",
  "vars": { "EXPORT_URL": "https://example.com/export.db" }
}
```

## A Durable Object

A Durable Object can keep a connection and its caches in instance memory across
calls. Serialize initialization and connection replacement with `blockConcurrencyWhile`;
the library serializes queries on the connection. Different objects must own their
own connections. This reads a remote export; it does not use Durable Object SQLite
storage or persist the downloaded pages.

```ts
import { DurableObject } from 'cloudflare:workers';
import { openUrl, type Database } from 'bono-export/cloudflare';

interface Env {
  EXPORT_URL: string;
  READERS: DurableObjectNamespace<ExportReader>;
}

export class ExportReader extends DurableObject<Env> {
  private database?: Database;

  async count() {
    if (!this.database) {
      await this.ctx.blockConcurrencyWhile(async () => {
        this.database = await openUrl(this.env.EXPORT_URL);
      });
    }
    return this.database!.query('SELECT count(*) AS n FROM telemetry');
  }

  async close() {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.database?.close();
      this.database = undefined;
    });
  }
}

export default {
  async fetch(_request: Request, env: Env) {
    const reader = env.READERS.getByName('recording');
    return Response.json(await reader.count());
  },
};
```

For this Durable Object example, add these entries to the Wrangler configuration:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "READERS", "class_name": "ExportReader" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["ExportReader"] }]
}
```

Use the object's `close()` method before switching to a different export URL.
Immutable files and ETags retain the same requirements as on Node. Object eviction
discards the database and caches; the next instance opens it again. Do not persist
the Database object in Durable Object storage. It is an in-memory WASM connection.

## Budgets and limits

The Cloudflare entry defaults to a 2 MiB HTTP chunk cache, a 2 MiB decoded-page /
dictionary cache, and a 2048 KiB page cache in **each** SQLite instance. Override
`cacheBytes`, `decodedCacheBytes`, and `sqliteCacheKiB` in the options object if needed.
The root Node entry retains its existing larger defaults.

These are cache budgets, not a total memory cap. Each open connection needs two
SQLite WASM instances, in addition to the shared zstd engine and result arrays.
Workers' 128 MB memory limit applies to the whole isolate, including concurrent
requests and WebAssembly heaps. Keep concurrent connections and result sizes small.
Closing releases references, but the runtime controls when garbage collection runs.

SQL and decompression use the invoking request's CPU budget. Large scans may exceed
Free-plan CPU or subrequest limits; measure representative workloads on your plan.
The library performs HTTP range requests; direct R2 bucket bindings are not a
separate built-in transport in this version.

## Verification

`npm run test:cloudflare` packs and installs the package into a temporary consumer,
bundles it with esbuild, and executes it on workerd via Miniflare without Node
compatibility flags. It verifies real Rust exports, selective HTTP reads, trained
dictionaries, SQL text/blob/integer values, read-only enforcement, multiple Worker
requests, concurrent queries, and Durable Object connection reuse / close / reopen.
No Cloudflare account, deployment or network-accessible database is required.
