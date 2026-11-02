import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';

export const fixture = name => readFile(new URL(`./fixtures/${name}.db`, import.meta.url));
export function rangeTransport(data, transform) {
  const stats = { requests: 0, bytes: 0, ranges: [], urls: [] };
  const fetch = async (url, init) => {
    stats.requests++;
    stats.urls.push(url);
    const match = /bytes=(\d+)-(\d+)/.exec(init.headers.Range);
    const first = Number(match[1]), last = Math.min(Number(match[2]), data.length - 1);
    const body = data.subarray(first, last + 1);
    stats.ranges.push([first, last]); stats.bytes += body.length;
    const response = new Response(body, { status: 206, headers: {
      'content-range': `bytes ${first}-${last}/${data.length}`, etag: 'fixture-v1',
    } });
    return transform ? transform(response, stats, init) : response;
  };
  return { fetch, stats };
}

export async function serve(data) {
  const stats = { requests: 0, bytes: 0 };
  const server = createServer((request, response) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range ?? '');
    if (!match) { response.writeHead(400).end(); return; }
    const first = Number(match[1]), last = Math.min(Number(match[2]), data.length - 1);
    const body = data.subarray(first, last + 1);
    stats.requests++; stats.bytes += body.length;
    response.writeHead(206, { 'Content-Range': `bytes ${first}-${last}/${data.length}`,
      ETag: 'fixture', 'Content-Length': body.length });
    response.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}/export.db`, stats,
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
