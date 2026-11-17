const fs = require('fs'); fs.mkdirSync(require('path').join(__dirname, 'shots'), { recursive: true });
const { start } = require('./bh');
const base = 'http://localhost:4173/';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
async function signup(page, name, email) {
  await page.goto(base + '#/account'); await page.waitForTimeout(300);
  await page.click('#modeup'); await page.fill('#dn', name); await page.fill('#em', email); await page.fill('#pw', 'correct horse');
  await page.check('#tos'); await page.click('#signup'); await page.waitForTimeout(900);
}
async function write(page, title, linkOnly) {
  await page.goto(base + '#/write'); await page.waitForTimeout(400);
  await page.fill('#t', title); await page.click('#x');
  await page.keyboard.type('The harbor was quiet before the boats came in. A gull walked the length of the pier. '.repeat(2), { delay: 4 });
  await page.waitForTimeout(1500);
  if (linkOnly) await page.check('input[name=evis][value=unlisted]');
  await page.click('#publish'); await page.waitForURL(/#\/p\//, { timeout: 8000 }); await page.waitForTimeout(900);
  return page.url();
}
const robots = (page) => page.$('meta[name="robots"][data-dyn]');
(async () => {
  const h = await start();
  const A = await h.newPage(); const pa = A.page;
  await signup(pa, 'Ada Lovelace', 'ada@example.com');
  const adaId = (await h.pg.query(`select id from auth.users where email='ada@example.com'`)).rows[0].id;

  // the picker appears in the editor for a signed-in writer
  await pa.goto(base + '#/write'); await pa.waitForTimeout(400);
  await pa.fill('#t', 'x'); await pa.click('#x'); await pa.keyboard.type('hello there', { delay: 4 }); await pa.waitForTimeout(600);
  ok(await pa.isVisible('#vispick') && (await pa.isChecked('input[name=evis][value=public]')), 'the editor offers Public and Link only, with Public chosen');
  await pa.click('#discard').catch(() => {}); pa.once('dialog', (d) => d.accept()); await pa.waitForTimeout(200);

  // publish one link-only piece and one public piece
  const hidden = await write(pa, 'Hidden Harbor', true);
  ok(await pa.isVisible('#visnote') && !!(await robots(pa)), 'a link-only piece shows its note to the owner and asks search engines to skip it');
  ok(await pa.isVisible('#vispanel') && (await pa.inputValue('#vislink')) === hidden && (await pa.isChecked('input[name=vis][value=unlisted]')), 'the owner sees the visibility panel with the link');
  const open = await write(pa, 'Open Harbor', false);
  ok(!(await pa.isVisible('#visnote')) && !(await robots(pa)), 'a public piece shows no link-only note and no noindex');

  // a stranger
  const S = await h.newPage(); const ps = S.page;
  await ps.goto(hidden); await ps.waitForTimeout(1200);
  ok((await ps.textContent('h1')) === 'Hidden Harbor', 'anyone with the link can open the link-only piece');
  ok(await ps.isVisible('#visnote') && !(await ps.$('#vispanel')) && !!(await robots(ps)), 'a stranger sees the note, no owner panel, and noindex');
  await ps.goto(base + '#/browse'); await ps.waitForTimeout(1200);
  const tiles = await ps.textContent('#rows');
  ok(/Open Harbor/.test(tiles) && !/Hidden Harbor/.test(tiles), 'Browse shows the public piece and leaves out the link-only one');
  ok(!(await robots(ps)), 'leaving the page clears the noindex');

  // owner changes it after publishing, both ways
  await pa.goto(open); await pa.waitForTimeout(1000);
  await pa.check('input[name=vis][value=unlisted]'); await pa.click('#vissave'); await pa.waitForTimeout(600);
  ok(/link only/i.test(await pa.textContent('#vismsg')) && await pa.isVisible('#visnote') && !!(await robots(pa)), 'saving Link only takes effect at once');
  await ps.goto(base + '#/browse'); await ps.waitForTimeout(1000); await ps.reload(); await ps.waitForTimeout(1200);
  ok(!/Open Harbor/.test(await ps.textContent('#rows')), 'it disappears from Browse');
  await pa.reload(); await pa.waitForTimeout(1000);
  await pa.check('input[name=vis][value=public]'); await pa.click('#vissave'); await pa.waitForTimeout(600);
  ok(/public/i.test(await pa.textContent('#vismsg')) && !(await pa.isVisible('#visnote')) && !(await robots(pa)), 'switching back to Public works');
  await ps.reload(); await ps.waitForTimeout(1200);
  ok(/Open Harbor/.test(await ps.textContent('#rows')), 'and it is listed again');
  await pa.click('#vscopy'); await pa.waitForTimeout(300);
  ok(/Copied/.test(await pa.textContent('#vismsg')), 'Copy link confirms');

  // account list shows the chip
  await pa.goto(base + '#/account'); await pa.waitForTimeout(1200);
  ok(/Hidden Harbor/.test(await pa.textContent('#cmine')) && (await pa.textContent('#cmine .rowitem:has-text("Hidden Harbor")')).includes('Link only') && !(await pa.textContent('#cmine .rowitem:has-text("Open Harbor")')).includes('Link only'), 'the Account list marks link-only pieces');

  // works: a draft with a finished file, published as link only through the real screen
  const wid = 'cccccccc-0000-4000-8000-000000000001';
  await h.pg.exec(`insert into public.works (id, author_id, kind, title, status) values ('${wid}','${adaId}','art','Quiet Canal','draft')`);
  await h.pg.exec(`insert into public.work_items (work_id, seq, role, path, filename, mime, bytes, sha256, received_at, prev_hash, hash)
    values ('${wid}',1,'final','${adaId}/${wid}/x.png','x.png','image/png',10,repeat('a',64),now(),repeat('0',64),repeat('b',64))`);
  await h.pg.exec(`update public.works set item_count=1, head_hash=repeat('b',64), first_received_at=now(), last_received_at=now() where id='${wid}'`);
  await pa.goto(base + '#/make/' + wid); await pa.waitForTimeout(1500);
  ok(await pa.isVisible('input[name=wvis][value=unlisted]') && (await pa.isChecked('input[name=wvis][value=public]')), 'the work publish panel offers Public and Link only');
  await pa.check('input[name=wvis][value=unlisted]'); await pa.check('#own');
  await pa.click('#pub'); await pa.waitForURL(/#\/m\//, { timeout: 8000 }); await pa.waitForTimeout(1000);
  const wurl = pa.url();
  ok(await pa.isVisible('#visnote') && await pa.isVisible('#vispanel') && !!(await robots(pa)), 'a link-only work shows its note and owner panel');
  await ps.goto(wurl); await ps.waitForTimeout(1200);
  ok((await ps.textContent('h1')) === 'Quiet Canal' && !(await ps.$('#vispanel')) && !!(await robots(ps)), 'anyone with the link can open the link-only work');
  await ps.goto(base + '#/browse'); await ps.waitForTimeout(1000); await ps.reload(); await ps.waitForTimeout(1200);
  ok(!/Quiet Canal/.test(await ps.textContent('#rows')), 'Browse leaves the link-only work out');
  await pa.goto(wurl); await pa.waitForTimeout(1000);
  await pa.check('input[name=vis][value=public]'); await pa.click('#vissave'); await pa.waitForTimeout(600);
  await ps.goto(base + '#/browse'); await ps.waitForTimeout(1000); await ps.reload(); await ps.waitForTimeout(1200);
  ok(/Quiet Canal/.test(await ps.textContent('#rows')), 'making the work public lists it');
  await pa.check('input[name=vis][value=unlisted]'); await pa.click('#vissave'); await pa.waitForTimeout(600);

  // writer page: lists only public items
  await ps.goto(base + '#/w/' + adaId); await ps.waitForTimeout(1200);
  const wp = await ps.textContent('#wgrid');
  ok(/Open Harbor/.test(wp) && !/Hidden Harbor/.test(wp) && !/Quiet Canal/.test(wp), 'the writer page lists public work only');

  // profile setting
  await pa.goto(base + '#/account'); await pa.waitForTimeout(1200);
  ok(await pa.isVisible('input[name=pvis][value=link]') && (await pa.isChecked('input[name=pvis][value=public]')), 'the profile offers Public and Link only');
  await ps.goto(open); await ps.waitForTimeout(1000);
  ok(!!(await ps.$('.byline a[href^="#/w/"]')), 'while the profile is public the author name links to it');
  await pa.check('input[name=pvis][value=link]'); await pa.click('#savepf'); await pa.waitForTimeout(700);
  ok(/Saved/.test(await pa.textContent('#pmsg')), 'saving the profile setting confirms');
  await ps.reload(); await ps.waitForTimeout(1200);
  ok(!(await ps.$('.byline a[href^="#/w/"]')) && /Ada Lovelace/.test(await ps.textContent('.byline')), 'a link-only profile is plain text on the piece page');
  await ps.goto(base + '#/w/' + adaId); await ps.waitForTimeout(1200);
  ok(/Ada Lovelace/.test(await ps.textContent('h1')) && !!(await robots(ps)), 'its page still opens by address and asks to be skipped by search engines');
  await pa.goto(base + '#/w/' + adaId); await pa.waitForTimeout(1200);
  
  ok(/Link only/.test(await pa.textContent('#app')), 'the owner is told the page is link-only');
  await pa.goto(base + '#/account'); await pa.waitForTimeout(1200);
  ok(await pa.isChecked('input[name=pvis][value=link]'), 'the setting is remembered');

  // mobile
  const M = await h.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await signup(M.page, 'Mo', 'mo@example.com');
  await M.page.goto(open); await M.page.waitForTimeout(1200);
  ok(await M.page.evaluate(() => document.documentElement.scrollWidth <= 391), 'mobile: a public piece has no horizontal scroll');
  await pa.goto(hidden); await pa.waitForTimeout(1000);
  await pa.screenshot({ path: 'shots/v-owner.png', fullPage: true });
  const bad = [].concat(A.problems, S.problems, M.problems);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('browser problems: ' + (bad.length ? '\n' + bad.join('\n') : 'none'));
  await h.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
