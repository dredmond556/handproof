-- Handproof backend schema for Supabase (Postgres).
-- Run once in the SQL editor of a fresh project, or apply it as a migration.
--
-- How it works
--   * Writers record a piece in batches. Every batch is stamped with the SERVER's clock
--     and chained to the previous batch with a SHA-256 hash, so history can't be quietly
--     rewritten or back-dated after the fact.
--   * A batch also states how much writing time it covers. If that is more time than the
--     server clock says actually passed, the batch is flagged as suspect.
--   * Nobody writes to the tables directly. All writes go through the functions below,
--     and a published piece is locked.
--   * Published pieces and their replay are public. Drafts are private to their author.

------------------------------------------------------------------------------
-- Tables
------------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default 'Writer'
               check (char_length(display_name) between 1 and 60),
  created_at   timestamptz not null default now()
);

create table if not exists public.pieces (
  id                uuid primary key default gen_random_uuid(),
  author_id         uuid not null references auth.users (id) on delete cascade,
  title             text not null default 'Untitled' check (char_length(title) <= 120),
  status            text not null default 'draft' check (status in ('draft', 'published')),
  created_at        timestamptz not null default now(),
  published_at      timestamptz,
  final_text        text,
  word_count        int,
  active_seconds    int,
  deletions         int,
  pasted_chars      bigint,
  paste_events      int,
  batch_count       int not null default 0,
  suspect_batches   int not null default 0,
  head_hash         text not null default repeat('0', 64),
  first_received_at timestamptz,
  last_received_at  timestamptz,
  spark             jsonb,
  band_times        jsonb,
  replay            jsonb
);

create index if not exists pieces_author_idx on public.pieces (author_id, created_at desc);
create index if not exists pieces_published_idx on public.pieces (published_at desc) where status = 'published';

create table if not exists public.piece_batches (
  piece_id    uuid not null references public.pieces (id) on delete cascade,
  seq         int not null,
  received_at timestamptz not null,
  claimed_ms  bigint not null,
  elapsed_ms  bigint not null,
  suspect     boolean not null default false,
  series      jsonb not null default '[]'::jsonb,
  snapshots   jsonb not null default '[]'::jsonb,
  prev_hash   text not null,
  hash        text not null,
  primary key (piece_id, seq)
);

------------------------------------------------------------------------------
-- Row level security and table privileges (reads only; all writes use functions)
------------------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.pieces        enable row level security;
alter table public.piece_batches enable row level security;

drop policy if exists profiles_read       on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
drop policy if exists pieces_read         on public.pieces;
drop policy if exists batches_read        on public.piece_batches;

create policy profiles_read on public.profiles
  for select using (true);

create policy profiles_update_own on public.profiles
  for update using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy pieces_read on public.pieces
  for select using (status = 'published' or author_id = (select auth.uid()));

create policy batches_read on public.piece_batches
  for select using (
    exists (
      select 1 from public.pieces p
      where p.id = piece_batches.piece_id
        and (p.status = 'published' or p.author_id = (select auth.uid()))
    )
  );

revoke all on public.profiles, public.pieces, public.piece_batches from anon, authenticated;
grant select on public.profiles, public.pieces, public.piece_batches to anon, authenticated;
grant update (display_name) on public.profiles to authenticated;

------------------------------------------------------------------------------
-- Helpers
------------------------------------------------------------------------------

create or replace function public.batch_hash(
  prev text, seq int, received timestamptz, claimed bigint, suspect boolean, series jsonb, snaps jsonb
) returns text
language sql immutable set search_path = ''
as $$
  select encode(
    sha256(convert_to(concat_ws('|',
      prev,
      seq::text,
      to_char(received at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
      claimed::text,
      suspect::text,
      series::text,
      snaps::text
    ), 'UTF8')),
    'hex')
$$;

create or replace function public.require_user() returns uuid
language plpgsql stable set search_path = ''
as $$
declare uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  return uid;
end
$$;

-- Create a profile whenever someone signs up.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    coalesce(
      nullif(left(btrim(new.raw_user_meta_data ->> 'display_name'), 60), ''),
      nullif(left(split_part(coalesce(new.email, ''), '@', 1), 60), ''),
      'Writer'
    )
  );
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

------------------------------------------------------------------------------
-- Writing: start a piece, record batches, publish
------------------------------------------------------------------------------

create or replace function public.create_piece(p_title text default 'Untitled') returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := public.require_user();
  new_id uuid;
  drafts int;
begin
  -- Abandoned drafts expire after two weeks.
  delete from public.pieces
   where author_id = uid and status = 'draft' and created_at < now() - interval '14 days';

  select count(*) into drafts from public.pieces where author_id = uid and status = 'draft';
  if drafts >= 25 then
    raise exception 'too many unfinished drafts';
  end if;

  insert into public.pieces (author_id, title)
  values (uid, coalesce(nullif(left(btrim(p_title), 120), ''), 'Untitled'))
  returning id into new_id;
  return new_id;
end
$$;

-- series:    [[t_ms, length, pasted_chars], ...]   (client timeline, in milliseconds)
-- snapshots: [{"t": seconds, "text": "...", "paste": n}, ...]
-- claimed_ms: how far the client's timeline advanced since the previous batch
create or replace function public.append_batch(
  p_piece uuid, p_claimed_ms bigint, p_series jsonb, p_snapshots jsonb, p_title text default null
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := public.require_user();
  pc public.pieces%rowtype;
  prev text;
  nseq int;
  recv timestamptz;
  elapsed bigint;
  susp boolean;
  h text;
  e jsonb;
begin
  select * into pc from public.pieces where id = p_piece and author_id = uid for update;
  if not found then raise exception 'piece not found'; end if;
  if pc.status <> 'draft' then raise exception 'piece already published'; end if;
  if pc.batch_count >= 5000 then raise exception 'too many batches'; end if;

  if p_claimed_ms is null or p_claimed_ms < 0 or p_claimed_ms > 86400000 then
    raise exception 'bad duration';
  end if;
  if jsonb_typeof(p_series) is distinct from 'array' or jsonb_typeof(p_snapshots) is distinct from 'array' then
    raise exception 'bad payload';
  end if;
  if jsonb_array_length(p_series) > 3000 or jsonb_array_length(p_snapshots) > 40 then
    raise exception 'batch too large';
  end if;
  if octet_length(p_series::text) > 250000 or octet_length(p_snapshots::text) > 1500000 then
    raise exception 'batch too large';
  end if;
  if jsonb_array_length(p_series) = 0 and jsonb_array_length(p_snapshots) = 0 then
    raise exception 'empty batch';
  end if;

  for e in select value from jsonb_array_elements(p_series) loop
    if jsonb_typeof(e) <> 'array' then raise exception 'bad series point'; end if;
    if jsonb_array_length(e) <> 3 then raise exception 'bad series point'; end if;
    if jsonb_typeof(e -> 0) <> 'number' or jsonb_typeof(e -> 1) <> 'number' or jsonb_typeof(e -> 2) <> 'number' then
      raise exception 'bad series point';
    end if;
    if (e ->> 0)::numeric < 0 or (e ->> 1)::numeric < 0 or (e ->> 2)::numeric < 0 then
      raise exception 'bad series point';
    end if;
  end loop;

  for e in select value from jsonb_array_elements(p_snapshots) loop
    if jsonb_typeof(e) <> 'object' then raise exception 'bad snapshot'; end if;
    if jsonb_typeof(e -> 't') is distinct from 'number' or jsonb_typeof(e -> 'text') is distinct from 'string' then
      raise exception 'bad snapshot';
    end if;
    if (e ->> 't')::numeric < 0 or char_length(e ->> 'text') > 100000 then
      raise exception 'bad snapshot';
    end if;
    if e ? 'paste' then
      if jsonb_typeof(e -> 'paste') <> 'number' then raise exception 'bad snapshot'; end if;
      if (e ->> 'paste')::numeric < 0 then raise exception 'bad snapshot'; end if;
    end if;
  end loop;

  select coalesce(
    (select b.hash from public.piece_batches b where b.piece_id = p_piece order by b.seq desc limit 1),
    repeat('0', 64)
  ) into prev;

  nseq    := pc.batch_count + 1;
  recv    := clock_timestamp();
  elapsed := floor(extract(epoch from (recv - coalesce(pc.last_received_at, pc.created_at))) * 1000)::bigint;
  -- A batch can't cover more writing time than the server clock says went by (plus a little slack).
  susp    := p_claimed_ms > (elapsed * 1.05 + 5000);
  h       := public.batch_hash(prev, nseq, recv, p_claimed_ms, susp, p_series, p_snapshots);

  insert into public.piece_batches
    (piece_id, seq, received_at, claimed_ms, elapsed_ms, suspect, series, snapshots, prev_hash, hash)
  values
    (p_piece, nseq, recv, p_claimed_ms, elapsed, susp, p_series, p_snapshots, prev, h);

  update public.pieces
     set batch_count       = nseq,
         suspect_batches   = suspect_batches + case when susp then 1 else 0 end,
         head_hash         = h,
         first_received_at = coalesce(first_received_at, recv),
         last_received_at  = recv,
         title             = coalesce(nullif(left(btrim(p_title), 120), ''), title)
   where id = p_piece;

  return jsonb_build_object('seq', nseq, 'hash', h, 'suspect', susp, 'received_at', recv);
end
$$;

-- Locks the piece. Final text and every number on the page come from the stored log,
-- not from anything the browser claims at publish time.
create or replace function public.publish_piece(p_piece uuid, p_title text default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := public.require_user();
  pc public.pieces%rowtype;
  final_txt text;
  rec record;
  prev_t numeric := null;
  prev_len numeric := 0;
  dels int := 0;
  pasted bigint := 0;
  pevents int := 0;
  active_ms numeric := 0;
  npoints int := 0;
  nsnap int;
  step int;
  replay_snaps jsonb;
  replay_series jsonb;
  spark_pts jsonb;
  bands jsonb;
  wc int;
begin
  select * into pc from public.pieces where id = p_piece and author_id = uid for update;
  if not found then raise exception 'piece not found'; end if;
  if pc.status <> 'draft' then raise exception 'piece already published'; end if;

  select s.e ->> 'text' into final_txt
    from public.piece_batches b, jsonb_array_elements(b.snapshots) with ordinality as s(e, ord)
   where b.piece_id = p_piece
   order by b.seq desc, s.ord desc
   limit 1;
  if final_txt is null or btrim(final_txt) = '' then raise exception 'nothing to publish'; end if;
  if char_length(final_txt) > 100000 then raise exception 'piece too long'; end if;

  for rec in
    select (s.e ->> 0)::numeric as t, (s.e ->> 1)::numeric as len, (s.e ->> 2)::numeric as paste
      from public.piece_batches b, jsonb_array_elements(b.series) with ordinality as s(e, ord)
     where b.piece_id = p_piece
     order by b.seq, s.ord
  loop
    npoints := npoints + 1;
    if prev_t is not null then
      if rec.t > prev_t and rec.t - prev_t < 30000 then active_ms := active_ms + (rec.t - prev_t); end if;
      if rec.len < prev_len then dels := dels + 1; end if;
    end if;
    if rec.paste > 0 then
      pasted  := pasted + rec.paste::bigint;
      pevents := pevents + 1;
    end if;
    prev_t := rec.t;
    prev_len := rec.len;
  end loop;

  -- Snapshots for the public replay: at most about 50, always keeping the first, the last and every paste.
  select count(*) into nsnap
    from public.piece_batches b, jsonb_array_elements(b.snapshots) s where b.piece_id = p_piece;
  step := greatest(1, ceil(nsnap / 50.0)::int);
  select coalesce(jsonb_agg(
           jsonb_build_object('t', (x.e ->> 't')::numeric, 'text', x.e ->> 'text',
                              'paste', coalesce((x.e ->> 'paste')::numeric, 0))
           order by x.rn), '[]'::jsonb)
    into replay_snaps
    from (
      select s.e, row_number() over (order by b.seq, s.ord) as rn
        from public.piece_batches b, jsonb_array_elements(b.snapshots) with ordinality as s(e, ord)
       where b.piece_id = p_piece
    ) x
   where x.rn = 1 or x.rn = nsnap or x.rn % step = 0 or coalesce((x.e ->> 'paste')::numeric, 0) > 0;

  step := greatest(1, ceil(npoints / 1400.0)::int);
  select coalesce(jsonb_agg(x.e order by x.rn), '[]'::jsonb)
    into replay_series
    from (
      select s.e, row_number() over (order by b.seq, s.ord) as rn
        from public.piece_batches b, jsonb_array_elements(b.series) with ordinality as s(e, ord)
       where b.piece_id = p_piece
    ) x
   where x.rn = 1 or x.rn = npoints or x.rn % step = 0 or (x.e ->> 2)::numeric > 0;

  step := greatest(1, ceil(jsonb_array_length(replay_series) / 120.0)::int);
  select coalesce(jsonb_agg(t.e order by t.ord), '[]'::jsonb)
    into spark_pts
    from jsonb_array_elements(replay_series) with ordinality as t(e, ord)
   where t.ord = 1 or t.ord = jsonb_array_length(replay_series) or t.ord % step = 0 or (t.e ->> 2)::numeric > 0;

  select coalesce(jsonb_agg((t.e ->> 't')::numeric order by t.ord), '[]'::jsonb)
    into bands
    from jsonb_array_elements(replay_snaps) with ordinality as t(e, ord);

  wc := coalesce(array_length(regexp_split_to_array(btrim(final_txt), '\s+'), 1), 0);

  update public.pieces
     set status         = 'published',
         published_at   = now(),
         title          = coalesce(nullif(left(btrim(p_title), 120), ''), title),
         final_text     = final_txt,
         word_count     = wc,
         active_seconds = round(active_ms / 1000.0)::int,
         deletions      = dels,
         pasted_chars   = pasted,
         paste_events   = pevents,
         replay         = jsonb_build_object('snapshots', replay_snaps, 'series', replay_series),
         spark          = spark_pts,
         band_times     = bands
   where id = p_piece;

  return jsonb_build_object(
    'id', p_piece, 'word_count', wc, 'active_seconds', round(active_ms / 1000.0)::int,
    'deletions', dels, 'pasted_chars', pasted, 'paste_events', pevents);
end
$$;

------------------------------------------------------------------------------
-- Reading and checking
------------------------------------------------------------------------------

-- True when every batch hash recomputes and the chain ends where the piece says it does.
-- Null when the piece doesn't exist or isn't visible to the caller.
create or replace function public.verify_chain(p_piece uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  pc public.pieces%rowtype;
  b record;
  prev text := repeat('0', 64);
  expect int := 1;
  good boolean := true;
begin
  select * into pc from public.pieces
   where id = p_piece and (status = 'published' or author_id = auth.uid());
  if not found then return null; end if;

  for b in select * from public.piece_batches where piece_id = p_piece order by seq loop
    if b.seq <> expect or b.prev_hash <> prev
       or b.hash <> public.batch_hash(prev, b.seq, b.received_at, b.claimed_ms, b.suspect, b.series, b.snapshots) then
      good := false;
      exit;
    end if;
    prev := b.hash;
    expect := expect + 1;
  end loop;

  return good and prev = pc.head_hash and (expect - 1) = pc.batch_count;
end
$$;

create or replace function public.get_public_piece(p_piece uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  pc public.pieces%rowtype;
  author text;
begin
  select * into pc from public.pieces where id = p_piece and status = 'published';
  if not found then return null; end if;
  select display_name into author from public.profiles where id = pc.author_id;

  return jsonb_build_object(
    'id', pc.id,
    'title', pc.title,
    'author', coalesce(author, 'Writer'),
    'published_at', pc.published_at,
    'word_count', pc.word_count,
    'active_seconds', pc.active_seconds,
    'deletions', pc.deletions,
    'pasted_chars', pc.pasted_chars,
    'paste_events', pc.paste_events,
    'replay', pc.replay,
    'verification', jsonb_build_object(
      'chain_ok', public.verify_chain(p_piece),
      'batches', pc.batch_count,
      'suspect_batches', pc.suspect_batches,
      'server_span_seconds', round(extract(epoch from (pc.last_received_at - pc.first_received_at))),
      'head_hash', pc.head_hash
    )
  );
end
$$;

create or replace function public.list_public_pieces(p_limit int default 24, p_offset int default 0) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.published_at desc), '[]'::jsonb)
  from (
    select pc.id, pc.title, coalesce(pr.display_name, 'Writer') as author, pc.published_at,
           pc.active_seconds, pc.word_count, pc.pasted_chars, pc.paste_events, pc.suspect_batches,
           jsonb_array_length(pc.replay -> 'snapshots') as snapshot_count, pc.spark, pc.band_times
      from public.pieces pc
      left join public.profiles pr on pr.id = pc.author_id
     where pc.status = 'published'
     order by pc.published_at desc
     limit least(greatest(p_limit, 1), 50) offset greatest(p_offset, 0)
  ) x
$$;

create or replace function public.my_pieces() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (
        select id, title, status, created_at, published_at, word_count, active_seconds,
               pasted_chars, paste_events, suspect_batches
          from public.pieces where author_id = uid
      ) x
  ), '[]'::jsonb);
