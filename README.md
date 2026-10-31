# Silencio content calendar

The content calendar for Silencio's X and LinkedIn accounts. It shows what we plan to post and what
has already gone out, with each post drawn the way the platform will show it.

**Live:** [silenciocalendar.vercel.app](https://silenciocalendar.vercel.app)

## What it does

- **Month and week views** of every post, with a marker on each day that has something planned.
- **Day view.** Open a day to read its posts as they'll appear on X or LinkedIn, with the copy,
  hashtags, photos and videos, a character count against the platform's limit, and buttons to copy
  the text or download the media.
- **X threads.** Add follow-up tweets to an X post, each with its own character count; the preview
  shows them joined the way X does, with a Copy button for each tweet.
- **Two states.** A post is a *draft* until it goes live. When it appears on X or LinkedIn, the
  calendar marks it *posted* on its own and links to it.
- **Comments.** Anyone with the link can leave feedback on a post, no account needed.
- **Your time zone.** Times show in each viewer's own zone, with a switch to UTC. Posts are
  written in your own time and saved as the moment they stand for.
- **Light and dark mode**, following the system setting, with a toggle in the header.
- **Keyboard shortcuts:** arrows move between days, T jumps to today, M and W switch views, ?
  lists them all.

Only Silencio's editor can add or change posts. Everyone else can read and comment.

The whole site sits behind a team password, checked on Vercel before any file is served
(`frontend/middleware.js`). The password and the session-signing secret are the Vercel environment
variables `CALENDAR_PASSWORD` and `CALENDAR_SESSION_SECRET`; a correct password keeps you signed in
for 48 hours on that browser, and changing the password signs everyone out.

## How it's built

- `frontend/`: a static site in plain JavaScript and CSS, no build step, hosted on Vercel.
- `supabase/`: the database (Postgres with row level security) and a scheduled function that reads
  each post's numbers from the X and LinkedIn APIs once a day.
- Photos and videos are stored in Google Drive.

## Run it locally

```sh
cd frontend
python3 -m http.server 8000    # then open http://localhost:8000
```

With an empty `SUPABASE_URL` in `frontend/src/config.js`, the calendar runs on sample posts, so
you can try it without a backend.

```sh
npm test                                                     # stats importer tests
DENO_NO_PACKAGE_JSON=1 deno test supabase/functions/_shared/  # platform and matching tests
```
