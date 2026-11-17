const path = require('path'), fs = require('fs');
const { PGlite } = require('@electric-sql/pglite');
const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const shim = require('./shim');
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const pg = new PGlite(); await pg.exec(shim); await pg.exec(schema);
  let again = true; try { await pg.exec(schema); } catch (e) { again = false; console.log(e.message); }
  ok(again, 'schema with visibility runs twice without errors');
  const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
  await pg.exec(`insert into auth.users (id,email,raw_user_meta_data) values ('${A}','a@x.com','{"display_name":"Ada"}'),('${B}','b@x.com','{"display_name":"Bo"}')`);
  async function as(role, uid, fn) { await pg.exec(`set role ${role}; select set_config('request.jwt.claim.sub','${uid || ''}', false);`); try { return await fn(); } finally { await pg.exec('reset role'); } }
  const q = (role, uid, sql, p) => as(role, uid, () => pg.query(sql, p || []));
  async function fails(role, uid, sql, p, re) { try { await q(role, uid, sql, p); return false; } catch (e) { return re ? re.test(e.message) : true; } }
  const P1 = 'aaaaaaaa-0000-4000-8000-000000000001', P2 = 'aaaaaaaa-0000-4000-8000-000000000002', PD = 'aaaaaaaa-0000-4000-8000-000000000003';
  const W1 = 'bbbbbbbb-0000-4000-8000-000000000001', W2 = 'bbbbbbbb-0000-4000-8000-000000000002';
  await pg.exec(`insert into public.pieces (id, author_id, title, status, published_at, final_text, word_count) values
    ('${P1}','${A}','Open piece','published', now(), 'x', 1),
    ('${P2}','${A}','Link piece','published', now(), 'y', 1),
    ('${PD}','${A}','Draft piece','draft', null, null, null)`);
  await pg.exec(`insert into public.works (id, author_id, kind, title, status, published_at) values
    ('${W1}','${A}','art','Open art','published', now()), ('${W2}','${A}','music','Link song','published', now())`);
  await pg.exec(`insert into public.work_items (work_id, seq, role, path, filename, mime, bytes, sha256, received_at, prev_hash, hash)
    values ('${W2}',1,'final','${A}/${W2}/f.mp3','f.mp3','audio/mpeg',10,repeat('a',64),now(),repeat('0',64),repeat('b',64))`);

  ok((await pg.query(`select visibility v from public.pieces where id='${P1}'`)).rows[0].v === 'public', 'pieces are public by default');
  ok((await pg.query(`select visibility v from public.works where id='${W1}'`)).rows[0].v === 'public', 'works are public by default');
  ok((await pg.query(`select visibility v from public.profiles where id='${A}'`)).rows[0].v === 'public', 'profiles are public by default');

  // who may change visibility
  ok(await fails('anon', null, `select public.set_visibility('piece','${P2}','unlisted')`, [], /not signed in|permission denied/), 'signed-out visitors cannot change visibility');
  ok(await fails('authenticated', B, `select public.set_visibility('piece','${P2}','unlisted')`, [], /Not found/), "you cannot change someone else's piece");
  ok(await fails('authenticated', B, `select public.set_visibility('work','${W2}','unlisted')`, [], /Not found/), "you cannot change someone else's work");
  ok(await fails('authenticated', A, `select public.set_visibility('piece','${P2}','secret')`, [], /public or unlisted/), 'only public or unlisted are accepted');
  ok(await fails('authenticated', A, `select public.set_visibility('blog','${P2}','unlisted')`, [], /Unknown kind/), 'unknown kinds are refused');
  ok((await q('authenticated', A, `select public.set_visibility('piece','${P2}','unlisted') r`)).rows[0].r === 'unlisted', 'the owner can make a published piece unlisted');
  ok((await q('authenticated', A, `select public.set_visibility('work','${W2}','unlisted') r`)).rows[0].r === 'unlisted', 'the owner can make a published work unlisted');
  ok((await q('authenticated', A, `select public.set_visibility('piece','${PD}','unlisted') r`)).rows[0].r === 'unlisted', 'a draft can be set before publishing');
  ok(await fails('authenticated', A, `select public.set_visibility('piece','${PD}','nope')`, [], /public or unlisted/), 'bad value on a draft is refused');

  // browse and lists leave unlisted items out
  const lp = (await q('anon', null, `select public.list_public_pieces(50,0) r`)).rows[0].r;
  ok(lp.length === 1 && lp[0].id === P1, 'Browse lists only public pieces');
  const lw = (await q('anon', null, `select public.list_public_works(null,50,0) r`)).rows[0].r;
  ok(lw.length === 1 && lw[0].id === W1, 'Browse lists only public works');
  ok((await q('anon', null, `select public.list_public_works('music',50,0) r`)).rows[0].r.length === 0, 'an unlisted work is missing from its kind filter too');

  // the link still works for anyone
  const gp = (await q('anon', null, `select public.get_public_piece('${P2}') r`)).rows[0].r;
  ok(gp && gp.title === 'Link piece' && gp.visibility === 'unlisted' && gp.mine === false, 'anyone with the link can open an unlisted piece');
  ok(gp.verification.chain_ok === true, 'its record still checks out');
  const gw = (await q('anon', null, `select public.get_work('${W2}') r`)).rows[0].r;
  ok(gw && gw.visibility === 'unlisted' && gw.items.length === 1, 'anyone with the link can open an unlisted work and its files list');
  ok((await q('authenticated', A, `select public.get_public_piece('${P2}') r`)).rows[0].r.mine === true, 'the owner is told it is theirs');
  ok((await q('anon', null, `select public.get_public_piece('${PD}') r`)).rows[0].r === null, 'drafts still do not open');
  ok((await q('anon', null, `select public.work_file_is_published('${A}/${W2}/f.mp3') r`)).rows[0].r === true, 'the files of an unlisted work can be read with the link');

  // direct table reads can no longer find unlisted items
  ok((await q('anon', null, `select id from public.pieces`)).rows.map((x) => x.id).join() === P1, 'listing the pieces table shows only public ones');
  ok((await q('anon', null, `select id from public.works`)).rows.map((x) => x.id).join() === W1, 'listing the works table shows only public ones');
  ok((await q('anon', null, `select id from public.work_items`)).rows.length === 0, 'file rows of an unlisted work are not listable');
  ok((await q('authenticated', A, `select id from public.pieces order by title`)).rows.length === 3, 'the owner still sees all their own pieces');
  ok((await q('authenticated', B, `select id from public.pieces`)).rows.length === 1, 'other signed-in users see only public ones');

  // the owner's lists show the setting
  const mp = (await q('authenticated', A, `select public.my_pieces() r`)).rows[0].r;
  ok(mp.find((x) => x.id === P2).visibility === 'unlisted' && mp.find((x) => x.id === P1).visibility === 'public', 'my pieces carries visibility');
  const mw = (await q('authenticated', A, `select public.my_works() r`)).rows[0].r;
  ok(mw.find((x) => x.id === W2).visibility === 'unlisted', 'my works carries visibility');

  // switching back
  await q('authenticated', A, `select public.set_visibility('piece','${P2}','public')`);
  ok((await q('anon', null, `select public.list_public_pieces(50,0) r`)).rows[0].r.length === 2, 'making it public lists it again');
  await q('authenticated', A, `select public.set_visibility('piece','${P2}','unlisted')`);

  // removed items cannot be changed by their owner
  await pg.exec(`update public.works set status='removed' where id='${W1}'`);
  ok(await fails('authenticated', A, `select public.set_visibility('work','${W1}','unlisted')`, [], /Not found/), 'a removed work cannot be changed');
  await pg.exec(`update public.works set status='published' where id='${W1}'`);

  // feedback works on unlisted items
  ok((await q('authenticated', B, `select public.set_reaction('work','${W2}',1) r`)).rows[0].r.up === 1, 'people with the link can react to an unlisted work');
  ok((await q('authenticated', B, `select public.add_comment('piece','${P2}','nice') r`)).rows[0].r.id, 'and comment on an unlisted piece');

  // profile visibility
  ok(await fails('anon', null, `select public.set_profile_visibility('link')`, [], /not signed in|permission denied/), 'signed-out visitors cannot change a profile');
  ok(await fails('authenticated', A, `select public.set_profile_visibility('hidden')`, [], /public or link/), 'only public or link are accepted for a profile');
  ok((await q('authenticated', A, `select public.get_my_profile() r`)).rows[0].r.visibility === 'public', 'my profile reports its visibility');
  // Bo comments, then goes link-only
  ok((await q('anon', null, `select public.get_feedback('piece','${P2}') r`)).rows[0].r.comments[0].author_id === B, 'a public profile is linked from its comments');
  ok((await q('authenticated', B, `select public.set_profile_visibility('link') r`)).rows[0].r === 'link', 'a profile can be made link-only');
  const fb = (await q('anon', null, `select public.get_feedback('piece','${P2}') r`)).rows[0].r;
  ok(fb.comments[0].author === 'Bo' && fb.comments[0].author_id === null, 'a link-only profile keeps its name on comments but is not linked');
  ok((await q('anon', null, `select count(*)::int n from public.profiles where id='${B}'`)).rows[0].n === 0, 'a link-only profile cannot be found by listing profiles');
  ok((await q('authenticated', B, `select count(*)::int n from public.profiles where id='${B}'`)).rows[0].n === 1, 'but its owner can read it');
  const pp = (await q('anon', null, `select public.get_public_profile('${B}') r`)).rows[0].r;
  ok(pp && pp.name === 'Bo' && pp.visibility === 'link', 'the page still opens for someone with the address');
  // Ada goes link-only: her public pieces are unlinked in Browse and on piece pages
  await q('authenticated', A, `select public.set_profile_visibility('link')`);
  ok((await q('anon', null, `select public.get_public_piece('${P1}') r`)).rows[0].r.author_id === null, 'a link-only author is not linked from their piece');
  ok((await q('anon', null, `select public.list_public_pieces(50,0) r`)).rows[0].r[0].author_id === null, 'nor from Browse rows');
  const ap = (await q('anon', null, `select public.get_public_profile('${A}') r`)).rows[0].r;
  ok(ap.pieces.length === 1 && ap.pieces[0].id === P1 && ap.works.length === 1 && ap.works[0].id === W1, 'the writer page lists only public pieces and works, never unlisted ones');
  ok((await q('authenticated', A, `select public.get_public_profile('${A}') r`)).rows[0].r.mine === true, 'the owner is told it is their page');

  // export
  const ex = (await q('authenticated', A, `select public.export_my_data() r`)).rows[0].r;
  ok(ex.pieces.find((p) => p.id === P2).visibility === 'unlisted' && ex.works.find((w) => w.id === W2).visibility === 'unlisted' && ex.profile.visibility === 'link', 'the data export includes the visibility settings');

  // the artists directory (Ada is link-only by now, Bo is link-only too: nobody is listed)
  ok((await q('anon', null, `select public.list_creators(null,24,0) r`)).rows[0].r.length === 0, 'artists: link-only profiles are not listed');
  await q('authenticated', A, `select public.set_profile_visibility('public')`);
  const cr = (await q('anon', null, `select public.list_creators(null,24,0) r`)).rows[0].r;
  ok(cr.length === 1 && cr[0].id === A && cr[0].name === 'Ada', 'artists: a public profile with public work is listed');
  ok(cr[0].writing === 1 && cr[0].art === 1 && cr[0].music === 0, 'artists: counts only public work (the unlisted song is not counted)');
  ok((await q('anon', null, `select public.list_creators('music',24,0) r`)).rows[0].r.length === 0, 'artists: filtering by a kind with no public work finds nobody');
  ok((await q('anon', null, `select public.list_creators('art',24,0) r`)).rows[0].r.length === 1, 'artists: filtering by art finds her');
  ok((await q('anon', null, `select public.list_creators('writing',24,0) r`)).rows[0].r.length === 1, 'artists: filtering by writing finds her');
  ok((await q('anon', null, `select public.list_creators('nonsense',24,0) r`)).rows[0].r.length === 0, 'artists: an unknown kind finds nobody');
  await pg.exec(`update public.profiles set bio = repeat('x', 300) where id = '${A}'`);
  ok((await q('anon', null, `select public.list_creators(null,24,0) r`)).rows[0].r[0].bio.length === 140, 'artists: bios are cut to 140 characters');
  await q('authenticated', B, `select public.set_profile_visibility('public')`);
  ok((await q('anon', null, `select public.list_creators(null,24,0) r`)).rows[0].r.length === 1, 'artists: someone with no published work is not listed');
  await q('authenticated', A, `select public.set_visibility('piece','${P1}','unlisted')`); await q('authenticated', A, `select public.set_visibility('work','${W1}','unlisted')`);
  ok((await q('anon', null, `select public.list_creators(null,24,0) r`)).rows[0].r.length === 0, 'artists: when all her work is link-only she drops off the list');
  ok((await q('anon', null, `select public.list_creators(null,1,0) r`)).rows[0].r.length === 0 && (await q('anon', null, `select public.list_creators(null,0,-5) r`)).rows[0].r.length === 0, 'artists: odd paging values do not break it');

  // the helper is not callable from outside
  ok(await fails('anon', null, `select public.listed_author('${A}')`, [], /permission denied/), 'internal helper is not exposed');
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