end
$$;

create or replace function public.set_display_name(p_name text) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := public.require_user();
  clean text := btrim(coalesce(p_name, ''));
begin
  if char_length(clean) < 1 or char_length(clean) > 60 then
    raise exception 'name must be 1 to 60 characters';
  end if;
  update public.profiles set display_name = clean where id = uid;
  return clean;
end
$$;

create or replace function public.delete_piece(p_piece uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  delete from public.pieces where id = p_piece and author_id = uid;
  return found;
end
$$;

------------------------------------------------------------------------------
-- Who may call what
------------------------------------------------------------------------------

revoke execute on function public.batch_hash(text, int, timestamptz, bigint, boolean, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.require_user() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.create_piece(text) from public, anon, authenticated;
revoke execute on function public.append_batch(uuid, bigint, jsonb, jsonb, text) from public, anon, authenticated;
revoke execute on function public.publish_piece(uuid, text) from public, anon, authenticated;
revoke execute on function public.verify_chain(uuid) from public, anon, authenticated;
revoke execute on function public.get_public_piece(uuid) from public, anon, authenticated;
revoke execute on function public.list_public_pieces(int, int) from public, anon, authenticated;
revoke execute on function public.my_pieces() from public, anon, authenticated;
revoke execute on function public.set_display_name(text) from public, anon, authenticated;
revoke execute on function public.delete_piece(uuid) from public, anon, authenticated;

grant execute on function public.create_piece(text) to authenticated;
grant execute on function public.append_batch(uuid, bigint, jsonb, jsonb, text) to authenticated;
grant execute on function public.publish_piece(uuid, text) to authenticated;
grant execute on function public.my_pieces() to authenticated;
grant execute on function public.set_display_name(text) to authenticated;
grant execute on function public.delete_piece(uuid) to authenticated;
grant execute on function public.verify_chain(uuid) to anon, authenticated;
grant execute on function public.get_public_piece(uuid) to anon, authenticated;
grant execute on function public.list_public_pieces(int, int) to anon, authenticated;

------------------------------------------------------------------------------
-- Part 2: terms consent, reports and takedowns, limits, privacy tools
-- (safe to run again)
------------------------------------------------------------------------------

alter table public.profiles add column if not exists terms_accepted_at timestamptz;
alter table public.profiles add column if not exists terms_version text;

alter table public.pieces add column if not exists removed_at timestamptz;
alter table public.pieces add column if not exists removed_reason text;
alter table public.pieces drop constraint if exists pieces_status_check;
alter table public.pieces add constraint pieces_status_check
  check (status in ('draft', 'published', 'removed'));

-- Remember which version of the terms a new account agreed to.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  tv text := nullif(left(btrim(new.raw_user_meta_data ->> 'accepted_terms'), 20), '');
begin
  insert into public.profiles (id, display_name, terms_accepted_at, terms_version)
  values (
    new.id,
    coalesce(
      nullif(left(btrim(new.raw_user_meta_data ->> 'display_name'), 60), ''),
      nullif(left(split_part(coalesce(new.email, ''), '@', 1), 60), ''),
      'Writer'
    ),
    case when tv is not null then now() end,
    tv
  );
  return new;
end
$$;

-- Reports. Nobody reads or writes this table through the API; only report_piece() and you (in the dashboard) can.
create table if not exists public.reports (
  id          uuid primary key default gen_random_uuid(),
  piece_id    uuid not null references public.pieces (id) on delete cascade,
  reporter_id uuid references auth.users (id) on delete set null,
  reason      text not null check (reason in ('ai_or_retyped', 'copyright', 'harassment', 'illegal', 'spam', 'other')),
  details     text check (char_length(details) <= 1000),
  status      text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  created_at  timestamptz not null default now()
);
create index if not exists reports_open_idx on public.reports (created_at desc) where status = 'open';
create index if not exists reports_piece_idx on public.reports (piece_id);
create index if not exists reports_reporter_idx on public.reports (reporter_id);
alter table public.reports enable row level security;
revoke all on public.reports from anon, authenticated;

create or replace function public.report_piece(p_piece uuid, p_reason text, p_details text default null) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if p_reason is null or p_reason not in ('ai_or_retyped', 'copyright', 'harassment', 'illegal', 'spam', 'other') then
    raise exception 'unknown reason';
  end if;
  if not exists (select 1 from public.pieces where id = p_piece and status = 'published') then
    raise exception 'piece not found';
  end if;
  if uid is not null and (select count(*) from public.reports where reporter_id = uid and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'too many reports today';
  end if;
  -- A piece that already has a pile of open reports doesn't need more; accept quietly.
  if (select count(*) from public.reports where piece_id = p_piece and status = 'open') >= 25 then
    return true;
  end if;
  insert into public.reports (piece_id, reporter_id, reason, details)
  values (p_piece, uid, p_reason, nullif(left(btrim(coalesce(p_details, '')), 1000), ''));
  return true;
end
$$;

-- Moderation. These can only be run by you (SQL editor or a service connection), never from the website.
create or replace function public.admin_remove_piece(p_piece uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.pieces
     set status = 'removed', removed_at = now(), removed_reason = nullif(left(btrim(coalesce(p_reason, '')), 500), '')
   where id = p_piece and status = 'published';
  if not found then return false; end if;
  update public.reports set status = 'actioned' where piece_id = p_piece and status = 'open';
  return true;
end
$$;

create or replace function public.admin_restore_piece(p_piece uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.pieces
     set status = 'published', removed_at = null, removed_reason = null
   where id = p_piece and status = 'removed' and published_at is not null;
  return found;
end
$$;

create or replace function public.admin_dismiss_reports(p_piece uuid) returns int
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  update public.reports set status = 'dismissed' where piece_id = p_piece and status = 'open';
  get diagnostics n = row_count;
  return n;
end
$$;

-- Limits against bulk abuse.
create or replace function public.limit_publishing() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'published' and old.status = 'draft'
     and (select count(*) from public.pieces
           where author_id = new.author_id and published_at > now() - interval '24 hours') >= 20 then
    raise exception 'daily publishing limit reached (20 per day)';
  end if;
  return new;
end
$$;
drop trigger if exists limit_publishing_trg on public.pieces;
create trigger limit_publishing_trg
  before update on public.pieces
  for each row execute function public.limit_publishing();

create or replace function public.create_piece(p_title text default 'Untitled') returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := public.require_user();
  new_id uuid;
  drafts int;
begin
  delete from public.pieces
   where author_id = uid and status = 'draft' and created_at < now() - interval '14 days';

  select count(*) into drafts from public.pieces where author_id = uid and status = 'draft';
  if drafts >= 25 then
    raise exception 'too many unfinished drafts';
  end if;
  if (select count(*) from public.pieces where author_id = uid and created_at > now() - interval '1 hour') >= 15 then
    raise exception 'too many new pieces in the last hour';
  end if;
  if (select count(*) from public.pieces where author_id = uid) >= 500 then
    raise exception 'piece limit reached';
  end if;

  insert into public.pieces (author_id, title)
  values (uid, coalesce(nullif(left(btrim(p_title), 120), ''), 'Untitled'))
  returning id into new_id;
  return new_id;
end
$$;

create or replace function public.my_pieces() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (
        select id, title, status, created_at, published_at, word_count, active_seconds,
               pasted_chars, paste_events, suspect_batches, removed_reason
          from public.pieces where author_id = uid
      ) x
  ), '[]'::jsonb);
end
$$;

-- Privacy tools: take your data with you, or erase it all.
create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = uid),
    'pieces', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pc.id, 'title', pc.title, 'status', pc.status,
               'created_at', pc.created_at, 'published_at', pc.published_at,
               'final_text', pc.final_text,
               'batches', (select coalesce(jsonb_agg(to_jsonb(b) order by b.seq), '[]'::jsonb)
                             from public.piece_batches b where b.piece_id = pc.id))
             order by pc.created_at)
        from public.pieces pc where pc.author_id = uid), '[]'::jsonb)
  );
end
$$;

create or replace function public.delete_my_account() returns boolean
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  delete from auth.users where id = uid;   -- profile, pieces and recordings go with it
  return true;
end
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.limit_publishing() from public, anon, authenticated;
revoke execute on function public.report_piece(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.admin_remove_piece(uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_restore_piece(uuid) from public, anon, authenticated;
revoke execute on function public.admin_dismiss_reports(uuid) from public, anon, authenticated;
revoke execute on function public.create_piece(text) from public, anon, authenticated;
revoke execute on function public.my_pieces() from public, anon, authenticated;
revoke execute on function public.export_my_data() from public, anon, authenticated;
revoke execute on function public.delete_my_account() from public, anon, authenticated;

grant execute on function public.report_piece(uuid, text, text) to anon, authenticated;
grant execute on function public.create_piece(text) to authenticated;
grant execute on function public.my_pieces() to authenticated;
grant execute on function public.export_my_data() to authenticated;
grant execute on function public.delete_my_account() to authenticated;

------------------------------------------------------------------------------
-- Part 3: public profiles (bio, website, contact). Safe to re-run.
-- Everything in these columns is public by design: the author chooses what to show.
------------------------------------------------------------------------------

alter table public.profiles add column if not exists bio     text not null default '';
alter table public.profiles add column if not exists website text not null default '';
alter table public.profiles add column if not exists contact text not null default '';

alter table public.profiles drop constraint if exists profiles_bio_len;
alter table public.profiles drop constraint if exists profiles_website_ok;
alter table public.profiles drop constraint if exists profiles_contact_len;
alter table public.profiles add constraint profiles_bio_len     check (char_length(bio) <= 600);
alter table public.profiles add constraint profiles_website_ok  check (website = '' or (char_length(website) <= 200 and website ~* '^https?://[^[:space:]]+$'));
alter table public.profiles add constraint profiles_contact_len check (char_length(contact) <= 200);

-- Only the intentionally public columns can be read directly (terms fields stay private).
revoke select on public.profiles from anon, authenticated;
grant select (id, display_name, bio, website, contact, created_at) on public.profiles to anon, authenticated;

create or replace function public.set_profile(p_name text, p_bio text, p_website text, p_contact text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := public.require_user();
  n text := btrim(coalesce(p_name, ''));
  b text := btrim(coalesce(p_bio, ''));
  w text := btrim(coalesce(p_website, ''));
  c text := btrim(coalesce(p_contact, ''));
begin
  if char_length(n) < 1 or char_length(n) > 60 then raise exception 'Name must be 1 to 60 characters.'; end if;
  if char_length(b) > 600 then raise exception 'The bio can be at most 600 characters.'; end if;
  if w <> '' and (char_length(w) > 200 or w !~* '^https?://[^[:space:]]+$') then
    raise exception 'The website must start with http:// or https:// and have no spaces.';
  end if;
  if char_length(c) > 200 then raise exception 'The contact line can be at most 200 characters.'; end if;
  update public.profiles set display_name = n, bio = b, website = w, contact = c where id = uid;
  return jsonb_build_object('name', n, 'bio', b, 'website', w, 'contact', c);
end
$$;

create or replace function public.get_my_profile() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return (select jsonb_build_object('id', id, 'name', display_name, 'bio', bio, 'website', website, 'contact', contact)
            from public.profiles where id = uid);
end
$$;

create or replace function public.get_public_profile(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare pr public.profiles%rowtype;
begin
  select * into pr from public.profiles where id = p_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', pr.id, 'name', pr.display_name, 'bio', pr.bio, 'website', pr.website, 'contact', pr.contact,
    'joined', pr.created_at,
    'pieces', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.published_at desc)
      from (
        select pc.id, pc.title, pr.display_name as author, pr.id as author_id, pc.published_at,
               pc.active_seconds, pc.word_count, pc.pasted_chars, pc.paste_events, pc.suspect_batches,
               jsonb_array_length(pc.replay -> 'snapshots') as snapshot_count, pc.spark, pc.band_times
          from public.pieces pc
         where pc.author_id = pr.id and pc.status = 'published'
         order by pc.published_at desc limit 50
      ) x), '[]'::jsonb)
  );
