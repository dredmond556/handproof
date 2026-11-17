const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const errors = [];
const alerts = [];
let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }

function boot(seed) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/navigation to another Document/.test(e.message)) errors.push('jsdomError: ' + (e.detail || e.message)); });
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  return new JSDOM(html, {
    url: 'http://localhost/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      if (seed) for (const k in seed) w.localStorage.setItem(k, seed[k]);
      w.scrollTo = () => {};
      w.confirm = () => true;
      w.alert = (m) => alerts.push(m);
    },
  });
}
async function go(w, hash) { w.location.hash = hash; await sleep(60); }
const $ = (w, s) => w.document.querySelector(s);
const $$ = (w, s) => Array.from(w.document.querySelectorAll(s));
const txt = (w, s) => ($(w, s) ? $(w, s).textContent : '');
function type(w, ta, str) { for (const ch of str) { ta.value += ch; ta.dispatchEvent(new w.InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true })); } }
function del(w, ta, n) { for (let i = 0; i < n; i++) { ta.value = ta.value.slice(0, -1); ta.dispatchEvent(new w.InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true })); } }
function paste(w, ta, str) {
  const ev = new w.Event('paste', { bubbles: true });
  Object.defineProperty(ev, 'clipboardData', { value: { getData: () => str } });
  ta.dispatchEvent(ev);
  ta.value += str;
  ta.dispatchEvent(new w.InputEvent('input', { inputType: 'insertFromPaste', bubbles: true }));
}
const key = (w, el, k) => el.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, bubbles: true }));

