const fs = require('fs'), crypto = require('crypto'); fs.mkdirSync(require('path').join(__dirname, 'shots'), { recursive: true });
const { start } = require('./bh');
const base = 'http://localhost:4173/';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
(async () => {
  const h = await start();
  const A = await h.newPage(); const pa = A.page;
  await pa.goto(base + '#/account'); await pa.waitForTimeout(300);
  await pa.click('#modeup'); await pa.fill('#dn', 'Mara Quill'); await pa.fill('#em', 'mara@example.com'); await pa.fill('#pw', 'correct horse');
  await pa.check('#tos'); await pa.click('#signup'); await pa.waitForTimeout(900);
  await pa.goto(base + '#/make'); await pa.waitForTimeout(500);
  await pa.check('input[name=kind][value=music]'); await pa.fill('#mt', 'Harbor Song'); await pa.click('#mgo');
  await pa.waitForURL(/#\/make\/[0-9a-f-]{36}/, { timeout: 8000 }); await pa.waitForTimeout(700);
  const wid = pa.url().split('/').pop();

  ok(await pa.isVisible('#recpanel') && await pa.isVisible('#recstart') && await pa.isHidden('#recstop'), 'a music draft offers a recorder');
  ok(/server’s clock/.test(await pa.textContent('#recpanel')), 'the recorder explains the clock check');
  ok(await pa.isVisible('#wrel'), 'and a field for the release link');

  // a take under one second is not kept
  await pa.click('#recstart'); await pa.waitForSelector('#recstop:not([hidden])', { timeout: 8000 });
  ok((await pa.$$eval('#recstart', (e) => e[0].hidden)) === true, 'while recording, Start is replaced by Stop');
  await pa.click('#recstop'); await pa.waitForTimeout(700);
  ok(/under a second/.test(await pa.textContent('#recmsg')) && await pa.isHidden('#recdone'), 'a take under a second is refused on the spot');

  // a real take
  await pa.click('#recstart'); await pa.waitForSelector('#recstop:not([hidden])', { timeout: 8000 });
  await pa.waitForTimeout(2600);
  ok(/^0:0[1-9]$/.test((await pa.textContent('#rectime')).trim()), 'the timer counts up');
  await pa.click('#recstop'); await pa.waitForSelector('#recdone:not([hidden])', { timeout: 8000 });
  ok((await pa.getAttribute('#recplay', 'src')).startsWith('blob:'), 'the take can be played back before adding it');
  ok((await h.pg.query(`select count(*)::int n from public.work_items where work_id='${wid}'`)).rows[0].n === 0, 'nothing is sent until the take is added');

  // discard, then record and add
  await pa.click('#recdrop'); ok(await pa.isHidden('#recdone'), 'a take can be discarded');
  await pa.click('#recstart'); await pa.waitForSelector('#recstop:not([hidden])', { timeout: 8000 });
  await pa.waitForTimeout(2200); await pa.click('#recstop'); await pa.waitForSelector('#recdone:not([hidden])', { timeout: 8000 });
  await pa.click('#recadd'); await pa.waitForFunction(() => /Added take-1/.test(document.getElementById('recmsg').textContent), null, { timeout: 10000 });
  const it = (await h.pg.query(`select * from public.work_items where work_id='${wid}' and role='live'`)).rows[0];
  ok(!!it && it.filename === 'take-1.webm' && it.mime === 'audio/webm', 'the take is stored as a live webm recording');
  ok(it.live_claimed_ms >= 2000 && it.live_elapsed_ms >= it.live_claimed_ms, 'the server saw at least as much time pass as the take is long');
  ok(sha(h.state.files[it.path].buf) === it.sha256, 'its recorded checksum matches the stored audio');
  ok(/Recorded here, \ds/.test(await pa.textContent('#wl')) && /Recorded in the browser/.test(await pa.textContent('#wl')), 'the draft list marks it as recorded here');
  await pa.screenshot({ path: 'shots/live-draft.png', fullPage: true });

  // release link
  await pa.fill('#wrel', 'http://example.com/x'); await pa.dispatchEvent('#wrel', 'change'); await pa.waitForTimeout(500);
  ok(/https/.test(await pa.textContent('#wrelmsg')), 'a link that isn’t https is refused with a clear message');
  await pa.fill('#wrel', 'javascript:alert(1)'); await pa.dispatchEvent('#wrel', 'change'); await pa.waitForTimeout(500);
  ok((await h.pg.query(`select release_url from public.works where id='${wid}'`)).rows[0].release_url === null, 'a script link is not stored');
  await pa.fill('#wrel', 'https://open.spotify.com/track/abc123'); await pa.dispatchEvent('#wrel', 'change'); await pa.waitForTimeout(500);
  ok(/Saved/.test(await pa.textContent('#wrelmsg')), 'an https link is saved');

  // finish and publish
  await pa.selectOption('#wr', 'final');
  await pa.setInputFiles('#wf', { name: 'harbor-song.mp3', mimeType: 'audio/mpeg', buffer: Buffer.concat([Buffer.from('ID3'), Buffer.alloc(3000, 7)]) });
  await pa.click('#up'); await pa.waitForFunction(() => /Uploaded/.test(document.getElementById('umsg').textContent), null, { timeout: 8000 });
  await pa.check('#own'); await pa.click('#pub'); await pa.waitForURL(/#\/m\//, { timeout: 8000 }); await pa.waitForTimeout(1200);
  const url = pa.url();

  const S = await h.newPage(); const ps = S.page;
  await ps.goto(url); await ps.waitForTimeout(1500);
  const page = await ps.textContent('#app');
  ok(/Recorded in the browser/.test(page) && /Recorded here, \ds/.test(page), 'the public page marks the live take');
  ok(/Recorded here1 take, \ds in all\. Each was checked against the server clock/.test(page.replace(/\s+/g, '')) || /Recorded here\s*1 take/.test(page), 'the facts list says how many takes were recorded here');
  ok(/First to last file/.test(page), 'and shows the time from the first to the last file');
  ok(/The record is intact/.test(page), 'the chain still verifies');
  const rel = await ps.$('a.release, .release a');
  ok(!!rel && (await rel.getAttribute('href')) === 'https://open.spotify.com/track/abc123' && /noopener/.test(await rel.getAttribute('rel')) && /nofollow/.test(await rel.getAttribute('rel')) && (await rel.getAttribute('target')) === '_blank', 'the release link is shown safely');
  ok(/Released at open\.spotify\.com/.test(await ps.textContent('.release')) && /doesn’t check it/.test(await ps.textContent('.release')), 'and says it is the artist’s link, not checked');
  ok(!!(await ps.$('audio')), 'the finished track plays on the page');
  await ps.click('#chk'); await ps.waitForTimeout(1500);
  ok(/match|checked|✓|Checked/i.test(await ps.textContent('#chkmsg')) || (await ps.$$('[data-res]')).length > 0, 'the browser check runs over the files, including the live take');
  await ps.screenshot({ path: 'shots/live-public.png', fullPage: true });

  // owner edits the link after publishing
  await pa.reload(); await pa.waitForTimeout(1200);
  ok(await pa.isVisible('#relin') && (await pa.inputValue('#relin')) === 'https://open.spotify.com/track/abc123', 'the owner can edit the release link on the published page');
  await pa.fill('#relin', ''); await pa.click('#relsave'); await pa.waitForTimeout(600);
  ok((await h.pg.query(`select release_url from public.works where id='${wid}'`)).rows[0].release_url === null, 'clearing it works');

  // a work with only uploaded files says so plainly
  const uid = (await h.pg.query(`select id from auth.users where email='mara@example.com'`)).rows[0].id;
  const w2 = 'dddddddd-0000-4000-8000-000000000002';
  await h.pg.exec(`insert into public.works (id, author_id, kind, title, status, published_at) values ('${w2}','${uid}','music','Uploaded only','published', now())`);
  await ps.goto(base + '#/m/' + w2); await ps.waitForTimeout(1200);
  ok(/None\. Every file was uploaded/.test(await ps.textContent('#app')), 'a music work with no live takes says every file was uploaded');

  // mobile
  const M = await h.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await M.page.goto(base + '#/account'); await M.page.waitForTimeout(300);
  await M.page.click('#modeup'); await M.page.fill('#dn', 'Mo'); await M.page.fill('#em', 'mo@example.com'); await M.page.fill('#pw', 'correct horse');
  await M.page.check('#tos'); await M.page.click('#signup'); await M.page.waitForTimeout(900);
  await M.page.goto(base + '#/make'); await M.page.waitForTimeout(400);
  await M.page.check('input[name=kind][value=music]'); await M.page.click('#mgo'); await M.page.waitForURL(/#\/make\/[0-9a-f-]{36}/); await M.page.waitForTimeout(700);
  ok(await M.page.evaluate(() => document.documentElement.scrollWidth <= 391), 'mobile: the recorder page has no horizontal scrolling');
  await M.page.screenshot({ path: 'shots/live-mobile.png', fullPage: true });
  await ps.goto(url); await ps.waitForTimeout(1200);
  const bad = [].concat(A.problems, S.problems, M.problems);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('browser problems: ' + (bad.length ? '\n' + bad.join('\n') : 'none'));
  await h.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