end
$$;

-- Same as before, plus author_id so names can link to profiles.
create or replace function public.get_public_piece(p_piece uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  pc public.pieces%rowtype;
  author text;
begin
  select * into pc from public.pieces where id = p_piece and status = 'published';
  if not found then return null; end if;
  select display_name into author from public.profiles where id = pc.author_id;

  return jsonb_build_object(
    'id', pc.id,
    'title', pc.title,
    'author', coalesce(author, 'Writer'),
    'author_id', pc.author_id,
    'published_at', pc.published_at,
    'word_count', pc.word_count,
    'active_seconds', pc.active_seconds,
    'deletions', pc.deletions,
    'pasted_chars', pc.pasted_chars,
    'paste_events', pc.paste_events,
    'replay', pc.replay,
    'verification', jsonb_build_object(
      'chain_ok', public.verify_chain(p_piece),
      'batches', pc.batch_count,
      'suspect_batches', pc.suspect_batches,
      'server_span_seconds', round(extract(epoch from (pc.last_received_at - pc.first_received_at))),
      'head_hash', pc.head_hash
    )
  );
end
$$;

create or replace function public.list_public_pieces(p_limit int default 24, p_offset int default 0) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.published_at desc), '[]'::jsonb)
  from (
    select pc.id, pc.title, coalesce(pr.display_name, 'Writer') as author, pc.author_id, pc.published_at,
           pc.active_seconds, pc.word_count, pc.pasted_chars, pc.paste_events, pc.suspect_batches,
           jsonb_array_length(pc.replay -> 'snapshots') as snapshot_count, pc.spark, pc.band_times
      from public.pieces pc
      left join public.profiles pr on pr.id = pc.author_id
     where pc.status = 'published'
     order by pc.published_at desc
     limit least(greatest(p_limit, 1), 50) offset greatest(p_offset, 0)
  ) x
$$;

revoke execute on function public.set_profile(text, text, text, text) from public, anon, authenticated;
revoke execute on function public.get_my_profile() from public, anon, authenticated;
revoke execute on function public.get_public_profile(uuid) from public, anon, authenticated;
revoke execute on function public.get_public_piece(uuid) from public, anon, authenticated;
revoke execute on function public.list_public_pieces(int, int) from public, anon, authenticated;
grant execute on function public.set_profile(text, text, text, text) to authenticated;
grant execute on function public.get_my_profile() to authenticated;
grant execute on function public.get_public_profile(uuid) to anon, authenticated;
grant execute on function public.get_public_piece(uuid) to anon, authenticated;
grant execute on function public.list_public_pieces(int, int) to anon, authenticated;

------------------------------------------------------------------------------
-- Part 4: works (art, photo, music, film). Files live in the private "works" storage bucket;
-- each file is chained into a per-work hash chain stamped with the server's clock. Safe to re-run.
------------------------------------------------------------------------------

create table if not exists public.works (
  id               uuid primary key default gen_random_uuid(),
  author_id        uuid not null references auth.users (id) on delete cascade,
  kind             text not null check (kind in ('art', 'photo', 'music', 'film')),
  title            text not null default 'Untitled' check (char_length(title) <= 120),
  description      text not null default '' check (char_length(description) <= 1000),
  status           text not null default 'draft' check (status in ('draft', 'published', 'removed')),
  created_at       timestamptz not null default now(),
  published_at     timestamptz,
  removed_at       timestamptz,
  removed_reason   text,
  item_count       int not null default 0,
  head_hash        text not null default repeat('0', 64),
  first_received_at timestamptz,
  last_received_at  timestamptz
);
create index if not exists works_author_idx on public.works (author_id);
create index if not exists works_published_idx on public.works (published_at desc) where status = 'published';

create table if not exists public.work_items (
  id          uuid primary key default gen_random_uuid(),
  work_id     uuid not null references public.works (id) on delete cascade,
  seq         int not null,
  role        text not null check (role in ('process', 'original', 'project', 'final', 'thumb')),
  path        text not null unique,
  filename    text not null check (char_length(filename) between 1 and 200),
  mime        text not null,
  bytes       bigint not null check (bytes > 0),
  sha256      text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null,
  prev_hash   text not null,
  hash        text not null,
  unique (work_id, seq)
);

alter table public.works      enable row level security;
alter table public.work_items enable row level security;
drop policy if exists works_read      on public.works;
drop policy if exists work_items_read on public.work_items;
create policy works_read on public.works
  for select using (status = 'published' or author_id = (select auth.uid()));
create policy work_items_read on public.work_items
  for select using (exists (select 1 from public.works w where w.id = work_items.work_id
                            and (w.status = 'published' or w.author_id = (select auth.uid()))));
revoke all on public.works, public.work_items from anon, authenticated;
grant select on public.works, public.work_items to anon, authenticated;

-- Reports can now point at a work as well as a piece.
alter table public.reports add column if not exists work_id uuid references public.works (id) on delete cascade;
alter table public.reports alter column piece_id drop not null;
alter table public.reports drop constraint if exists reports_target_check;
alter table public.reports add constraint reports_target_check check (num_nonnulls(piece_id, work_id) = 1);
create index if not exists reports_work_idx on public.reports (work_id);

create or replace function public.item_hash(
  prev text, seq int, received timestamptz, role text, filename text, mime text, bytes bigint, sha text
) returns text
language sql immutable set search_path = ''
as $$
  select encode(sha256(convert_to(concat_ws('|', prev, seq::text,
    to_char(received at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    role, filename, mime, bytes::text, sha), 'UTF8')), 'hex')
$$;

create or replace function public.verify_work_chain(p_work uuid) returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  w public.works%rowtype; it record;
  prev text := repeat('0', 64); expect int := 1;
begin
  select * into w from public.works where id = p_work;
  if not found then return false; end if;
  for it in select * from public.work_items where work_id = p_work order by seq loop
    if it.seq <> expect or it.prev_hash <> prev
       or it.hash <> public.item_hash(prev, it.seq, it.received_at, it.role, it.filename, it.mime, it.bytes, it.sha256) then
      return false;
    end if;
    prev := it.hash; expect := expect + 1;
  end loop;
  return prev = w.head_hash and (expect - 1) = w.item_count;
end
$$;

create or replace function public.limit_work_publishing() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'published' and old.status = 'draft'
     and (select count(*) from public.works
           where author_id = new.author_id and published_at > now() - interval '24 hours') >= 20 then
    raise exception 'daily publishing limit reached (20 per day)';
  end if;
  return new;
end
$$;
drop trigger if exists limit_work_publishing_trg on public.works;
create trigger limit_work_publishing_trg before update on public.works
  for each row execute function public.limit_work_publishing();

create or replace function public.create_work(p_kind text, p_title text default 'Untitled', p_description text default '') returns uuid
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user(); new_id uuid;
begin
  if p_kind is null or p_kind not in ('art', 'photo', 'music', 'film') then raise exception 'unknown kind of work'; end if;
  delete from public.works where author_id = uid and status = 'draft' and item_count = 0 and created_at < now() - interval '14 days';
  if (select count(*) from public.works where author_id = uid and status = 'draft') >= 25 then raise exception 'too many unfinished drafts'; end if;
  if (select count(*) from public.works where author_id = uid and created_at > now() - interval '1 hour') >= 15 then raise exception 'too many new works in the last hour'; end if;
  if (select count(*) from public.works where author_id = uid) >= 200 then raise exception 'work limit reached'; end if;
  insert into public.works (author_id, kind, title, description)
  values (uid, p_kind, coalesce(nullif(left(btrim(p_title), 120), ''), 'Untitled'), left(btrim(coalesce(p_description, '')), 1000))
  returning id into new_id;
  return new_id;
end
$$;

create or replace function public.add_work_item(
  p_work uuid, p_role text, p_path text, p_filename text, p_mime text, p_bytes bigint, p_sha256 text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := public.require_user();
  w public.works%rowtype;
  recv timestamptz; h text; n int; obj_size bigint; used bigint; main_type text;
  fname text := btrim(coalesce(p_filename, ''));
begin
  select * into w from public.works where id = p_work and author_id = uid for update;
  if not found then raise exception 'work not found'; end if;
  if w.status <> 'draft' then raise exception 'this work is published and locked'; end if;
  if p_role is null or p_role not in ('process', 'original', 'project', 'final', 'thumb') then raise exception 'unknown file role'; end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'bad checksum'; end if;
  if p_bytes is null or p_bytes < 1 then raise exception 'empty file'; end if;
  if char_length(fname) < 1 or char_length(fname) > 200 then raise exception 'file name must be 1 to 200 characters'; end if;
  if p_path is null or p_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,140}$'
     or split_part(p_path, '/', 1) <> uid::text or split_part(p_path, '/', 2) <> p_work::text then
    raise exception 'bad file path';
  end if;

  main_type := case w.kind when 'art' then 'image/' when 'photo' then 'image/' when 'music' then 'audio/' else 'video/' end;
  if p_mime = 'application/zip' then
    if p_role not in ('project', 'process', 'original') then raise exception 'zip files can only be project, process or original files'; end if;
  elsif p_mime in ('image/jpeg', 'image/png', 'image/webp') then
    null;
  elsif w.kind = 'music' and p_mime in ('audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/flac', 'audio/ogg', 'audio/aac') then
    null;
  elsif w.kind = 'film' and p_mime in ('video/mp4', 'video/webm', 'video/quicktime') then
    null;
  else
    raise exception 'that file type isn''t accepted for this kind of work';
  end if;
  if p_role = 'final' and left(p_mime, char_length(main_type)) <> main_type then
    raise exception 'the finished work for this kind must be %', trim(trailing '/' from main_type);
  end if;
  if p_role = 'project' and p_mime <> 'application/zip' then raise exception 'project files must be zipped'; end if;
  if p_role = 'thumb' and (p_mime <> 'image/jpeg' or p_bytes > 400000) then raise exception 'bad thumbnail'; end if;
  if p_mime like 'image/%' and p_bytes > 26214400 then raise exception 'images can be at most 25 MB'; end if;
  if p_bytes > 52428800 then raise exception 'files can be at most 50 MB'; end if;

  if (select count(*) from public.work_items where work_id = p_work and role <> 'thumb') >= 40 and p_role <> 'thumb' then
    raise exception 'a work can have at most 40 files';
  end if;
  if (select count(*) from public.work_items i join public.works x on x.id = i.work_id
       where x.author_id = uid and i.received_at > now() - interval '1 hour') >= 120 then
    raise exception 'too many uploads in the last hour';
  end if;
  select coalesce(sum(i.bytes), 0) into used from public.work_items i join public.works x on x.id = i.work_id where x.author_id = uid;
  if used + p_bytes > 262144000 then raise exception 'storage limit reached (250 MB per account)'; end if;

  select (metadata ->> 'size')::bigint into obj_size from storage.objects where bucket_id = 'works' and name = p_path;
  if obj_size is null then raise exception 'the file isn''t in storage yet'; end if;
  if obj_size <> p_bytes then raise exception 'the uploaded file size doesn''t match'; end if;

  recv := clock_timestamp();
  n := w.item_count + 1;
  h := public.item_hash(w.head_hash, n, recv, p_role, fname, p_mime, p_bytes, p_sha256);
  insert into public.work_items (work_id, seq, role, path, filename, mime, bytes, sha256, received_at, prev_hash, hash)
  values (p_work, n, p_role, p_path, fname, p_mime, p_bytes, p_sha256, recv, w.head_hash, h);
  update public.works
     set item_count = n, head_hash = h,
         first_received_at = coalesce(first_received_at, recv), last_received_at = recv
   where id = p_work;
  return jsonb_build_object('seq', n, 'hash', h, 'received_at', recv);
end
$$;

create or replace function public.undo_last_item(p_work uuid) returns text
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user(); w public.works%rowtype; it public.work_items%rowtype; prev_recv timestamptz;
begin
  select * into w from public.works where id = p_work and author_id = uid for update;
  if not found then raise exception 'work not found'; end if;
  if w.status <> 'draft' then raise exception 'this work is published and locked'; end if;
  select * into it from public.work_items where work_id = p_work order by seq desc limit 1;
  if not found then return null; end if;
  delete from public.work_items where id = it.id;
  select received_at into prev_recv from public.work_items where work_id = p_work order by seq desc limit 1;
  update public.works
     set item_count = item_count - 1, head_hash = it.prev_hash,
         last_received_at = prev_recv, first_received_at = case when item_count - 1 = 0 then null else first_received_at end
   where id = p_work;
  return it.path;
end
$$;

create or replace function public.update_work(p_work uuid, p_title text, p_description text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  update public.works
     set title = coalesce(nullif(left(btrim(coalesce(p_title, '')), 120), ''), 'Untitled'),
         description = left(btrim(coalesce(p_description, '')), 1000)
   where id = p_work and author_id = uid and status = 'draft';
  return found;
end
$$;

create or replace function public.publish_work(p_work uuid, p_title text default null, p_description text default null) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user(); w public.works%rowtype;
begin
  select * into w from public.works where id = p_work and author_id = uid for update;
  if not found then raise exception 'work not found'; end if;
  if w.status <> 'draft' then raise exception 'this work is already published'; end if;
  if not exists (select 1 from public.work_items where work_id = p_work and role = 'final') then
    raise exception 'add the finished work before publishing';
  end if;
  update public.works
     set status = 'published', published_at = now(),
         title = coalesce(nullif(left(btrim(coalesce(p_title, title)), 120), ''), 'Untitled'),
         description = left(btrim(coalesce(p_description, description)), 1000)
   where id = p_work;
  return jsonb_build_object('id', p_work);
end
$$;

create or replace function public.delete_work(p_work uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user(); paths jsonb;
begin
  select coalesce(jsonb_agg(i.path), '[]'::jsonb) into paths
    from public.work_items i join public.works w on w.id = i.work_id where w.id = p_work and w.author_id = uid;
  delete from public.works where id = p_work and author_id = uid;
  if not found then raise exception 'work not found'; end if;
  return paths;   -- the browser then removes these files from storage
end
$$;

create or replace function public.my_work_paths() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return coalesce((select jsonb_agg(i.path) from public.work_items i join public.works w on w.id = i.work_id where w.author_id = uid), '[]'::jsonb);
end
$$;

create or replace function public.my_works() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (select id, kind, title, status, created_at, published_at, item_count, removed_reason
              from public.works where author_id = uid) x
  ), '[]'::jsonb);
end
$$;

-- One work with its files and a fresh check of its chain. Public if published; otherwise only for its author.
create or replace function public.get_work(p_work uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare w public.works%rowtype; uid uuid := auth.uid(); author text;
begin
  select * into w from public.works where id = p_work and (status = 'published' or author_id = uid);
  if not found then return null; end if;
  select display_name into author from public.profiles where id = w.author_id;
  return jsonb_build_object(
    'id', w.id, 'kind', w.kind, 'title', w.title, 'description', w.description, 'status', w.status,
    'author', coalesce(author, 'Creator'), 'author_id', w.author_id,
    'published_at', w.published_at, 'created_at', w.created_at,
    'removed_reason', case when w.author_id = uid then w.removed_reason end,
    'mine', (w.author_id = uid),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'seq', i.seq, 'role', i.role, 'path', i.path, 'filename', i.filename, 'mime', i.mime,
        'bytes', i.bytes, 'sha256', i.sha256, 'received_at', i.received_at, 'hash', i.hash) order by i.seq)
        from public.work_items i where i.work_id = w.id), '[]'::jsonb),
    'verification', jsonb_build_object(
      'chain_ok', public.verify_work_chain(w.id),
      'items', w.item_count,
      'server_span_seconds', round(extract(epoch from (w.last_received_at - w.first_received_at))),
      'head_hash', w.head_hash)
  );
