# Content calendar front end

A content calendar for X and LinkedIn, built on the patterns of the leading social schedulers
(Buffer, Sprout Social, Hootsuite) and the WAI-ARIA grid pattern:

- **Month and week views.** Month shows a chip per post (platform, time, opening words); week shows
  each post as a card with its status and image.
- **Workflow status.** Draft, suggested, scheduled and published each have their own mark, and the
  status chips above the grid filter by status and show the counts. The platform filter sits in the bar.
- **Platform-native previews.** The day panel draws each post the way X or LinkedIn lays it out,
  including LinkedIn's "see more" fold at about 210 characters, so copy is judged in place.
- **Ready to post.** Character count against each platform's limit, Copy text, and asset downloads.
- **Gaps.** Upcoming weekdays with nothing planned are listed under the grid.
- **Keyboard.** Arrows move between days, Page Up/Down change period, T is today, M/W switch view,
  ? lists the shortcuts. The selected day is kept in the URL hash.
- **Phone.** The grid folds to status dots and the day opens below it.

No build step. Serve the folder and open it:

```sh
cd frontend
python3 -m http.server 8000
# http://localhost:8000
```

## Files

- `index.html` – page shell
- `src/styles.css` – all styling; brand colours and the typeface are tokens at the top of the file
- `src/data.js` – the post shape, the loader and sample posts
- `src/config.js`, `src/supabase.js` – Supabase settings, client and sign-in
- `stats/index.html`, `src/stats*.{js,css}` – the stats page
- `src/app.js` – calendar rendering and interaction
- `assets/` – the mark and sample post graphics

## Data

`src/data.js` documents the post shape. With the Supabase URL and anon key in `src/config.js`, posts
come from the `posts` and `post_assets` tables after an email sign-in; without them the calendar
shows sample posts. Times are shown in Manila time (`TIME_ZONE`), and a post lands on the day of
its `scheduledAt` in that zone. See the repository README for the backend setup.

## Stats

`stats/` is the stats page at `/stats/`. Nothing links to it. It reads the stats views and
markers from Supabase (`src/stats-data.js`) and draws its charts in `src/stats.js`.

## Branding

Colours, type and the logo come from silencio.network: a black ground, near-white ink, Geist, pill
controls, and the site's sky, mint and amber accents (LinkedIn, scheduled, over-limit). The tokens sit
at the top of `src/styles.css`; `assets/logo.svg` is the wordmark and `assets/mark.svg` the favicon.

