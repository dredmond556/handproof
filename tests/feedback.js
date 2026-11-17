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
(async () => {
  const h = await start();
  const A = await h.newPage(); const pa = A.page;
  await signup(pa, 'Ada Lovelace', 'ada@example.com');
  await pa.goto(base + '#/write'); await pa.waitForTimeout(400);
  await pa.fill('#t', 'Harbor Notes'); await pa.click('#x');
  await pa.keyboard.type('The harbor was quiet before the boats came in. A gull walked the length of the pier. '.repeat(2), { delay: 4 });
  await pa.waitForTimeout(1500);
  await pa.click('#publish'); await pa.waitForURL(/#\/p\//, { timeout: 8000 }); await pa.waitForTimeout(1000);
  const url = pa.url();
  ok(await pa.isVisible('#fb .react') && (await pa.textContent('#nup')) === '0' && (await pa.textContent('#ndown')) === '0', 'the piece page shows thumbs up and down with counts');

  // signed-out visitor
  const S = await h.newPage(); const ps = S.page;
  await ps.goto(url); await ps.waitForTimeout(1200);
  ok(/Sign in/.test(await ps.textContent('#fb')) && !(await ps.$('#cform')), 'a signed-out visitor is told to sign in and gets no comment box');
  await ps.click('#rup'); await ps.waitForTimeout(300);
  ok(/Sign in/.test(await ps.textContent('#fmsg')) && (await ps.textContent('#nup')) === '0', 'clicking a thumb while signed out asks them to sign in');

  // a second user reacts and comments
  const B = await h.newPage(); const pb = B.page;
  await signup(pb, 'Bo Diaz', 'bo@example.com');
  await pb.goto(url); await pb.waitForTimeout(1200);
  ok(!!(await pb.$('#cform')), 'a signed-in user gets a comment box');
  await pb.click('#rup'); await pb.waitForTimeout(500);
  ok((await pb.textContent('#nup')) === '1' && (await pb.getAttribute('#rup', 'aria-pressed')) === 'true', 'thumbs up counts and shows as pressed');
  await pb.click('#rdown'); await pb.waitForTimeout(500);
  ok((await pb.textContent('#nup')) === '0' && (await pb.textContent('#ndown')) === '1' && (await pb.getAttribute('#rdown', 'aria-pressed')) === 'true', 'switching to thumbs down moves the vote');
  await pb.click('#rup'); await pb.waitForTimeout(500);
  await pb.click('#rup'); await pb.waitForTimeout(500);
  ok((await pb.textContent('#nup')) === '0' && (await pb.textContent('#ndown')) === '0' && (await pb.getAttribute('#rup', 'aria-pressed')) === 'false', 'pressing the same thumb again clears it');
  await pb.click('#rup'); await pb.waitForTimeout(400);

  await pb.click('#cpost'); await pb.waitForTimeout(200);
  ok(/Write something/.test(await pb.textContent('#cmsg')), 'an empty comment is refused');
  await pb.fill('#cb', 'First! Lovely pacing.'); await pb.click('#cpost'); await pb.waitForTimeout(700);
  ok((await pb.$$('#clist li.cm')).length === 1 && (await pb.inputValue('#cb')) === '', 'a comment appears and the box clears');
  await pb.fill('#cb', 'Second thought: <b>the ending</b> works.'); await pb.click('#cpost'); await pb.waitForTimeout(700);
  const bodies = await pb.$$eval('.cm-body', (e) => e.map((x) => x.textContent));
  ok(bodies[0].startsWith('Second thought') && bodies[1].startsWith('First!'), 'newest comments come first by default');
  ok(bodies[0].includes('<b>the ending</b>') && (await pb.$$('.cm-body b')).length === 0, 'HTML in a comment is shown as text');
  await pb.selectOption('#csort', 'oldest'); await pb.waitForTimeout(500);
  ok((await pb.$$eval('.cm-body', (e) => e.map((x) => x.textContent)))[0].startsWith('First!'), 'oldest first reverses the order');
  ok((await pb.textContent('#cmh')) === 'Comments (2)', 'the comment count is shown');
  ok((await pb.$$('#clist .rbtn')).length === 0 && !/vote|upvote|downvote/i.test(await pb.textContent('#clist')), 'comments have no thumbs or votes');
  await pb.screenshot({ path: 'shots/f-piece.png', fullPage: true });

  // anyone can read
  await ps.reload(); await ps.waitForTimeout(1200);
  ok((await ps.$$('#clist li.cm')).length === 2 && (await ps.textContent('#nup')) === '1', 'a signed-out visitor sees the comments and the counts');
  ok((await ps.$$('[data-del], [data-rep]')).length === 0, 'and sees no delete or report buttons');

  // the owner can delete, others can report
  await pa.reload(); await pa.waitForTimeout(1200);
  ok((await pa.$$('[data-del]')).length === 2, 'the piece owner can delete comments on their piece');
  await pa.fill('#cb', 'Thanks both!'); await pa.click('#cpost'); await pa.waitForTimeout(700);
  pa.once('dialog', (d) => d.accept());
  await pa.click('li.cm:has-text("Second thought") [data-del]'); await pa.waitForTimeout(800);
  ok((await pa.$$('#clist li.cm')).length === 2 && !/Second thought/.test(await pa.textContent('#clist')), 'deleting removes that comment');
  await pb.reload(); await pb.waitForTimeout(1200);
  ok((await pb.$$('li.cm:has-text("First!") [data-del]')).length === 1 && (await pb.$$('li.cm:has-text("First!") [data-rep]')).length === 0, 'you can delete your own comment but not report it');
  await pb.click('li.cm:has-text("Thanks both") [data-rep]'); await pb.selectOption('li.cm:has-text("Thanks both") select', 'spam');
  await pb.click('li.cm:has-text("Thanks both") button[type=submit]'); await pb.waitForTimeout(700);
  ok((await h.pg.query(`select count(*)::int n from public.reports where comment_id is not null and reason='spam'`)).rows[0].n === 1, 'reporting a comment reaches the server');
  ok(/Thanks\. Reports are reviewed/.test(await pb.textContent('li.cm:has-text("Thanks both")')), 'the reporter gets a confirmation');

  // mobile
  const M = await h.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await M.page.goto(url); await M.page.waitForTimeout(1200);
  ok(await M.page.evaluate(() => document.documentElement.scrollWidth <= 391), 'mobile: no horizontal scrolling on a piece with comments');
  await M.page.screenshot({ path: 'shots/m-feedback.png', fullPage: true });
  const bad = [].concat(A.problems, B.problems, S.problems, M.problems);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('browser problems: ' + (bad.length ? '\n' + bad.join('\n') : 'none'));
  await h.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
