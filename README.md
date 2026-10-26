# content-calendar

Silencio's content calendar and post stats for X and LinkedIn.

- `frontend/` is a static site with no build step. `/` is the calendar. `/stats/` is the stats page,
  which nothing links to and search engines are told to skip.
- `supabase/` holds the database schema, the stats collector function and its schedule.
- `scripts/import-stats.mjs` loads past stats from a CSV.

Who can do what:

- **Anyone with the calendar link** sees the posts and can comment on them, no account needed.
  Comments are limited to 5 per sender per 10 minutes.
- **Editors** (emails in `public.editors`, at first just you) add and edit posts, delete
  comments, and see the stats page after an email sign-in.
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
   Under Authentication → URL Configuration, set the site's address as the Site URL so the
   sign-in links for the stats page work.
3. **Connect the front end.** Put the project URL and anon key in `frontend/src/config.js`.
   The anon key is meant to be public: it can read the calendar and add comments, nothing else.
4. **Deploy the collector.**
   ```sh
   supabase functions deploy collect-stats --no-verify-jwt
   supabase secrets set COLLECTOR_SECRET=<long random string> \
     X_BEARER_TOKEN=… X_USERNAME=… \
     LINKEDIN_ACCESS_TOKEN=… LINKEDIN_ORG_ID=…
   ```
   `--no-verify-jwt` is safe because the function checks `x-collector-secret` itself.
5. **Pull the history once,** which creates past posts and their first snapshots:
   ```sh
   curl -X POST "https://<ref>.supabase.co/functions/v1/collect-stats?mode=backfill&since=2026-01-01" \
     -H "x-collector-secret: <COLLECTOR_SECRET>"
   ```
6. **Schedule it.** Run `supabase/schedule.sql` in the SQL editor after filling in its two
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

Until the calendar has its own composer, add posts in the dashboard: Table Editor → `posts` →
Insert row (`platform`, `status`, `scheduled_at` with `+08:00`, `copy`, `hashtags` like
`{VoiceAI,Silencio}`). For images, upload to Storage → `post-assets` and add a `post_assets` row with
the post's `id`, the file's `storage_path` and a `name`. A CSV of drafts can be imported into
`posts` from the Table Editor too.

Planned posts are linked to their live versions by setting `external_id` (the tweet ID, or the
LinkedIn `urn:li:share:…`) when they go out. Posts the backfill finds are added as new published
posts.

## Develop

```sh
cd frontend && python3 -m http.server 8000     # http://localhost:8000 and /stats/
npm test                                       # importer tests
deno test supabase/functions/_shared/          # platform client tests
```
