const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const shim = require('./shim');
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const pg = new PGlite();
  await pg.exec(shim); await pg.exec(schema);
  let again = true; try { await pg.exec(schema); } catch (e) { again = false; console.log(e.message); }
  ok(again, 'whole schema can be run a second time without errors');

  const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222', C = '33333333-3333-3333-3333-333333333333';
  await pg.exec(`insert into auth.users (id,email,raw_user_meta_data) values
    ('${A}','a@x.com','{"display_name":"Ada","accepted_terms":"2026-11-12"}'),
    ('${B}','b@x.com','{}'), ('${C}','c@x.com','{}')`);
  const pr = (await pg.query('select id, terms_version, terms_accepted_at from public.profiles order by id')).rows;
  ok(pr[0].terms_version === '2026-11-12' && pr[0].terms_accepted_at && !pr[1].terms_version, 'sign-up records the terms version when given');

  async function as(role, uid, fn) {
    await pg.exec(`set role ${role}; select set_config('request.jwt.claim.sub','${uid || ''}', false);`);
    try { return await fn(); } finally { await pg.exec('reset role'); }
  }
  const q = (role, uid, sql, p) => as(role, uid, () => pg.query(sql, p || []));
  async function fails(role, uid, sql, p, re) { try { await q(role, uid, sql, p); return false; } catch (e) { return re ? re.test(e.message) : true; } }
  const J = JSON.stringify;
  async function publishOne(uid, title, text) {
    const id = (await q('authenticated', uid, 'select public.create_piece($1) id', [title])).rows[0].id;
    await q('authenticated', uid, 'select public.append_batch($1,100,$2::jsonb,$3::jsonb)', [id, J([[0, 0, 0], [100, text.length, 0]]), J([{ t: 1, text }])]);
    await q('authenticated', uid, 'select public.publish_piece($1)', [id]);
    return id;
  }
  const p1 = await publishOne(A, 'One', 'Some words here.');

  /* reports */
  ok((await q('anon', null, 'select public.report_piece($1,$2,$3) r', [p1, 'spam', '  looks like spam  '])).rows[0].r === true, 'a signed-out visitor can report a published piece');
  ok((await q('authenticated', B, 'select public.report_piece($1,$2) r', [p1, 'copyright'])).rows[0].r === true, 'a signed-in user can report too');
  const reps = (await pg.query('select reporter_id, reason, details, status from public.reports order by created_at')).rows;
  ok(reps.length === 2 && reps[0].reporter_id === null && reps[0].details === 'looks like spam' && reps[1].reporter_id === B && reps.every((r) => r.status === 'open'), 'reports are stored with who sent them (if signed in), trimmed details, status open');
  ok(await fails('anon', null, 'select public.report_piece($1,$2)', [p1, 'because'], /unknown reason/), 'an unknown reason is rejected');
  ok(await fails('anon', null, 'select public.report_piece($1,$2)', ['99999999-9999-9999-9999-999999999999', 'spam'], /piece not found/), 'reporting a piece that does not exist fails');
  const d1 = await q('authenticated', A, 'select public.create_piece($1) id', ['Draft']);
  ok(await fails('anon', null, 'select public.report_piece($1,$2)', [d1.rows[0].id, 'spam'], /piece not found/), 'drafts cannot be reported (they are private)');
  ok(await fails('anon', null, 'select * from public.reports', [], /permission denied/), 'nobody can read reports through the API (signed out)');
  ok(await fails('authenticated', B, 'select * from public.reports', [], /permission denied/), 'nobody can read reports through the API (signed in)');
  ok(await fails('authenticated', B, "insert into public.reports (piece_id, reason) values ($1,'spam')", [p1], /permission denied/), 'nobody can write reports directly');
  for (let i = 0; i < 30; i++) await pg.query("insert into public.reports (piece_id, reason) values ($1,'spam')", [p1]);
  await q('anon', null, 'select public.report_piece($1,$2)', [p1, 'other']);
  ok((await pg.query("select count(*)::int n from public.reports where piece_id=$1 and status='open'", [p1])).rows[0].n === 32, 'a piece with 25+ open reports stops collecting more (quietly)');
  await pg.query('delete from public.reports');
  const p2 = await publishOne(B, 'Two', 'More words here.');
  for (let i = 0; i < 20; i++) await q('authenticated', C, 'select public.report_piece($1,$2)', [p2, 'other']);
  await pg.query("delete from public.reports where piece_id=$1 and reporter_id is null", [p2]);
  await pg.query("update public.reports set created_at = now() where reporter_id = $1", [C]);
  // 20 reports used up 20 of C's daily allowance; need a second piece to avoid the per-piece cap interfering
  const p3 = await publishOne(B, 'Three', 'Even more words.');
  ok(await fails('authenticated', C, 'select public.report_piece($1,$2)', [p3, 'other'], /too many reports today/), 'one account cannot file more than 20 reports a day');
  await pg.query('delete from public.reports');

  /* admin tools are not callable from the website */
  for (const [fn, args] of [['admin_remove_piece', [p1, 'x']], ['admin_restore_piece', [p1]], ['admin_dismiss_reports', [p1]]]) {
    const sql = `select public.${fn}(${args.map((_, i) => '$' + (i + 1)).join(',')})`;
    ok(await fails('anon', null, sql, args, /permission denied/) && await fails('authenticated', A, sql, args, /permission denied/), fn + ' is not callable by visitors or signed-in users');
  }
  await q('anon', null, 'select public.report_piece($1,$2)', [p1, 'illegal']);
  ok((await pg.query('select public.admin_remove_piece($1,$2) r', [p1, 'Breaks the rules'])).rows[0].r === true, 'you can remove a piece (running as the database owner)');
  ok((await pg.query("select status, removed_reason from public.pieces where id=$1", [p1])).rows[0].status === 'removed', 'it is marked removed with the reason');
  ok((await q('anon', null, 'select public.get_public_piece($1) r', [p1])).rows[0].r === null, 'a removed piece no longer opens publicly');
  ok(!(await q('anon', null, 'select public.list_public_pieces() r')).rows[0].r.some((x) => x.id === p1), 'a removed piece disappears from the public list');
  ok((await q('anon', null, 'select count(*)::int n from public.pieces where id=$1', [p1])).rows[0].n === 0, 'a removed piece cannot be read directly either');
  ok((await pg.query("select status from public.reports where piece_id=$1", [p1])).rows.every((r) => r.status === 'actioned'), 'open reports on it are marked actioned');
  const mine = (await q('authenticated', A, 'select public.my_pieces() r')).rows[0].r.find((x) => x.id === p1);
  ok(mine && mine.status === 'removed' && mine.removed_reason === 'Breaks the rules', 'the author sees it as removed, with the reason');
  ok(await fails('authenticated', A, 'select public.append_batch($1,1,$2::jsonb,$3::jsonb)', [p1, '[]', J([{ t: 1, text: 'x' }])], /already published/), 'a removed piece cannot be edited');
  ok((await pg.query('select public.admin_restore_piece($1) r', [p1])).rows[0].r === true && (await q('anon', null, 'select public.get_public_piece($1) r', [p1])).rows[0].r !== null, 'you can restore it');
  ok((await pg.query('select public.admin_remove_piece($1,$2) r', [d1.rows[0].id, 'x'])).rows[0].r === false, 'drafts cannot be "removed"');
  await q('anon', null, 'select public.report_piece($1,$2)', [p1, 'spam']);
  ok((await pg.query('select public.admin_dismiss_reports($1) n', [p1])).rows[0].n === 1, 'you can dismiss reports');

  /* limits */
  const E = '44444444-4444-4444-4444-444444444444';
  await pg.exec(`insert into auth.users (id,email) values ('${E}','e@x.com')`);
  let made = 0, err = '';
  for (let i = 0; i < 20; i++) { try { await q('authenticated', E, 'select public.create_piece($1)', ['t' + i]); made++; } catch (e) { err = e.message; break; } }
  ok(made === 15 && /too many new pieces/.test(err), 'at most 15 new pieces in an hour (got ' + made + ')');
  const F = '55555555-5555-5555-5555-555555555555';
  await pg.exec(`insert into auth.users (id,email) values ('${F}','f@x.com')`);
  let pubd = 0, perr = '';
  for (let i = 0; i < 22; i++) {
    try {
      if (i % 10 === 0) await pg.query("update public.pieces set created_at = now() - interval '3 hours' where author_id=$1", [F]);
      await publishOne(F, 'p' + i, 'word ' + i); pubd++;
    } catch (e) { perr = e.message; break; }
  }
  ok(pubd === 20 && /daily publishing limit/.test(perr), 'at most 20 publishes in a day (got ' + pubd + ')');

  /* export and delete */
  const ex = (await q('authenticated', A, 'select public.export_my_data() r')).rows[0].r;
  ok(ex.profile.display_name === 'Ada' && ex.pieces.length === 2 && ex.pieces.some((p) => p.final_text === 'Some words here.' && p.batches.length === 1), 'export includes the profile, final text and recording batches');
  ok(!ex.pieces.some((p) => p.title === 'Two'), "export contains only the caller's own data");
  ok(await fails('anon', null, 'select public.export_my_data()', [], /permission denied/), 'export needs sign-in');
  await q('anon', null, 'select public.report_piece($1,$2)', [p2, 'spam']);
  await q('authenticated', B, 'select public.report_piece($1,$2)', [p1, 'spam']);
  ok((await q('authenticated', A, 'select public.delete_my_account() r')).rows[0].r === true, 'account deletion succeeds');
  const left = async (t, col, id) => (await pg.query(`select count(*)::int n from ${t} where ${col}=$1`, [id])).rows[0].n;
  ok((await left('public.profiles', 'id', A)) === 0 && (await left('public.pieces', 'author_id', A)) === 0, 'profile and pieces are gone');
  ok((await pg.query("select count(*)::int n from public.piece_batches where piece_id=$1", [p1])).rows[0].n === 0, 'the recording batches are gone');
  ok((await left('public.reports', 'piece_id', p1)) === 0, 'reports about the deleted pieces are gone');
  ok((await left('public.pieces', 'author_id', B)) >= 2, "other people's pieces are untouched");
  ok(await fails('anon', null, 'select public.delete_my_account()', [], /permission denied/), 'account deletion needs sign-in');
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