end
$$;

create or replace function public.work_rows(p_author uuid, p_kind text, p_limit int, p_offset int) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.published_at desc), '[]'::jsonb)
  from (
    select w.id, w.kind, w.title, coalesce(pr.display_name, 'Creator') as author, w.author_id, w.published_at,
           (select count(*) from public.work_items i where i.work_id = w.id and i.role in ('process', 'original', 'project')) as process_count,
           round(extract(epoch from (w.last_received_at - w.first_received_at))) as span_seconds,
           (select i.path from public.work_items i where i.work_id = w.id and i.role = 'thumb' order by i.seq limit 1) as thumb_path,
           (select i.path from public.work_items i where i.work_id = w.id and i.role = 'final' order by i.seq limit 1) as final_path,
           (select i.mime from public.work_items i where i.work_id = w.id and i.role = 'final' order by i.seq limit 1) as final_mime
      from public.works w
      left join public.profiles pr on pr.id = w.author_id
     where w.status = 'published'
       and (p_author is null or w.author_id = p_author)
       and (p_kind is null or w.kind = p_kind)
     order by w.published_at desc
     limit least(greatest(p_limit, 1), 50) offset greatest(p_offset, 0)
  ) x
$$;

create or replace function public.list_public_works(p_kind text default null, p_limit int default 24, p_offset int default 0) returns jsonb
language sql stable security definer set search_path = ''
as $$ select public.work_rows(null, p_kind, p_limit, p_offset) $$;

-- Profile pages now list works as well as writing.
create or replace function public.get_public_profile(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare pr public.profiles%rowtype;
begin
  select * into pr from public.profiles where id = p_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', pr.id, 'name', pr.display_name, 'bio', pr.bio, 'website', pr.website, 'contact', pr.contact,
    'joined', pr.created_at,
    'pieces', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.published_at desc)
      from (
        select pc.id, pc.title, pr.display_name as author, pr.id as author_id, pc.published_at,
               pc.active_seconds, pc.word_count, pc.pasted_chars, pc.paste_events, pc.suspect_batches,
               jsonb_array_length(pc.replay -> 'snapshots') as snapshot_count, pc.spark, pc.band_times
          from public.pieces pc
         where pc.author_id = pr.id and pc.status = 'published'
         order by pc.published_at desc limit 50
      ) x), '[]'::jsonb),
    'works', public.work_rows(pr.id, null, 50, 0)
  );
end
$$;

-- Reports and takedowns for works.
create or replace function public.report_work(p_work uuid, p_reason text, p_details text default null) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := auth.uid();
begin
  if p_reason is null or p_reason not in ('ai_or_retyped', 'copyright', 'harassment', 'illegal', 'spam', 'other') then
    raise exception 'unknown reason';
  end if;
  if not exists (select 1 from public.works where id = p_work and status = 'published') then raise exception 'work not found'; end if;
  if uid is not null and (select count(*) from public.reports where reporter_id = uid and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'too many reports today';
  end if;
  if (select count(*) from public.reports where work_id = p_work and status = 'open') >= 25 then return true; end if;
  insert into public.reports (work_id, reporter_id, reason, details)
  values (p_work, uid, p_reason, nullif(left(btrim(coalesce(p_details, '')), 1000), ''));
  return true;
end
$$;

create or replace function public.admin_remove_work(p_work uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.works
     set status = 'removed', removed_at = now(), removed_reason = nullif(left(btrim(coalesce(p_reason, '')), 500), '')
   where id = p_work and status = 'published';
  if not found then return false; end if;
  update public.reports set status = 'actioned' where work_id = p_work and status = 'open';
  return true;
end
$$;

create or replace function public.admin_restore_work(p_work uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.works set status = 'published', removed_at = null, removed_reason = null
   where id = p_work and status = 'removed' and published_at is not null;
  return found;
end
$$;

create or replace function public.admin_dismiss_work_reports(p_work uuid) returns int
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  update public.reports set status = 'dismissed' where work_id = p_work and status = 'open';
  get diagnostics n = row_count;
  return n;
end
$$;

-- Data export now includes works (file details and checksums; the files themselves aren't bundled).
create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = uid),
    'pieces', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pc.id, 'title', pc.title, 'status', pc.status,
               'created_at', pc.created_at, 'published_at', pc.published_at,
               'final_text', pc.final_text,
               'batches', (select coalesce(jsonb_agg(to_jsonb(b) order by b.seq), '[]'::jsonb)
                             from public.piece_batches b where b.piece_id = pc.id))
             order by pc.created_at)
        from public.pieces pc where pc.author_id = uid), '[]'::jsonb),
    'works', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'kind', w.kind, 'title', w.title, 'description', w.description, 'status', w.status,
               'created_at', w.created_at, 'published_at', w.published_at,
               'files', (select coalesce(jsonb_agg(jsonb_build_object(
                          'seq', i.seq, 'role', i.role, 'filename', i.filename, 'mime', i.mime, 'bytes', i.bytes,
                          'sha256', i.sha256, 'received_at', i.received_at) order by i.seq), '[]'::jsonb)
                          from public.work_items i where i.work_id = w.id))
             order by w.created_at)
        from public.works w where w.author_id = uid), '[]'::jsonb)
  );
end
$$;

-- File storage: a private bucket, owner-only uploads into their own draft works, public reads only once published.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('works', 'works', false, 52428800, array[
  'image/jpeg', 'image/png', 'image/webp',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/flac', 'audio/ogg', 'audio/aac',
  'video/mp4', 'video/webm', 'video/quicktime', 'application/zip'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.work_file_is_published(p_path text) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.work_items i join public.works w on w.id = i.work_id
                      where i.path = p_path and w.status = 'published') $$;

create or replace function public.work_is_my_draft(p_work text) returns boolean
language sql stable security definer set search_path = ''
as $$ select exists (select 1 from public.works w where w.id::text = p_work and w.author_id = auth.uid() and w.status = 'draft') $$;

drop policy if exists works_files_insert on storage.objects;
drop policy if exists works_files_select on storage.objects;
drop policy if exists works_files_delete on storage.objects;
create policy works_files_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'works'
              and (storage.foldername(name))[1] = (select auth.uid())::text
              and public.work_is_my_draft((storage.foldername(name))[2]));
create policy works_files_select on storage.objects for select to anon, authenticated
  using (bucket_id = 'works'
         and ((storage.foldername(name))[1] = (select auth.uid())::text or public.work_file_is_published(name)));
create policy works_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'works'
         and (storage.foldername(name))[1] = (select auth.uid())::text
         and not public.work_file_is_published(name));

