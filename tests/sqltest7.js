const path = require('path'), fs = require('fs');
const { PGlite } = require('@electric-sql/pglite');
const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const shim = require('./shim');
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const pg = new PGlite(); await pg.exec(shim); await pg.exec(schema);
  let again = true; try { await pg.exec(schema); } catch (e) { again = false; console.log(e.message); }
  ok(again, 'schema with blocking runs twice without errors');
  const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222', C = '33333333-3333-3333-3333-333333333333';
  await pg.exec(`insert into auth.users (id,email,raw_user_meta_data) values ('${A}','a@x.com','{"display_name":"Ada"}'),('${B}','b@x.com','{"display_name":"Bo"}'),('${C}','c@x.com','{"display_name":"Cy"}')`);
  async function as(role, uid, fn) { await pg.exec(`set role ${role}; select set_config('request.jwt.claim.sub','${uid || ''}', false);`); try { return await fn(); } finally { await pg.exec('reset role'); } }
  const q = (role, uid, sql, p) => as(role, uid, () => pg.query(sql, p || []));
  async function fails(role, uid, sql, p, re) { try { await q(role, uid, sql, p); return false; } catch (e) { return re ? re.test(e.message) : true; } }
  const P = 'aaaaaaaa-0000-4000-8000-000000000001', PB = 'aaaaaaaa-0000-4000-8000-000000000002', W = 'bbbbbbbb-0000-4000-8000-000000000001';
  await pg.exec(`insert into public.pieces (id, author_id, title, status, published_at, final_text, word_count) values ('${P}','${A}','Ada piece','published', now(),'x',1),('${PB}','${B}','Bo piece','published', now(),'y',1)`);
  await pg.exec(`insert into public.works (id, author_id, kind, title, status, published_at) values ('${W}','${B}','music','Bo song','published', now())`);
  await q('authenticated', B, `select public.add_comment('piece','${P}','Hello from Bo')`);
  await q('authenticated', C, `select public.add_comment('piece','${P}','Hello from Cy')`);
  const cb = (await pg.query(`select id from public.comments where author_id='${B}'`)).rows[0].id;

  ok(await fails('anon', null, `select public.block_user('${B}')`, [], /not signed in|permission denied/), 'blocking needs sign-in');
  ok(await fails('authenticated', A, `select public.block_user('${A}')`, [], /block yourself/), 'you cannot block yourself');
  ok(await fails('authenticated', A, `select public.block_user('99999999-9999-4999-8999-999999999999')`, [], /Not found/), 'blocking someone who does not exist is refused');
  ok(await fails('authenticated', A, `insert into public.blocks (blocker_id, blocked_id) values ('${A}','${B}')`, [], /permission denied/), 'the blocks table cannot be written directly');
  ok((await q('anon', null, `select public.list_public_pieces(10,0) r`)).rows[0].r.length === 2, 'before blocking, Ada sees both pieces in Browse');

  // block from a comment
  ok((await q('authenticated', A, `select public.block_comment_author('${cb}') r`)).rows[0].r.blocked === true, 'Ada can block a commenter from their comment');
  ok((await q('authenticated', A, `select public.block_comment_author('${cb}') r`)).rows[0].r.blocked === true, 'blocking twice is harmless');
  ok((await pg.query(`select count(*)::int n from public.blocks`)).rows[0].n === 1, 'and stores one block');
  ok(await fails('authenticated', A, `select public.block_comment_author('99999999-9999-4999-8999-999999999999')`, [], /Not found/), 'an unknown comment is refused');

  // effects on Ada
  const fb = (await q('authenticated', A, `select public.get_feedback('piece','${P}') r`)).rows[0].r;
  ok(fb.comments.length === 1 && fb.comments[0].author === 'Cy' && fb.total === 1, "Ada no longer sees Bo's comments, and the count agrees");
  ok((await q('authenticated', C, `select public.get_feedback('piece','${P}') r`)).rows[0].r.comments.length === 2, 'other people still see them');
  ok((await q('anon', null, `select public.get_feedback('piece','${P}') r`)).rows[0].r.comments.length === 2, 'signed-out visitors still see them');
  ok((await q('authenticated', A, `select public.list_public_pieces(10,0) r`)).rows[0].r.map((x) => x.id).join() === P, "Bo's pieces leave Ada's Browse");
  ok((await q('authenticated', A, `select public.list_public_works('music',10,0) r`)).rows[0].r.length === 0, "and Bo's works");
  ok((await q('authenticated', C, `select public.list_public_pieces(10,0) r`)).rows[0].r.length === 2, "but stay in everyone else's");
  const cr = (await q('authenticated', A, `select public.list_creators(null,24,0) r`)).rows[0].r;
  ok(!cr.some((c) => c.id === B), "Bo is missing from Ada's Artists page");
  ok((await q('authenticated', C, `select public.list_creators(null,24,0) r`)).rows[0].r.some((c) => c.id === B), "but present on others'");
  const prof = (await q('authenticated', A, `select public.get_public_profile('${B}') r`)).rows[0].r;
  ok(prof.blocked === true && prof.name === 'Bo', "Bo's page still opens by address and says you blocked them");
  ok(prof.works.length === 0, "and shows none of Bo's work to Ada");
  ok((await q('authenticated', C, `select public.get_public_profile('${B}') r`)).rows[0].r.blocked === false, 'others are not told anything');
  ok((await q('anon', null, `select public.get_public_piece('${PB}') r`)).rows[0].r.title === 'Bo piece', "Bo's piece still opens by link");

  // effects on Bo
  ok(await fails('authenticated', B, `select public.add_comment('piece','${P}','Let me in')`, [], /can't comment here/), "Bo can't comment on Ada's piece");
  ok((await q('authenticated', B, `select public.add_comment('piece','${PB}','On my own') r`)).rows[0].r.id, 'but can comment on their own and on other people’s');
  ok((await q('authenticated', B, `select public.get_feedback('piece','${P}') r`)).rows[0].r.comments.length === 2, "Bo's own view is unchanged, so nothing tells Bo they were blocked");
  ok((await q('authenticated', B, `select public.my_blocks() r`)).rows[0].r.length === 0, "and Bo's blocked list is empty");

  // the list, unblocking
  const mine = (await q('authenticated', A, `select public.my_blocks() r`)).rows[0].r;
  ok(mine.length === 1 && mine[0].name === 'Bo' && !('blocked_id' in mine[0]), 'Ada’s list names Bo without exposing an id');
  ok((await q('authenticated', B, `select public.unblock('${mine[0].id}') r`)).rows[0].r === false, "someone else can't remove Ada's block");
  const ex = (await q('authenticated', A, `select public.export_my_data() r`)).rows[0].r;
  ok(ex.blocked_people.length === 1 && ex.blocked_people[0].name === 'Bo', 'the data export includes blocked people');
  ok((await q('authenticated', A, `select public.unblock('${mine[0].id}') r`)).rows[0].r === true, 'Ada can unblock');
  ok((await q('authenticated', A, `select public.list_public_pieces(10,0) r`)).rows[0].r.length === 2 && (await q('authenticated', A, `select public.get_feedback('piece','${P}') r`)).rows[0].r.comments.length === 2, "unblocking brings Bo's work and comments back");
  ok((await q('authenticated', B, `select public.add_comment('piece','${P}','Thanks for unblocking') r`)).rows[0].r.id, 'and lets Bo comment again');

  // block from the page, with a link-only commenter
  await q('authenticated', C, `select public.set_profile_visibility('link')`);
  const cc = (await pg.query(`select id from public.comments where author_id='${C}'`)).rows[0].id;
  const seen = (await q('authenticated', A, `select public.get_feedback('piece','${P}') r`)).rows[0].r.comments.find((c) => c.author === 'Cy');
  ok(seen.author_id === null, 'a link-only commenter has no id in the comment list');
  ok((await q('authenticated', A, `select public.block_comment_author('${cc}') r`)).rows[0].r.blocked === true, 'Ada can still block them from the comment');
  ok((await q('authenticated', A, `select public.block_user('${B}') r`)).rows[0].r.blocked === true, 'and block from a page by id');
  ok((await q('authenticated', A, `select public.my_blocks() r`)).rows[0].r.length === 2, 'the list now has two people');

  // deleting an account removes its blocks
  await q('authenticated', A, `select public.delete_my_account()`);
  ok((await pg.query(`select count(*)::int n from public.blocks`)).rows[0].n === 0, 'deleting an account removes its blocks');
  await pg.exec(`insert into public.blocks (blocker_id, blocked_id) values ('${B}','${C}')`);
  await pg.exec(`delete from auth.users where id='${C}'`);
  ok((await pg.query(`select count(*)::int n from public.blocks`)).rows[0].n === 0, 'and blocks against a deleted account');
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
