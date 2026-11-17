const path = require('path'), fs = require('fs');
const { PGlite } = require('@electric-sql/pglite');
const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const shim = require('./shim');
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const pg = new PGlite(); await pg.exec(shim); await pg.exec(schema);
  let again = true; try { await pg.exec(schema); } catch (e) { again = false; console.log(e.message); }
  ok(again, 'schema with live takes runs twice without errors');
  const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
  await pg.exec(`insert into auth.users (id,email,raw_user_meta_data) values ('${A}','a@x.com','{"display_name":"Ada"}'),('${B}','b@x.com','{"display_name":"Bo"}')`);
  async function as(role, uid, fn) { await pg.exec(`set role ${role}; select set_config('request.jwt.claim.sub','${uid || ''}', false);`); try { return await fn(); } finally { await pg.exec('reset role'); } }
  const q = (role, uid, sql, p) => as(role, uid, () => pg.query(sql, p || []));
  async function fails(role, uid, sql, p, re) { try { await q(role, uid, sql, p); return false; } catch (e) { return re ? re.test(e.message) : true; } }
  const sha = (c) => c.repeat(64); let n = 0;
  async function put(uid, work, name, size) {
    const p = `${uid}/${work}/${'00000000-0000-4000-8000-' + String(++n).padStart(12, '0')}-${name}`;
    await q('authenticated', uid, `insert into storage.objects (bucket_id, name, owner, metadata) values ('works', $1, $2, $3::jsonb)`, [p, uid, JSON.stringify({ size })]);
    return p;
  }
  const wm = (await q('authenticated', A, `select public.create_work('music','Harbor Song') id`)).rows[0].id;
  const wa = (await q('authenticated', A, `select public.create_work('art','Sketch') id`)).rows[0].id;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const start = async (uid, w) => (await q('authenticated', uid, `select public.start_take($1) r`, [w])).rows[0].r;
  const take = (uid, s, p, mime, bytes, claimed, h) => q('authenticated', uid, `select public.add_live_take($1,$2,'take.webm',$3,$4,$5,$6) r`, [s, p, mime, bytes, h || sha('c'), claimed]);

  // add_work_item can no longer be used to claim a live take
  const pr = await put(A, wm, 'x.webm', 1000);
  ok(await fails('authenticated', A, `select public.add_work_item('${wm}','live','${pr}','x.webm','audio/webm',1000,'${sha('a')}')`, [], /unknown file role/), 'the live role cannot be claimed through the ordinary upload');
  ok(await fails('authenticated', A, `select public.register_work_item('${A}','${wm}','live','${pr}','x.webm','audio/webm',1000,'${sha('a')}',1000,1000)`, [], /permission denied/), 'the internal registration step is not callable');
  ok(await fails('authenticated', A, `insert into public.take_sessions (work_id, user_id) values ('${wm}','${A}')`, [], /permission denied/), 'take sessions cannot be written directly');

  // sessions
  ok(await fails('anon', null, `select public.start_take('${wm}')`, [], /not signed in|permission denied/), 'starting a take needs sign-in');
  ok(await fails('authenticated', B, `select public.start_take('${wm}')`, [], /work not found/), "you cannot record into someone else's work");
  ok(await fails('authenticated', A, `select public.start_take('${wa}')`, [], /only for music/), 'recording is only for music works');

  // a genuine take: the server clock has passed at least the take's length
  const s1 = await start(A, wm); await sleep(1300);
  const p1 = await put(A, wm, 'take1.webm', 20000);
  let r1; try { r1 = (await take(A, s1.session, p1, 'audio/webm', 20000, 1000)).rows[0].r; } catch (e) { console.log('ERR', e.message); r1 = {}; }
  ok(r1.seq === 1 && r1.elapsed_ms >= 1000, 'a take that really took that long is accepted');
  const it = (await pg.query(`select role, live_claimed_ms c, live_elapsed_ms e from public.work_items where work_id='${wm}' and role='live'`)).rows;
  ok(it.length === 1 && it[0].c === 1000 && it[0].e >= 1000, 'it is stored as a live take with its claimed and elapsed times');
  ok((await q('authenticated', A, `select public.get_work('${wm}') r`)).rows[0].r.items.find((i) => i.role === 'live').live_elapsed_ms >= 1000, 'the work page data carries the live timing');
  ok(await fails('authenticated', A, `select public.add_live_take('${s1.session}','${p1}','take.webm','audio/webm',20000,'${sha('c')}',1000)`, [], /already added/), 'a recording session can be used only once');

  // too fast
  const s2 = await start(A, wm); const p2 = await put(A, wm, 'take2.webm', 20000);
  ok(await fails('authenticated', A, `select public.add_live_take('${s2.session}','${p2}','take.webm','audio/webm',20000,'${sha('d')}',60000)`, [], /longer than the time that has passed/), 'a 60-second take uploaded right after starting is refused');
  // the failed attempt did not burn the session; wait the claimed time by moving the start back
  await pg.exec(`update public.take_sessions set started_at = clock_timestamp() - interval '61 seconds' where id = '${s2.session}'`);
  ok((await take(A, s2.session, p2, 'audio/webm', 20000, 60000, sha('d'))).rows[0].r.seq === 2, 'the same take is accepted once 60 seconds really have passed');

  // other limits
  const s3 = await start(A, wm); const p3 = await put(A, wm, 'take3.webm', 20000);
  await pg.exec(`update public.take_sessions set started_at = clock_timestamp() - interval '2 hours' where id = '${s3.session}'`);
  ok(await fails('authenticated', A, `select public.add_live_take('${s3.session}','${p3}','take.webm','audio/webm',20000,'${sha('e')}',5000)`, [], /too long ago/), 'a session that started hours ago is refused');
  await pg.exec(`update public.take_sessions set started_at = clock_timestamp() - interval '10 seconds' where id = '${s3.session}'`);
  ok(await fails('authenticated', A, `select public.add_live_take('${s3.session}','${p3}','take.webm','audio/webm',20000,'${sha('e')}',500)`, [], /1 second to 30 minutes/), 'takes under a second are refused');
  ok(await fails('authenticated', A, `select public.add_live_take('${s3.session}','${p3}','take.webm','audio/webm',20000,'${sha('e')}',1900000)`, [], /1 second to 30 minutes/), 'takes over 30 minutes are refused');
  const big = await put(A, wm, 'big.webm', 5000000);
  ok(await fails('authenticated', A, `select public.add_live_take('${s3.session}','${big}','take.webm','audio/webm',5000000,'${sha('f')}',8000)`, [], /too big for a take of that length/), 'a file far too large for the claimed length is refused');
  ok(await fails('authenticated', A, `select public.add_live_take('${s3.session}','${p3}','take.wav','audio/wav',20000,'${sha('e')}',5000)`, [], /audio recorded on a music work/), 'only recorder formats are accepted as live takes');
  ok(await fails('authenticated', B, `select public.add_live_take('${s3.session}','${p3}','take.webm','audio/webm',20000,'${sha('e')}',5000)`, [], /isn't valid/), "someone else's session cannot be used");
  ok(await fails('authenticated', A, `select public.add_live_take('${s3.session}','${wm}/../x','take.webm','audio/webm',20000,'${sha('e')}',5000)`, [], /bad file path/), 'a bad storage path is refused');
  ok((await pg.query(`select used from public.take_sessions where id='${s3.session}'`)).rows[0].used === false, 'refused attempts leave the session unused');

  // locked after publish
  await put(A, wm, 'final.mp3', 3000).then((p) => q('authenticated', A, `select public.add_work_item('${wm}','final','${p}','final.mp3','audio/mpeg',3000,'${sha('9')}')`));
  await q('authenticated', A, `select public.publish_work('${wm}')`);
  ok(await fails('authenticated', A, `select public.start_take('${wm}')`, [], /published and locked/), 'no new takes after publishing');
  ok((await pg.query(`select public.verify_work_chain('${wm}') ok`)).rows[0].ok === true, 'the chain still verifies with live takes in it');
  ok((await q('anon', null, `select public.list_public_works('music',10,0) r`)).rows[0].r[0].live_count === 2, 'Browse rows count the live takes');

  // release link
  ok(await fails('authenticated', B, `select public.set_release_link('${wm}','https://open.spotify.com/x')`, [], /Not found/), "you cannot set someone else's release link");
  ok(await fails('authenticated', A, `select public.set_release_link('${wm}','http://example.com/x')`, [], /https/), 'a link must start with https://');
  ok(await fails('authenticated', A, `select public.set_release_link('${wm}','javascript:alert(1)')`, [], /https/), 'script links are refused');
  ok((await q('authenticated', A, `select public.set_release_link('${wm}','https://open.spotify.com/track/abc') r`)).rows[0].r === 'https://open.spotify.com/track/abc', 'the owner can add a release link, even after publishing');
  ok((await q('anon', null, `select public.get_work('${wm}') r`)).rows[0].r.release_url === 'https://open.spotify.com/track/abc', 'it shows on the public page data');
  ok((await q('authenticated', A, `select public.set_release_link('${wm}','  ') r`)).rows[0].r === null && (await q('anon', null, `select public.get_work('${wm}') r`)).rows[0].r.release_url === null, 'an empty link clears it');

  // account deletion clears sessions
  await q('authenticated', A, `select public.delete_my_account()`);
  ok((await pg.query(`select count(*)::int n from public.take_sessions`)).rows[0].n === 0, 'deleting the account removes recording sessions');
  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
