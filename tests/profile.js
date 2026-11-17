const fs = require('fs'); fs.mkdirSync(require('path').join(__dirname, 'shots'), { recursive: true });
const { start } = require('./bh');
const base = 'http://localhost:4173/';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const h = await start();
  const A = await h.newPage(); const page = A.page;
  await page.goto(base + '#/account'); await page.waitForTimeout(400);
  await page.click('#modeup'); await page.fill('#dn', 'Grace Hopper'); await page.fill('#em', 'grace@example.com'); await page.fill('#pw', 'correct horse');
  await page.check('#tos'); await page.click('#signup'); await page.waitForTimeout(900);
  ok(await page.isVisible('#pn') && (await page.inputValue('#pn')) === 'Grace Hopper', 'account page shows the profile form with the signup name');

  await page.fill('#pb', 'I write about ships & compilers.\n<img src=x onerror=window.__x=1>');
  await page.fill('#pw', 'ftp://nope'); await page.fill('#pc', 'grace.contact@example.org');
  await page.click('#savepf'); await page.waitForTimeout(500);
  ok(/http/.test(await page.textContent('#pmsg')) && (await h.pg.query("select website from public.profiles")).rows[0].website === '', 'a bad website is rejected with a clear message');
  await page.fill('#pw', 'javascript:alert(1)'); await page.click('#savepf'); await page.waitForTimeout(400);
  ok((await h.pg.query("select website from public.profiles")).rows[0].website === '', 'javascript: URLs are rejected');
  await page.fill('#pw', 'https://example.com/grace'); await page.click('#savepf'); await page.waitForTimeout(500);
  ok((await page.textContent('#pmsg')) === 'Saved.', 'valid profile saves');
  const row = (await h.pg.query('select * from public.profiles')).rows[0];
  ok(row.website === 'https://example.com/grace' && row.contact === 'grace.contact@example.org' && /compilers/.test(row.bio), 'server stored bio, website and contact');
  const id = row.id;

  // public view as a signed-out stranger
  const B = await h.newPage(); const p2 = B.page;
  await p2.goto(base + '#/w/' + id); await p2.waitForTimeout(900);
  const txt = await p2.textContent('#app');
  ok((await p2.textContent('h1')) === 'Grace Hopper' && /compilers/.test(txt), 'a stranger sees the name and bio');
  ok(await p2.isVisible('a[href="mailto:grace.contact@example.org"]'), 'email-shaped contact becomes a mailto link');
  const web = await p2.getAttribute('a[href="https://example.com/grace"]', 'rel');
  ok(/noopener/.test(web) && /nofollow/.test(web), 'website link is noopener and nofollow');
  ok(!/grace@example.com/.test(txt) && !/grace@example.com/.test(await p2.content()), 'the sign-in email is never shown');
  ok((await p2.evaluate(() => window.__x)) === undefined && (await p2.$$('#app img')).length === 0, 'HTML in the bio is shown as text, not run');
  await p2.screenshot({ path: 'shots/p-writer.png', fullPage: true });

  // direct table reads can't see private columns
  const priv = await h.pg.query("select has_column_privilege('anon','public.profiles','terms_version','select') a, has_column_privilege('anon','public.profiles','contact','select') b");
  ok(priv.rows[0].a === false && priv.rows[0].b === true, 'terms fields are not readable by the public, profile fields are');

  // piece byline links to the profile
  await page.goto(base + '#/write'); await page.waitForTimeout(400);
  await page.fill('#t', 'Bytes'); await page.click('#x');
  await page.keyboard.type('Every program is a small machine that someone once wished into being. '.repeat(3), { delay: 4 });
  await page.waitForTimeout(1500);
  await page.click('#publish'); await page.waitForURL(/#\/p\//, { timeout: 8000 }); await page.waitForTimeout(800);
  ok((await page.getAttribute('.byline a', 'href')) === '#/w/' + id, 'piece byline links to the writer page');
  await p2.reload(); await p2.waitForTimeout(900);
  ok((await p2.$$eval('.grid a.tile', (a) => a.map((x) => x.textContent))).some((t) => /Bytes/.test(t)), 'the writer page lists their published piece');

  // bad ids and deleted accounts
  await p2.goto(base + '#/w/not-a-uuid'); await p2.waitForTimeout(300);
  ok(/isn’t here/.test(await p2.textContent('h1')), 'a malformed profile link shows a friendly not-found');
  await p2.goto(base + '#/w/00000000-0000-0000-0000-000000000000'); await p2.waitForTimeout(600);
  ok(/isn’t here/.test(await p2.textContent('h1')), 'an unknown profile shows not-found');

  // mobile
  const M = await h.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await M.page.goto(base + '#/w/' + id); await M.page.waitForTimeout(800);
  ok(await M.page.evaluate(() => document.documentElement.scrollWidth <= 391), 'mobile: no horizontal scrolling on the writer page');
  await M.page.screenshot({ path: 'shots/m-writer.png', fullPage: true });

  const bad = [].concat(A.problems, B.problems, M.problems);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('browser problems: ' + (bad.length ? '\n' + bad.join('\n') : 'none'));
  await h.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