-- Who may call what
revoke execute on function public.item_hash(text, int, timestamptz, text, text, text, bigint, text) from public, anon, authenticated;
revoke execute on function public.verify_work_chain(uuid) from public, anon, authenticated;
revoke execute on function public.limit_work_publishing() from public, anon, authenticated;
revoke execute on function public.work_rows(uuid, text, int, int) from public, anon, authenticated;
revoke execute on function public.create_work(text, text, text) from public, anon, authenticated;
revoke execute on function public.add_work_item(uuid, text, text, text, text, bigint, text) from public, anon, authenticated;
revoke execute on function public.undo_last_item(uuid) from public, anon, authenticated;
revoke execute on function public.update_work(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.publish_work(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.delete_work(uuid) from public, anon, authenticated;
revoke execute on function public.my_work_paths() from public, anon, authenticated;
revoke execute on function public.my_works() from public, anon, authenticated;
revoke execute on function public.get_work(uuid) from public, anon, authenticated;
revoke execute on function public.list_public_works(text, int, int) from public, anon, authenticated;
revoke execute on function public.get_public_profile(uuid) from public, anon, authenticated;
revoke execute on function public.report_work(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.admin_remove_work(uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_restore_work(uuid) from public, anon, authenticated;
revoke execute on function public.admin_dismiss_work_reports(uuid) from public, anon, authenticated;
revoke execute on function public.export_my_data() from public, anon, authenticated;
revoke execute on function public.work_file_is_published(text) from public, anon, authenticated;
revoke execute on function public.work_is_my_draft(text) from public, anon, authenticated;

grant execute on function public.create_work(text, text, text) to authenticated;
grant execute on function public.add_work_item(uuid, text, text, text, text, bigint, text) to authenticated;
grant execute on function public.undo_last_item(uuid) to authenticated;
grant execute on function public.update_work(uuid, text, text) to authenticated;
grant execute on function public.publish_work(uuid, text, text) to authenticated;
grant execute on function public.delete_work(uuid) to authenticated;
grant execute on function public.my_work_paths() to authenticated;
grant execute on function public.my_works() to authenticated;
grant execute on function public.export_my_data() to authenticated;
grant execute on function public.get_work(uuid) to anon, authenticated;
grant execute on function public.list_public_works(text, int, int) to anon, authenticated;
grant execute on function public.get_public_profile(uuid) to anon, authenticated;
grant execute on function public.report_work(uuid, text, text) to anon, authenticated;
grant execute on function public.work_file_is_published(text) to anon, authenticated;
grant execute on function public.work_is_my_draft(text) to anon, authenticated;

------------------------------------------------------------------------------
-- Part 5: feedback. Thumbs up or down and comments on published pieces and works, for signed-in
-- people only (everyone can read). Comments have no votes. Safe to re-run.
------------------------------------------------------------------------------

create table if not exists public.comments (
  id             uuid primary key default gen_random_uuid(),
  piece_id       uuid references public.pieces (id) on delete cascade,
  work_id        uuid references public.works (id) on delete cascade,
  author_id      uuid not null references auth.users (id) on delete cascade,
  body           text not null check (char_length(body) between 1 and 1000),
  created_at     timestamptz not null default now(),
  removed_at     timestamptz,
  removed_reason text,
  check (num_nonnulls(piece_id, work_id) = 1)
);
create index if not exists comments_piece_idx  on public.comments (piece_id, created_at) where piece_id is not null;
create index if not exists comments_work_idx   on public.comments (work_id, created_at) where work_id is not null;
create index if not exists comments_author_idx on public.comments (author_id, created_at);

create table if not exists public.reactions (
  id         uuid primary key default gen_random_uuid(),
  piece_id   uuid references public.pieces (id) on delete cascade,
  work_id    uuid references public.works (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  value      smallint not null check (value in (1, -1)),
  created_at timestamptz not null default now(),
  check (num_nonnulls(piece_id, work_id) = 1)
);
create unique index if not exists reactions_user_piece on public.reactions (user_id, piece_id) where piece_id is not null;
create unique index if not exists reactions_user_work  on public.reactions (user_id, work_id)  where work_id is not null;
create index if not exists reactions_piece_idx on public.reactions (piece_id) where piece_id is not null;
create index if not exists reactions_work_idx  on public.reactions (work_id)  where work_id is not null;

alter table public.comments  enable row level security;
alter table public.reactions enable row level security;
revoke all on public.comments, public.reactions from anon, authenticated;   -- only the functions below touch them

-- Comments can be reported like pieces and works.
alter table public.reports add column if not exists comment_id uuid references public.comments (id) on delete cascade;
alter table public.reports drop constraint if exists reports_target_check;
alter table public.reports add constraint reports_target_check check (num_nonnulls(piece_id, work_id, comment_id) = 1);
create index if not exists reports_comment_idx on public.reports (comment_id);

create or replace function public.feedback_owner(p_kind text, p_id uuid) returns uuid
language sql stable security definer set search_path = ''
as $$
  select case p_kind
    when 'piece' then (select author_id from public.pieces where id = p_id and status = 'published')
    when 'work'  then (select author_id from public.works  where id = p_id and status = 'published')
  end
$$;

create or replace function public.set_reaction(p_kind text, p_id uuid, p_value int) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  if p_value is null or p_value not in (-1, 0, 1) then raise exception 'bad reaction'; end if;
  if public.feedback_owner(p_kind, p_id) is null then raise exception 'not found'; end if;
  if p_value = 0 then
    if p_kind = 'piece' then delete from public.reactions where user_id = uid and piece_id = p_id;
    else delete from public.reactions where user_id = uid and work_id = p_id; end if;
  else
    if p_kind = 'piece' then
      update public.reactions set value = p_value where user_id = uid and piece_id = p_id;
    else
      update public.reactions set value = p_value where user_id = uid and work_id = p_id;
    end if;
    if not found then
      if (select count(*) from public.reactions where user_id = uid and created_at > now() - interval '1 hour') >= 120 then
        raise exception 'too many reactions in the last hour';
      end if;
      insert into public.reactions (piece_id, work_id, user_id, value)
      values (case when p_kind = 'piece' then p_id end, case when p_kind = 'work' then p_id end, uid, p_value);
    end if;
  end if;
  return jsonb_build_object(
    'up',   (select count(*) from public.reactions where value = 1  and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'down', (select count(*) from public.reactions where value = -1 and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'mine', p_value);
end
$$;

create or replace function public.get_feedback(p_kind text, p_id uuid, p_order text default 'newest', p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := auth.uid(); owner uuid := public.feedback_owner(p_kind, p_id); lim int := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if owner is null then return null; end if;
  return jsonb_build_object(
    'up',   (select count(*) from public.reactions where value = 1  and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'down', (select count(*) from public.reactions where value = -1 and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'mine', (select value from public.reactions where user_id = uid and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'can_moderate', (uid is not null and uid = owner),
    'total', (select count(*) from public.comments where removed_at is null and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'comments', coalesce((
      select jsonb_agg(to_jsonb(x) order by case when p_order = 'oldest' then x.created_at end asc, case when p_order = 'oldest' then null else x.created_at end desc, x.id)
      from (
        select c.id, coalesce(pr.display_name, 'Someone') as author, c.author_id, c.body, c.created_at, (c.author_id = uid) as mine
          from public.comments c left join public.profiles pr on pr.id = c.author_id
         where c.removed_at is null and (case when p_kind = 'piece' then c.piece_id else c.work_id end) = p_id
         order by case when p_order = 'oldest' then c.created_at end asc, c.created_at desc, c.id
         limit lim offset greatest(coalesce(p_offset, 0), 0)
      ) x), '[]'::jsonb)
  );
end
$$;

create or replace function public.add_comment(p_kind text, p_id uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := public.require_user();
  b text := btrim(coalesce(p_body, ''));
  new_id uuid; made timestamptz;
begin
  if char_length(b) < 1 then raise exception 'Write something first.'; end if;
  if char_length(b) > 1000 then raise exception 'Comments can be at most 1000 characters.'; end if;
  if public.feedback_owner(p_kind, p_id) is null then raise exception 'not found'; end if;
  if (select count(*) from public.comments where author_id = uid and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'You’re commenting very fast. Try again in a little while.';
  end if;
  if (select count(*) from public.comments where author_id = uid and created_at > now() - interval '24 hours') >= 100 then
    raise exception 'You’ve reached the daily comment limit.';
  end if;
  if (select count(*) from public.comments where author_id = uid and (case when p_kind = 'piece' then piece_id else work_id end) = p_id) >= 20 then
    raise exception 'You’ve left a lot of comments here already.';
  end if;
  if exists (select 1 from public.comments where author_id = uid and body = b and created_at > now() - interval '10 minutes') then
    raise exception 'You already posted that.';
  end if;
  insert into public.comments (piece_id, work_id, author_id, body)
  values (case when p_kind = 'piece' then p_id end, case when p_kind = 'work' then p_id end, uid, b)
  returning id, created_at into new_id, made;
  return jsonb_build_object('id', new_id, 'created_at', made);
end
$$;

-- The author of a comment, or the owner of the piece or work it's on, can delete it.
create or replace function public.delete_comment(p_comment uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user(); c public.comments%rowtype; owner uuid;
begin
  select * into c from public.comments where id = p_comment;
  if not found then return false; end if;
  owner := coalesce((select author_id from public.pieces where id = c.piece_id), (select author_id from public.works where id = c.work_id));
  if c.author_id <> uid and owner is distinct from uid then raise exception 'not allowed'; end if;
  delete from public.comments where id = p_comment;
  return true;
end
$$;

create or replace function public.report_comment(p_comment uuid, p_reason text, p_details text default null) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := auth.uid(); c public.comments%rowtype;
begin
  if p_reason is null or p_reason not in ('harassment', 'illegal', 'spam', 'copyright', 'other') then raise exception 'unknown reason'; end if;
  select * into c from public.comments where id = p_comment and removed_at is null;
  if not found or public.feedback_owner(case when c.piece_id is not null then 'piece' else 'work' end, coalesce(c.piece_id, c.work_id)) is null then
    raise exception 'comment not found';
  end if;
  if uid is not null and (select count(*) from public.reports where reporter_id = uid and created_at > now() - interval '24 hours') >= 20 then
    raise exception 'too many reports today';
  end if;
  if (select count(*) from public.reports where comment_id = p_comment and status = 'open') >= 25 then return true; end if;
  insert into public.reports (comment_id, reporter_id, reason, details)
  values (p_comment, uid, p_reason, nullif(left(btrim(coalesce(p_details, '')), 1000), ''));
  return true;
end
$$;

create or replace function public.admin_remove_comment(p_comment uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.comments set removed_at = now(), removed_reason = nullif(left(btrim(coalesce(p_reason, '')), 500), '')
   where id = p_comment and removed_at is null;
  if not found then return false; end if;
  update public.reports set status = 'actioned' where comment_id = p_comment and status = 'open';
  return true;
end
$$;

create or replace function public.admin_restore_comment(p_comment uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$
begin
  update public.comments set removed_at = null, removed_reason = null where id = p_comment and removed_at is not null;
  return found;
end
$$;

create or replace function public.admin_dismiss_comment_reports(p_comment uuid) returns int
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  update public.reports set status = 'dismissed' where comment_id = p_comment and status = 'open';
  get diagnostics n = row_count;
  return n;
end
$$;

-- Data export now includes your comments and reactions.
create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = uid),
    'pieces', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pc.id, 'title', pc.title, 'status', pc.status,
               'created_at', pc.created_at, 'published_at', pc.published_at,
               'final_text', pc.final_text,
               'batches', (select coalesce(jsonb_agg(to_jsonb(b) order by b.seq), '[]'::jsonb)
                             from public.piece_batches b where b.piece_id = pc.id))
             order by pc.created_at)
        from public.pieces pc where pc.author_id = uid), '[]'::jsonb),
    'works', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'kind', w.kind, 'title', w.title, 'description', w.description, 'status', w.status,
               'created_at', w.created_at, 'published_at', w.published_at,
               'files', (select coalesce(jsonb_agg(jsonb_build_object(
                          'seq', i.seq, 'role', i.role, 'filename', i.filename, 'mime', i.mime, 'bytes', i.bytes,
                          'sha256', i.sha256, 'received_at', i.received_at) order by i.seq), '[]'::jsonb)
                          from public.work_items i where i.work_id = w.id))
             order by w.created_at)
        from public.works w where w.author_id = uid), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'piece_id', c.piece_id, 'work_id', c.work_id, 'body', c.body, 'created_at', c.created_at) order by c.created_at)
                            from public.comments c where c.author_id = uid), '[]'::jsonb),
    'reactions', coalesce((select jsonb_agg(jsonb_build_object('piece_id', r.piece_id, 'work_id', r.work_id, 'value', r.value, 'created_at', r.created_at) order by r.created_at)
                            from public.reactions r where r.user_id = uid), '[]'::jsonb)
  );
end
$$;

revoke execute on function public.feedback_owner(text, uuid) from public, anon, authenticated;
revoke execute on function public.set_reaction(text, uuid, int) from public, anon, authenticated;
revoke execute on function public.get_feedback(text, uuid, text, int, int) from public, anon, authenticated;
revoke execute on function public.add_comment(text, uuid, text) from public, anon, authenticated;
revoke execute on function public.delete_comment(uuid) from public, anon, authenticated;
revoke execute on function public.report_comment(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.admin_remove_comment(uuid, text) from public, anon, authenticated;
revoke execute on function public.admin_restore_comment(uuid) from public, anon, authenticated;
revoke execute on function public.admin_dismiss_comment_reports(uuid) from public, anon, authenticated;
revoke execute on function public.export_my_data() from public, anon, authenticated;
grant execute on function public.set_reaction(text, uuid, int) to authenticated;
grant execute on function public.add_comment(text, uuid, text) to authenticated;
grant execute on function public.delete_comment(uuid) to authenticated;
grant execute on function public.export_my_data() to authenticated;
grant execute on function public.get_feedback(text, uuid, text, int, int) to anon, authenticated;
grant execute on function public.report_comment(uuid, text, text) to anon, authenticated;

------------------------------------------------------------------------------
-- Part 6: visibility. A piece or work can be "public" (listed in Browse and on the writer page) or
-- "unlisted" (reachable only by its link). A profile can be "public" or "link" (not listed or linked from
-- anywhere; its page still opens for anyone who has the address). Safe to re-run.
------------------------------------------------------------------------------

alter table public.pieces   add column if not exists visibility text not null default 'public' check (visibility in ('public', 'unlisted'));
alter table public.works    add column if not exists visibility text not null default 'public' check (visibility in ('public', 'unlisted'));
alter table public.profiles add column if not exists visibility text not null default 'public' check (visibility in ('public', 'link'));

-- Direct table reads (the app never uses them) now stop at public rows, so an unlisted address can't be found
-- by listing the tables. Anyone with the link still reads it through the functions below.
drop policy if exists pieces_read       on public.pieces;
drop policy if exists batches_read      on public.piece_batches;
drop policy if exists works_read        on public.works;
drop policy if exists work_items_read   on public.work_items;
drop policy if exists profiles_read     on public.profiles;
create policy pieces_read on public.pieces
  for select using ((status = 'published' and visibility = 'public') or author_id = (select auth.uid()));
create policy batches_read on public.piece_batches
  for select using (exists (select 1 from public.pieces p where p.id = piece_batches.piece_id
                            and ((p.status = 'published' and p.visibility = 'public') or p.author_id = (select auth.uid()))));
create policy works_read on public.works
  for select using ((status = 'published' and visibility = 'public') or author_id = (select auth.uid()));
create policy work_items_read on public.work_items
  for select using (exists (select 1 from public.works w where w.id = work_items.work_id
                            and ((w.status = 'published' and w.visibility = 'public') or w.author_id = (select auth.uid()))));
create policy profiles_read on public.profiles
  for select using (visibility = 'public' or id = (select auth.uid()));

revoke select on public.profiles from anon, authenticated;
grant select (id, display_name, bio, website, contact, created_at, visibility) on public.profiles to anon, authenticated;

-- The profile id to link a name to, or null when that person keeps their page unlinked.
create or replace function public.listed_author(p_id uuid) returns uuid
language sql stable security definer set search_path = ''
as $$ select id from public.profiles where id = p_id and visibility = 'public' $$;

create or replace function public.set_visibility(p_kind text, p_id uuid, p_value text) returns text
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user(); n int;
begin
  if p_value is null or p_value not in ('public', 'unlisted') then raise exception 'Choose public or unlisted.'; end if;
  if p_kind = 'piece' then
    update public.pieces set visibility = p_value where id = p_id and author_id = uid and status in ('draft', 'published');
  elsif p_kind = 'work' then
    update public.works set visibility = p_value where id = p_id and author_id = uid and status in ('draft', 'published');
  else
    raise exception 'Unknown kind.';
  end if;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'Not found.'; end if;
  return p_value;
end
$$;

create or replace function public.set_profile_visibility(p_value text) returns text
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  if p_value is null or p_value not in ('public', 'link') then raise exception 'Choose public or link.'; end if;
  update public.profiles set visibility = p_value where id = uid;
  return p_value;
end
$$;

create or replace function public.get_my_profile() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return (select jsonb_build_object('id', id, 'name', display_name, 'bio', bio, 'website', website, 'contact', contact, 'visibility', visibility)
            from public.profiles where id = uid);
end
$$;

create or replace function public.my_pieces() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (
        select id, title, status, visibility, created_at, published_at, word_count, active_seconds,
               pasted_chars, paste_events, suspect_batches, removed_reason
          from public.pieces where author_id = uid
      ) x
  ), '[]'::jsonb);
end
$$;

create or replace function public.my_works() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
      from (select id, kind, title, status, visibility, created_at, published_at, item_count, removed_reason
              from public.works where author_id = uid) x
  ), '[]'::jsonb);
end
$$;

-- One published piece, by its address. Unlisted pieces open here too; they just aren't listed anywhere.
create or replace function public.get_public_piece(p_piece uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  pc public.pieces%rowtype;
  author text;
begin
  select * into pc from public.pieces where id = p_piece and status = 'published';
  if not found then return null; end if;
  select display_name into author from public.profiles where id = pc.author_id;

  return jsonb_build_object(
    'id', pc.id,
    'title', pc.title,
    'author', coalesce(author, 'Writer'),
    'author_id', public.listed_author(pc.author_id),
    'visibility', pc.visibility,
    'mine', coalesce(pc.author_id = auth.uid(), false),
    'published_at', pc.published_at,
    'word_count', pc.word_count,
    'active_seconds', pc.active_seconds,
    'deletions', pc.deletions,
    'pasted_chars', pc.pasted_chars,
    'paste_events', pc.paste_events,
    'replay', pc.replay,
    'verification', jsonb_build_object(
      'chain_ok', public.verify_chain(p_piece),
      'batches', pc.batch_count,
      'suspect_batches', pc.suspect_batches,
      'server_span_seconds', round(extract(epoch from (pc.last_received_at - pc.first_received_at))),
      'head_hash', pc.head_hash
    )
  );
end
$$;

create or replace function public.list_public_pieces(p_limit int default 24, p_offset int default 0) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.published_at desc), '[]'::jsonb)
  from (
    select pc.id, pc.title, coalesce(pr.display_name, 'Writer') as author, public.listed_author(pc.author_id) as author_id, pc.published_at,
           pc.active_seconds, pc.word_count, pc.pasted_chars, pc.paste_events, pc.suspect_batches,
           jsonb_array_length(pc.replay -> 'snapshots') as snapshot_count, pc.spark, pc.band_times
      from public.pieces pc
      left join public.profiles pr on pr.id = pc.author_id
     where pc.status = 'published' and pc.visibility = 'public'
     order by pc.published_at desc
     limit least(greatest(p_limit, 1), 50) offset greatest(p_offset, 0)
  ) x
