import { DurableObject } from 'cloudflare:workers';
import { openUrl, open_url } from 'bono-export/cloudflare';

async function point(db, id) {
  return db.query('SELECT id, x, label FROM telemetry WHERE id = ?', [id]);
}

export class ExportReader extends DurableObject {
  db;
  opens = 0;
  async fetch(request) {
    const path = new URL(request.url).pathname;
    // This example deliberately includes explicit close/reopen for testing.
    // Block other events while changing ownership of the cached connection.
    if (path === '/close') {
      await this.ctx.blockConcurrencyWhile(async () => {
        await this.db?.close(); this.db = undefined;
      });
      return Response.json({ closed: true });
    }
    if (!this.db) await this.ctx.blockConcurrencyWhile(async () => {
      this.db = await openUrl(this.env.EXPORT_URL);
      this.opens++;
    });
    const rows = path === '/sum'
      ? await this.db.query('SELECT count(*) AS n, sum(x) AS total FROM telemetry')
      : await point(this.db, Number(new URL(request.url).searchParams.get('id') ?? 7));
    return Response.json({ opens: this.opens, rows });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/do/')) {
      url.pathname = url.pathname.slice(3);
      return env.READERS.getByName('recording').fetch(new Request(url, request));
    }
    if (openUrl !== open_url) throw new Error('Alias missing');
    const db = await openUrl(env.EXPORT_URL, { sqliteCacheKiB: undefined, cacheBytes: undefined });
    try {
      if (url.pathname === '/values') {
        const [row] = await db.query('SELECT ? AS text, ? AS blob, ? AS large', ['a\0b', new Uint8Array(), 9223372036854775807n]);
        return Response.json({ text: row.text, bytes: [...row.blob], large: String(row.large) });
      }
      if (url.pathname === '/cache') return Response.json(await db.query('PRAGMA cache_size'));
      if (url.pathname === '/sum') return Response.json(await db.query('SELECT count(*) AS n, sum(x) AS total FROM telemetry'));
      if (url.pathname === '/readonly') {
        try { await db.query('CREATE TABLE nope(x)'); } catch { return new Response('read-only'); }
        throw new Error('Expected read-only failure');
      }
      return Response.json(await point(db, 7));
    } finally { await db.close(); }
  },
};
