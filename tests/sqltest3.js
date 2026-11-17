const path = require('path'), fs = require('fs');
const { PGlite } = require('@electric-sql/pglite');
const schema = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'schema.sql'), 'utf8');
const shim = require('./shim');
let pass = 0, fail = 0;
function ok(c, m) { if (c) { pass++; console.log('PASS  ' + m); } else { fail++; console.log('FAIL  ' + m); } }
(async () => {
  const pg = new PGlite(); await pg.exec(shim); await pg.exec(schema);
  let again = true; try { await pg.exec(schema); } catch (e) { again = false; console.log(e.message); }
  ok(again, 'schema with works still runs twice without errors');
  const A = '11111111-1111-1111-1111-111111111111', B = '22222222-2222-2222-2222-222222222222';
  await pg.exec(`insert into auth.users (id,email,raw_user_meta_data) values ('${A}','a@x.com','{"display_name":"Ada"}'),('${B}','b@x.com','{"display_name":"Bo"}')`);
  async function as(role, uid, fn) { await pg.exec(`set role ${role}; select set_config('request.jwt.claim.sub','${uid || ''}', false);`); try { return await fn(); } finally { await pg.exec('reset role'); } }
  const q = (role, uid, sql, p) => as(role, uid, () => pg.query(sql, p || []));
  async function fails(role, uid, sql, p, re) { try { await q(role, uid, sql, p); return false; } catch (e) { return re ? re.test(e.message) : true; } }
  const sha = (c) => c.repeat(64);
  let n = 0;
  async function put(uid, work, name, size) { // stand-in for the storage API upload, run under the real policies
    const p = `${uid}/${work}/${'00000000-0000-4000-8000-' + String(++n).padStart(12, '0')}-${name}`;
    await q('authenticated', uid, `insert into storage.objects (bucket_id, name, owner, metadata) values ('works', $1, $2, $3::jsonb)`, [p, uid, JSON.stringify({ size })]);
    return p;
  }
  const add = (uid, work, role, p, fname, mime, bytes, s) => q('authenticated', uid, 'select public.add_work_item($1,$2,$3,$4,$5,$6,$7) r', [work, role, p, fname, mime, bytes, s || sha('a')]);

  ok(await fails('anon', null, `select public.create_work('art','x')`, [], /not signed in|permission denied/), 'creating a work needs sign-in');
  ok(await fails('authenticated', A, `select public.create_work('podcast','x')`, [], /unknown kind/), 'unknown kinds are refused');
  const w = (await q('authenticated', A, `select public.create_work('photo','Harbor at dawn','Shot on film') id`)).rows[0].id;

  // storage insert policy
  ok(await fails('authenticated', B, `insert into storage.objects (bucket_id,name,metadata) values ('works','${A}/${w}/x.jpg','{"size":5}')`, [], /row-level security/), "you can't upload into someone else's folder");
  ok(await fails('authenticated', B, `insert into storage.objects (bucket_id,name,metadata) values ('works','${B}/${w}/x.jpg','{"size":5}')`, [], /row-level security/), "you can't upload into a work that isn't yours");
  ok(await fails('anon', null, `insert into storage.objects (bucket_id,name,metadata) values ('works','${A}/${w}/x.jpg','{"size":5}')`, [], /permission|row-level/), 'signed-out visitors cannot upload');

  const fin = await put(A, w, 'final.jpg', 1200);
  const orig = await put(A, w, 'raw.jpg', 3000);
  ok(await fails('authenticated', B, `select public.add_work_item('${w}','final','${fin}','f.jpg','image/jpeg',1200,'${sha('a')}')`, [], /work not found/), "nobody else can add files to your work");
  ok(await fails('authenticated', A, `select public.add_work_item('${w}','final','${A}/${w}/nope.jpg','f.jpg','image/jpeg',10,'${sha('a')}')`, [], /bad file path|isn't in storage/), 'a file must exist in storage first');
  const ghost = `${A}/${w}/00000000-0000-4000-8000-0000000000ff-ghost.jpg`;
  ok(await fails('authenticated', A, `select public.add_work_item('${w}','final','${ghost}','g.jpg','image/jpeg',10,'${sha('a')}')`, [], /isn't in storage/), 'registering a path that was never uploaded fails');
  ok(await fails('authenticated', A, `select public.add_work_item('${w}','final','${fin}','f.jpg','image/jpeg',999,'${sha('a')}')`, [], /size doesn't match/), 'a wrong size is refused');
  ok(await fails('authenticated', A, `select public.add_work_item('${w}','final','${fin}','f.jpg','image/jpeg',1200,'xyz')`, [], /bad checksum/), 'a bad checksum is refused');
  ok(await fails('authenticated', A, `select public.add_work_item('${w}','final','${fin}','f.exe','application/x-msdownload',1200,'${sha('a')}')`, [], /isn't accepted/), 'unknown file types are refused');
  ok(await fails('authenticated', A, `select public.add_work_item('${w}','final','${fin}','f.svg','image/svg+xml',1200,'${sha('a')}')`, [], /isn't accepted/), 'SVG is refused (it can carry scripts)');
  ok(await fails('authenticated', A, `select public.add_work_item('${w}','final','${fin}','s.mp3','audio/mpeg',1200,'${sha('a')}')`, [], /isn't accepted/), 'audio is refused on a photo work');
  ok(await fails('authenticated', A, `select public.add_work_item('${w}','project','${fin}','p.jpg','image/jpeg',1200,'${sha('a')}')`, [], /must be zipped/), 'project files must be zips');
  ok(await fails('authenticated', A, `select public.publish_work('${w}')`, [], /add the finished work/), 'cannot publish without a finished work');

  await add(A, w, 'original', orig, 'raw.jpg', 'image/jpeg', 3000, sha('b'));
  const r2 = (await add(A, w, 'final', fin, 'final.jpg', 'image/jpeg', 1200, sha('c'))).rows[0].r;
  ok(r2.seq === 2 && /^[0-9a-f]{64}$/.test(r2.hash), 'files get sequence numbers and chained hashes');
  const row = (await pg.query(`select * from public.works where id='${w}'`)).rows[0];
  ok(row.item_count === 2 && row.head_hash === r2.hash && row.first_received_at && row.last_received_at >= row.first_received_at, 'work head and server timestamps track the chain');
  ok((await pg.query(`select public.verify_work_chain('${w}') v`)).rows[0].v === true, 'the chain verifies');

  // draft privacy
  ok((await q('anon', null, `select public.get_work('${w}') r`)).rows[0].r === null, 'strangers cannot see a draft work');
  ok((await q('authenticated', B, `select public.get_work('${w}') r`)).rows[0].r === null, 'other users cannot see a draft work');
  ok((await q('anon', null, `select count(*)::int n from storage.objects where bucket_id='works'`)).rows[0].n === 0, "a draft's files are invisible to strangers");
  ok((await q('authenticated', B, `select count(*)::int n from storage.objects where bucket_id='works'`)).rows[0].n === 0, "a draft's files are invisible to other users");
  ok((await q('authenticated', A, `select count(*)::int n from storage.objects where bucket_id='works'`)).rows[0].n === 2, 'the author sees their own files');
  const mine = (await q('authenticated', A, `select public.get_work('${w}') r`)).rows[0].r;
  ok(mine.mine === true && mine.items.length === 2 && mine.verification.chain_ok === true, 'the author can open their draft with its items');

  // undo
  const extra = await put(A, w, 'oops.jpg', 500);
  await add(A, w, 'process', extra, 'oops.jpg', 'image/jpeg', 500, sha('d'));
  const undone = (await q('authenticated', A, `select public.undo_last_item('${w}') p`)).rows[0].p;
  ok(undone === extra && (await pg.query(`select public.verify_work_chain('${w}') v, item_count, head_hash from public.works where id='${w}'`)).rows[0].v === true, 'undoing the last file keeps the chain valid');
  ok((await pg.query(`select head_hash h from public.works where id='${w}'`)).rows[0].h === r2.hash, 'undo restores the previous head hash');
  const wip = await put(A, w, 'sketch.png', 800);
  await add(A, w, 'process', wip, 'sketch.png', 'image/png', 800, sha('e'));

  // tamper detection
  await pg.exec(`update public.work_items set sha256 = '${sha('f')}' where work_id='${w}' and seq=1`);
  ok((await pg.query(`select public.verify_work_chain('${w}') v`)).rows[0].v === false, 'editing a stored checksum breaks the chain');
  await pg.exec(`update public.work_items set sha256 = '${sha('b')}' where work_id='${w}' and seq=1`);
  ok((await pg.query(`select public.verify_work_chain('${w}') v`)).rows[0].v === true, '…and restoring it makes it verify again');

  // publish
  ok(await fails('authenticated', B, `select public.publish_work('${w}')`, [], /work not found/), "you can't publish someone else's work");
  await q('authenticated', A, `select public.publish_work($1,'Harbor at dawn','Shot on film, then scanned') r`, [w]);
  ok((await q('anon', null, `select public.get_work('${w}') r`)).rows[0].r.status === 'published', 'a published work is public');
  ok((await q('anon', null, `select count(*)::int n from storage.objects where bucket_id='works'`)).rows[0].n === 3, 'published files become readable by anyone');
  ok(await fails('authenticated', A, `select public.add_work_item('${w}','process','${extra}','x.jpg','image/jpeg',500,'${sha('d')}')`, [], /locked/), 'a published work is locked');
  ok((await pg.query(`delete from storage.objects where false`)).affectedRows === 0, 'sanity');
  const del = await q('authenticated', A, `delete from storage.objects where bucket_id='works' and name='${fin}'`);
  ok(del.affectedRows === 0, "published files can't be deleted from storage");

  // browse + profile
  const list = (await q('anon', null, `select public.list_public_works() r`)).rows[0].r;
  ok(list.length === 1 && list[0].kind === 'photo' && list[0].author === 'Ada' && list[0].final_path === fin && list[0].process_count === 2, 'list shows kind, author, final file and process count');
  ok((await q('anon', null, `select public.list_public_works('music') r`)).rows[0].r.length === 0, 'kind filter works');
  const prof = (await q('anon', null, `select public.get_public_profile('${A}') r`)).rows[0].r;
  ok(prof.works.length === 1 && prof.works[0].title === 'Harbor at dawn', "a profile lists the creator's works");

  // reports and takedown
  ok(await fails('anon', null, `select public.report_work('${w}','bogus')`, [], /unknown reason/), 'reports need a valid reason');
  await q('anon', null, `select public.report_work('${w}','copyright','not theirs')`);
  ok((await pg.query(`select count(*)::int n from public.reports where work_id='${w}' and piece_id is null`)).rows[0].n === 1, 'a work report is stored against the work');
  ok(await fails('anon', null, `select public.admin_remove_work('${w}','x')`, [], /permission denied/), 'the public cannot remove works');
  await pg.query(`select public.admin_remove_work('${w}','copyright claim')`);
  ok((await q('anon', null, `select public.get_work('${w}') r`)).rows[0].r === null, 'a removed work disappears from its public link');
  ok((await q('anon', null, `select count(*)::int n from storage.objects where bucket_id='works'`)).rows[0].n === 0, "a removed work's files stop being public");
  ok((await q('authenticated', A, `select public.get_work('${w}') r`)).rows[0].r.removed_reason === 'copyright claim', 'the author sees why it was removed');
  await pg.query(`select public.admin_restore_work('${w}')`);
  ok((await q('anon', null, `select public.get_work('${w}') r`)).rows[0].r !== null, 'restoring brings it back');

  // export
  const ex = (await q('authenticated', A, `select public.export_my_data() r`)).rows[0].r;
  ok(ex.works.length === 1 && ex.works[0].files.length === 3, 'data export includes works and file details');

  // limits
  const w2 = (await q('authenticated', B, `select public.create_work('film','Short') id`)).rows[0].id;
  const big = await put(B, w2, 'a.mp4', 50000000);
  await add(B, w2, 'process', big, 'a.mp4', 'video/mp4', 50000000, sha('1'));
  const big2 = await put(B, w2, 'b.mp4', 50000000);
  await add(B, w2, 'process', big2, 'b.mp4', 'video/mp4', 50000000, sha('2'));
  const big3 = await put(B, w2, 'c.mp4', 50000000);
  await add(B, w2, 'process', big3, 'c.mp4', 'video/mp4', 50000000, sha('3'));
  const big4 = await put(B, w2, 'd.mp4', 50000000);
  await add(B, w2, 'process', big4, 'd.mp4', 'video/mp4', 50000000, sha('4'));
  const big5 = await put(B, w2, 'e.mp4', 50000000);
  await add(B, w2, 'process', big5, 'e.mp4', 'video/mp4', 50000000, sha('5'));
  const big6 = await put(B, w2, 'f.mp4', 50000000);
  ok(await fails('authenticated', B, `select public.add_work_item('${w2}','process','${big6}','f.mp4','video/mp4',50000000,'${sha('6')}')`, [], /storage limit/), 'the per-account storage cap (250 MB) is enforced');
  const huge = await put(B, w2, 'h.jpg', 27000000);
  ok(await fails('authenticated', B, `select public.add_work_item('${w2}','process','${huge}','h.jpg','image/jpeg',27000000,'${sha('7')}')`, [], /at most 25 MB/), 'images over 25 MB are refused');
  ok(await fails('authenticated', B, `select public.add_work_item('${w2}','final','${big6}','f.png','image/png',50000000,'${sha('6')}')`, [], /must be video|at most 25|storage limit/), 'a film work needs a video as its finished file');

  // delete
  const paths = (await q('authenticated', A, `select public.delete_work('${w}') r`)).rows[0].r;
  ok(paths.length === 3, 'deleting a work returns the file paths so the browser can remove them');
  ok((await pg.query(`select count(*)::int n from public.work_items where work_id='${w}'`)).rows[0].n === 0, 'its file records are gone');
  const rm = await q('authenticated', A, `delete from storage.objects where bucket_id='works' and name='${fin}'`);
  ok(rm.affectedRows === 1, 'once the work is deleted its files can be removed from storage');
  await pg.exec(`delete from auth.users where id='${B}'`);
  ok((await pg.query(`select count(*)::int n from public.works where author_id='${B}'`)).rows[0].n === 0, 'deleting an account removes its works');

  console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
