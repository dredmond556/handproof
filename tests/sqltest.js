const path = require('path');
const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');

const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const shim = require('./shim');

let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }

(async () => {
  const pg = new PGlite();
  await pg.exec(shim);
  await pg.exec(schema);
  ok(true, 'schema applies cleanly');

  const A = '11111111-1111-1111-1111-111111111111';
  const B = '22222222-2222-2222-2222-222222222222';
  await pg.exec(`insert into auth.users (id,email,raw_user_meta_data) values
    ('${A}','ada@example.com','{"display_name":"Ada"}'),
    ('${B}','bob@example.com','{}')`);
  const profs = (await pg.query('select id, display_name from public.profiles order by display_name')).rows;
  ok(profs.length === 2 && profs.some((p) => p.display_name === 'Ada') && profs.some((p) => p.display_name === 'bob'), 'sign-up trigger creates profiles (display name, or email prefix as fallback)');

  async function as(role, uid, fn) {
    await pg.exec(`set role ${role}; select set_config('request.jwt.claim.sub','${uid || ''}', false);`);
    try { return await fn(); } finally { await pg.exec('reset role'); }
  }
  async function fails(role, uid, sql, params, re) {
    try { await as(role, uid, () => pg.query(sql, params)); return false; }
    catch (e) { return re ? re.test(e.message) : true; }
  }
  const J = (x) => JSON.stringify(x);

  /* ---- who can call what ---- */
  ok(await fails('anon', null, 'select public.create_piece($1)', ['x'], /permission denied/), 'signed-out visitors cannot create a piece');
  ok(await fails('anon', null, 'select public.my_pieces()', [], /permission denied/), 'signed-out visitors cannot list private pieces');
  ok(await fails('anon', null, 'select public.append_batch($1,1,$2,$3)', [A, '[]', '[]'], /permission denied/), 'signed-out visitors cannot record edits');
  ok(await fails('authenticated', null, 'select public.create_piece($1)', ['x'], /not signed in/), 'a session without a user id is rejected');

  /* ---- record a piece ---- */
  const pid = (await as('authenticated', A, () => pg.query('select public.create_piece($1) as id', ['  First  '])))
    .rows[0].id;
  ok(/^[0-9a-f-]{36}$/.test(pid), 'create_piece returns an id');
  await pg.exec(`update public.pieces set created_at = now() - interval '60 seconds' where id = '${pid}'`);

  const append = (uid, id, claimed, series, snaps, title) =>
    as('authenticated', uid, async () => (await pg.query('select public.append_batch($1,$2,$3::jsonb,$4::jsonb,$5) as r', [id, claimed, J(series), J(snaps), title || null])).rows[0].r);

  const r1 = await append(A, pid, 40000,
    [[0, 0, 0], [1000, 10, 0], [2000, 25, 0], [3000, 20, 0]],
    [{ t: 1, text: 'hello world' }], 'My Title');
  ok(r1.seq === 1 && r1.suspect === false && /^[0-9a-f]{64}$/.test(r1.hash), 'honest batch is accepted, numbered 1 and not flagged');
  ok((await pg.query('select title from public.pieces where id=$1', [pid])).rows[0].title === 'My Title', 'title is updated from the batch');

  const r2 = await append(A, pid, 10800000, [[4000, 30, 0]], [{ t: 4, text: 'hello world again' }]);
  ok(r2.seq === 2 && r2.suspect === true, 'a batch claiming 3 hours of writing in a moment is flagged as suspect');

  const r3 = await append(A, pid, 1500,
    [[5000, 60, 0], [5200, 160, 100], [6000, 150, 0]],
    [{ t: 5, text: 'hello world again and again ' + 'x'.repeat(100), paste: 100 }, { t: 6, text: 'The final text of the piece, as written.' }]);
  ok(r3.seq === 3 && r3.suspect === false, 'a small, plausible batch right after is not flagged');
  ok(r1.hash !== r2.hash && r2.hash !== r3.hash, 'each batch has its own hash');

  /* ---- other people ---- */
  ok(await fails('authenticated', B, 'select public.append_batch($1,1000,$2::jsonb,$3::jsonb)', [pid, J([[0, 0, 0]]), '[]'], /piece not found/), 'another user cannot append to my piece');
  ok(await fails('authenticated', B, 'select public.publish_piece($1)', [pid], /piece not found/), 'another user cannot publish my piece');
  ok(await as('authenticated', B, async () => (await pg.query('select * from public.pieces')).rows.length) === 0, 'another user cannot see my draft');
  ok(await as('anon', null, async () => (await pg.query('select * from public.pieces')).rows.length) === 0, 'the public cannot see my draft');
  ok(await as('anon', null, async () => (await pg.query('select * from public.piece_batches')).rows.length) === 0, 'the public cannot see my draft’s recorded batches');
  ok((await as('anon', null, async () => (await pg.query('select public.verify_chain($1) as v', [pid])).rows[0].v)) === null, 'verify_chain on a private draft reveals nothing');
  ok((await as('anon', null, async () => (await pg.query('select public.get_public_piece($1) as p', [pid])).rows[0].p)) === null, 'get_public_piece on a draft returns nothing');

  /* ---- bad input ---- */
  ok(await fails('authenticated', A, 'select public.append_batch($1,1000,$2::jsonb,$3::jsonb)', [pid, J([[1, 2]]), '[]'], /bad series point/), 'malformed series point is rejected');
  ok(await fails('authenticated', A, 'select public.append_batch($1,1000,$2::jsonb,$3::jsonb)', [pid, J([[1, -2, 0]]), '[]'], /bad series point/), 'negative values are rejected');
  ok(await fails('authenticated', A, 'select public.append_batch($1,1000,$2::jsonb,$3::jsonb)', [pid, '[]', J([{ t: 1 }])], /bad snapshot/), 'snapshot without text is rejected');
  ok(await fails('authenticated', A, 'select public.append_batch($1,1000,$2::jsonb,$3::jsonb)', [pid, J(Array.from({ length: 3001 }, (_, i) => [i, 1, 0])), '[]'], /batch too large/), 'oversized batch is rejected');
  ok(await fails('authenticated', A, 'select public.append_batch($1,-5,$2::jsonb,$3::jsonb)', [pid, J([[1, 1, 0]]), '[]'], /bad duration/), 'negative claimed duration is rejected');
  ok(await fails('authenticated', A, 'select public.append_batch($1,1000,$2::jsonb,$3::jsonb)', [pid, '[]', '[]'], /empty batch/), 'empty batch is rejected');
  ok(await fails('authenticated', A, 'select public.append_batch($1,1000,$2::jsonb,$3::jsonb)', [pid, '{}', '[]'], /bad payload/), 'non-array payload is rejected');

  /* ---- publish ---- */
  const pub = await as('authenticated', A, async () => (await pg.query('select public.publish_piece($1, $2) as r', [pid, null])).rows[0].r);
  ok(pub.word_count === 8,'word count comes from the final snapshot (' + pub.word_count + ')');
  ok(pub.deletions === 2, 'deletions derived from the log (' + pub.deletions + ')');
  ok(Number(pub.pasted_chars) === 100 && pub.paste_events === 1, 'paste totals derived from the log (' + pub.pasted_chars + ' chars, ' + pub.paste_events + ' event)');
  ok(pub.active_seconds === 6, 'active time derived from the log (' + pub.active_seconds + ' s)');
  const row = (await pg.query('select * from public.pieces where id=$1', [pid])).rows[0];
  ok(row.status === 'published' && row.final_text === 'The final text of the piece, as written.', 'piece is published with the last snapshot as its text');
  ok(row.replay.snapshots.length === 4 && row.replay.series.length === 8 && row.band_times.length === 4 && row.spark.length === 8, 'replay, spark and band times are built');
  ok(row.replay.snapshots.find((s) => s.paste === 100) !== undefined, 'the paste snapshot is kept in the replay');

  /* ---- locked after publishing ---- */
  ok(await fails('authenticated', A, 'select public.append_batch($1,1000,$2::jsonb,$3::jsonb)', [pid, J([[1, 1, 0]]), '[]'], /already published/), 'a published piece cannot take more batches');
  ok(await fails('authenticated', A, 'select public.publish_piece($1)', [pid], /already published/), 'a piece cannot be published twice');
  ok(await fails('authenticated', A, "update public.pieces set title='hacked' where id=$1", [pid], /permission denied/), 'direct UPDATE on pieces is denied');
  ok(await fails('authenticated', A, 'delete from public.piece_batches', [], /permission denied/), 'direct DELETE on batches is denied');
  ok(await fails('authenticated', A, "update public.piece_batches set suspect=false", [], /permission denied/), 'direct UPDATE on batches is denied');
  ok(await fails('authenticated', A, "insert into public.pieces (author_id,title) values ($1,'x')", [A], /permission denied/), 'direct INSERT on pieces is denied');
  ok(await fails('authenticated', A, "update public.profiles set id=$1", [B], /permission denied/), 'cannot change a profile id');
  ok(await fails('anon', null, "update public.profiles set display_name='x'", [], /permission denied/), 'the public cannot edit profiles');
  await as('authenticated', A, () => pg.query("update public.profiles set display_name='Ada L' where id=$1", [A]));
  await as('authenticated', B, () => pg.query("update public.profiles set display_name='Hacked' where id=$1", [A]));
  ok((await pg.query('select display_name from public.profiles where id=$1', [A])).rows[0].display_name === 'Ada L', 'users can edit only their own display name (row security)');

  /* ---- public reads ---- */
  const pub1 = await as('anon', null, async () => (await pg.query('select public.get_public_piece($1) as p', [pid])).rows[0].p);
  ok(pub1 && pub1.title === 'My Title' && pub1.author === 'Ada L', 'anyone can read a published piece, with the author’s display name');
  ok(pub1.verification.chain_ok === true && pub1.verification.batches === 3 && pub1.verification.suspect_batches === 1, 'verification reports an intact chain, 3 batches, 1 suspect');
  ok(pub1.verification.server_span_seconds >= 0 && /^[0-9a-f]{64}$/.test(pub1.verification.head_hash), 'verification includes the server time span and head hash');
  ok(pub1.replay.snapshots.length === 4 && pub1.pasted_chars === 100, 'replay and totals are returned');
  ok((await as('anon', null, async () => (await pg.query('select * from public.pieces')).rows.length)) === 1, 'the public can select the published piece');
  ok((await as('authenticated', B, async () => (await pg.query('select * from public.piece_batches')).rows.length)) === 3, 'anyone can read the batches of a published piece');

  const feed = await as('anon', null, async () => (await pg.query('select public.list_public_pieces(10, 0) as l')).rows[0].l);
  ok(feed.length === 1 && feed[0].author === 'Ada L' && feed[0].snapshot_count === 4 && feed[0].spark.length > 0 && feed[0].band_times.length === 4 && !('final_text' in feed[0]), 'the public feed returns light-weight cards without the full text');

  /* ---- tamper detection ---- */
  await pg.exec(`update public.piece_batches set series='[[0,0,0],[1,999999,0]]'::jsonb where piece_id='${pid}' and seq=2`);
  const tam = await as('anon', null, async () => (await pg.query('select public.get_public_piece($1) as p', [pid])).rows[0].p);
  ok(tam.verification.chain_ok === false, 'editing a stored batch after the fact breaks verification');

  /* ---- a second piece: delete, drafts limit, names ---- */
  const p2 = (await as('authenticated', A, () => pg.query("select public.create_piece('Second') as id"))).rows[0].id;
  ok((await as('authenticated', A, async () => (await pg.query('select public.my_pieces() as m')).rows[0].m)).length === 2, 'my_pieces lists drafts and published pieces');
  ok((await as('authenticated', B, async () => (await pg.query('select public.my_pieces() as m')).rows[0].m)).length === 0, 'my_pieces only lists my own');
  ok(await fails('authenticated', A, 'select public.publish_piece($1)', [p2], /nothing to publish/), 'publishing an empty piece is refused');
  ok((await as('authenticated', B, async () => (await pg.query('select public.delete_piece($1) as d', [p2])).rows[0].d)) === false, 'someone else cannot delete my piece');
  ok((await as('authenticated', A, async () => (await pg.query('select public.delete_piece($1) as d', [p2])).rows[0].d)) === true, 'I can delete my own piece');
  ok((await as('authenticated', A, async () => (await pg.query('select public.delete_piece($1) as d', [pid])).rows[0].d)) === true && (await pg.query('select count(*)::int c from public.piece_batches')).rows[0].c === 0, 'deleting a published piece also removes its batches');

  for (let i = 0; i < 25; i++) {
    await as('authenticated', B, () => pg.query("select public.create_piece('d')"));
    if (i % 10 === 9) await pg.query("update public.pieces set created_at = now() - interval '3 days' where author_id = $1 and status = 'draft'", [B]);  /* stay under the newer hourly creation limit */
  }
  ok(await fails('authenticated', B, "select public.create_piece('one too many')", [], /too many unfinished drafts/), 'unfinished drafts are limited to 25');
  await pg.exec("update public.pieces set created_at = now() - interval '15 days' where author_id = '" + B + "'");
  ok((await as('authenticated', B, async () => (await pg.query("select public.create_piece('fresh') as id")).rows[0].id)) !== undefined, 'drafts older than two weeks are cleared automatically');

  ok((await as('authenticated', A, async () => (await pg.query("select public.set_display_name('  Ada Lovelace ') as n")).rows[0].n)) === 'Ada Lovelace', 'display name can be changed and is trimmed');
  ok(await fails('authenticated', A, "select public.set_display_name('')", [], /name must be/), 'empty display name is refused');
  ok(await fails('authenticated', A, 'select public.set_display_name($1)', ['x'.repeat(61)], /name must be/), 'overlong display name is refused');

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('HARNESS ERROR', e.message); process.exit(2); });
