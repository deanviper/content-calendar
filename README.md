# content-calendar

Silencio's content calendar and post stats for X and LinkedIn.

- `frontend/` is a static site with no build step. `/` is the calendar. `/stats/` is the stats page,
  which nothing links to and search engines are told to skip.
- `supabase/` holds the database schema, the stats collector function and its schedule.
- `scripts/import-stats.mjs` loads past stats from a CSV.

Who can do what:

- **Anyone with the calendar link** sees the posts and can comment on them, no account needed.
  Comments are limited to 5 per sender per 10 minutes.
- **Editors** (emails in `public.editors`, at first just joaquin@silencio.network) sign in with
  Google to add, edit, approve, move and delete posts, delete comments, and see the stats page.
- **The collector** writes stats with the service role.

Without Supabase settings the pages run on sample data, so the front end works on its own.

## Set up Supabase

1. **Create the schema.** In a Supabase project, apply the migration, either with
   `supabase link --project-ref <ref>` and `supabase db push`, or by pasting
   `supabase/migrations/20261026090000_content_calendar.sql` into the SQL editor.
2. **Make yourself the editor.** Signing up is not enough to edit; the email must be listed:
   ```sql
   insert into public.editors (email) values ('you@silencio.network');
   ```
   Then turn on Google sign-in (next step).
3. **Google sign-in.** In Google Cloud Console → APIs & Services → Credentials, create an OAuth
   client ID of type *Web application*, with this authorised redirect URI:
   `https://<project-ref>.supabase.co/auth/v1/callback`. Paste its client ID and secret into
   Supabase → Authentication → Sign In / Providers → Google, and enable it. Under Authentication →
   URL Configuration, set the deployed site as the Site URL and add it (plus
   `http://localhost:8000/**` for local work) to the redirect URLs.
4. **Connect the front end.** Put the project URL and anon key in `frontend/src/config.js`.
   The anon key is meant to be public: it can read the calendar and add comments, nothing else.
5. **Deploy the collector.**
   ```sh
   supabase functions deploy collect-stats --no-verify-jwt
   supabase secrets set COLLECTOR_SECRET=<long random string> \
     X_BEARER_TOKEN=… X_USERNAME=… \
     LINKEDIN_ACCESS_TOKEN=… LINKEDIN_ORG_ID=…
   ```
   `--no-verify-jwt` is safe because the function checks `x-collector-secret` itself.
6. **Pull the history once,** which creates past posts and their first snapshots:
   ```sh
   curl -X POST "https://<ref>.supabase.co/functions/v1/collect-stats?mode=backfill&since=2026-01-01" \
     -H "x-collector-secret: <COLLECTOR_SECRET>"
   ```
7. **Schedule it.** Run `supabase/schedule.sql` in the SQL editor after filling in its two
   placeholders. It collects every 6 hours.

## How the stats work

Every collector run adds a snapshot per published post (impressions, likes, reposts, replies,
quotes, bookmarks, clicks) and the follower count per platform. Nothing is overwritten, so:

- a post's **baseline** is its first snapshot, and the stats page shows its growth since then;
- a **marker** (`stat_markers`) names a moment such as a baseline day or a campaign start. Markers
  appear on the charts, and the page compares equal windows before and after any marker.

Older numbers the APIs no longer return can be loaded from a CSV; the columns are documented at the
top of `scripts/import-stats.mjs`:

```sh
SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/import-stats.mjs past-stats.csv
```

### What each platform needs

- **X:** an API bearer token for the app and the account's username. Post impressions come from
  `public_metrics`. The timeline backfill reaches the account's latest 3,200 posts. Reads count
  against the X plan's monthly cap, so check its limits before collecting more often.
- **LinkedIn:** a Community Management API token with `r_organization_social` for an admin of the
  page, plus the page's organization ID. Stats come from `organizationalEntityShareStatistics`.

### Adding posts

Sign in with Google from the link at the bottom of the calendar. As the editor you get a **New
post** button (or press N), a New post button on each open day, and **Edit** and **Approve** on
every post. The composer sets the platform, status, date and time, copy, hashtags and images, and
shows the X or LinkedIn preview as you type. Moving a post to another day is a date change in the
composer. Published posts can't be deleted, so their stats stay intact.

Planned posts are linked to their live versions by setting `external_id` (the tweet ID, or the
LinkedIn `urn:li:share:…`) when they go out. Posts the backfill finds are added as new published
posts.

## Develop

```sh
cd frontend && python3 -m http.server 8000     # http://localhost:8000 and /stats/
npm test                                       # importer tests
deno test supabase/functions/_shared/          # platform client tests
```