(async () => {
  /* ---- landing ---- */
  let dom = boot();
  let w = dom.window;
  await sleep(80);
  ok(!$(w, '#hero') && !/Start a draft/.test(txt(w, '#app')), 'landing: no sample replay and no repeated start-a-draft block');
  ok(!!$(w, 'a[href="#/write"]') && !!$(w, 'a[href="#/make"]') && !!$(w, 'a[href="#/browse"]'), 'landing: the three actions are at the top');
  w.location.hash = '#/piece/sample-low-tide'; await sleep(200);
  ok(!!$(w, '#rp .replay'), 'replay: sample replay renders');
  ok($$(w, '#rp rect.band').length === 6 && !!$(w, '#rp polyline.trace'), 'replay: chart has one color band per revision (6) and a trace line');
  ok($$(w, '#rp .stack .tab').length === 6, 'replay: page-stack tabs match snapshots');
  ok(/--bg:#FFFFFF/i.test($(w, '#rp .stack .tab').getAttribute('style')) && /--ink:#B9BCC4/i.test($(w, '#rp .stack .tab').getAttribute('style')), 'replay: tabs carry their revision colors as CSS variables');
  ok($$(w, '#rp .stack .tab').every((t) => !t.textContent), 'replay: tabs are plain color segments with no stray text');
  const plot = $(w, '#rp .chart-plot');
  key(w, plot, 'End');
  ok(/Snapshot 6 of 6/.test(txt(w, '#rp .rp-info')) && txt(w, '#rp .rp-play') === 'Play', 'replay: End jumps to last');
  ok(/Goldenrod revision/.test(txt(w, '#rp .rev-name')), 'replay: sixth snapshot is the Goldenrod revision');
  ok($(w, '#rp .page').style.background.includes('rgb(244, 220, 150)'), 'replay: page color matches the revision color');
  key(w, plot, 'ArrowLeft');
  ok(/Snapshot 5 of 6/.test(txt(w, '#rp .rp-info')) && /Green revision/.test(txt(w, '#rp .rev-name')), 'replay: arrow key steps back and recolors');
  key(w, plot, 'Home');
  ok(/Snapshot 1 of 6/.test(txt(w, '#rp .rp-info')) && /White revision/.test(txt(w, '#rp .rev-name')), 'replay: Home goes to white revision');
  ok(txt(w, '#rp .rp-text').startsWith('The house always smelled like'), 'replay: text pane follows snapshot');
  $$(w, '#rp .stack .tab')[2].click();
  ok(/Snapshot 3 of 6/.test(txt(w, '#rp .rp-info')) && /Pink revision/.test(txt(w, '#rp .rev-name')), 'replay: clicking a page tab jumps to it');
  $(w, '#rp .rp-play').click();
  ok(txt(w, '#rp .rp-play') === 'Pause', 'replay: Play button toggles to Pause');
  await sleep(1500);
  ok(/ of \d+:\d\d/.test(txt(w, '#rp .rp-info')) && !/Snapshot 3 of 6/.test(txt(w, '#rp .rp-info')), 'replay: manual playback advances');
  $(w, '#rp .rp-play').click();
  ok(txt(w, '#rp .rp-play') === 'Play', 'replay: pause works');
  w.location.hash = '#/'; await sleep(200);

  /* ---- landing craft tabs ---- */
  ok($$(w, '.craft-tab').length === 6 && $(w, '#tab-writing').getAttribute('aria-selected') === 'true', 'crafts: six tabs, writing selected first');
  ok(/Works today/.test(txt(w, '#craft-panel')) && !!$(w, '#craft-panel .spark svg'), 'crafts: writing panel shows live status and a chart');
  $(w, '#tab-acting').click();
  ok($(w, '#tab-acting').getAttribute('aria-selected') === 'true' && /Every take, kept/.test(txt(w, '#craft-panel')) && /Not built yet/.test(txt(w, '#craft-panel')), 'crafts: acting panel is labeled as planned');
  $(w, '#tab-film').click();
  ok(/Raw footage to final cut/.test(txt(w, '#craft-panel')) && /Works today/.test(txt(w, '#craft-panel')) && $$(w, '#craft-panel .take').length === 4, 'crafts: film panel is live and shows the uploaded-files preview');
  $(w, '#tab-acting').click();
  key(w, $(w, '#tab-acting'), 'ArrowDown');
  ok($(w, '#tab-writing').getAttribute('aria-selected') === 'true', 'crafts: arrow keys move between tabs');

  /* ---- not found ---- */
  await go(w, '#/piece/nope');
  ok(/isn.t here/.test(txt(w, 'h1')), 'router: unknown piece shows a clear not-found page');

  /* ---- editor ---- */
  await go(w, '#/write');
  const ta = $(w, '#x');
  ok(!!ta && $(w, '#publish').disabled, 'editor: publish disabled while empty');
  type(w, ta, 'Hello there, this is a test of the editor.');
  await sleep(1350);
  del(w, ta, 8);
  await sleep(1350);
  type(w, ta, ' It records what I do.');
  await sleep(1350);
  ok(!$(w, '#publish').disabled, 'editor: publish enabled after typing');
  ok(txt(w, '#s-paste') === '0' && !$(w, '#s-paste').classList.contains('bad'), 'editor: no paste recorded for typed text');
  ok(+txt(w, '#s-snaps') >= 3, 'editor: snapshots captured on pauses (' + txt(w, '#s-snaps') + ')');
  ok(txt(w, '#s-del') === '8', 'editor: deletions counted');
  ok(+txt(w, '#s-words') === 13,'editor: word count (' + txt(w, '#s-words') + ')');
  const pasted = ' This sentence was pasted from somewhere else and it is fairly long so it is flagged. '.repeat(2);
  paste(w, ta, pasted);
  await sleep(50);
  ok(txt(w, '#s-paste') === String(pasted.length) && $(w, '#s-paste').classList.contains('bad'), 'editor: paste recorded with correct size and highlighted');
  ok($(w, '#live .rp-note') && !$(w, '#live .rp-note').hidden, 'editor: live replay shows paste note');
  ok($$(w, '#live .pastemark').length === 1 && $$(w, '#live .tab.p').length === 1, 'editor: red paste mark on chart and page tab');
  await sleep(900);
  const savedDraft = w.localStorage.getItem('handproof.draft.v1');
  ok(!!savedDraft && JSON.parse(savedDraft).text === ta.value, 'editor: draft autosaved to localStorage');
  $(w, '#t').value = 'My Test Piece';
  $(w, '#t').dispatchEvent(new w.Event('input', { bubbles: true }));

  const pastedBefore = +txt(w, '#s-paste');
  ta.value += 'x'.repeat(50);
  ta.dispatchEvent(new w.InputEvent('input', { inputType: 'insertText', data: 'x'.repeat(50), bubbles: true }));
  ok(+txt(w, '#s-paste') === pastedBefore + 50, 'editor: bulk non-keystroke insert is flagged');
  del(w, ta, 50);

  $(w, '#publish').click();
  await sleep(120);
  ok(/^#\/piece\//.test(w.location.hash), 'publish: navigates to piece page');
  const stored = JSON.parse(w.localStorage.getItem('handproof.pieces.v1'));
  ok(stored.length === 1 && stored[0].title === 'My Test Piece', 'publish: piece saved to localStorage');
  ok(stored[0].series.length > 40 && stored[0].snapshots.length >= 4, 'publish: series (' + stored[0].series.length + ' pts) and snapshots (' + stored[0].snapshots.length + ') stored');
  ok(w.localStorage.getItem('handproof.draft.v1') === null, 'publish: draft cleared');
  ok(/characters in 2 pastes/.test(txt(w, '#app')) && !!$(w, '.banner.bad'), 'piece page: paste banner shown');
  ok($$(w, '.pastemark').length >= 1, 'piece page: paste mark drawn on chart');
  ok(/Snapshot \d+ of \d+/.test(txt(w, '.rp-info')) && txt(w, '.rp-text') === stored[0].snapshots.slice(-1)[0].text, 'piece page: replay opens on final text');
  ok(!!$(w, '.page').style.background, 'piece page: page is tinted with its revision color');

  /* ---- browse ---- */
  await go(w, '#/browse');
  ok($$(w, '#rows .tile').length === 1, 'browse: 1 tile (mine), no sample tiles');
  ok($$(w, '#rows .tile')[0].textContent.includes('My Test Piece') && !!$$(w, '#rows .tile')[0].querySelector('.chip.flag'), 'browse: my piece first, with pasted-text flag');
  ok($$(w, '#rows .tile svg').length === 1 && $$(w, '#rows .tile rect.band').length >= 1, 'browse: each tile has a colored thumbnail chart');
  const f = $(w, '#f');
  f.value = 'kitchen'; f.dispatchEvent(new w.Event('input', { bubbles: true }));
  ok($$(w, '#rows .tile').length === 0, 'browse: filter narrows list');
  f.value = 'zzzz'; f.dispatchEvent(new w.Event('input', { bubbles: true }));
  ok($$(w, '#rows .tile').length === 0 && !$(w, '#none').hidden, 'browse: empty filter shows message');

  /* ---- profile ---- */
  await go(w, '#/profile');
  ok(/1\s*piece/.test(txt(w, '#pstats')), 'profile: stats show 1 piece');
  const nm = $(w, '#nm'); nm.value = 'Dana'; nm.dispatchEvent(new w.Event('input', { bubbles: true }));
  ok(JSON.parse(w.localStorage.getItem('handproof.name')) === 'Dana' && txt(w, '#av') === 'D', 'profile: name saved and avatar updates');
  w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
  $(w, '#export').click();
  ok(/Exported 1 piece/.test(txt(w, '#dataMsg')), 'profile: export runs');
  $(w, '[data-del]').click();
  await sleep(30);
  ok(JSON.parse(w.localStorage.getItem('handproof.pieces.v1')).length === 0 && /Nothing published yet/.test(txt(w, '#app')), 'profile: delete removes piece and shows empty state');
  const exportJson = JSON.stringify({ app: 'handproof', version: 1, pieces: stored });
  const imp = $(w, '#imp');
  Object.defineProperty(imp, 'files', { value: [new w.File([exportJson], 'x.json', { type: 'application/json' })] });
  imp.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(150);
  ok(JSON.parse(w.localStorage.getItem('handproof.pieces.v1')).length === 1, 'profile: import restores piece');
  ok(/Imported 1 new piece/.test(txt(w, '#dataMsg')), 'profile: import message shown');
  const imp2 = $(w, '#imp');
  Object.defineProperty(imp2, 'files', { value: [new w.File(['not json'], 'bad.json')] });
  imp2.dispatchEvent(new w.Event('change', { bubbles: true }));
  await sleep(120);
  ok(/isn.t a Handproof export/.test(txt(w, '#dataMsg')), 'profile: bad file rejected with a clear message');

  /* ---- draft restore after reload ---- */
  const dom2 = boot({ 'handproof.draft.v1': savedDraft });
  const w2 = dom2.window;
  await go(w2, '#/write');
  ok($(w2, '#x').value === JSON.parse(savedDraft).text, 'reload: unfinished draft text restored');
  ok(!!$(w2, '#restored'), 'reload: restored notice shown');
  ok(+txt(w2, '#s-paste') > 0 && $$(w2, '#live .pastemark').length === 1, 'reload: paste history and chart restored');

  /* ---- pieces saved by the earlier version still open ---- */
  const old = { id: 'old1', title: 'Old piece', author: 'X', excerpt: 'ab', snapshots: [{ t: 0, text: 'ab' }, { t: 5, text: 'abc def' }], wordCount: 2, revisions: 2, backspaces: 0, pasted: 0, pasteEvents: 0, activeSeconds: 5, createdAt: 1700000000000, demo: false };
  const dom3 = boot({ 'handproof.pieces.v1': JSON.stringify([old]) });
  const w3 = dom3.window;
  await go(w3, '#/piece/old1');
  ok(/Old piece/.test(txt(w3, 'h1')) && !!$(w3, 'polyline.trace') && $$(w3, 'rect.band').length === 2, 'compat: older saved piece opens and draws a chart');
  await go(w3, '#/browse');
  ok($$(w3, '#rows .tile').length === 1, 'compat: older saved piece appears in browse');

  /* ---- long piece on a fake clock: 6,000 characters, deletions, long idle gaps ---- */
  const dom4 = boot();
  const w4 = dom4.window;
  let fakeNow = 1700000000000;
  w4.Date.now = () => fakeNow;
  let timers = [];
  w4.setTimeout = (fn) => { timers.push(fn); return timers.length; };
  w4.clearTimeout = (id) => { if (id) timers[id - 1] = null; };
  const flush = () => { const t = timers; timers = []; t.forEach((f) => f && f()); };
  w4.location.hash = '#/write'; await sleep(20); flush(); await sleep(20);
  const ta4 = $(w4, '#x');
  const words = 'the quick brown fox jumps over the lazy dog and keeps writing sentences about lakes, houses and kitchens. ';
  let n = 0;
  const t0 = Date.now();
  while (ta4.value.length < 6000) {
    const ch = words[n++ % words.length];
    fakeNow += 150;
    ta4.value += ch;
    ta4.dispatchEvent(new w4.InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
    if (n % 25 === 0) { fakeNow += 2000; flush(); }
    if (n % 1000 === 0) { fakeNow += 45000; }
    if (n % 400 === 0) { for (let i = 0; i < 30; i++) { fakeNow += 120; ta4.value = ta4.value.slice(0, -1); ta4.dispatchEvent(new w4.InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true })); } }
  }
  flush();
  const typingMs = Date.now() - t0;
  const snaps4 = +txt(w4, '#s-snaps');
  ok(snaps4 >= 40 && snaps4 <= 60, 'long piece: snapshots stay capped (' + snaps4 + ' of at most 60) after ' + n + ' keystrokes');
  ok(typingMs < 20000, 'long piece: stays responsive (' + typingMs + ' ms to process ' + n + ' input events)');
  ok($$(w4, '#live .stack .tab').length === snaps4, 'long piece: one tab per snapshot in the live strip');
  $(w4, '#t').value = 'Long one'; $(w4, '#t').dispatchEvent(new w4.Event('input', { bubbles: true }));
  $(w4, '#publish').click();
  await sleep(20); flush(); await sleep(50);
  const st4 = JSON.parse(w4.localStorage.getItem('handproof.pieces.v1'));
  const bytes = w4.localStorage.getItem('handproof.pieces.v1').length;
  ok(st4.length === 1 && st4[0].snapshots.length <= 60, 'long piece: published with <= 60 snapshots (' + (st4[0] && st4[0].snapshots.length) + ')');
  const sn4 = st4[0].snapshots;
  ok(sn4[sn4.length - 1].text === ta4.value, 'long piece: last snapshot is the final text (' + sn4[sn4.length - 1].text.length + ' vs ' + ta4.value.length + ' chars)');
  ok(sn4[0].text.length <= 30 && sn4.every((s, i) => i === 0 || s.t >= sn4[i - 1].t), 'long piece: first snapshot is the earliest and times never go backwards (first has ' + sn4[0].text.length + ' chars, t=' + sn4[0].t + ')');
  ok(st4[0].series.length <= 2400, 'long piece: chart series capped (' + st4[0].series.length + ' points)');
  ok(bytes < 1500000, 'long piece: stored size is reasonable (' + Math.round(bytes / 1024) + ' KB)');
  ok(st4[0].activeSeconds > 800 && st4[0].activeSeconds < 2600, 'long piece: active time ignores long idle gaps (' + st4[0].activeSeconds + ' s)');
  const maxT = st4[0].snapshots[st4[0].snapshots.length - 1].t;
  ok(maxT < 6500 * 3, 'long piece: 45 s idle gaps are shortened on the timeline (' + maxT + ' s total)');
  ok($$(w4, '#rp .stack .tab').length === st4[0].snapshots.length && /Round|round/.test(txt(w4, '#rp .rev-name')) || $$(w4, '#rp .stack .tab').length === st4[0].snapshots.length, 'long piece: piece page draws every tab');

  /* ---- data saved under the old name (Handmark) still loads under Handproof ---- */
  const oldPiece = { id: 'mig1', title: 'Migrated piece', author: 'Casey', excerpt: 'x', snapshots: [{ t: 0, text: 'a' }, { t: 4, text: 'ab cd' }], wordCount: 2, backspaces: 0, pasted: 0, pasteEvents: 0, activeSeconds: 4, createdAt: 1700000000000, demo: false };
  const dom6 = boot({ 'handmark.pieces.v1': JSON.stringify([oldPiece]), 'handmark.name': JSON.stringify('Casey') });
  const w6 = dom6.window;
  await sleep(60);
  ok(w6.document.title === 'Handproof' && /Handproof/.test(txt(w6, '.top .brand')), 'rename: page title and header say Handproof');
  ok(/Handproof/.test(txt(w6, '#app')) && !/Handmark/i.test(txt(w6, '.top') + txt(w6, '#app') + txt(w6, 'footer')), 'rename: no old name left in visible text');
  await go(w6, '#/browse');
  ok($$(w6, '#rows .tile').length === 1 && $$(w6, '#rows .tile')[0].textContent.includes('Migrated piece'), 'rename: pieces saved as Handmark appear under Handproof');
  await go(w6, '#/profile');
  ok($(w6, '#nm').value === 'Casey', 'rename: saved name carried over');
  ok(w6.localStorage.getItem('handproof.pieces.v1') !== null, 'rename: old data copied to the new storage key');

  /* ---- storage full when publishing ---- */
  const dom5 = boot();
  const w5 = dom5.window;
  await go(w5, '#/write');
  type(w5, $(w5, '#x'), 'A short draft.');
  w5.Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
  $(w5, '#publish').click();
  await sleep(150);
  ok(alerts.length === 1 && /storage is full/.test(alerts[0]), 'storage full: publish explains what happened and what to do');
  ok(/#\/write/.test(w5.location.hash) && $(w5, '#x').value === 'A short draft.', 'storage full: you stay in the editor and keep your text');
  await go(w5, '#/browse');
  ok($$(w5, '#rows .tile').length === 0, 'storage full: nothing half-saved appears in browse');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('Errors captured: ' + (errors.length ? '\n  ' + errors.join('\n  ') : 'none'));
  process.exit(fail || errors.length ? 1 : 0);
})();
