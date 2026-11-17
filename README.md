# Handproof

Handproof hosts human-made work together with a record of how it was made. Writing is recorded as you type, with a replay of every revision. Art, photos, music and film are uploaded with the files from each stage (work in progress, originals, project files, the finished work). In both cases the server timestamps and chains the record, and published work gets a public page that anyone can re-check.

```
public/            the whole site (static files, no build step)
  index.html       the app
  vendor/          the Supabase sign-in library, served from your own domain
supabase/schema.sql  the database: tables, security rules, functions, and the private file bucket (run once, safe to re-run)
vercel.json        hosting settings and security headers
tests/             automated tests (see below)
MODERATION.md      handling reports and takedowns
```

## Launch checklist

1. **Put the code on GitHub** and import the repository in Vercel (framework: Other; `vercel.json` already sets the `public` folder and security headers).
2. **Add your domain** in Vercel (Project > Settings > Domains) and follow its DNS instructions.
3. **Supabase > Authentication > URL Configuration:** set Site URL to your domain and add it under Redirect URLs. Sign-in, confirmation and password-reset links use this.
4. **Supabase > Authentication > SMTP Settings:** add your own email sender (the built-in one is rate-limited). Use an address on your domain.
5. **Upgrade the Supabase project to Pro** so it doesn't pause itself after a week without traffic. Uploaded files count against storage: the free plan includes 1 GB and a 50 MB maximum per file. Check Dashboard > Storage > Settings that the global file size limit is at least 50 MB.
6. **Set the contact address.** In `public/index.html`, find `window.HANDPROOF_CONFIG` and fill in `contact:`. It appears on the Terms and Privacy pages for takedown requests and data questions.
7. **Have a lawyer read the Terms and Privacy pages** (they're drafts, not legal advice). If you change them, update `TERMS_VERSION` in `public/index.html`.
8. If your domain isn't the Supabase URL in `vercel.json`'s `connect-src`, nothing needs changing: the app only talks to that Supabase project. If you ever move to a new project, change the URL in both `index.html` and `vercel.json`.
9. **Try it live once:** create an account, write, paste, publish, open the link in a private window, report it. Then share a photo (add a JPG with location data, check the warning, upload, publish), open its page in a private window and press "Check the files in your browser". Reset the password, then delete the test account and confirm the files are gone from Dashboard > Storage.
10. Check the name as a trademark (search HANDPROOF in software and online-service classes).

## How it works

- Signed-in writing is sent to the server in batches. Each batch gets the server's timestamp and a SHA-256 hash that includes the previous batch's hash, so changing an earlier batch breaks the chain.
- A batch claiming more writing time than the server clock allows is flagged.
- Final text, word count, active time, deletions and paste counts are computed on the server when you publish. Published pieces are locked.
- Public pages re-check the whole chain every time they load.
- Feedback: signed-in people can give one thumbs up or down to a published piece or work (the counts are public, who voted isn't) and leave comments. Comments have no votes and are sorted newest or oldest first. The owner can delete comments on their own piece or work, and anyone can report a comment.
- Visibility: every piece and work is either Public (listed in Browse and on the writer page) or Link only (opens for anyone who has the link, listed nowhere, and the page asks search engines to skip it). It's chosen when publishing and can be changed any time from the piece's own page. A profile can be Public or Link only too: a link-only writer page isn't linked from names on pieces and comments, and isn't readable by listing the profiles table, but it still opens for anyone with its address. **Link only is not private.** Anyone with the address sees everything on the page, including its files. One technical caveat: the files of a link-only work sit in the same storage bucket as public ones, so a determined person who probes Supabase's storage API directly could in principle discover their paths. Closing that would mean serving files through an Edge Function. Don't offer link-only as a way to keep something secret.
- Artists page (`#/artists`, reached from the Work / Artists switch on Browse): people with a public profile and at least one public published piece or work, newest activity first, filterable by kind. Link-only profiles, and people whose work is all link-only, are not listed.
- Live takes (music): a work's page can record audio in the browser. `start_take` notes the server time, the take is uploaded, and `add_live_take` accepts it only if at least as much server time passed as the take is long (and it isn't absurdly large for its length). Accepted takes get the chained role `live`, and the page shows them as "Recorded in the browser" with the claimed and server-seen durations. This shows a take couldn't have been uploaded faster than it was made. It does not show who or what made the sound: someone could play audio into the microphone. The Permissions-Policy header allows the microphone for the site itself, and the CSP allows `blob:` media for playback before adding. Music works can also carry an optional https release link, shown as the artist's own link (not checked).
- Works: each uploaded file goes to a private storage bucket, then is registered with its SHA-256 checksum, size and type. The server stamps it with its own clock and chains it to the previous file. Files become readable by the public only when the work is published, and a published work is locked. A work page offers "Check the files in your browser", which re-hashes every file and compares it with the recorded checksum.
- JPEG location data (GPS) is detected before upload and stripped by default.
- Reports, takedowns, rate limits, data export and account deletion live in the database. See `MODERATION.md`.

## Tests

```
cd tests && npm install && npx playwright install chromium && npm test
```

- `sqltest.js`, `sqltest2.js`, `sqltest3.js`: the database rules (writing, privacy tools, works and file storage), run in an in-process Postgres.
- `run.js`: the app without accounts, in a simulated browser.
- `cloudtest.js`: the app with accounts, against the real database code.
- `sqltest4.js` covers thumbs, comments, limits and takedowns. `feedback.js` covers them in the browser.
- `sqltest6.js` and `live.js` cover live takes and release links (the browser test uses Chromium's fake microphone). `artists.js` covers the artists page in the browser. `sqltest5.js` and `visibility.js` cover Public / Link only for pieces, works and profiles, in the database and in the browser.
- `profile.js`, `works.js`: public profiles, and uploading, publishing, checking and deleting art, photos and music, in real Chromium.
- `flow.js`, `resilience.js`: the real site in real Chromium with the real Supabase library, with only the network replaced by a stand-in backed by the real SQL. Includes the security headers, phone-sized screens, and the cases where the server or library is unavailable.

What these can't cover: real email delivery, and Supabase's own servers and file storage. Step 9 above covers those.

## Limits to be upfront about

- It can't show whether someone retyped AI text, or whose ideas they were. Say "process recorded", not "verified human".
- A determined person could script realistic typing in real time. This raises the effort; it doesn't make forgery impossible.
- Comments are not pre-screened; they rely on reports, owner deletion and your moderation. Read `MODERATION.md`.
- Dictation and some phone keyboards insert text in chunks and get counted like paste.
- The public replay shows every version, including deleted text. The editor and the privacy page both say so.
- Pieces are capped at 100,000 characters; drafts expire after 14 days.
- Art, photo, music and film are evidence uploaded after the fact. A staged "process" is possible, and a recorded process can't show that AI-made material isn't inside a file. The page says so.
- Film is practical for short clips or low-resolution copies only (50 MB per file).
- Acting is a preview on the landing page, not built.

## Installable app and blocking

- The site is installable (manifest, service worker, icons). `tests/pwa.js` checks it. The service worker never caches Supabase calls.
- Blocking: a signed-in person can block someone from a comment or their writer page, and undo it under Account. Blocked people are hidden from the blocker (comments, Browse, Artists) and can't comment on the blocker's work. Blocking is silent. Covered by `tests/sqltest7.js` and `tests/blocks.js`.
