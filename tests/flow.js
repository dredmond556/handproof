const fs = require('fs'); fs.mkdirSync(require('path').join(__dirname, 'shots'), { recursive: true });
const { start } = require('./bh');
const base = 'http://localhost:4173/';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const h = await start();
  const A = await h.newPage(); const page = A.page;
  await page.goto(base + '#/account'); await page.waitForTimeout(400);
  ok((await page.textContent('#ah')) === 'Sign in' && await page.isHidden('#tos') && await page.isHidden('#dn'), 'sign-in view hides the new-account fields');
  await page.click('#modeup'); await page.waitForTimeout(100);
  ok((await page.textContent('#ah')) === 'Create account' && await page.isVisible('#tos') && await page.isVisible('#dn') && await page.isHidden('#signin'), 'switching shows name, consent box and Create account');
  await page.screenshot({ path: 'shots/d-signup.png' });
  await page.fill('#dn', 'Ada Lovelace'); await page.fill('#em', 'ada@example.com'); await page.fill('#pw', 'correct horse');
  await page.click('#signup'); await page.waitForTimeout(300);
  ok(/Tick the box/.test(await page.textContent('#amsg')), 'consent is required');
  await page.check('#tos'); await page.click('#signup'); await page.waitForTimeout(900);
  ok((await page.textContent('#nav-account')) === 'Account', 'real supabase-js signed the user up and the page noticed (nav says Account)');
  ok(/ada@example.com/.test(await page.textContent('#app')), 'account page shows the email');
  const prof = (await h.pg.query('select display_name, terms_version from public.profiles')).rows;
  ok(prof.length === 1 && prof[0].display_name === 'Ada Lovelace' && prof[0].terms_version === '2026-11-12', 'server profile has the name and terms version');
  await page.screenshot({ path: 'shots/d-account-in.png', fullPage: true });

  await page.goto(base + '#/write'); await page.waitForTimeout(400);
  ok(/recorded to your account/.test(await page.textContent('#where')), 'editor says it records to the account');
  await page.screenshot({ path: 'shots/d-editor-in.png' });
  await page.fill('#t', 'Harbor Notes');
  await page.click('#x');
  await page.keyboard.type('The harbor was quiet before the boats came in. A gull walked the length of the pier. '.repeat(3), { delay: 4 });
  await page.waitForTimeout(1500);
  await page.evaluate(() => navigator.clipboard.writeText(' [PASTED FROM ELSEWHERE: ' + 'lorem ipsum dolor sit amet '.repeat(5) + ']'));
  await page.keyboard.press('Control+V'); await page.waitForTimeout(300);
  await page.keyboard.type(' Then the tide turned, and the first boat appeared.', { delay: 4 });
  await page.waitForTimeout(1600);
  const typed = await page.inputValue('#x');
  ok(/PASTED FROM ELSEWHERE/.test(typed), 'a real Ctrl+V paste landed in the editor');
  ok(/[1-9]/.test(await page.textContent('#s-paste')), 'editor counted the paste (' + (await page.textContent('#s-paste')) + ')');
  ok((await h.pg.query('select count(*)::int n from public.piece_batches')).rows[0].n >= 1, 'batches reached the server while writing');
  await page.screenshot({ path: 'shots/d-editor-typed.png', fullPage: true });
  await page.click('#publish'); await page.waitForURL(/#\/p\//, { timeout: 8000 }); await page.waitForTimeout(800);
  const pieceUrl = page.url();
  ok(/#\/p\/[0-9a-f-]{36}$/.test(pieceUrl), 'publish opened the public page');
  const row = (await h.pg.query('select * from public.pieces')).rows[0];
  ok(row.status === 'published' && row.final_text === typed && row.paste_events === 1, 'server holds the exact text and one paste event');
  ok(await page.isVisible('#verify .banner.good') && /intact/.test(await page.textContent('#verify')), 'verification panel says intact');
  await page.screenshot({ path: 'shots/d-public.png', fullPage: true });
  // play the replay
  await page.click('#rp .replay button'); await page.waitForTimeout(1200);
  await page.screenshot({ path: 'shots/d-public-replay.png' });

  // report as a stranger
  const B = await h.newPage(); const p2 = B.page;
  await p2.goto(pieceUrl); await p2.waitForTimeout(900);
  ok(await p2.isVisible('h1') && (await p2.textContent('h1')) === 'Harbor Notes', 'a signed-out visitor can open the link');
  await p2.click('#reportopen'); await p2.selectOption('#rr', 'spam'); await p2.fill('#rdet', 'test report');
  await p2.screenshot({ path: 'shots/d-report-open.png', fullPage: true });
  await p2.click('#rsend'); await p2.waitForTimeout(600);
  ok((await h.pg.query("select count(*)::int n from public.reports where reason='spam' and reporter_id is null")).rows[0].n === 1, 'the report reached the server');
  await p2.goto(base + '#/browse'); await p2.waitForTimeout(900);
  ok((await p2.$$eval('#rows a.tile', (a) => a.map((x) => x.textContent))).some((t) => /Harbor Notes/.test(t)), 'browse lists the published piece for everyone');
  await p2.screenshot({ path: 'shots/d-browse-cloud.png', fullPage: true });

  // reload keeps the session (real localStorage), sign out, sign in again
  await page.reload(); await page.waitForTimeout(800);
  ok((await page.textContent('#nav-account')) === 'Account', 'a page reload keeps you signed in');
  await page.goto(base + '#/account'); await page.waitForTimeout(500);
  ok(await page.isVisible('#cmine a'), 'account lists the published piece');
  await page.click('#signout'); await page.waitForTimeout(500);
  ok((await page.textContent('#nav-account')) === 'Sign in' && await page.isVisible('#af'), 'sign out works');
  await page.fill('#em', 'ada@example.com'); await page.fill('#pw', 'nope nope nope');
  await page.click('#signin'); await page.waitForTimeout(500);
  ok(/Invalid login/.test(await page.textContent('#amsg')), 'wrong password shows the server message');
  await page.fill('#pw', 'correct horse'); await page.click('#signin'); await page.waitForTimeout(700);
  ok((await page.textContent('#nav-account')) === 'Account', 'signing in again works');

  // forgot password -> recovery link -> new password
  await page.click('#signout'); await page.waitForTimeout(400);
  await page.fill('#em', 'ada@example.com'); await page.click('#forgot'); await page.waitForTimeout(500);
  ok(h.state.emails.some((e) => e.kind === 'recover' && e.to === 'ada@example.com'), 'forgot password asked the server to send a reset email');
  const { jwt } = require('./backend');
  const u = h.state.users['ada@example.com'];
  const tok = jwt({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 });
  const C = await h.newPage(); const p3 = C.page;
  await p3.goto(base + '#access_token=' + tok + '&refresh_token=r-' + u.id + '&expires_in=3600&token_type=bearer&type=recovery'); await p3.waitForTimeout(1200);
  ok(/Choose a new password/.test(await p3.textContent('h1')), 'following the reset link opens the new-password form (real library event)');
  await p3.screenshot({ path: 'shots/d-recovery.png' });
  await p3.fill('#npw', 'a brand new passphrase'); await p3.click('#rsave'); await p3.waitForTimeout(900);
  ok((await p3.textContent('h1')) === 'Account' && u.password === 'a brand new passphrase', 'new password saved');

  // account delete
  await p3.click('#delacct'); await p3.fill('#delconf', 'DELETE'); await p3.click('#delgo'); await p3.waitForTimeout(1200);
  ok((await h.pg.query('select count(*)::int n from public.pieces')).rows[0].n === 0 && (await p3.textContent('#nav-account')) === 'Sign in', 'account deletion erased the data and signed out');

  // mobile screenshots
  const M = await h.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const m = M.page;
  for (const [n, hash] of [['landing', '#/'], ['account', '#/account'], ['write', '#/write'], ['browse', '#/browse'], ['terms', '#/terms']]) {
    await m.goto(base + hash); await m.waitForTimeout(500);
    ok(await m.evaluate(() => document.documentElement.scrollWidth <= 391 && window.innerWidth <= 391), 'mobile ' + n + ': no horizontal scrolling');
    await m.screenshot({ path: 'shots/m-' + n + '.png', fullPage: true });
  }
  const bad = [].concat(A.problems, B.problems, C.problems, M.problems);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('browser problems: ' + (bad.length ? '\n' + bad.join('\n') : 'none'));
  await h.stop();
})().catch((e) => { console.error(e); process.exit(1); });
