const fs = require('fs'); fs.mkdirSync(require('path').join(__dirname, 'shots'), { recursive: true });
const { start } = require('./bh');
const base = 'http://localhost:4173/';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const h = await start();
  const ids = {};
  async function person(n, name, bio, vis) {
    const id = `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`; ids[name] = id;
    await h.pg.exec(`insert into auth.users (id,email,raw_user_meta_data) values ('${id}','u${n}@x.com','{"display_name":"${name}"}')`);
    await h.pg.exec(`update public.profiles set bio='${bio}', visibility='${vis}' where id='${id}'`);
    return id;
  }
  async function work(id, kind, title, vis) {
    await h.pg.exec(`insert into public.works (author_id, kind, title, status, published_at, visibility) values ('${id}','${kind}','${title}','published', now(), '${vis || 'public'}')`);
  }
  async function piece(id, title) {
    await h.pg.exec(`insert into public.pieces (author_id, title, status, published_at, final_text, word_count) values ('${id}','${title}','published', now(), 'x', 1)`);
  }
  for (let i = 0; i < 30; i++) { const id = await person(10 + i, 'Extra ' + String(i).padStart(2, '0'), 'bio', 'public'); await work(id, 'art', 'A' + i); }
  const ada = await person(1, 'Ada Writer', 'I write about harbors.', 'public');
  const bo = await person(2, 'Bo Beats', 'Bedroom producer.', 'public');
  const cy = await person(3, 'Cy Private', 'Hidden', 'link');
  await person(4, 'Di Nothing', 'No work yet', 'public');
  await piece(ada, 'Harbor'); await work(ada, 'photo', 'Pier', 'public');
  await work(bo, 'music', 'Song A'); await work(bo, 'music', 'Song B'); await work(bo, 'music', 'Secret song', 'unlisted');
  await work(cy, 'art', 'Hidden art');

  const S = await h.newPage(); const ps = S.page;
  await ps.goto(base + '#/browse'); await ps.waitForTimeout(800);
  ok(await ps.isVisible('.subnav a[href="#/artists"]') && (await ps.getAttribute('.subnav a[href="#/browse"]', 'aria-current')) === 'page', 'Browse has a Work / Artists switch');
  await ps.click('.subnav a[href="#/artists"]'); await ps.waitForSelector('.artist'); await ps.waitForTimeout(400);
  ok((await ps.textContent('h1')) === 'Artists' && (await ps.getAttribute('.subnav a[href="#/artists"]', 'aria-current')) === 'page', 'the Artists page opens');
  ok((await ps.getAttribute('.top nav a[data-route="browse"]', 'aria-current')) === 'page', 'the Browse menu item stays highlighted');
  const names1 = await ps.$$eval('.artist h3', (e) => e.map((x) => x.textContent));
  ok(names1.includes('Ada Writer') && names1.includes('Bo Beats'), 'artists with public work are listed');
  ok(!names1.includes('Cy Private') && !names1.includes('Di Nothing'), 'link-only profiles and people with no work are not');
  ok(names1.length === 24 && !(await ps.isHidden('#more')), 'the first page has 24 and offers Show more');
  await ps.click('#more'); await ps.waitForTimeout(600);
  ok((await ps.$$('.artist')).length === 32 && (await ps.isHidden('#more')), 'Show more loads the rest and then hides itself');
  const bo2 = await ps.textContent('.artist:has-text("Bo Beats")');
  ok(/2 music/.test(bo2) && !/3 music/.test(bo2) && /Bedroom producer/.test(bo2), 'a card shows the bio and counts only public work');
  const ada2 = await ps.textContent('.artist:has-text("Ada Writer")');
  ok(/1 writing/.test(ada2) && /1 photo/.test(ada2), 'a card shows each kind');
  await ps.click('.fbtn[data-k="music"]'); await ps.waitForTimeout(600);
  ok((await ps.$$eval('.artist h3', (e) => e.map((x) => x.textContent))).join() === 'Bo Beats', 'filtering by Music shows only musicians');
  ok((await ps.getAttribute('.fbtn[data-k="music"]', 'aria-pressed')) === 'true', 'and the filter shows as pressed');
  await ps.click('.fbtn[data-k="film"]'); await ps.waitForTimeout(600);
  ok(await ps.isVisible('#none') && /Nobody has shared this kind/.test(await ps.textContent('#none')), 'a kind with nobody says so');
  await ps.click('.fbtn[data-k="all"]'); await ps.waitForTimeout(600);
  await ps.fill('#f', 'bo b'); await ps.waitForTimeout(200);
  ok((await ps.$$('.artist')).length === 1, 'the name filter narrows the list');
  await ps.fill('#f', 'zzzz'); await ps.waitForTimeout(200);
  ok(await ps.isVisible('#none'), 'and says when nothing matches');
  await ps.fill('#f', ''); await ps.waitForTimeout(200);
  await ps.click('.artist:has-text("Ada Writer")'); await ps.waitForTimeout(1000);
  ok(/Ada Writer/.test(await ps.textContent('h1')) && /I write about harbors/.test(await ps.textContent('#app')), 'a card opens that artist’s page');
  ok(!/Secret song/.test(await (async () => { await ps.goto(base + '#/w/' + bo); await ps.waitForTimeout(1000); return ps.textContent('#app'); })()), 'an artist page never shows their link-only work');

  const M = await h.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await M.page.goto(base + '#/artists'); await M.page.waitForSelector('.artist'); await M.page.waitForTimeout(400);
  ok(await M.page.evaluate(() => document.documentElement.scrollWidth <= 391), 'mobile: no horizontal scrolling on the artists page');
  await M.page.screenshot({ path: 'shots/m-artists.png', fullPage: false });
  await ps.goto(base + '#/artists'); await ps.waitForSelector('.artist'); await ps.waitForTimeout(300);
  await ps.screenshot({ path: 'shots/artists.png', fullPage: false });
  const bad = [].concat(S.problems, M.problems);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('browser problems: ' + (bad.length ? '\n' + bad.join('\n') : 'none'));
  await h.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
