const { start } = require('./bh');
const base = 'http://localhost:4173/';
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const h = await start();
  const A = await h.newPage(); const p = A.page;
  await p.goto(base + '#/account'); await p.waitForTimeout(300);
  await p.click('#modeup'); await p.fill('#dn', 'Rae'); await p.fill('#em', 'rae@example.com'); await p.fill('#pw', 'correct horse'); await p.check('#tos'); await p.click('#signup'); await p.waitForTimeout(900);
  await p.goto(base + '#/write'); await p.waitForTimeout(400);
  await p.fill('#t', 'Tide'); await p.click('#x');
  await p.keyboard.type('The tide went out slowly. ', { delay: 30 }); await p.waitForTimeout(2500);
  await p.keyboard.type('Gulls argued over a crab shell, and the light turned copper. ', { delay: 30 }); await p.waitForTimeout(2500);
  await p.keyboard.type('Somebody had left a red boot on the sand.', { delay: 30 }); await p.waitForTimeout(2000);
  await p.click('#publish'); await p.waitForURL(/#\/p\//, { timeout: 8000 }); await p.waitForTimeout(1200);
  const len = () => p.evaluate(() => document.querySelector('#rp .rp-text').textContent.length);
  const final = await len();
  await p.click('#rp .rp-play'); await p.waitForTimeout(500);
  const samples = []; for (let i = 0; i < 6; i++) { samples.push(await len()); await p.waitForTimeout(700); }
  console.log('lengths while playing:', samples.join(','), 'final', final);
  ok(samples[0] < final, 'playing starts before the full text is shown');
  ok(new Set(samples).size >= 4, 'the text grows gradually, not in a few jumps');
  ok(/Pause/.test(await p.textContent('#rp .rp-play')), 'the button shows Pause while playing');
  await p.click('#rp .rp-play'); const paused = await len(); await p.waitForTimeout(500);
  ok(await len() === paused && /Play/.test(await p.textContent('#rp .rp-play')), 'pause holds the text where it is');
  await p.click('#rp .rp-play'); await p.waitForTimeout(16000);
  ok(await len() === final && /Play/.test(await p.textContent('#rp .rp-play')), 'it finishes on the full text and goes back to Play');
  console.log('\n' + pass + ' passed, ' + fail + ' failed; problems: ' + (A.problems.length ? A.problems.join('; ') : 'none'));
  await h.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
