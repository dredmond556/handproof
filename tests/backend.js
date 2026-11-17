/* A stand-in for Supabase's network API (GoTrue auth + PostgREST rpc) backed by the real schema in PGlite.
   The page uses the real supabase-js library; only the network is faked. */
const crypto = require('crypto');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(payload) { return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(payload) + '.' + 'sig'; }
function decode(tok) { try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()); } catch (e) { return null; } }

module.exports = function createBackend(pg, state) {
  state.users = state.users || {};     // email -> {id,password,meta,created}
  state.log = state.log || [];         // every request: {method, path}
  state.emails = state.emails || [];   // emails the server "sent"
  state.files = state.files || {};     // storage path -> {buf, mime}
  state.signed = state.signed || {};   // token -> path
  let q = Promise.resolve();
  const locked = (fn) => { const p = q.then(fn); q = p.catch(() => {}); return p; };
  const userObj = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: new Date().toISOString(), phone: '', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: u.meta || {}, identities: [], created_at: u.created, updated_at: new Date().toISOString() });
  const session = (u) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    return { access_token: jwt({ sub: u.id, email: u.email, role: 'authenticated', aud: 'authenticated', exp }), token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'r-' + u.id, user: userObj(u) };
  };
  const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const authErr = (status, msg, code) => json(status, { code: status, error_code: code || 'bad_request', msg, message: msg });

  async function createUser(email, password, meta) {
    const r = await locked(() => pg.query(`insert into auth.users (email, raw_user_meta_data) values ($1,$2::jsonb) returning id`, [email, JSON.stringify(meta || {})]));
    state.users[email] = { id: r.rows[0].id, email, password, meta: meta || {}, created: new Date().toISOString() };
    return state.users[email];
  }

  function parseMultipart(buf, ct) {
    const m = /boundary=(.+)$/.exec(ct || ''); if (!m) return null;
    const bnd = Buffer.from('--' + m[1]); let pos = buf.indexOf(bnd);
    while (pos >= 0) {
      const next = buf.indexOf(bnd, pos + bnd.length); if (next < 0) break;
      const part = buf.subarray(pos + bnd.length + 2, next - 2);       // strip CRLF around the part
      const split = part.indexOf('\r\n\r\n'); const head = part.subarray(0, split).toString();
      if (/filename=/.test(head)) { const mime = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1]; return { data: part.subarray(split + 4), mime }; }
      pos = next;
    }
    return null;
  }
  const roleOf = (headers) => {
    const p = decode((headers.authorization || '').replace(/^Bearer /i, ''));
    return p && p.role === 'authenticated' && p.sub && p.exp * 1000 > Date.now() ? { role: 'authenticated', uid: p.sub } : { role: 'anon', uid: '' };
  };
  const asRole = (r, fn) => locked(async () => {
    await pg.exec(`set role ${r.role}; select set_config('request.jwt.claim.sub','${r.uid}', false);`);
    try { return await fn(); } finally { await pg.exec('reset role'); }
  });
  const serr = (status, msg) => json(status, { statusCode: String(status), error: status === 403 ? 'Unauthorized' : status === 413 ? 'Payload too large' : 'Error', message: msg });
  const byToken = (h) => {
    const t = (h.authorization || '').replace(/^Bearer /i, '');
    const p = decode(t);
    if (!p || !p.sub) return null;
    return Object.values(state.users).find((u) => u.id === p.sub) || null;
  };

  return async function handle(method, urlStr, headers, bodyText, bodyBuf) {
    const url = new URL(urlStr);
    const path = url.pathname;
    state.log.push({ method, path });
    if (state.down) return json(503, { message: 'down' });
    let body = {}; try { body = bodyText ? JSON.parse(bodyText) : {}; } catch (e) {}
    if (path === '/auth/v1/signup' && method === 'POST') {
      if (state.users[body.email]) return authErr(422, 'User already registered', 'user_already_exists');
      if (!body.password || body.password.length < 8) return authErr(422, 'Password should be at least 8 characters.', 'weak_password');
      const u = await createUser(body.email, body.password, body.data);
      if (state.requireConfirm) { state.emails.push({ to: body.email, kind: 'confirm' }); return json(200, userObj(u)); }
      return json(200, session(u));
    }
    if (path === '/auth/v1/token' && method === 'POST') {
      const gt = url.searchParams.get('grant_type');
      if (gt === 'password') {
        const u = state.users[body.email];
        if (!u || u.password !== body.password) return authErr(400, 'Invalid login credentials', 'invalid_credentials');
        return json(200, session(u));
      }
      if (gt === 'refresh_token') {
        const u = Object.values(state.users).find((x) => 'r-' + x.id === body.refresh_token);
        if (!u) return authErr(400, 'Invalid Refresh Token: Refresh Token Not Found', 'refresh_token_not_found');
        return json(200, session(u));
      }
    }
    if (path === '/auth/v1/user' && method === 'GET') {
      const u = byToken(headers); return u ? json(200, userObj(u)) : authErr(401, 'invalid JWT', 'bad_jwt');
    }
    if (path === '/auth/v1/user' && method === 'PUT') {
      const u = byToken(headers); if (!u) return authErr(401, 'invalid JWT', 'bad_jwt');
      if (body.password) { if (body.password.length < 8) return authErr(422, 'Password should be at least 8 characters.', 'weak_password'); u.password = body.password; }
      return json(200, userObj(u));
    }
    if (path === '/auth/v1/logout') return { status: 204, headers: {}, body: '' };
    if (path === '/auth/v1/recover' && method === 'POST') { state.emails.push({ to: body.email, kind: 'recover', redirect: url.searchParams.get('redirect_to') }); return json(200, {}); }
    if (path === '/auth/v1/otp' && method === 'POST') {
      if (body.create_user === false && !state.users[body.email]) return authErr(422, 'Signups not allowed for otp', 'otp_disabled');
      state.emails.push({ to: body.email, kind: 'magic' }); return json(200, {});
    }
    const m = path.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (m && method === 'POST') {
      const fn = m[1];
      const tok = (headers.authorization || '').replace(/^Bearer /i, '');
      const p = decode(tok);
      const authed = p && p.role === 'authenticated' && p.sub;
      if (authed && p.exp * 1000 < Date.now()) return json(401, { code: 'PGRST301', message: 'JWT expired' });
      const keys = Object.keys(body);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${/^p_(series|snapshots)$/.test(k) ? '::jsonb' : ''}`).join(',')}) as r`;
      const params = keys.map((k) => (/^p_(series|snapshots)$/.test(k) ? JSON.stringify(body[k]) : body[k]));
      return locked(async () => {
        await pg.exec(`set role ${authed ? 'authenticated' : 'anon'}; select set_config('request.jwt.claim.sub','${authed ? p.sub : ''}', false);`);
        try { const r = await pg.query(sql, params); return json(200, r.rows[0].r === undefined ? null : r.rows[0].r); }
        catch (e) {
          const denied = /permission denied/.test(e.message);
          return json(denied ? 401 : 400, { code: denied ? '42501' : 'P0001', message: e.message, details: null, hint: null });
        } finally { await pg.exec('reset role'); }
      });
    }

    // ---- storage ----
    let sm;
    if ((sm = path.match(/^\/storage\/v1\/object\/works\/(.+)$/)) && method === 'POST') {
      const name = decodeURIComponent(sm[1]); const r = roleOf(headers);
      if (r.role !== 'authenticated') return serr(403, 'new row violates row-level security policy');
      const mp = parseMultipart(bodyBuf, headers['content-type']); if (!mp) return serr(400, 'no file');
      const bk = (await pg.query(`select file_size_limit, allowed_mime_types from storage.buckets where id='works'`)).rows[0];
      if (mp.data.length > Number(bk.file_size_limit)) return serr(413, 'The object exceeded the maximum allowed size');
      if (bk.allowed_mime_types && !bk.allowed_mime_types.includes(mp.mime)) return serr(415, 'mime type ' + mp.mime + ' is not supported');
      return asRole(r, async () => {
        try {
          await pg.query(`insert into storage.objects (bucket_id, name, owner, metadata) values ('works', $1, $2, $3::jsonb)`, [name, r.uid, JSON.stringify({ size: mp.data.length, mimetype: mp.mime })]);
          state.files[name] = { buf: Buffer.from(mp.data), mime: mp.mime };
          return json(200, { Id: crypto.randomUUID(), Key: 'works/' + name });
        } catch (e) { return /row-level/.test(e.message) ? serr(403, e.message) : /duplicate/.test(e.message) ? serr(409, 'The resource already exists') : serr(400, e.message); }
      });
    }
    if (path === '/storage/v1/object/sign/works' && method === 'POST') {
      const r = roleOf(headers);
      return asRole(r, async () => {
        const out = [];
        for (const pth of body.paths || []) {
          const f = (await pg.query(`select 1 from storage.objects where bucket_id='works' and name=$1`, [pth])).rows.length;
          if (f) { const tok = crypto.randomBytes(8).toString('hex'); state.signed[tok] = pth; out.push({ error: null, path: pth, signedURL: '/object/sign/works/' + pth + '?token=' + tok }); }
          else out.push({ error: 'Object not found', path: pth, signedURL: null });
        }
        return json(200, out);
      });
    }
    if ((sm = path.match(/^\/storage\/v1\/object\/sign\/works\/(.+)$/)) && method === 'GET') {
      const name = decodeURIComponent(sm[1]); const tok = url.searchParams.get('token');
      if (state.signed[tok] !== name || !state.files[name]) return serr(400, 'Invalid token');
      return { status: 200, headers: { 'content-type': state.files[name].mime }, body: state.files[name].buf };
    }
    if (path === '/storage/v1/object/works' && method === 'DELETE') {
      const r = roleOf(headers);
      return asRole(r, async () => {
        const d = await pg.query(`delete from storage.objects where bucket_id='works' and name = any($1::text[]) returning name`, [body.prefixes || []]);
        d.rows.forEach((x) => { delete state.files[x.name]; });
        return json(200, d.rows.map((x) => ({ name: x.name, bucket_id: 'works' })));
      });
    }
    return json(404, { message: 'not found: ' + method + ' ' + path });
  };
};
module.exports.jwt = jwt;
