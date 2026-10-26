import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { extname, resolve, sep } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { handleApi } from './api.mjs';

const root = resolve(import.meta.dirname, '..');
const distDir = resolve(root, 'dist');
const contentTypes = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.mp3', 'audio/mpeg'], ['.png', 'image/png'], ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
]);

async function serveStatic(request, response, pathname) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
    return response.end(JSON.stringify({ error: '不支持这个请求方法' }));
  }
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch {
    response.writeHead(400);
    return response.end();
  }
  let filePath = resolve(distDir, `.${decoded}`);
  if (filePath !== distDir && !filePath.startsWith(`${distDir}${sep}`)) {
    response.writeHead(404);
    return response.end();
  }
  try {
    if ((await stat(filePath)).isDirectory()) filePath = resolve(filePath, 'index.html');
    await stat(filePath);
  } catch {
    filePath = resolve(distDir, 'index.html');
  }
  let body;
  try { body = await readFile(filePath); } catch {
    response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
    return response.end(JSON.stringify({ error: '网页尚未构建，请先运行 npm run build' }));
  }
  response.writeHead(200, {
    'Content-Type': contentTypes.get(extname(filePath).toLowerCase()) ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

async function dispatchApi(request, response) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) headers.set(name, value.join(', '));
    else if (value !== undefined) headers.set(name, value);
  }
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  const webRequest = new Request(new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`), {
    method: request.method,
    headers,
    ...(hasBody ? { body: Readable.toWeb(request), duplex: 'half' } : {}),
  });
  const webResponse = await handleApi(webRequest);
  response.writeHead(webResponse.status, Object.fromEntries(webResponse.headers));
  if (!webResponse.body) return response.end();
  Readable.fromWeb(webResponse.body).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    if (url.pathname.startsWith('/api/')) await dispatchApi(request, response);
    else await serveStatic(request, response, url.pathname);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: '服务器暂时无法处理请求' }));
  }
});

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
server.listen(port, host, () => console.log(`Heart Memories 已启动：http://${host}:${port}`));