$$;

create or replace function public.get_work(p_work uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare w public.works%rowtype; uid uuid := auth.uid(); author text;
begin
  select * into w from public.works where id = p_work and (status = 'published' or author_id = uid);
  if not found then return null; end if;
  select display_name into author from public.profiles where id = w.author_id;
  return jsonb_build_object(
    'id', w.id, 'kind', w.kind, 'title', w.title, 'description', w.description, 'status', w.status,
    'visibility', w.visibility,
    'author', coalesce(author, 'Creator'), 'author_id', public.listed_author(w.author_id),
    'published_at', w.published_at, 'created_at', w.created_at,
    'removed_reason', case when w.author_id = uid then w.removed_reason end,
    'mine', coalesce(w.author_id = uid, false),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'seq', i.seq, 'role', i.role, 'path', i.path, 'filename', i.filename, 'mime', i.mime,
        'bytes', i.bytes, 'sha256', i.sha256, 'received_at', i.received_at, 'hash', i.hash) order by i.seq)
        from public.work_items i where i.work_id = w.id), '[]'::jsonb),
    'verification', jsonb_build_object(
      'chain_ok', public.verify_work_chain(w.id),
      'items', w.item_count,
      'server_span_seconds', round(extract(epoch from (w.last_received_at - w.first_received_at))),
      'head_hash', w.head_hash)
  );
end
$$;

create or replace function public.work_rows(p_author uuid, p_kind text, p_limit int, p_offset int) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.published_at desc), '[]'::jsonb)
  from (
    select w.id, w.kind, w.title, coalesce(pr.display_name, 'Creator') as author, public.listed_author(w.author_id) as author_id, w.published_at,
           (select count(*) from public.work_items i where i.work_id = w.id and i.role in ('process', 'original', 'project')) as process_count,
           round(extract(epoch from (w.last_received_at - w.first_received_at))) as span_seconds,
           (select i.path from public.work_items i where i.work_id = w.id and i.role = 'thumb' order by i.seq limit 1) as thumb_path,
           (select i.path from public.work_items i where i.work_id = w.id and i.role = 'final' order by i.seq limit 1) as final_path,
           (select i.mime from public.work_items i where i.work_id = w.id and i.role = 'final' order by i.seq limit 1) as final_mime
      from public.works w
      left join public.profiles pr on pr.id = w.author_id
     where w.status = 'published' and w.visibility = 'public'
       and (p_author is null or w.author_id = p_author)
       and (p_kind is null or w.kind = p_kind)
     order by w.published_at desc
     limit least(greatest(p_limit, 1), 50) offset greatest(p_offset, 0)
  ) x
$$;

-- A writer page. It opens for anyone who has the address, whether the profile is public or link-only,
-- and lists only the pieces and works marked public.
create or replace function public.get_public_profile(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare pr public.profiles%rowtype;
begin
  select * into pr from public.profiles where id = p_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', pr.id, 'name', pr.display_name, 'bio', pr.bio, 'website', pr.website, 'contact', pr.contact,
    'visibility', pr.visibility, 'mine', coalesce(pr.id = auth.uid(), false),
    'joined', pr.created_at,
    'pieces', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.published_at desc)
      from (
        select pc.id, pc.title, pr.display_name as author, null::uuid as author_id, pc.published_at,
               pc.active_seconds, pc.word_count, pc.pasted_chars, pc.paste_events, pc.suspect_batches,
               jsonb_array_length(pc.replay -> 'snapshots') as snapshot_count, pc.spark, pc.band_times
          from public.pieces pc
         where pc.author_id = pr.id and pc.status = 'published' and pc.visibility = 'public'
         order by pc.published_at desc limit 50
      ) x), '[]'::jsonb),
    'works', public.work_rows(pr.id, null, 50, 0)
  );
end
$$;

-- Comment authors link to their page only when that page is listed.
create or replace function public.get_feedback(p_kind text, p_id uuid, p_order text default 'newest', p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := auth.uid(); owner uuid := public.feedback_owner(p_kind, p_id); lim int := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if owner is null then return null; end if;
  return jsonb_build_object(
    'up',   (select count(*) from public.reactions where value = 1  and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'down', (select count(*) from public.reactions where value = -1 and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'mine', (select value from public.reactions where user_id = uid and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'can_moderate', (uid is not null and uid = owner),
    'total', (select count(*) from public.comments where removed_at is null and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'comments', coalesce((
      select jsonb_agg(to_jsonb(x) order by case when p_order = 'oldest' then x.created_at end asc, case when p_order = 'oldest' then null else x.created_at end desc, x.id)
      from (
        select c.id, coalesce(pr.display_name, 'Someone') as author, public.listed_author(c.author_id) as author_id, c.body, c.created_at, (c.author_id = uid) as mine
          from public.comments c left join public.profiles pr on pr.id = c.author_id
         where c.removed_at is null and (case when p_kind = 'piece' then c.piece_id else c.work_id end) = p_id
         order by case when p_order = 'oldest' then c.created_at end asc, c.created_at desc, c.id
         limit lim offset greatest(coalesce(p_offset, 0), 0)
      ) x), '[]'::jsonb)
  );
end
$$;

create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = uid),
    'pieces', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pc.id, 'title', pc.title, 'status', pc.status, 'visibility', pc.visibility,
               'created_at', pc.created_at, 'published_at', pc.published_at,
               'final_text', pc.final_text,
               'batches', (select coalesce(jsonb_agg(to_jsonb(b) order by b.seq), '[]'::jsonb)
                             from public.piece_batches b where b.piece_id = pc.id))
             order by pc.created_at)
        from public.pieces pc where pc.author_id = uid), '[]'::jsonb),
    'works', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'kind', w.kind, 'title', w.title, 'description', w.description, 'status', w.status, 'visibility', w.visibility,
               'created_at', w.created_at, 'published_at', w.published_at,
               'files', (select coalesce(jsonb_agg(jsonb_build_object(
                          'seq', i.seq, 'role', i.role, 'filename', i.filename, 'mime', i.mime, 'bytes', i.bytes,
                          'sha256', i.sha256, 'received_at', i.received_at) order by i.seq), '[]'::jsonb)
                          from public.work_items i where i.work_id = w.id))
             order by w.created_at)
        from public.works w where w.author_id = uid), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'piece_id', c.piece_id, 'work_id', c.work_id, 'body', c.body, 'created_at', c.created_at) order by c.created_at)
                            from public.comments c where c.author_id = uid), '[]'::jsonb),
    'reactions', coalesce((select jsonb_agg(jsonb_build_object('piece_id', r.piece_id, 'work_id', r.work_id, 'value', r.value, 'created_at', r.created_at) order by r.created_at)
                            from public.reactions r where r.user_id = uid), '[]'::jsonb)
  );
end
$$;

revoke execute on function public.listed_author(uuid) from public, anon, authenticated;
revoke execute on function public.set_visibility(text, uuid, text) from public, anon, authenticated;
revoke execute on function public.set_profile_visibility(text) from public, anon, authenticated;
revoke execute on function public.get_my_profile() from public, anon, authenticated;
revoke execute on function public.my_pieces() from public, anon, authenticated;
revoke execute on function public.my_works() from public, anon, authenticated;
revoke execute on function public.get_public_piece(uuid) from public, anon, authenticated;
revoke execute on function public.list_public_pieces(int, int) from public, anon, authenticated;
revoke execute on function public.get_work(uuid) from public, anon, authenticated;
revoke execute on function public.work_rows(uuid, text, int, int) from public, anon, authenticated;
revoke execute on function public.get_public_profile(uuid) from public, anon, authenticated;
revoke execute on function public.get_feedback(text, uuid, text, int, int) from public, anon, authenticated;
revoke execute on function public.export_my_data() from public, anon, authenticated;
grant execute on function public.set_visibility(text, uuid, text) to authenticated;
grant execute on function public.set_profile_visibility(text) to authenticated;
grant execute on function public.get_my_profile() to authenticated;
grant execute on function public.my_pieces() to authenticated;
grant execute on function public.my_works() to authenticated;
grant execute on function public.get_public_piece(uuid) to anon, authenticated;
grant execute on function public.list_public_pieces(int, int) to anon, authenticated;
grant execute on function public.get_work(uuid) to anon, authenticated;
grant execute on function public.get_public_profile(uuid) to anon, authenticated;
grant execute on function public.get_feedback(text, uuid, text, int, int) to anon, authenticated;
grant execute on function public.export_my_data() to authenticated;

------------------------------------------------------------------------------
-- Part 7: the artists page. People with a public profile and at least one public published piece or work.
-- p_kind: null for everyone, or writing / art / photo / music / film. Safe to re-run.
------------------------------------------------------------------------------

create or replace function public.list_creators(p_kind text default null, p_limit int default 24, p_offset int default 0) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.latest desc, x.name, x.id), '[]'::jsonb)
  from (
    select pr.id, pr.display_name as name, left(coalesce(pr.bio, ''), 140) as bio,
           a.writing, a.art, a.photo, a.music, a.film, a.latest
      from (
        select i.author_id,
               count(*) filter (where i.kind = 'writing')::int as writing,
               count(*) filter (where i.kind = 'art')::int     as art,
               count(*) filter (where i.kind = 'photo')::int   as photo,
               count(*) filter (where i.kind = 'music')::int   as music,
               count(*) filter (where i.kind = 'film')::int    as film,
               max(i.published_at) as latest
          from (
            select author_id, 'writing'::text as kind, published_at from public.pieces where status = 'published' and visibility = 'public'
            union all
            select author_id, kind, published_at from public.works where status = 'published' and visibility = 'public'
          ) i
         group by i.author_id
        having p_kind is null or count(*) filter (where i.kind = p_kind) > 0
      ) a
      join public.profiles pr on pr.id = a.author_id and pr.visibility = 'public'
     order by a.latest desc, pr.display_name, pr.id
     limit least(greatest(coalesce(p_limit, 24), 1), 50) offset greatest(coalesce(p_offset, 0), 0)
  ) x
$$;

revoke execute on function public.list_creators(text, int, int) from public, anon, authenticated;
grant execute on function public.list_creators(text, int, int) to anon, authenticated;

------------------------------------------------------------------------------
-- Part 8: tighter music. A take recorded in the browser is accepted only if the server's own clock shows
-- that at least as much time passed as the take is long, so a finished recording can't be uploaded faster
-- than it could have been made. Such files are stored with the role "live", which is part of the chain.
-- Also an optional release link. Safe to re-run.
------------------------------------------------------------------------------

