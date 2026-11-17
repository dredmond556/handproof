const { start } = require('./bh');
const base = 'http://localhost:4173/';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const h = await start();
  const S = await h.newPage(); const p = S.page;
  await p.goto(base + '#/profile'); await p.waitForTimeout(800);
  ok(await p.evaluate(() => location.hash) === '#/account', 'signed out: Profile goes to the account page');
  ok(/Create your profile/.test(await p.textContent('#ah')) && await p.isVisible('#dn') && await p.isVisible('#signup'), 'it opens in create mode with the name field');
  ok(!/Everything is stored in this browser/.test(await p.textContent('#app')), 'the local "You" page is not shown');
  await p.click('#modein'); ok(/Sign in/.test(await p.textContent('#ah')), 'people with an account can still switch to Sign in');
  await p.fill('#dn', 'x').catch(() => {});
  await p.click('#modeup'); await p.fill('#dn', 'Pia Moss'); await p.fill('#em', 'pia@example.com'); await p.fill('#pw', 'correct horse'); await p.check('#tos'); await p.click('#signup'); await p.waitForTimeout(900);
  await p.goto(base + '#/'); await p.waitForTimeout(300);
  await p.goto(base + '#/profile'); await p.waitForTimeout(700);
  ok(await p.evaluate(() => location.hash) === '#/profile', 'signed in: Profile stays on the profile page');
  ok(/Pia Moss/.test(await p.textContent('h1, .who')) && await p.isVisible('#editpf'), 'signed in: Profile shows your own page with an Edit profile button');
  await p.click('#editpf'); await p.waitForTimeout(600);
  ok(await p.evaluate(() => location.hash) === '#/account' && await p.isVisible('#pn'), 'Edit profile opens the editor');
  await p.goto(base + '#/profile'); await p.waitForTimeout(500);
  await p.reload(); await p.waitForTimeout(1200);
  ok(await p.evaluate(() => location.hash) === '#/profile', 'signed in: reloading the Profile page does not bounce to Account');
  console.log('\n' + pass + ' passed, ' + fail + ' failed; problems: ' + (S.problems.length ? S.problems.join('; ') : 'none'));
  await h.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
