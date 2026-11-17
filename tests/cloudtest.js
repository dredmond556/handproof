const path = require('path');
/* End-to-end test of index.html's cloud mode: the real app in jsdom, talking to the real schema in PGlite
   through a fake supabase-js client (auth + rpc only). */
const { JSDOM, VirtualConsole } = require('jsdom');
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const shim = require('./shim');

const errors = [];
let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
const $ = (w, s) => w.document.querySelector(s);
const $$ = (w, s) => Array.from(w.document.querySelectorAll(s));
const txt = (w, s) => ($(w, s) ? $(w, s).textContent : '');

function makeClient(pg, state) {
  const listeners = [];
  let q = Promise.resolve();
  const locked = (fn) => { const p = q.then(fn); q = p.catch(() => {}); return p; };
  const users = state.users;
  const session = () => (state.user ? { user: state.user } : null);
  const notify = (ev) => listeners.forEach((cb) => cb(ev, session()));
  async function createUser(email, password, name, extra) {
    if (users[email]) return { data: null, error: { message: 'User already registered' } };
    const r = await locked(() => pg.query(`insert into auth.users (email, raw_user_meta_data) values ($1,$2::jsonb) returning id`, [email, JSON.stringify(Object.assign({ display_name: name || '' }, extra || {}))]));
    users[email] = { id: r.rows[0].id, password, name };
    return null;
  }
  const mk = (email) => ({ id: users[email].id, email, user_metadata: { display_name: users[email].name } });
  return {
    _notify: (ev) => notify(ev),
    auth: {
      getSession: async () => ({ data: { session: session() } }),
      onAuthStateChange: (cb) => { listeners.push(cb); return { data: { subscription: { unsubscribe() {} } } }; },
      async signUp({ email, password, options }) {
        const e = await createUser(email, password, options && options.data && options.data.display_name, options && options.data);
        if (e) return e;
        state.user = mk(email); notify('SIGNED_IN');
        return { data: { session: session(), user: state.user }, error: null };
      },
      async signInWithPassword({ email, password }) {
        if (!users[email] || users[email].password !== password) return { data: null, error: { message: 'Invalid login credentials' } };
        state.user = mk(email); notify('SIGNED_IN');
        return { data: { session: session() }, error: null };
      },
      async signInWithOtp(a) { state.lastOtp = a; return { data: {}, error: null }; },
      async resetPasswordForEmail(email, o) { state.reset = { email, o }; return { data: {}, error: null }; },
      async updateUser({ password }) { users[state.user.email].password = password; return { data: { user: state.user }, error: null }; },
      async signOut() { state.user = null; notify('SIGNED_OUT'); return { error: null }; },
    },
    rpc(name, args) {
      if (state.fail) return Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });
      args = args || {};
      const keys = Object.keys(args);
      const sql = `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}${/^p_(series|snapshots)$/.test(k) ? '::jsonb' : ''}`).join(',')}) as r`;
      const params = keys.map((k) => (/^p_(series|snapshots)$/.test(k) ? JSON.stringify(args[k]) : args[k]));
      return locked(async () => {
        const uid = state.user ? state.user.id : '';
        await pg.exec(`set role ${state.user ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub','${uid}', false);`);
        try { const r = await pg.query(sql, params); return { data: r.rows[0].r, error: null }; }
        catch (e) { return { data: null, error: { message: e.message } }; }
        finally { await pg.exec('reset role'); }
      });
    },
  };
}

function boot(client, seed) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/navigation to another Document/.test(e.message)) errors.push('jsdomError: ' + (e.detail && e.detail.stack || e.message)); });
  vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
  return new JSDOM(html, {
    url: 'http://localhost/index.html', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      if (seed) for (const k in seed) w.localStorage.setItem(k, seed[k]);
      w.scrollTo = () => {}; w.confirm = () => true; w.alert = () => {};
      w.HANDPROOF_CLIENT = client;
    },
  });
}
async function go(w, hash) { w.location.hash = hash; await sleep(120); }
function type(w, ta, str) { for (const ch of str) { ta.value += ch; ta.dispatchEvent(new w.InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true })); } }
function paste(w, ta, str) {
  const ev = new w.Event('paste', { bubbles: true });
  Object.defineProperty(ev, 'clipboardData', { value: { getData: () => str } });
  ta.dispatchEvent(ev); ta.value += str;
  ta.dispatchEvent(new w.InputEvent('input', { inputType: 'insertFromPaste', bubbles: true }));
}
function fill(w, sel, v) { const el = $(w, sel); el.value = v; el.dispatchEvent(new w.Event('input', { bubbles: true })); }