alter table public.work_items drop constraint if exists work_items_role_check;
alter table public.work_items add constraint work_items_role_check check (role in ('process', 'original', 'project', 'final', 'thumb', 'live'));
alter table public.work_items add column if not exists live_claimed_ms int;
alter table public.work_items add column if not exists live_elapsed_ms int;
alter table public.works add column if not exists release_url text check (release_url is null or release_url ~ '^https://[^[:space:]]{3,255}$');

update storage.buckets set allowed_mime_types = array[
  'image/jpeg', 'image/png', 'image/webp',
  'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/flac', 'audio/ogg', 'audio/aac', 'audio/webm',
  'video/mp4', 'video/webm', 'video/quicktime', 'application/zip'] where id = 'works';

create table if not exists public.take_sessions (
  id         uuid primary key default gen_random_uuid(),
  work_id    uuid not null references public.works (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  started_at timestamptz not null default clock_timestamp(),
  used       boolean not null default false
);
alter table public.take_sessions enable row level security;
revoke all on public.take_sessions from anon, authenticated;

-- The shared registration step. Not callable from outside: add_work_item and add_live_take call it.
create or replace function public.register_work_item(
  uid uuid, p_work uuid, p_role text, p_path text, p_filename text, p_mime text, p_bytes bigint, p_sha256 text,
  p_live_claimed int, p_live_elapsed int
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  w public.works%rowtype;
  recv timestamptz; h text; n int; obj_size bigint; used bigint; main_type text;
  fname text := btrim(coalesce(p_filename, ''));
begin
  select * into w from public.works where id = p_work and author_id = uid for update;
  if not found then raise exception 'work not found'; end if;
  if w.status <> 'draft' then raise exception 'this work is published and locked'; end if;
  if p_role is null or p_role not in ('process', 'original', 'project', 'final', 'thumb', 'live') then raise exception 'unknown file role'; end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'bad checksum'; end if;
  if p_bytes is null or p_bytes < 1 then raise exception 'empty file'; end if;
  if char_length(fname) < 1 or char_length(fname) > 200 then raise exception 'file name must be 1 to 200 characters'; end if;
  if p_path is null or p_path !~ '^[0-9a-f-]{36}/[0-9a-f-]{36}/[A-Za-z0-9._-]{1,140}$'
     or split_part(p_path, '/', 1) <> uid::text or split_part(p_path, '/', 2) <> p_work::text then
    raise exception 'bad file path';
  end if;

  main_type := case w.kind when 'art' then 'image/' when 'photo' then 'image/' when 'music' then 'audio/' else 'video/' end;
  if p_mime = 'application/zip' then
    if p_role not in ('project', 'process', 'original') then raise exception 'zip files can only be project, process or original files'; end if;
  elsif p_mime in ('image/jpeg', 'image/png', 'image/webp') then
    null;
  elsif w.kind = 'music' and p_mime in ('audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a', 'audio/flac', 'audio/ogg', 'audio/aac', 'audio/webm') then
    null;
  elsif w.kind = 'film' and p_mime in ('video/mp4', 'video/webm', 'video/quicktime') then
    null;
  else
    raise exception 'that file type isn''t accepted for this kind of work';
  end if;
  if p_role = 'final' and left(p_mime, char_length(main_type)) <> main_type then
    raise exception 'the finished work for this kind must be %', trim(trailing '/' from main_type);
  end if;
  if p_role = 'live' and (w.kind <> 'music' or p_mime not in ('audio/webm', 'audio/ogg', 'audio/mp4')) then
    raise exception 'recorded takes must be audio recorded on a music work';
  end if;
  if p_role = 'project' and p_mime <> 'application/zip' then raise exception 'project files must be zipped'; end if;
  if p_role = 'thumb' and (p_mime <> 'image/jpeg' or p_bytes > 400000) then raise exception 'bad thumbnail'; end if;
  if p_mime like 'image/%' and p_bytes > 26214400 then raise exception 'images can be at most 25 MB'; end if;
  if p_bytes > 52428800 then raise exception 'files can be at most 50 MB'; end if;

  if (select count(*) from public.work_items where work_id = p_work and role <> 'thumb') >= 40 and p_role <> 'thumb' then
    raise exception 'a work can have at most 40 files';
  end if;
  if (select count(*) from public.work_items i join public.works x on x.id = i.work_id
       where x.author_id = uid and i.received_at > now() - interval '1 hour') >= 120 then
    raise exception 'too many uploads in the last hour';
  end if;
  select coalesce(sum(i.bytes), 0) into used from public.work_items i join public.works x on x.id = i.work_id where x.author_id = uid;
  if used + p_bytes > 262144000 then raise exception 'storage limit reached (250 MB per account)'; end if;

  select (metadata ->> 'size')::bigint into obj_size from storage.objects where bucket_id = 'works' and name = p_path;
  if obj_size is null then raise exception 'the file isn''t in storage yet'; end if;
  if obj_size <> p_bytes then raise exception 'the uploaded file size doesn''t match'; end if;

  recv := clock_timestamp();
  n := w.item_count + 1;
  h := public.item_hash(w.head_hash, n, recv, p_role, fname, p_mime, p_bytes, p_sha256);
  insert into public.work_items (work_id, seq, role, path, filename, mime, bytes, sha256, received_at, prev_hash, hash, live_claimed_ms, live_elapsed_ms)
  values (p_work, n, p_role, p_path, fname, p_mime, p_bytes, p_sha256, recv, w.head_hash, h, p_live_claimed, p_live_elapsed);
  update public.works
     set item_count = n, head_hash = h,
         first_received_at = coalesce(first_received_at, recv), last_received_at = recv
   where id = p_work;
  return jsonb_build_object('seq', n, 'hash', h, 'received_at', recv);
end
$$;

-- Same signature as before. The "live" role can only come from add_live_take.
create or replace function public.add_work_item(
  p_work uuid, p_role text, p_path text, p_filename text, p_mime text, p_bytes bigint, p_sha256 text
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  if p_role is null or p_role not in ('process', 'original', 'project', 'final', 'thumb') then raise exception 'unknown file role'; end if;
  return public.register_work_item(uid, p_work, p_role, p_path, p_filename, p_mime, p_bytes, p_sha256, null, null);
end
$$;

-- Step 1 of a recorded take: the server notes the time the recording begins.
create or replace function public.start_take(p_work uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user(); w public.works%rowtype; sid uuid; t timestamptz;
begin
  select * into w from public.works where id = p_work and author_id = uid;
  if not found then raise exception 'work not found'; end if;
  if w.status <> 'draft' then raise exception 'this work is published and locked'; end if;
  if w.kind <> 'music' then raise exception 'recording is only for music'; end if;
  delete from public.take_sessions where user_id = uid and started_at < now() - interval '1 day';
  if (select count(*) from public.take_sessions where user_id = uid and started_at > now() - interval '1 hour') >= 60 then
    raise exception 'too many recordings started in the last hour';
  end if;
  insert into public.take_sessions (work_id, user_id) values (p_work, uid) returning id, started_at into sid, t;
  return jsonb_build_object('session', sid, 'started_at', t);
end
$$;

-- Step 2: the finished take, uploaded to storage first, is registered only if the server's clock agrees with its length.
create or replace function public.add_live_take(
  p_session uuid, p_path text, p_filename text, p_mime text, p_bytes bigint, p_sha256 text, p_claimed_ms int
) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user(); s public.take_sessions%rowtype; el int; res jsonb;
begin
  select * into s from public.take_sessions where id = p_session and user_id = uid for update;
  if not found then raise exception 'That recording session isn''t valid.'; end if;
  if s.used then raise exception 'That recording was already added.'; end if;
  if p_claimed_ms is null or p_claimed_ms < 1000 or p_claimed_ms > 1800000 then raise exception 'A take can be 1 second to 30 minutes long.'; end if;
  el := least(floor(extract(epoch from (clock_timestamp() - s.started_at)) * 1000), 2000000000);
  if el < p_claimed_ms - 500 then raise exception 'That take is longer than the time that has passed since it started, so it can''t be a live recording.'; end if;
  if el > p_claimed_ms + 1200000 then raise exception 'That recording started too long ago. Record it again.'; end if;
  if p_bytes is null or p_bytes > (p_claimed_ms / 1000.0) * 200000 + 200000 then raise exception 'That file is too big for a take of that length.'; end if;
  res := public.register_work_item(uid, s.work_id, 'live', p_path, p_filename, p_mime, p_bytes, p_sha256, p_claimed_ms, el);
  update public.take_sessions set used = true where id = p_session;
  return res || jsonb_build_object('elapsed_ms', el);
end
$$;

create or replace function public.set_release_link(p_work uuid, p_url text) returns text
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user(); u text := nullif(btrim(coalesce(p_url, '')), '');
begin
  if u is not null and u !~ '^https://[^[:space:]]{3,255}$' then raise exception 'Use a full link starting with https://'; end if;
  update public.works set release_url = u where id = p_work and author_id = uid and status in ('draft', 'published');
  if not found then raise exception 'Not found.'; end if;
  return u;
end
$$;

create or replace function public.get_work(p_work uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare w public.works%rowtype; uid uuid := auth.uid(); author text;
begin
  select * into w from public.works where id = p_work and (status = 'published' or author_id = uid);
  if not found then return null; end if;
  select display_name into author from public.profiles where id = w.author_id;
  return jsonb_build_object(
    'id', w.id, 'kind', w.kind, 'title', w.title, 'description', w.description, 'status', w.status,
    'visibility', w.visibility, 'release_url', w.release_url,
    'author', coalesce(author, 'Creator'), 'author_id', public.listed_author(w.author_id),
    'published_at', w.published_at, 'created_at', w.created_at,
    'removed_reason', case when w.author_id = uid then w.removed_reason end,
    'mine', coalesce(w.author_id = uid, false),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
        'seq', i.seq, 'role', i.role, 'path', i.path, 'filename', i.filename, 'mime', i.mime,
        'bytes', i.bytes, 'sha256', i.sha256, 'received_at', i.received_at, 'hash', i.hash,
        'live_claimed_ms', i.live_claimed_ms, 'live_elapsed_ms', i.live_elapsed_ms) order by i.seq)
        from public.work_items i where i.work_id = w.id), '[]'::jsonb),
    'verification', jsonb_build_object(
      'chain_ok', public.verify_work_chain(w.id),
      'items', w.item_count,
      'server_span_seconds', round(extract(epoch from (w.last_received_at - w.first_received_at))),
      'head_hash', w.head_hash)
  );
end
$$;

create or replace function public.work_rows(p_author uuid, p_kind text, p_limit int, p_offset int) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.published_at desc), '[]'::jsonb)
  from (
    select w.id, w.kind, w.title, coalesce(pr.display_name, 'Creator') as author, public.listed_author(w.author_id) as author_id, w.published_at,
           (select count(*) from public.work_items i where i.work_id = w.id and i.role in ('process', 'original', 'project', 'live')) as process_count,
           (select count(*) from public.work_items i where i.work_id = w.id and i.role = 'live') as live_count,
           round(extract(epoch from (w.last_received_at - w.first_received_at))) as span_seconds,
           (select i.path from public.work_items i where i.work_id = w.id and i.role = 'thumb' order by i.seq limit 1) as thumb_path,
           (select i.path from public.work_items i where i.work_id = w.id and i.role = 'final' order by i.seq limit 1) as final_path,
           (select i.mime from public.work_items i where i.work_id = w.id and i.role = 'final' order by i.seq limit 1) as final_mime
      from public.works w
      left join public.profiles pr on pr.id = w.author_id
     where w.status = 'published' and w.visibility = 'public'
       and (p_author is null or w.author_id = p_author)
       and (p_kind is null or w.kind = p_kind)
     order by w.published_at desc
     limit least(greatest(p_limit, 1), 50) offset greatest(p_offset, 0)
  ) x
$$;

revoke execute on function public.register_work_item(uuid, uuid, text, text, text, text, bigint, text, int, int) from public, anon, authenticated;
revoke execute on function public.add_work_item(uuid, text, text, text, text, bigint, text) from public, anon, authenticated;
revoke execute on function public.start_take(uuid) from public, anon, authenticated;
revoke execute on function public.add_live_take(uuid, text, text, text, bigint, text, int) from public, anon, authenticated;
revoke execute on function public.set_release_link(uuid, text) from public, anon, authenticated;
revoke execute on function public.get_work(uuid) from public, anon, authenticated;
revoke execute on function public.work_rows(uuid, text, int, int) from public, anon, authenticated;
grant execute on function public.add_work_item(uuid, text, text, text, text, bigint, text) to authenticated;
grant execute on function public.start_take(uuid) to authenticated;
grant execute on function public.add_live_take(uuid, text, text, text, bigint, text, int) to authenticated;
grant execute on function public.set_release_link(uuid, text) to authenticated;
grant execute on function public.get_work(uuid) to anon, authenticated;

------------------------------------------------------------------------------
-- Part 9: blocking. You can block someone from their comment or their page. You then stop seeing their
-- comments, their work in Browse and Artists, and they can no longer comment on your pieces or works.
-- Safe to re-run.
------------------------------------------------------------------------------

create table if not exists public.blocks (
  id         uuid primary key default gen_random_uuid(),
  blocker_id uuid not null references auth.users (id) on delete cascade,
  blocked_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);
create index if not exists blocks_blocked_idx on public.blocks (blocked_id);
alter table public.blocks enable row level security;
revoke all on public.blocks from anon, authenticated;

