const fs = require('fs'), crypto = require('crypto'); fs.mkdirSync(require('path').join(__dirname, 'shots'), { recursive: true });
const { start } = require('./bh');
const base = 'http://localhost:4173/';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function withGps(jpeg) { // insert an APP1/Exif segment holding a GPS IFD pointer right after SOI
  const tiff = Buffer.from([0x49, 0x49, 0x2A, 0, 8, 0, 0, 0, 1, 0, 0x25, 0x88, 4, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const seg = Buffer.concat([Buffer.from([0xFF, 0xE1, (payload.length + 2) >> 8, (payload.length + 2) & 255]), payload]);
  return Buffer.concat([jpeg.subarray(0, 2), seg, jpeg.subarray(2)]);
}
const hasExif = (b) => b.includes(Buffer.from('Exif\0\0', 'binary'));
(async () => {
  const h = await start();
  const A = await h.newPage(); const page = A.page;
  const jpg = Buffer.from(await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 900; c.height = 600; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 900, 600); g.addColorStop(0, '#d33'); g.addColorStop(1, '#36c'); x.fillStyle = g; x.fillRect(0, 0, 900, 600); return c.toDataURL('image/jpeg', 0.9).split(',')[1]; }), 'base64');
  const gpsJpg = withGps(jpg);
  ok(hasExif(gpsJpg) && !hasExif(jpg), 'test photo has a GPS tag');

  await page.goto(base + '#/make'); await page.waitForTimeout(500);
  ok(/Sign in/.test(await page.textContent('#app')), 'signed-out visitors are asked to sign in before sharing');
  await page.goto(base + '#/account'); await page.waitForTimeout(300);
  await page.click('#modeup'); await page.fill('#dn', 'Ines Rey'); await page.fill('#em', 'ines@example.com'); await page.fill('#pw', 'correct horse');
  await page.check('#tos'); await page.click('#signup'); await page.waitForTimeout(900);

  await page.goto(base + '#/make'); await page.waitForTimeout(500);
  ok((await page.$$('input[name=kind]')).length === 4, 'the picker offers art, photo, music and film');
  await page.screenshot({ path: 'shots/w-start.png', fullPage: true });
  await page.check('input[name=kind][value=photo]'); await page.fill('#mt', 'Harbor at dawn'); await page.fill('#md', 'Shot on a cold morning.');
  await page.click('#mgo'); await page.waitForURL(/#\/make\/[0-9a-f-]{36}/, { timeout: 8000 }); await page.waitForTimeout(600);
  const wid = page.url().split('/').pop();
  ok((await h.pg.query(`select kind, status from public.works where id='${wid}'`)).rows[0].kind === 'photo', 'a draft photo work was created');
  ok(await page.isDisabled('#pub'), 'publish is disabled until a finished work is added');

  // bad files are refused before upload
  await page.selectOption('#wr', 'process');
  await page.setInputFiles('#wf', { name: 'virus.exe', mimeType: 'application/x-msdownload', buffer: Buffer.from('MZ') });
  await page.click('#up'); await page.waitForTimeout(800);
  ok(/isn’t accepted/.test(await page.textContent('#umsg')), 'an .exe is refused');
  await page.setInputFiles('#wf', { name: 'song.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('ID3....') });
  await page.click('#up'); await page.waitForTimeout(800);
  ok(/isn’t accepted/.test(await page.textContent('#umsg')), 'audio is refused on a photo work');
  ok((await h.pg.query('select count(*)::int n from public.work_items')).rows[0].n === 0, 'nothing reached the server');

  // original with GPS: warn, strip, upload
  await page.selectOption('#wr', 'original');
  await page.setInputFiles('#wf', { name: 'IMG_0001.jpg', mimeType: 'image/jpeg', buffer: gpsJpg });
  await page.waitForTimeout(500);
  ok(await page.isVisible('#gps') && /GPS/.test(await page.textContent('#gpsn')), 'a photo with a GPS tag triggers the location warning');
  ok(await page.isChecked('#strip'), 'removing location is ticked by default');
  await page.screenshot({ path: 'shots/w-gps.png', fullPage: true });
  await page.click('#up'); await page.waitForFunction(() => /Uploaded/.test(document.getElementById('umsg').textContent), null, { timeout: 8000 });
  const it1 = (await h.pg.query(`select * from public.work_items where work_id='${wid}' and role='original'`)).rows[0];
  const stored1 = h.state.files[it1.path].buf;
  ok(!hasExif(stored1) && stored1.length < gpsJpg.length, 'the stored original has its location data removed');
  ok(it1.sha256 === sha(stored1) && Number(it1.bytes) === stored1.length, 'the recorded checksum matches the stored bytes');

  // finished photo (no GPS) gets a preview
  await page.selectOption('#wr', 'final');
  await page.setInputFiles('#wf', { name: 'harbor.jpg', mimeType: 'image/jpeg', buffer: jpg });
  await page.click('#up'); await page.waitForFunction(() => /Uploaded/.test(document.getElementById('umsg').textContent), null, { timeout: 10000 });
  const roles = (await h.pg.query(`select role from public.work_items where work_id='${wid}' order by seq`)).rows.map((r) => r.role);
  ok(roles.join() === 'original,final,thumb', 'the finished photo was added with a preview (' + roles.join() + ')');
  ok(/harbor\.jpg/.test(await page.textContent('#wl')) && !/preview\.jpg/.test(await page.textContent('#wl')), 'the file list shows files but hides previews');
  ok(await page.isDisabled('#pub'), 'publish stays off until the box is ticked');
  await page.check('#own'); ok(!(await page.isDisabled('#pub')), 'ticking the box enables publish');
  await page.screenshot({ path: 'shots/w-workspace.png', fullPage: true });
  await page.click('#pub'); await page.waitForURL(/#\/m\/[0-9a-f-]{36}/, { timeout: 8000 }); await page.waitForTimeout(1500);
  const pubUrl = page.url();
  ok((await h.pg.query(`select status from public.works where id='${wid}'`)).rows[0].status === 'published', 'the work is published');

  // public page
  ok((await page.textContent('h1')) === 'Harbor at dawn' && await page.isVisible('#verify .banner.good'), 'the work page shows the title and an intact record');
  ok(await page.evaluate(() => { const i = document.querySelector('.work-img'); return !!i && i.complete && i.naturalWidth > 0; }), 'the finished image loads from private storage via a signed link');
  ok(await page.isVisible('#fb .react') && !!(await page.$('#cform')), 'a published work has thumbs and a comment box too');
  ok((await page.$$('#files .rowitem')).length === 2, 'the file list shows two files (previews are hidden)');
  await page.screenshot({ path: 'shots/w-public.png', fullPage: true });
  await page.click('#chk'); await page.waitForFunction(() => /match/.test(document.getElementById('chkmsg').textContent) && !document.getElementById('chk').disabled, null, { timeout: 8000 });
  ok(/All 2 files match/.test(await page.textContent('#chkmsg')), 'the in-browser check says every file matches');
  // tamper with a stored file
  h.state.files[it1.path].buf = Buffer.concat([h.state.files[it1.path].buf, Buffer.from('x')]);
  await page.click('#chk'); await page.waitForFunction(() => /do not match/.test(document.getElementById('chkmsg').textContent), null, { timeout: 8000 });
  ok(/1 of 2 files do not match/.test(await page.textContent('#chkmsg')), 'a changed file is caught by the check');
  h.state.files[it1.path].buf = stored1;

  // stranger
  const B = await h.newPage(); const p2 = B.page;
  await p2.goto(pubUrl); await p2.waitForTimeout(1500);
  ok((await p2.textContent('h1')) === 'Harbor at dawn' && await p2.evaluate(() => { const i = document.querySelector('.work-img'); return !!i && i.complete && i.naturalWidth > 0; }), 'a signed-out visitor sees the work and its image');
  await p2.goto(base + '#/browse'); await p2.waitForTimeout(1500);
  ok((await p2.$$('#rows a.tile')).some ? (await p2.$$eval('#rows a.tile', (a) => a.some((x) => /Harbor at dawn/.test(x.textContent)))) : false, 'browse lists the work');
  ok(await p2.evaluate(() => { const i = document.querySelector('.wk-thumb img'); return !!i && i.complete && i.naturalWidth > 0; }), 'its preview image loads on the browse page');
  await p2.click('.fbtn[data-k=music]'); await p2.waitForTimeout(200);
  ok(!(await p2.$$eval('#rows a.tile', (a) => a.some((x) => /Harbor at dawn/.test(x.textContent)))) && !(await p2.isHidden('#none')), 'the Music filter hides a photo and says so');
  await p2.click('.fbtn[data-k=photo]'); await p2.waitForTimeout(200);
  ok(await p2.$$eval('#rows a.tile', (a) => a.some((x) => /Harbor at dawn/.test(x.textContent))), 'the Photo filter shows it');
  await p2.screenshot({ path: 'shots/w-browse.png', fullPage: true });
  const uid = (await h.pg.query('select id from public.profiles')).rows[0].id;
  await p2.goto(base + '#/w/' + uid); await p2.waitForTimeout(1200);
  ok(await p2.$$eval('#wgrid a.tile', (a) => a.some((x) => /Harbor at dawn/.test(x.textContent))), "the creator's profile lists the work");
  await p2.goto(pubUrl); await p2.waitForTimeout(800);
  await p2.click('#reportopen'); await p2.selectOption('#rr', 'copyright'); await p2.click('#rsend'); await p2.waitForTimeout(600);
  ok((await h.pg.query(`select count(*)::int n from public.reports where work_id='${wid}'`)).rows[0].n === 1, 'a stranger can report the work');

  // music: audio player
  await page.goto(base + '#/make'); await page.waitForTimeout(400);
  await page.check('input[name=kind][value=music]'); await page.fill('#mt', 'Night Bus'); await page.click('#mgo');
  await page.waitForURL(/#\/make\/[0-9a-f-]{36}/); await page.waitForTimeout(500);
  await page.selectOption('#wr', 'project');
  await page.setInputFiles('#wf', { name: 'session.zip', mimeType: 'application/zip', buffer: Buffer.from('PK\x03\x04zipdata') });
  await page.click('#up'); await page.waitForFunction(() => /Uploaded/.test(document.getElementById('umsg').textContent), null, { timeout: 8000 });
  await page.selectOption('#wr', 'final');
  await page.setInputFiles('#wf', { name: 'night-bus.mp3', mimeType: 'audio/mpeg', buffer: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000, 7)]) });
  await page.click('#up'); await page.waitForFunction(() => /Uploaded/.test(document.getElementById('umsg').textContent), null, { timeout: 8000 });
  ok((await h.pg.query(`select count(*)::int n from public.work_items where role='thumb'`)).rows[0].n === 1, 'audio gets no preview image');
  await page.check('#own'); await page.click('#pub'); await page.waitForURL(/#\/m\//); await page.waitForTimeout(1200);
  ok(await page.isVisible('audio[controls]'), 'a music work shows an audio player');
  const musicUrl = page.url();

  // account list, undo, delete
  await page.goto(base + '#/account'); await page.waitForTimeout(1000);
  ok(/Harbor at dawn/.test(await page.textContent('#wl')) && /Night Bus/.test(await page.textContent('#wl')), 'the account page lists your works');
  await page.screenshot({ path: 'shots/w-account.png', fullPage: true });
  page.once('dialog', (d) => d.accept());
  await page.click('[data-wdel]'); await page.waitForTimeout(1200);
  ok((await h.pg.query('select count(*)::int n from public.works')).rows[0].n === 1, 'deleting a work removes it');
  ok(Object.keys(h.state.files).length === 3, 'and removes its files from storage (the other work keeps its three)');
  page.once('dialog', (d) => d.accept());

  // mobile
  const M = await h.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  for (const [n, hash] of [['make', '#/make'], ['browse', '#/browse'], ['work', pubUrl.slice(base.length)]]) {
    await M.page.goto(base + hash); await M.page.waitForTimeout(900);
    const fits = await M.page.evaluate(() => document.documentElement.scrollWidth <= 391);
    if (!fits) console.log('overflow:', await M.page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.getBoundingClientRect().right > 391).map((e) => e.tagName + '.' + e.className + ' ' + Math.round(e.getBoundingClientRect().right)).slice(0, 8)));
    ok(fits, 'mobile ' + n + ': no horizontal scrolling');
    await M.page.screenshot({ path: 'shots/m-w-' + n + '.png', fullPage: true });
  }
  // deleting the account removes works and their stored files
  await page.goto(base + '#/account'); await page.waitForTimeout(1000);
  await page.click('#delacct'); await page.fill('#delconf', 'DELETE'); await page.click('#delgo'); await page.waitForTimeout(2000);
  ok((await h.pg.query('select count(*)::int n from public.works')).rows[0].n === 0 && (await h.pg.query('select count(*)::int n from public.work_items')).rows[0].n === 0, 'deleting the account removes every work');
  ok(Object.keys(h.state.files).length === 0 && (await h.pg.query(`select count(*)::int n from storage.objects`)).rows[0].n === 0, 'and every stored file, so nothing is left behind');
  const bad = [].concat(A.problems, B.problems, M.problems);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('browser problems: ' + (bad.length ? '\n' + bad.join('\n') : 'none'));
  await h.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