(async () => {
  const pg = new PGlite();
  await pg.exec(shim); await pg.exec(schema);
  const state = { user: null, users: {}, fail: false };
  const client = makeClient(pg, state);

  /* ---- signed out ---- */
  let dom = boot(client); let w = dom.window; await sleep(150);
  ok(!$(w, '#nav-account').hidden && txt(w, '#nav-account') === 'Sign in', 'nav shows Sign in when accounts are on');
  ok(/stored on Handproof/.test(txt(w, '#foot')), 'footer explains what is stored on the server');
  await go(w, '#/account');
  ok(!!$(w, '#af') && !!$(w, '#signup'), 'account page shows the sign-in form');
  fill(w, '#em', 'nope'); fill(w, '#pw', 'longenough');
  $(w, '#signup').click(); await sleep(50);
  ok(/valid email/.test(txt(w, '#amsg')), 'bad email is explained');
  fill(w, '#em', 'ada@example.com'); fill(w, '#pw', 'short');
  $(w, '#signup').click(); await sleep(50);
  ok(/at least 8/.test(txt(w, '#amsg')), 'short password is explained');
  await go(w, '#/write');
  ok(/not signed in/i.test(txt(w, '#where')) && !!$(w, '#where a'), 'editor tells signed-out writers the piece stays in this browser');

  /* ---- sign up ---- */
  await go(w, '#/account');
  fill(w, '#dn', 'Ada Lovelace'); fill(w, '#em', 'ada@example.com'); fill(w, '#pw', 'correct horse');
  $(w, '#signup').click(); await sleep(100);
  ok(/Tick the box/.test(txt(w, '#amsg')) && !state.user, 'creating an account without agreeing to the terms is refused');
  ok(!!$(w, '#tos') && !!$(w, 'label.check a[href="#/terms"]') && !!$(w, 'label.check a[href="#/privacy"]'), 'the consent box links to the Terms and Privacy pages');
  $(w, '#tos').checked = true;
  $(w, '#signup').click(); await sleep(400);
  ok(txt(w, '#nav-account') === 'Account', 'nav switches to Account after sign-up');
  ok(/ada@example.com/.test(txt(w, '#app')), 'account page shows who is signed in');
  const prof = (await pg.query(`select display_name from public.profiles`)).rows;
  ok(prof.length === 1 && prof[0].display_name === 'Ada Lovelace', 'profile was created with the chosen name');
  const tv = (await pg.query('select terms_version from public.profiles')).rows[0].terms_version;
  ok(tv === '2026-11-12', 'the terms version the account agreed to is stored (' + tv + ')');
  ok(/Nothing here yet/.test(txt(w, '#cl')), 'new account has no pieces');

  /* ---- write and publish to the cloud ---- */
  await go(w, '#/write');
  ok(/recorded to your account/.test(txt(w, '#where')), 'editor says it records to the account');
  const ta = $(w, '#x');
  $(w, '#t').value = 'Cloud piece'; $(w, '#t').dispatchEvent(new w.Event('input', { bubbles: true }));
  const sentence = 'The harbor was quiet before the boats came in. ';
  type(w, ta, sentence.repeat(8));
  paste(w, ta, ' PASTED_BLOCK_' + 'z'.repeat(100));
  type(w, ta, ' And then the end.');
  await sleep(1500);
  const finalText = ta.value;
  ok((await pg.query('select count(*)::int n from public.pieces')).rows[0].n === 1, 'a piece row was created on the server at the first keystrokes');
  ok((await pg.query('select count(*)::int n from public.piece_batches')).rows[0].n >= 1, 'edits were streamed to the server before publishing');
  $(w, '#publish').click(); await sleep(1200);
  ok(/^#\/p\/[0-9a-f-]{36}$/.test(w.location.hash), 'publishing opens the public page (' + w.location.hash + ')');
  const row = (await pg.query(`select * from public.pieces`)).rows[0];
  ok(row.status === 'published' && row.final_text === finalText, 'server stored the exact final text and locked the piece');
  ok(Number(row.pasted_chars) >= 100 && row.paste_events === 1, 'paste was counted from the server-side log (' + row.pasted_chars + ' chars)');
  ok(row.suspect_batches === 0, 'honest batches are not flagged');
  ok(txt(w, 'h1') === 'Cloud piece' && /Ada Lovelace/.test(txt(w, '.byline')), 'public page shows title and author');
  ok(!!$(w, '#rp .replay') && $$(w, '#rp .stack .tab').length >= 2, 'public page mounts the replay');
  ok(!!$(w, '#verify .banner.good') && /intact/.test(txt(w, '#verify')), 'verification panel says the record is intact');
  ok(!!$(w, '.banner.bad') && /Pasted text/.test(txt(w, '.banner.bad')), 'public page marks the pasted text');
  ok(/^[0-9a-f]{16}…$/.test(txt(w, '#verify .fp')), 'fingerprint is shown');
  const pubHash = w.location.hash;
  ok(!w.localStorage.getItem('handproof.draft.v1') || w.localStorage.getItem('handproof.draft.v1') === 'null', 'local draft is cleared after publishing');

  /* ---- browse, account list ---- */
  await go(w, '#/browse'); await sleep(300);
  ok($$(w, '#rows a.tile').some((a) => a.getAttribute('href') === pubHash && /Cloud piece/.test(a.textContent)), 'browse lists the published piece with a public link');
  ok($$(w, '#rows a.tile').length >= 1 && !$$(w, '#rows .tile').some((a) => /Sample/.test(a.textContent)), 'browse shows no sample pieces');
  await go(w, '#/account'); await sleep(300);
  ok($$(w, '#cmine .rowitem').length === 1 && !!$(w, '#cmine a'), 'account lists the published piece');

  /* ---- a stranger can open the link, signed out, on a fresh page ---- */
  const state2 = { user: null, users: {}, fail: false };
  const dom2 = boot(makeClient(pg, state2)); const w2 = dom2.window; await sleep(100);
  await go(w2, pubHash); await sleep(400);
  ok(txt(w2, 'h1') === 'Cloud piece' && !!$(w2, '#verify .banner.good'), 'signed-out visitor sees the piece and its verification');
  await go(w2, '#/p/not-a-real-id'); await sleep(300);
  ok(/isn’t here/.test(txt(w2, 'h1')), 'a bad link gets a clear not-found page');
  await go(w2, '#/p/00000000-0000-0000-0000-000000000000'); await sleep(300);
  ok(/isn’t here/.test(txt(w2, 'h1')), 'an unknown id gets a clear not-found page');

  /* ---- tampering is visible ---- */
  await pg.exec(`update public.piece_batches set snapshots = jsonb_set(snapshots, '{0,text}', '"edited later"') where seq = 1`);
  await go(w2, '#/browse'); await go(w2, pubHash); await sleep(400);
  ok(!!$(w2, '#verify .banner.bad') && /no longer matches/.test(txt(w2, '#verify')), 'an altered record is called out on the public page');

  /* ---- server trouble ---- */
  await go(w, '#/write');
  const ta3 = $(w, '#x');
  type(w, ta3, 'Second piece, written while the server is down.');
  state.fail = true;
  $(w, '#publish').click(); await sleep(400);
  ok(/Couldn’t publish/.test(txt(w, '#saved')) && /#\/write/.test(w.location.hash), 'failed publish explains itself and stays in the editor');
  ok($(w, '#x').value.includes('Second piece') && !$(w, '#publish').disabled, 'text is kept and Publish can be pressed again');
  state.fail = false;
  $(w, '#publish').click(); await sleep(1200);
  ok(/^#\/p\//.test(w.location.hash) && /Second piece/.test(txt(w, '.rp-text') + txt(w, '.page')), 'retry publishes after the server comes back');
  ok((await pg.query(`select count(*)::int n from public.pieces where status='published'`)).rows[0].n === 2, 'two pieces published; the retry did not duplicate');

  /* ---- discard removes the server draft ---- */
  await go(w, '#/write');
  type(w, $(w, '#x'), 'A draft I will throw away. '.repeat(12)); await sleep(1500);
  const before = (await pg.query(`select count(*)::int n from public.pieces where status='draft'`)).rows[0].n;
  $(w, '#discard').click(); await sleep(500);
  const after = (await pg.query(`select count(*)::int n from public.pieces where status='draft'`)).rows[0].n;
  ok(before === 1 && after === 0, 'discarding deletes the draft on the server too');

  /* ---- delete a published piece from the account ---- */
  await go(w, '#/account'); await sleep(300);
  $$(w, '#cmine [data-cdel]')[0].click(); await sleep(500);
  ok((await pg.query(`select count(*)::int n from public.pieces`)).rows[0].n === 1 && $$(w, '#cmine .rowitem').length === 1, 'deleting from the account removes it');

  /* ---- sign out; a cloud draft can't continue as a cloud draft elsewhere ---- */
  await go(w, '#/write');
  type(w, $(w, '#x'), 'Unfinished cloud draft. '.repeat(3)); await sleep(1300);
  const keep = w.localStorage.getItem('handproof.draft.v1');
  ok(!!keep && JSON.parse(keep).mode === 'cloud', 'cloud draft is saved locally with its mode');
  await go(w, '#/account');
  $(w, '#signout').click(); await sleep(300);
  ok(txt(w, '#nav-account') === 'Sign in' && !!$(w, '#af'), 'signing out returns to the sign-in form');
  const dom3 = boot(makeClient(pg, { user: null, users: {}, fail: false }), { 'handproof.draft.v1': keep });
  const w3 = dom3.window; await sleep(100); await go(w3, '#/write');
  ok(/isn’t signed in here/.test(txt(w3, '#where')), 'a cloud draft opened while signed out explains it will publish locally');
  ok($(w3, '#x').value.includes('Unfinished cloud draft'), 'its text is still there');

  /* ---- sign back in for the next checks ---- */
  await go(w, '#/account');
  fill(w, '#em', 'ada@example.com'); fill(w, '#pw', 'correct horse');
  $(w, '#af').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await sleep(400);

  /* ---- legal pages and footer ---- */
  await go(w, '#/terms');
  ok(txt(w, 'h1') === 'Terms' && /Publish only work you wrote yourself/.test(txt(w, '#app')) && /Reports and removal/.test(txt(w, '#app')), 'Terms page renders with the rules');
  ok(!/Contact/.test(txt(w, '#app h2:last-of-type')) , 'no contact section appears until a contact address is configured');
  await go(w, '#/privacy');
  ok(txt(w, 'h1') === 'Privacy' && /earlier versions of the text and anything you deleted/.test(txt(w, '#app')) && /Google Fonts/.test(txt(w, '#app')), 'Privacy page explains what is public and which third parties see visitors');
  ok($$(w, '#foot a').map((a) => a.getAttribute('href')).join() === '#/terms,#/privacy', 'footer links to Terms and Privacy');

  /* ---- report a piece ---- */
  const ids = (await pg.query("select id from public.pieces where status='published'")).rows;
  const w4 = boot(makeClient(pg, { user: null, users: {}, fail: false })).window; await sleep(100);
  await go(w4, '#/p/' + ids[0].id); await sleep(400);
  ok(!!$(w4, '#reportform') && $(w4, '#reportform').hidden, 'report form starts closed on a public piece');
  $(w4, '#reportopen').click();
  ok(!$(w4, '#reportform').hidden && $$(w4, '#rr option').length === 6, 'opening it shows six reasons');
  $(w4, '#rr').value = 'ai_or_retyped'; $(w4, '#rdet').value = 'Reads like a chatbot';
  $(w4, '#reportform').dispatchEvent(new w4.Event('submit', { bubbles: true, cancelable: true })); await sleep(400);
  const rep = (await pg.query('select reason, details, reporter_id, status from public.reports')).rows;
  ok(rep.length === 1 && rep[0].reason === 'ai_or_retyped' && rep[0].details === 'Reads like a chatbot' && rep[0].reporter_id === null && rep[0].status === 'open', 'the report reached the server (sent without signing in)');
  ok(/Thanks/.test(txt(w4, '#rmsg')) && $(w4, '#reportform').hidden, 'reporter gets a confirmation and the form closes');

  /* ---- a removed piece disappears for everyone, and the author is told ---- */
  await pg.query("select public.admin_remove_piece($1,'Retyped AI text')", [ids[0].id]);
  await go(w4, '#/browse'); await go(w4, '#/p/' + ids[0].id); await sleep(400);
  ok(/isn’t here/.test(txt(w4, 'h1')), 'a removed piece is gone from its public link');
  await go(w, '#/account'); await sleep(400);
  ok(/Removed: Retyped AI text/.test(txt(w, '#cl')) && !!$(w, '#cl .chip.flag'), 'the author sees that it was removed, and why');

  /* ---- forgot password ---- */
  await go(w, '#/account'); $(w, '#signout').click(); await sleep(300);
  fill(w, '#em', 'ada@example.com');
  $(w, '#forgot').click(); await sleep(200);
  ok(state.reset && state.reset.email === 'ada@example.com' && /reset the password/.test(txt(w, '#amsg')), 'forgot password asks the server for a reset email');
  $(w, '#magic').click(); await sleep(200);
  ok(state.lastOtp && state.lastOtp.options.shouldCreateUser === false, 'the sign-in link cannot create accounts (so everyone agrees to the terms first)');
  fill(w, '#pw', 'correct horse');
  $(w, '#af').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await sleep(300);
  client._notify('PASSWORD_RECOVERY'); await sleep(300);
  ok(w.location.hash === '#/account' && txt(w, 'h1') === 'Choose a new password', 'following a reset link opens the new-password form');
  fill(w, '#npw', 'short');
  $(w, '#rf').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await sleep(100);
  ok(/at least 8/.test(txt(w, '#rmsg2')), 'a short new password is refused');
  fill(w, '#npw', 'brand new passphrase');
  $(w, '#rf').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await sleep(300);
  ok(txt(w, 'h1') === 'Account' && state.users['ada@example.com'].password === 'brand new passphrase', 'the new password is saved and you land on your account');

  /* ---- download my data ---- */
  let clicked = 0;
  w.URL.revokeObjectURL = () => {}; const origCreate = w.URL.createObjectURL; w.URL.createObjectURL = (b) => { clicked = b.size; return 'blob:x'; };
  $(w, '#xport').click(); await sleep(300);
  ok(clicked > 50 && /Downloaded/.test(txt(w, '#xmsg')), 'download my data produces a file (' + clicked + ' bytes)');
  w.URL.createObjectURL = origCreate;

  /* ---- delete account ---- */
  $(w, '#delacct').click();
  ok(!$(w, '#delbox').hidden && $(w, '#delgo').disabled, 'deleting an account asks for typed confirmation first');
  fill(w, '#delconf', 'delete');
  ok($(w, '#delgo').disabled, 'lower-case "delete" is not enough');
  fill(w, '#delconf', 'DELETE');
  ok(!$(w, '#delgo').disabled, 'typing DELETE enables the button');
  $(w, '#delgo').click(); await sleep(700);
  ok((await pg.query('select count(*)::int n from auth.users')).rows[0].n === 0 && (await pg.query('select count(*)::int n from public.pieces')).rows[0].n === 0, 'the account, its pieces and recordings are gone from the server');
  ok(!state.user && txt(w, '#nav-account') === 'Sign in' && w.location.hash === '#/', 'you are signed out and returned to the home page');

  /* ---- wrong password ---- */
  await go(w, '#/account');
  fill(w, '#em', 'ada@example.com'); fill(w, '#pw', 'wrong password');
  $(w, '#af').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await sleep(200);
  ok(/Invalid login/.test(txt(w, '#amsg')), 'wrong password shows the server’s message');
  fill(w, '#pw', 'brand new passphrase');
  $(w, '#af').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await sleep(300);
  ok(txt(w, '#nav-account') === 'Account', 'signing back in works');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  console.log('Errors captured: ' + (errors.length ? '\n' + errors.join('\n') : 'none'));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
