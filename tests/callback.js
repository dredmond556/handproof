const { start } = require('./bh');
const base = 'http://localhost:4173/';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const h = await start();
  const A = await h.newPage(); const p = A.page;
  await p.goto(base + '#/account'); await p.waitForTimeout(300);
  await p.click('#modeup'); await p.fill('#dn', 'Cb'); await p.fill('#em', 'cb@example.com'); await p.fill('#pw', 'correct horse'); await p.check('#tos'); await p.click('#signup'); await p.waitForTimeout(900);
  const tok = await p.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /auth/.test(k)))));
  const B = await h.newPage(); const q = B.page;
  await q.goto('about:blank');
  await q.goto(base + '#access_token=' + tok.access_token + '&refresh_token=' + tok.refresh_token + '&expires_in=3600&token_type=bearer&type=signup'); await q.waitForTimeout(1500);
  ok(await q.evaluate(() => location.hash) === '#/account', 'a confirmation link lands on the Account page');
  ok(/Email confirmed\. You’re signed in\./.test(await q.textContent('#app')) && (await q.textContent('#nav-account')) === 'Account', 'it says the email is confirmed and you are signed in');
  await q.goto(base + '#/'); await q.waitForTimeout(300); await q.goto(base + '#/account'); await q.waitForTimeout(500);
  ok(!/Email confirmed/.test(await q.textContent('#app')), 'the message does not stick around');
  const C = await h.newPage(); const r = C.page;
  await r.goto('about:blank');
  await r.goto(base + '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'); await r.waitForTimeout(1200);
  ok(await r.evaluate(() => location.hash) === '#/account' && /didn’t work/.test(await r.textContent('#ah + p')) && await r.isVisible('#em'), 'an expired link explains itself and offers sign-in');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  await h.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
