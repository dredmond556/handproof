# Moderating Handproof

Anyone can report a published piece or work (the "Report this piece" / "Report this work" link on its page). Reports go into the `reports` table, which only you can read: open the Supabase dashboard, SQL editor, and run the queries below. Visitors and signed-in users cannot call the admin functions at all.

## See what's been reported

```sql
select r.created_at, r.reason, r.details, p.id as piece_id, p.title, pr.display_name as author,
       (select count(*) from public.reports x where x.piece_id = p.id and x.status = 'open') as open_reports_on_piece
from public.reports r
join public.pieces p on p.id = r.piece_id
left join public.profiles pr on pr.id = p.author_id
where r.status = 'open'
order by r.created_at desc;
```

Open `https://YOUR-SITE/#/p/<piece_id>` to read the piece and its replay.

### Works (art, photo, music, film)

```sql
select r.created_at, r.reason, r.details, w.id as work_id, w.kind, w.title, pr.display_name as author
from public.reports r
join public.works w on w.id = r.work_id
left join public.profiles pr on pr.id = w.author_id
where r.status = 'open'
order by r.created_at desc;
```

Open `https://YOUR-SITE/#/m/<work_id>` to see it and its files.

### Comments

```sql
select r.created_at, r.reason, r.details, c.id as comment_id, c.body, pr.display_name as commenter,
       coalesce(c.piece_id, c.work_id) as on_id, case when c.piece_id is not null then 'piece' else 'work' end as on_kind
from public.reports r
join public.comments c on c.id = r.comment_id
left join public.profiles pr on pr.id = c.author_id
where r.status = 'open'
order by r.created_at desc;
```

## Act on a report

```sql
-- Take a piece down (it disappears from its link and from Browse; the author sees it as removed, with this reason)
select public.admin_remove_piece('<piece_id>', 'Retyped AI-generated text');

-- Put it back
select public.admin_restore_piece('<piece_id>');

-- Close the reports without acting
select public.admin_dismiss_reports('<piece_id>');
```

```sql
-- Works: take down (its page and its files stop being public; the author sees why), restore, or dismiss
select public.admin_remove_work('<work_id>', 'Copyright complaint');
select public.admin_restore_work('<work_id>');
select public.admin_dismiss_work_reports('<work_id>');
```

```sql
-- Comments: hide (it disappears from the page), restore, or dismiss
select public.admin_remove_comment('<comment_id>', 'Harassment');
select public.admin_restore_comment('<comment_id>');
select public.admin_dismiss_comment_reports('<comment_id>');
```

Owners of a piece or work can also delete comments on it themselves. Removing a piece, work or comment marks its open reports as actioned.

## Close an account

Dashboard > Authentication > Users > the user > Delete. This erases their profile, pieces, recordings and the records of their works. Their uploaded files stay in storage until you delete them (the website's own "Delete account" button removes the files too). Find leftovers with:

```sql
select name, (metadata->>'size')::bigint as bytes from storage.objects
where bucket_id = 'works' and name not in (select path from public.work_items);
```

Delete those in Dashboard > Storage > works. Deleting rows with SQL alone doesn't free the space.

## Reasons the report form offers

Written by AI or retyped, copied from someone else, harassment or hate, illegal or dangerous, spam, something else.

## Built-in limits

- 20 publishes per account per day, 15 new pieces per hour, 25 unfinished drafts, 500 pieces in total.
- Uploads: 40 files per work, 120 uploads per hour, 250 MB per account, 25 MB per image, 50 MB per file, 200 works per account, 20 publishes per day.
- Comments: 20 per hour, 100 per day, 20 per person on any one piece or work, 1,000 characters each, and an identical repeat within 10 minutes is refused. Thumbs: 120 new ones per hour.
- 20 reports per signed-in account per day. A piece with 25 open reports stops collecting more.
- Signed-out visitors can report without limits per person (a site can't tell them apart), so the per-piece cap is what stops floods.

## Things to do on a schedule

Check open reports at least once a day while you're small. Legal complaints (copyright, court orders) need a quick answer, so set a contact address in `index.html` (`contact:` in the config near the bottom of the page) and watch that inbox.

## Link-only pieces, works and profiles

Pieces and works have a `visibility` column (`public` or `unlisted`), and profiles have one too (`public` or `link`). Unlisted items open for anyone with the link and can still be reported and removed like any other. To find one a report refers to, use its id:

```sql
select id, title, visibility, status from public.pieces where id = '<id>';
select id, title, visibility, status from public.works  where id = '<id>';
```

## Blocking
Users can block others themselves (Account lists who). This doesn't replace reports: blocked people can still be reported, and rule-breaking content is still removed by you.
