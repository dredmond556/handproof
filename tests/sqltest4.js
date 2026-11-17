const path = require('path'), fs = require('fs');
const { PGlite } = require('@electric-sql/pglite');
const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const shim = require('./shim');
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const pg = new PGlite(); await pg.exec(shim); await pg.exec(schema);
  let again = true; try { await pg.exec(schema); } catch (e) { again = false; console.log(e.message); }
  ok(again, 'schema with feedback runs twice without errors');
  const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222', C = '33333333-3333-3333-3333-333333333333';
  await pg.exec(`insert into auth.users (id,email,raw_user_meta_data) values ('${A}','a@x.com','{"display_name":"Ada"}'),('${B}','b@x.com','{"display_name":"Bo"}'),('${C}','c@x.com','{"display_name":"Cy"}')`);
  async function as(role, uid, fn) { await pg.exec(`set role ${role}; select set_config('request.jwt.claim.sub','${uid || ''}', false);`); try { return await fn(); } finally { await pg.exec('reset role'); } }
  const q = (role, uid, sql, p) => as(role, uid, () => pg.query(sql, p || []));
  async function fails(role, uid, sql, p, re) { try { await q(role, uid, sql, p); return false; } catch (e) { return re ? re.test(e.message) : true; } }
  // a published piece by A, a draft piece by A, and a published work by A
  await pg.exec(`insert into public.pieces (id, author_id, title, status, published_at, final_text, word_count) values
    ('aaaaaaaa-0000-4000-8000-000000000001','${A}','Pub','published', now(), 'x', 1),
    ('aaaaaaaa-0000-4000-8000-000000000002','${A}','Draft','draft', null, null, null)`);
  await pg.exec(`insert into public.works (id, author_id, kind, title, status, published_at) values ('bbbbbbbb-0000-4000-8000-000000000001','${A}','art','Art','published', now())`);
  const P = 'aaaaaaaa-0000-4000-8000-000000000001', D = 'aaaaaaaa-0000-4000-8000-000000000002', W = 'bbbbbbbb-0000-4000-8000-000000000001';

  ok(await fails('anon', null, `select public.set_reaction('piece','${P}',1)`, [], /not signed in|permission denied/), 'signed-out visitors cannot react');
  ok(await fails('anon', null, `select public.add_comment('piece','${P}','hi')`, [], /not signed in|permission denied/), 'signed-out visitors cannot comment');
  ok(await fails('authenticated', B, `select public.set_reaction('piece','${P}',5)`, [], /bad reaction/), 'only up, down or clear are accepted');
  ok(await fails('authenticated', B, `select public.set_reaction('piece','${D}',1)`, [], /not found/), 'drafts cannot be reacted to');
  ok(await fails('authenticated', B, `select public.add_comment('piece','${D}','hi')`, [], /not found/), 'drafts cannot be commented on');
  ok(await fails('authenticated', B, `select public.set_reaction('blog','${P}',1)`, [], /not found/), 'unknown target kinds are refused');

  let r = (await q('authenticated', B, `select public.set_reaction('piece','${P}',1) r`)).rows[0].r;
  ok(r.up === 1 && r.down === 0 && r.mine === 1, 'a thumbs up counts');
  r = (await q('authenticated', B, `select public.set_reaction('piece','${P}',1) r`)).rows[0].r;
  ok(r.up === 1, 'repeating it does not double count');
  r = (await q('authenticated', B, `select public.set_reaction('piece','${P}',-1) r`)).rows[0].r;
  ok(r.up === 0 && r.down === 1 && r.mine === -1, 'switching to thumbs down moves the vote');
  await q('authenticated', C, `select public.set_reaction('piece','${P}',1)`);
  let f = (await q('anon', null, `select public.get_feedback('piece','${P}') r`)).rows[0].r;
  ok(f.up === 1 && f.down === 1 && f.mine === null && f.can_moderate === false, 'anyone can read the counts; a stranger has no vote of their own');
  f = (await q('authenticated', B, `select public.get_feedback('piece','${P}') r`)).rows[0].r;
  ok(f.mine === -1, 'a signed-in reader sees their own vote');
  r = (await q('authenticated', B, `select public.set_reaction('piece','${P}',0) r`)).rows[0].r;
  ok(r.down === 0 && r.up === 1, 'clearing a vote removes it');
  await q('authenticated', B, `select public.set_reaction('work','${W}',1)`);
  ok((await q('anon', null, `select public.get_feedback('work','${W}') r`)).rows[0].r.up === 1, 'works take reactions too, counted separately');
  ok((await q('anon', null, `select public.get_feedback('piece','${D}') r`)).rows[0].r === null, 'feedback on a draft is not readable');

  // comments
  ok(await fails('authenticated', B, `select public.add_comment('piece','${P}','   ')`, [], /Write something/), 'empty comments are refused');
  ok(await fails('authenticated', B, `select public.add_comment('piece','${P}',$1)`, ['x'.repeat(1001)], /at most 1000/), 'long comments are refused');
  const t0 = Date.now();
  const c1 = (await q('authenticated', B, `select public.add_comment('piece','${P}','First thoughts') r`)).rows[0].r.id;
  await pg.exec(`update public.comments set created_at = now() - interval '3 hours' where id='${c1}'`);
  const c2 = (await q('authenticated', C, `select public.add_comment('piece','${P}','Lovely pacing') r`)).rows[0].r.id;
  await pg.exec(`update public.comments set created_at = now() - interval '1 hour' where id='${c2}'`);
  const c3 = (await q('authenticated', A, `select public.add_comment('piece','${P}','Thanks both') r`)).rows[0].r.id;
  ok(await fails('authenticated', A, `select public.add_comment('piece','${P}','Thanks both')`, [], /already posted/), 'an identical comment is refused');
  f = (await q('anon', null, `select public.get_feedback('piece','${P}') r`)).rows[0].r;
  ok(f.total === 3 && f.comments.length === 3, 'strangers can read comments');
  ok(f.comments.map((c) => c.body).join('|') === 'Thanks both|Lovely pacing|First thoughts', 'default order is newest first');
  f = (await q('anon', null, `select public.get_feedback('piece','${P}','oldest') r`)).rows[0].r;
  ok(f.comments.map((c) => c.body).join('|') === 'First thoughts|Lovely pacing|Thanks both', 'oldest first works');
  f = (await q('anon', null, `select public.get_feedback('piece','${P}','oldest',2,1) r`)).rows[0].r;
  ok(f.comments.length === 2 && f.comments[0].body === 'Lovely pacing' && f.total === 3, 'paging returns the right slice and the total');
  ok(f.comments.every((c) => !('votes' in c) && !('up' in c) && !('score' in c)), 'comments carry no votes');
  f = (await q('authenticated', B, `select public.get_feedback('piece','${P}') r`)).rows[0].r;
  ok(f.comments.filter((c) => c.mine).length === 1 && f.can_moderate === false, 'your own comments are marked as yours');
  f = (await q('authenticated', A, `select public.get_feedback('piece','${P}') r`)).rows[0].r;
  ok(f.can_moderate === true, 'the owner of the piece can moderate its comments');

  // deleting
  ok(await fails('authenticated', C, `select public.delete_comment('${c1}')`, [], /not allowed/), "you can't delete someone else's comment");
  ok((await q('authenticated', B, `select public.delete_comment('${c1}') r`)).rows[0].r === true, 'you can delete your own comment');
  ok((await q('authenticated', A, `select public.delete_comment('${c2}') r`)).rows[0].r === true, 'the owner can delete a comment on their piece');
  ok((await pg.query(`select count(*)::int n from public.comments`)).rows[0].n === 1, 'only the remaining comment is left');

  // reporting and takedown
  ok(await fails('anon', null, `select public.report_comment('${c3}','bogus')`, [], /unknown reason/), 'comment reports need a valid reason');
  await q('anon', null, `select public.report_comment('${c3}','spam','buy now')`);
  ok((await pg.query(`select count(*)::int n from public.reports where comment_id='${c3}' and piece_id is null and work_id is null`)).rows[0].n === 1, 'a comment report is stored against the comment');
  ok(await fails('anon', null, `select public.admin_remove_comment('${c3}','x')`, [], /permission denied/), 'the public cannot hide comments');
  await pg.query(`select public.admin_remove_comment('${c3}','spam')`);
  ok((await q('anon', null, `select public.get_feedback('piece','${P}') r`)).rows[0].r.total === 0, 'a hidden comment disappears from the page');
  ok((await pg.query(`select status from public.reports where comment_id='${c3}'`)).rows[0].status === 'actioned', 'hiding it closes the report');
  await pg.query(`select public.admin_restore_comment('${c3}')`);
  ok((await q('anon', null, `select public.get_feedback('piece','${P}') r`)).rows[0].r.total === 1, 'restoring brings it back');

  // limits
  for (let i = 0; i < 20; i++) await q('authenticated', B, `select public.add_comment('work','${W}',$1)`, ['note ' + i]);
  ok(await fails('authenticated', B, `select public.add_comment('work','${W}','one more')`, [], /fast|a lot of comments/), 'comment flooding is limited');

  // removed targets hide their feedback
  await pg.exec(`update public.pieces set status='removed' where id='${P}'`);
  ok((await q('anon', null, `select public.get_feedback('piece','${P}') r`)).rows[0].r === null, "a removed piece's feedback is hidden");
  ok(await fails('authenticated', C, `select public.add_comment('piece','${P}','late')`, [], /not found/), 'you cannot comment on a removed piece');

  // export and deletion
  const ex = (await q('authenticated', B, `select public.export_my_data() r`)).rows[0].r;
  ok(ex.comments.length === 20 && ex.reactions.length >= 1, 'data export includes your comments and reactions');
  await pg.exec(`delete from auth.users where id='${B}'`);
  ok((await pg.query(`select count(*)::int n from public.comments where author_id='${B}'`)).rows[0].n === 0 && (await pg.query(`select count(*)::int n from public.reactions where user_id='${B}'`)).rows[0].n === 0, 'deleting an account removes its comments and reactions');
  ok((await pg.query(`select count(*)::int n from public.comments where author_id='${A}'`)).rows[0].n === 1, "other people's comments are untouched");
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
