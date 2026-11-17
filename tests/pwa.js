const fs = require('fs'); fs.mkdirSync(require('path').join(__dirname, 'shots'), { recursive: true });
const { start } = require('./bh');
const base = 'http://localhost:4173/';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const h = await start();
  const A = await h.newPage(); const pa = A.page;
  const mres = await pa.request.get(base + 'manifest.webmanifest');
  const man = await mres.json();
  ok(mres.status() === 200 && /manifest\+json/.test(mres.headers()['content-type']), 'the manifest is served as a web manifest');
  ok(man.name === 'Handproof' && man.display === 'standalone' && man.start_url === '/' && man.scope === '/', 'it names the app and opens it standalone');
  ok(man.icons.some((i) => i.sizes === '192x192') && man.icons.some((i) => i.sizes === '512x512') && man.icons.some((i) => i.purpose === 'maskable'), 'it lists 192, 512 and maskable icons');
  let allIcons = true;
  for (const i of man.icons.concat([{ src: 'icons/apple-touch-icon.png' }])) {
    const r = await pa.request.get(base + i.src); const b = await r.body();
    if (r.status() !== 200 || b.subarray(1, 4).toString() !== 'PNG') allIcons = false;
  }
  ok(allIcons, 'every icon exists and is a real PNG');
  const sw = await pa.request.get(base + 'sw.js');
  ok(sw.status() === 200 && /no-cache/.test(sw.headers()['cache-control']) && /javascript/.test(sw.headers()['content-type']), 'the service worker is served with no-cache so updates arrive');

  await pa.goto(base); await pa.waitForTimeout(800);
  ok(!!(await pa.$('link[rel=manifest]')) && !!(await pa.$('link[rel=apple-touch-icon]')) && (await pa.getAttribute('meta[name=apple-mobile-web-app-capable]', 'content')) === 'yes', 'the page links the manifest and iPhone home-screen settings');
  await pa.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller || false, null, { timeout: 8000 }).catch(() => {});
  const ready = await pa.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active));
  ok(ready, 'the service worker registers and activates');
  await pa.reload(); await pa.waitForTimeout(800);
  const cached = await pa.evaluate(async () => { const ks = await caches.keys(); const c = await caches.open(ks[0]); return (await c.keys()).map((r) => new URL(r.url).pathname); });
  ok(cached.includes('/') && cached.includes('/vendor/supabase.js') && cached.includes('/manifest.webmanifest'), 'the page shell is saved on the device');
  ok(cached.every((p) => !/rest\/v1|auth\/v1|storage/.test(p)), 'no server data or files are saved by the worker');

  // offline: the shell opens, and pages that need the server fail politely instead of crashing
  await A.ctx.setOffline(true);
  await pa.goto(base); await pa.waitForTimeout(1000);
  ok(/Handproof/.test(await pa.title()) && (await pa.$$('#app *')).length > 5, 'offline: the app still opens from the saved copy');
  await pa.goto(base + '#/artists'); await pa.waitForTimeout(1200);
  ok(/Couldn’t load artists|Artists/.test(await pa.textContent('#app')), 'offline: a page that needs the server says so');
  await A.ctx.setOffline(false);

  // install button
  const S = await h.newPage(); const ps = S.page;
  await ps.goto(base); await ps.waitForTimeout(800);
  ok(await ps.isHidden('#installbar'), 'no install bar until the browser offers installing');
  await ps.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => { window.__prompted = true; }; window.dispatchEvent(e); });
  ok(await ps.isVisible('#installbtn'), 'when the browser offers installing, the button appears');
  await ps.click('#installbtn'); await ps.waitForTimeout(200);
  ok((await ps.evaluate(() => window.__prompted)) === true && await ps.isHidden('#installbar'), 'clicking it opens the browser’s install prompt and hides the bar');

  // iPhone
  const I = await h.newPage({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  await I.page.goto(base); await I.page.waitForTimeout(800);
  ok(await I.page.isVisible('#installhint') && /Add to Home Screen/.test(await I.page.textContent('#installhint')) && await I.page.isHidden('#installbtn'), 'on iPhone it explains Share, then Add to Home Screen');

  const M = await h.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await M.page.goto(base); await M.page.waitForTimeout(800);
  await M.page.evaluate(() => { const e = new Event('beforeinstallprompt', { cancelable: true }); e.prompt = () => {}; window.dispatchEvent(e); });
  ok(await M.page.evaluate(() => document.documentElement.scrollWidth <= 391), 'mobile: the install bar causes no horizontal scrolling');
  const bad = [].concat(A.problems, S.problems, I.problems, M.problems).filter((x) => !/Failed to fetch|net::ERR/.test(x));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('browser problems: ' + (bad.length ? '\n' + bad.join('\n') : 'none'));
  await h.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
