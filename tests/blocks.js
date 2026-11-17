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
async function publish(page, title) {
  await page.goto(base + '#/write'); await page.waitForTimeout(400);
  await page.fill('#t', title); await page.click('#x');
  await page.keyboard.type('The harbor was quiet before the boats came in. A gull walked the length of the pier. '.repeat(2), { delay: 4 });
  await page.waitForTimeout(1500);
  await page.click('#publish'); await page.waitForURL(/#\/p\//, { timeout: 8000 }); await page.waitForTimeout(1000);
  return page.url();
}
(async () => {
  const h = await start();
  const A = await h.newPage(); const pa = A.page; pa.on('dialog', (d) => d.accept());
  await signup(pa, 'Ada Lovelace', 'ada@example.com');
  const urlA = await publish(pa, 'Harbor Notes');
  const B = await h.newPage(); const pb = B.page; pb.on('dialog', (d) => d.accept());
  await signup(pb, 'Bo Diaz', 'bo@example.com');
  const urlB = await publish(pb, 'Bo’s Pier');
  await pb.goto(urlA); await pb.waitForTimeout(1200);
  await pb.fill('#cb', 'Lovely pacing.'); await pb.click('#cpost'); await pb.waitForTimeout(700);
  ok((await pb.$$('#clist [data-blk]')).length === 0, 'you cannot block yourself from your own comment');

  await pa.goto(urlA); await pa.reload(); await pa.waitForTimeout(1500);
  ok((await pa.$$('#clist li.cm')).length === 1 && (await pa.$$('#clist [data-blk]')).length === 1, 'Ada sees Bo’s comment with a Block button');
  await pa.click('#clist [data-blk]'); await pa.waitForTimeout(900);
  ok((await pa.$$('#clist li.cm')).length === 0 && /Blocked/.test(await pa.textContent('#fmsg')), 'blocking hides the comment and confirms');
  await pa.goto(base + '#/account'); await pa.waitForTimeout(900);
  ok(/Bo Diaz/.test(await pa.textContent('#blklist')), 'Account lists Bo under Blocked people');
  await pa.goto(base + '#/browse'); await pa.waitForTimeout(1200);
  ok(!/Bo’s Pier/.test(await pa.textContent('body')), 'Bo’s piece is hidden from Ada’s Browse');
  await pb.goto(urlA); await pb.reload(); await pb.waitForTimeout(1200);
  await pb.fill('#cb', 'Again'); await pb.click('#cpost'); await pb.waitForTimeout(800);
  console.log('cmsg:', await pb.textContent('#cmsg'), (await pb.$$('#clist li.cm')).length);
  ok((await pb.$$('#clist li.cm')).length === 1, 'Bo cannot add a comment on Ada’s piece');

  await pa.goto(base + '#/account'); await pa.waitForTimeout(900);
  await pa.click('[data-unb]'); await pa.waitForTimeout(900);
  ok(/haven’t blocked anyone/.test(await pa.textContent('#blklist')), 'Unblock in Account clears the list');
  await pa.goto(urlA); await pa.reload(); await pa.waitForTimeout(1200);
  ok((await pa.$$('#clist li.cm')).length === 1, 'the comment is visible again');

  // writer page
  await pa.goto(urlB); await pa.waitForTimeout(1200);
  await pa.click('.byline a'); await pa.waitForTimeout(1000);
  ok(/Block this person/.test(await pa.textContent('#blkrow')), 'a writer page offers Block');
  await pa.click('#blkbtn'); await pa.waitForTimeout(1200);
  ok(/Unblock this person/.test(await pa.textContent('#blkrow')) && /Blocked/.test(await pa.textContent('#blkrow')), 'after blocking it shows Unblock');
  await pa.click('#blkbtn'); await pa.waitForTimeout(1200);
  ok(/Block this person/.test(await pa.textContent('#blkrow')), 'Unblock from the page works');
  await pb.goto(urlB); await pb.waitForTimeout(1000); await pb.click('.byline a'); await pb.waitForTimeout(1000);
  ok((await pb.$$('#blkbtn')).length === 0, 'your own page has no Block button');
  const S = await h.newPage(); await S.page.goto(urlB); await S.page.waitForTimeout(900); await S.page.click('.byline a'); await S.page.waitForTimeout(900);
  ok((await S.page.$$('#blkbtn')).length === 0, 'signed-out visitors see no Block button');

  const bad = [].concat(A.problems, B.problems, S.problems);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('browser problems: ' + (bad.length ? '\n' + bad.join('\n') : 'none'));
  await h.stop(); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
