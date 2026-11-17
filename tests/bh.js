const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { PGlite } = require('@electric-sql/pglite');
const createBackend = require('./backend');
const SITE = path.join(__dirname, '..', 'public');
const VERCEL = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const SEC = {}; (VERCEL.headers.find((h) => h.source === '/(.*)').headers).forEach((h) => { SEC[h.key.toLowerCase()] = h.value; });
const SB = 'https://qmxkbvpzkgkkcdzbyget.supabase.co';
const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const shim = require('./shim');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain', '.png': 'image/png' };

async function start() {
  const pg = new PGlite(); await pg.exec(shim); await pg.exec(schema);
  const state = {}; const handle = createBackend(pg, state);
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]); const f = path.join(SITE, p === '/' ? 'index.html' : p);
    if (!f.startsWith(SITE) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nf'); }
    const extra = {}; VERCEL.headers.forEach((hd) => { if (hd.source === '/(.*)') return; if (new RegExp('^' + hd.source.replace('(.*)', '.*') + '$').test(p)) hd.headers.forEach((x) => { extra[x.key.toLowerCase()] = x.value; }); });
    res.writeHead(200, Object.assign({ 'content-type': mime[path.extname(f)] || 'application/octet-stream' }, SEC, extra)); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(4173, r));
  const browser = await chromium.launch(Object.assign({ args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }, process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}));
  async function newPage(opts = {}) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 860 }, permissions: ['clipboard-read', 'clipboard-write', 'microphone'] }, opts));
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to/.test(m.text())) problems.push('CSP: ' + m.text()); if (m.type() === 'error' && !/Failed to load resource|fonts\./.test(m.text())) problems.push('console: ' + m.text()); });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await ctx.route(SB + '/**', async (r) => {
      const req = r.request();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
      const out = await handle(req.method(), req.url(), req.headers(), req.postData(), req.postDataBuffer());
      return r.fulfill({ status: out.status, headers: Object.assign({}, out.headers, cors), body: out.body });
    });
    return { page, ctx, problems };
  }
  return { pg, state, newPage, browser, async stop() { await browser.close(); server.close(); } };
}
module.exports = { start, SB };
