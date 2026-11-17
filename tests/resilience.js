const { start } = require('./bh');
const base = 'http://localhost:4173/';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const h = await start();
  // 1. the sign-in library fails to load
  let { page, ctx, problems } = await h.newPage();
  await ctx.route('**/vendor/supabase.js', (r) => r.abort());
  await page.goto(base); await page.waitForTimeout(600);
  ok(await page.isHidden('#nav-account'), 'library missing: the Sign in link is hidden');
  ok(/Accounts are unavailable right now/.test(await page.textContent('#foot')), 'library missing: the footer says accounts are unavailable');
  await page.goto(base + '#/write'); await page.waitForTimeout(300);
  await page.click('#x'); await page.keyboard.type('Written with no account at all. '.repeat(4), { delay: 3 });
  await page.waitForTimeout(1500); await page.click('#publish'); await page.waitForTimeout(800);
  ok(/#\/piece\//.test(page.url()), 'library missing: writing and publishing locally still works');
  ok((await h.pg.query('select count(*)::int n from public.pieces')).rows[0].n === 0, 'library missing: nothing was sent to the server');
  // 2. the server is down
  const B = await h.newPage(); const p2 = B.page;
  await p2.goto(base + '#/account'); await p2.waitForTimeout(500);
  h.state.down = true;
  await p2.fill('#em', 'a@b.co'); await p2.fill('#pw', 'long enough pw'); await p2.click('#signin'); await p2.waitForTimeout(2500);
  const msg = await p2.textContent('#amsg');
  ok(/Couldn’t reach the server/.test(msg), 'server down: sign-in says so plainly (“' + msg + '”)');
  await p2.goto(base + '#/browse'); await p2.waitForTimeout(800);
  ok(await p2.isVisible('#none') && /Couldn’t load published pieces/.test(await p2.textContent('#none')) && (await p2.$$('#rows a.tile')).length >= 2, 'server down: Browse says so and still shows the samples');
  await p2.goto(base + '#/p/00000000-0000-0000-0000-000000000000'); await p2.waitForTimeout(800);
  ok(/isn’t here/.test(await p2.textContent('h1')), 'server down: a public link shows a clear message');
  const bad = problems.concat(B.problems).filter((x) => !/503|abort|ERR_FAILED/i.test(x));
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); console.log('browser problems: ' + (bad.length ? '\n' + bad.join('\n') : 'none'));
  await h.stop();
})().catch((e) => { console.error(e); process.exit(1); });