create or replace function public.do_block(uid uuid, target uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  if target is null or not exists (select 1 from public.profiles where id = target) then raise exception 'Not found.'; end if;
  if target = uid then raise exception 'You can''t block yourself.'; end if;
  if (select count(*) from public.blocks where blocker_id = uid) >= 500 then raise exception 'You''ve blocked as many people as is allowed.'; end if;
  insert into public.blocks (blocker_id, blocked_id) values (uid, target) on conflict do nothing;
  return jsonb_build_object('blocked', true);
end
$$;

create or replace function public.block_user(p_id uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
begin
  return public.do_block(public.require_user(), p_id);
end
$$;

-- Blocking from a comment works even when the commenter keeps their page unlinked, because it never exposes their id.
create or replace function public.block_comment_author(p_comment uuid) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user(); target uuid;
begin
  select author_id into target from public.comments where id = p_comment and removed_at is null;
  return public.do_block(uid, target);
end
$$;

create or replace function public.unblock(p_block uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  delete from public.blocks where id = p_block and blocker_id = uid;
  return found;
end
$$;

create or replace function public.my_blocks() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', b.id, 'name', coalesce(pr.display_name, 'Someone'), 'created_at', b.created_at) order by b.created_at desc)
      from public.blocks b left join public.profiles pr on pr.id = b.blocked_id
     where b.blocker_id = uid), '[]'::jsonb);
end
$$;

create or replace function public.add_comment(p_kind text, p_id uuid, p_body text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  uid uuid := public.require_user();
  b text := btrim(coalesce(p_body, ''));
  owner uuid := public.feedback_owner(p_kind, p_id);
  new_id uuid; made timestamptz;
begin
  if char_length(b) < 1 then raise exception 'Write something first.'; end if;
  if char_length(b) > 1000 then raise exception 'Comments can be at most 1000 characters.'; end if;
  if owner is null then raise exception 'not found'; end if;
  if exists (select 1 from public.blocks where blocker_id = owner and blocked_id = uid) then
    raise exception 'You can''t comment here.';
  end if;
  if (select count(*) from public.comments where author_id = uid and created_at > now() - interval '1 hour') >= 20 then
    raise exception 'You’re commenting very fast. Try again in a little while.';
  end if;
  if (select count(*) from public.comments where author_id = uid and created_at > now() - interval '24 hours') >= 100 then
    raise exception 'You’ve reached the daily comment limit.';
  end if;
  if (select count(*) from public.comments where author_id = uid and (case when p_kind = 'piece' then piece_id else work_id end) = p_id) >= 20 then
    raise exception 'You’ve left a lot of comments here already.';
  end if;
  if exists (select 1 from public.comments where author_id = uid and body = b and created_at > now() - interval '10 minutes') then
    raise exception 'You already posted that.';
  end if;
  insert into public.comments (piece_id, work_id, author_id, body)
  values (case when p_kind = 'piece' then p_id end, case when p_kind = 'work' then p_id end, uid, b)
  returning id, created_at into new_id, made;
  return jsonb_build_object('id', new_id, 'created_at', made);
end
$$;

create or replace function public.get_feedback(p_kind text, p_id uuid, p_order text default 'newest', p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := auth.uid(); owner uuid := public.feedback_owner(p_kind, p_id); lim int := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if owner is null then return null; end if;
  return jsonb_build_object(
    'up',   (select count(*) from public.reactions where value = 1  and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'down', (select count(*) from public.reactions where value = -1 and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'mine', (select value from public.reactions where user_id = uid and (case when p_kind = 'piece' then piece_id else work_id end) = p_id),
    'can_moderate', (uid is not null and uid = owner),
    'total', (select count(*) from public.comments c where c.removed_at is null and (case when p_kind = 'piece' then c.piece_id else c.work_id end) = p_id
                and not exists (select 1 from public.blocks b where b.blocker_id = uid and b.blocked_id = c.author_id)),
    'comments', coalesce((
      select jsonb_agg(to_jsonb(x) order by case when p_order = 'oldest' then x.created_at end asc, case when p_order = 'oldest' then null else x.created_at end desc, x.id)
      from (
        select c.id, coalesce(pr.display_name, 'Someone') as author, public.listed_author(c.author_id) as author_id, c.body, c.created_at, (c.author_id = uid) as mine
          from public.comments c left join public.profiles pr on pr.id = c.author_id
         where c.removed_at is null and (case when p_kind = 'piece' then c.piece_id else c.work_id end) = p_id
           and not exists (select 1 from public.blocks b where b.blocker_id = uid and b.blocked_id = c.author_id)
         order by case when p_order = 'oldest' then c.created_at end asc, c.created_at desc, c.id
         limit lim offset greatest(coalesce(p_offset, 0), 0)
      ) x), '[]'::jsonb)
  );
end
$$;

create or replace function public.list_public_pieces(p_limit int default 24, p_offset int default 0) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.published_at desc), '[]'::jsonb)
  from (
    select pc.id, pc.title, coalesce(pr.display_name, 'Writer') as author, public.listed_author(pc.author_id) as author_id, pc.published_at,
           pc.active_seconds, pc.word_count, pc.pasted_chars, pc.paste_events, pc.suspect_batches,
           jsonb_array_length(pc.replay -> 'snapshots') as snapshot_count, pc.spark, pc.band_times
      from public.pieces pc
      left join public.profiles pr on pr.id = pc.author_id
     where pc.status = 'published' and pc.visibility = 'public'
       and not exists (select 1 from public.blocks b where b.blocker_id = auth.uid() and b.blocked_id = pc.author_id)
     order by pc.published_at desc
     limit least(greatest(p_limit, 1), 50) offset greatest(p_offset, 0)
  ) x
$$;

create or replace function public.work_rows(p_author uuid, p_kind text, p_limit int, p_offset int) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.published_at desc), '[]'::jsonb)
  from (
    select w.id, w.kind, w.title, coalesce(pr.display_name, 'Creator') as author, public.listed_author(w.author_id) as author_id, w.published_at,
           (select count(*) from public.work_items i where i.work_id = w.id and i.role in ('process', 'original', 'project', 'live')) as process_count,
           (select count(*) from public.work_items i where i.work_id = w.id and i.role = 'live') as live_count,
           round(extract(epoch from (w.last_received_at - w.first_received_at))) as span_seconds,
           (select i.path from public.work_items i where i.work_id = w.id and i.role = 'thumb' order by i.seq limit 1) as thumb_path,
           (select i.path from public.work_items i where i.work_id = w.id and i.role = 'final' order by i.seq limit 1) as final_path,
           (select i.mime from public.work_items i where i.work_id = w.id and i.role = 'final' order by i.seq limit 1) as final_mime
      from public.works w
      left join public.profiles pr on pr.id = w.author_id
     where w.status = 'published' and w.visibility = 'public'
       and (p_author is null or w.author_id = p_author)
       and (p_kind is null or w.kind = p_kind)
       and not exists (select 1 from public.blocks b where b.blocker_id = auth.uid() and b.blocked_id = w.author_id)
     order by w.published_at desc
     limit least(greatest(p_limit, 1), 50) offset greatest(p_offset, 0)
  ) x
$$;

create or replace function public.list_creators(p_kind text default null, p_limit int default 24, p_offset int default 0) returns jsonb
language sql stable security definer set search_path = ''
as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.latest desc, x.name, x.id), '[]'::jsonb)
  from (
    select pr.id, pr.display_name as name, left(coalesce(pr.bio, ''), 140) as bio,
           a.writing, a.art, a.photo, a.music, a.film, a.latest
      from (
        select i.author_id,
               count(*) filter (where i.kind = 'writing')::int as writing,
               count(*) filter (where i.kind = 'art')::int     as art,
               count(*) filter (where i.kind = 'photo')::int   as photo,
               count(*) filter (where i.kind = 'music')::int   as music,
               count(*) filter (where i.kind = 'film')::int    as film,
               max(i.published_at) as latest
          from (
            select author_id, 'writing'::text as kind, published_at from public.pieces where status = 'published' and visibility = 'public'
            union all
            select author_id, kind, published_at from public.works where status = 'published' and visibility = 'public'
          ) i
         group by i.author_id
        having p_kind is null or count(*) filter (where i.kind = p_kind) > 0
      ) a
      join public.profiles pr on pr.id = a.author_id and pr.visibility = 'public'
     where not exists (select 1 from public.blocks b where b.blocker_id = auth.uid() and b.blocked_id = a.author_id)
     order by a.latest desc, pr.display_name, pr.id
     limit least(greatest(coalesce(p_limit, 24), 1), 50) offset greatest(coalesce(p_offset, 0), 0)
  ) x
$$;

create or replace function public.get_public_profile(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare pr public.profiles%rowtype;
begin
  select * into pr from public.profiles where id = p_id;
  if not found then return null; end if;
  return jsonb_build_object(
    'id', pr.id, 'name', pr.display_name, 'bio', pr.bio, 'website', pr.website, 'contact', pr.contact,
    'visibility', pr.visibility, 'mine', coalesce(pr.id = auth.uid(), false),
    'blocked', exists (select 1 from public.blocks b where b.blocker_id = auth.uid() and b.blocked_id = pr.id),
    'joined', pr.created_at,
    'pieces', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.published_at desc)
      from (
        select pc.id, pc.title, pr.display_name as author, null::uuid as author_id, pc.published_at,
               pc.active_seconds, pc.word_count, pc.pasted_chars, pc.paste_events, pc.suspect_batches,
               jsonb_array_length(pc.replay -> 'snapshots') as snapshot_count, pc.spark, pc.band_times
          from public.pieces pc
         where pc.author_id = pr.id and pc.status = 'published' and pc.visibility = 'public'
         order by pc.published_at desc limit 50
      ) x), '[]'::jsonb),
    'works', public.work_rows(pr.id, null, 50, 0)
  );
end
$$;

create or replace function public.export_my_data() returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  return jsonb_build_object(
    'exported_at', now(),
    'profile', (select to_jsonb(p) from public.profiles p where p.id = uid),
    'pieces', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pc.id, 'title', pc.title, 'status', pc.status, 'visibility', pc.visibility,
               'created_at', pc.created_at, 'published_at', pc.published_at,
               'final_text', pc.final_text,
               'batches', (select coalesce(jsonb_agg(to_jsonb(b) order by b.seq), '[]'::jsonb)
                             from public.piece_batches b where b.piece_id = pc.id))
             order by pc.created_at)
        from public.pieces pc where pc.author_id = uid), '[]'::jsonb),
    'works', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', w.id, 'kind', w.kind, 'title', w.title, 'description', w.description, 'status', w.status, 'visibility', w.visibility,
               'release_url', w.release_url,
               'created_at', w.created_at, 'published_at', w.published_at,
               'files', (select coalesce(jsonb_agg(jsonb_build_object(
                          'seq', i.seq, 'role', i.role, 'filename', i.filename, 'mime', i.mime, 'bytes', i.bytes,
                          'sha256', i.sha256, 'received_at', i.received_at) order by i.seq), '[]'::jsonb)
                          from public.work_items i where i.work_id = w.id))
             order by w.created_at)
        from public.works w where w.author_id = uid), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'piece_id', c.piece_id, 'work_id', c.work_id, 'body', c.body, 'created_at', c.created_at) order by c.created_at)
                            from public.comments c where c.author_id = uid), '[]'::jsonb),
    'reactions', coalesce((select jsonb_agg(jsonb_build_object('piece_id', r.piece_id, 'work_id', r.work_id, 'value', r.value, 'created_at', r.created_at) order by r.created_at)
                            from public.reactions r where r.user_id = uid), '[]'::jsonb),
    'blocked_people', coalesce((select jsonb_agg(jsonb_build_object('name', coalesce(pr.display_name, 'Someone'), 'created_at', b.created_at) order by b.created_at)
                            from public.blocks b left join public.profiles pr on pr.id = b.blocked_id where b.blocker_id = uid), '[]'::jsonb)
  );
end
$$;

revoke execute on function public.do_block(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.block_user(uuid) from public, anon, authenticated;
revoke execute on function public.block_comment_author(uuid) from public, anon, authenticated;
revoke execute on function public.unblock(uuid) from public, anon, authenticated;
revoke execute on function public.my_blocks() from public, anon, authenticated;
revoke execute on function public.add_comment(text, uuid, text) from public, anon, authenticated;
revoke execute on function public.get_feedback(text, uuid, text, int, int) from public, anon, authenticated;
revoke execute on function public.list_public_pieces(int, int) from public, anon, authenticated;
revoke execute on function public.work_rows(uuid, text, int, int) from public, anon, authenticated;
revoke execute on function public.list_creators(text, int, int) from public, anon, authenticated;
revoke execute on function public.get_public_profile(uuid) from public, anon, authenticated;
revoke execute on function public.export_my_data() from public, anon, authenticated;
grant execute on function public.block_user(uuid) to authenticated;
grant execute on function public.block_comment_author(uuid) to authenticated;
grant execute on function public.unblock(uuid) to authenticated;
grant execute on function public.my_blocks() to authenticated;
grant execute on function public.add_comment(text, uuid, text) to authenticated;
grant execute on function public.get_feedback(text, uuid, text, int, int) to anon, authenticated;
grant execute on function public.list_public_pieces(int, int) to anon, authenticated;
grant execute on function public.list_creators(text, int, int) to anon, authenticated;
grant execute on function public.get_public_profile(uuid) to anon, authenticated;
grant execute on function public.export_my_data() to authenticated;

-- Unblock from a person's page, by their profile id.
create or replace function public.unblock_user(p_id uuid) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare uid uuid := public.require_user();
begin
  delete from public.blocks where blocker_id = uid and blocked_id = p_id;
  return found;
end
$$;
revoke execute on function public.unblock_user(uuid) from public, anon, authenticated;
grant execute on function public.unblock_user(uuid) to authenticated;
