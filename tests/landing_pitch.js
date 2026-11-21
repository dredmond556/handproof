const { start } = require('./bh');
const base = 'http://localhost:4173/';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const h = await start();
  const V = await h.newPage(); const v = V.page;
  await v.goto(base); await v.waitForTimeout(800);
  const body = await v.textContent('#app');
  ok(/See how it was made\./.test(body) && /detector guesses/.test(body), 'the homepage says what it is and how it differs from a detector');
  ok(await v.isVisible('a[href="#/write"]') && await v.isVisible('a[href="#/make"]') && await v.isVisible('a[href="#/browse"]'), 'the next steps are the first buttons');
  ok((await v.$$('.steps li')).length === 3, 'a three-step "How it works" row');
  ok((await v.$$('#featrp')).length === 0, 'no real example is shown while there is nothing to show');

  const A = await h.newPage(); const p = A.page;
  await p.goto(base + '#/account'); await p.waitForTimeout(300);
  await p.click('#modeup'); await p.fill('#dn', 'Jo Park'); await p.fill('#em', 'jo@example.com'); await p.fill('#pw', 'correct horse'); await p.check('#tos'); await p.click('#signup'); await p.waitForTimeout(900);
  const short = await (async () => { await p.goto(base + '#/write'); await p.waitForTimeout(400); await p.fill('#t', 'Too short'); await p.click('#x'); await p.keyboard.type('Just a few words here.', { delay: 5 }); await p.waitForTimeout(1500); await p.click('#publish'); await p.waitForURL(/#\/p\//); await p.waitForTimeout(800); })();
  await v.reload(); await v.waitForTimeout(900);
  ok((await v.$$('#featrp')).length === 0, 'a short test piece is not featured');
  await p.goto(base + '#/write'); await p.waitForTimeout(400); await p.fill('#t', 'Low Light');
  await p.click('#x');
  const sentence = 'The kitchen was quiet except for the kettle and the slow tick of the clock above the door. ';
  await p.keyboard.type(sentence.repeat(7), { delay: 2 }); await p.waitForTimeout(2200);
  await p.click('#publish'); await p.waitForURL(/#\/p\//); await p.waitForTimeout(900);
  await v.reload(); await v.waitForTimeout(1200);
  ok((await v.$$('#featrp .replay')).length === 1 && /Low Light/.test(await v.textContent('#feat')), 'a long enough piece is featured with its replay');
  ok(/a\[href|Read it and see its full record/.test(await v.textContent('#feat')) && (await v.$$('#feat a.btn')).length === 1, 'it links to the full record');
  console.log('\n' + pass + ' passed, ' + fail + ' failed; problems: ' + [].concat(V.problems, A.problems).join('; '));
  await h.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
