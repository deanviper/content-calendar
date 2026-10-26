-- Content calendar and stats schema.
--
-- posts                     one row per X or LinkedIn post, planned or published
-- post_assets               images, videos and files attached to a post (files live in storage)
-- post_metric_snapshots     a post's numbers at a moment; collected repeatedly, never overwritten
-- account_metric_snapshots  follower counts per platform over time
-- stat_markers              named points in time to compare against ("baseline", "campaign start")
-- post_comments             feedback on a post from anyone with the calendar link
--
-- Every snapshot is kept, so the first one for a post is its baseline and any later one can be
-- compared with it or with a marker. Anyone with the link can read the calendar and comment;
-- only listed editors add posts or see stats; snapshots are written only by the collector.

create extension if not exists pgcrypto with schema extensions;

create type public.platform as enum ('x', 'linkedin');
create type public.post_status as enum ('draft', 'suggested', 'scheduled', 'published');
create type public.asset_type as enum ('image', 'video', 'file');
create type public.metric_source as enum ('api', 'import', 'manual');

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Posts

create table public.posts (
  id            uuid primary key default gen_random_uuid(),
  platform      public.platform not null,
  status        public.post_status not null default 'draft',
  scheduled_at  timestamptz not null,
  copy          text not null default '',
  hashtags      text[] not null default '{}',
  -- Set once the post is live: the tweet id, or the LinkedIn share/ugcPost URN.
  external_id   text,
  external_url  text,
  published_at  timestamptz,
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint posts_external_unique unique (platform, external_id),
  constraint posts_published_has_time check (status <> 'published' or published_at is not null)
);

create index posts_scheduled_at_idx on public.posts (scheduled_at);
create index posts_published_at_idx on public.posts (platform, published_at desc) where status = 'published';

create trigger posts_touch before update on public.posts
  for each row execute function public.touch_updated_at();

create table public.post_assets (
  id            uuid primary key default gen_random_uuid(),
  post_id       uuid not null references public.posts (id) on delete cascade,
  type          public.asset_type not null default 'image',
  -- Path inside the post-assets storage bucket, or a full URL for files hosted elsewhere.
  storage_path  text,
  url           text,
  name          text not null,
  alt           text,
  position      int not null default 0,
  created_at    timestamptz not null default now(),
  constraint post_assets_location check (storage_path is not null or url is not null)
);

create index post_assets_post_idx on public.post_assets (post_id, position);

-- Stats

create table public.post_metric_snapshots (
  id           bigint generated always as identity primary key,
  post_id      uuid not null references public.posts (id) on delete cascade,
  captured_at  timestamptz not null default now(),
  source       public.metric_source not null default 'api',
  impressions  bigint,
  likes        bigint,
  reposts      bigint,   -- X reposts, LinkedIn shares
  replies      bigint,   -- X replies, LinkedIn comments
  quotes       bigint,
  bookmarks    bigint,
  clicks       bigint,
  engagements  bigint generated always as (
    coalesce(likes, 0) + coalesce(reposts, 0) + coalesce(replies, 0)
    + coalesce(quotes, 0) + coalesce(bookmarks, 0) + coalesce(clicks, 0)
  ) stored,
  raw          jsonb,
  constraint post_metric_snapshots_once unique (post_id, captured_at)
);

create index post_metric_snapshots_post_idx on public.post_metric_snapshots (post_id, captured_at desc);
create index post_metric_snapshots_time_idx on public.post_metric_snapshots (captured_at);

create table public.account_metric_snapshots (
  id           bigint generated always as identity primary key,
  platform     public.platform not null,
  captured_at  timestamptz not null default now(),
  source       public.metric_source not null default 'api',
  followers    bigint not null,
  raw          jsonb,
  constraint account_metric_snapshots_once unique (platform, captured_at)
);

create table public.stat_markers (
  id          uuid primary key default gen_random_uuid(),
  label       text not null check (length(label) between 1 and 80),
  marked_at   timestamptz not null default now(),
  -- Null means the marker applies to both platforms.
  platform    public.platform,
  note        text,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now()
);

create index stat_markers_time_idx on public.stat_markers (marked_at);

-- Views. security_invoker makes them obey the caller's row level security.

-- Each post's first snapshot (its baseline) and latest snapshot side by side.
create view public.post_performance with (security_invoker = true) as
select
  p.id,
  p.platform,
  p.status,
  p.copy,
  p.external_url,
  p.published_at,
  latest.captured_at                        as latest_at,
  latest.impressions,
  latest.engagements,
  latest.likes,
  latest.reposts,
  latest.replies,
  latest.clicks,
  case when latest.impressions > 0
       then round(latest.engagements::numeric / latest.impressions, 4) end as engagement_rate,
  baseline.captured_at                      as baseline_at,
  baseline.impressions                      as baseline_impressions,
  baseline.engagements                      as baseline_engagements,
  (select count(*) from public.post_metric_snapshots s where s.post_id = p.id) as snapshot_count
from public.posts p
left join lateral (
  select * from public.post_metric_snapshots s
  where s.post_id = p.id order by s.captured_at desc limit 1
) latest on true
left join lateral (
  select * from public.post_metric_snapshots s
  where s.post_id = p.id order by s.captured_at asc limit 1
) baseline on true
where p.status = 'published';

-- Daily totals per platform: the latest number each post had by the end of each day, summed.
-- This counts a post's growth on the days it happened instead of piling it onto its publish day.
create view public.daily_post_metrics with (security_invoker = true) as
with days as (
  select generate_series(
    (select date_trunc('day', min(captured_at) at time zone 'Asia/Manila') from public.post_metric_snapshots),
    date_trunc('day', now() at time zone 'Asia/Manila'),
    interval '1 day'
  )::date as day
),
end_of_day as (
  select distinct on (d.day, s.post_id)
    d.day, p.platform, s.post_id, s.impressions, s.engagements
  from days d
  join public.post_metric_snapshots s
    on (s.captured_at at time zone 'Asia/Manila')::date <= d.day
  join public.posts p on p.id = s.post_id
  order by d.day, s.post_id, s.captured_at desc
)
select
  day,
  platform,
  count(*)                          as posts_tracked,
  sum(coalesce(impressions, 0))     as impressions,
  sum(coalesce(engagements, 0))     as engagements
from end_of_day
group by day, platform;

-- Follower count at the end of each day.
create view public.daily_followers with (security_invoker = true) as
select distinct on (platform, (captured_at at time zone 'Asia/Manila')::date)
  platform,
  (captured_at at time zone 'Asia/Manila')::date as day,
  followers
from public.account_metric_snapshots
order by platform, (captured_at at time zone 'Asia/Manila')::date, captured_at desc;

-- Comments: anyone with the calendar link can leave one, no account needed.

create table public.post_comments (
  id           uuid primary key default gen_random_uuid(),
  post_id      uuid not null references public.posts (id) on delete cascade,
  author_name  text not null check (length(btrim(author_name)) between 1 and 60),
  body         text not null check (length(btrim(body)) between 1 and 2000),
  -- A hash of the sender's IP, kept only to rate-limit comments.
  sender       text,
  created_at   timestamptz not null default now()
);

create index post_comments_post_idx on public.post_comments (post_id, created_at);
create index post_comments_sender_idx on public.post_comments (sender, created_at);

-- Who may edit. Supabase lets anyone create an account, so being signed in is not enough:
-- the email must be listed here. Add yourself with
--   insert into public.editors (email) values ('you@silencio.network');

create table public.editors (
  email      text primary key check (email = lower(email)),
  added_at   timestamptz not null default now()
);

alter table public.editors enable row level security;

create or replace function public.is_editor() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.editors
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke execute on function public.is_editor() from public;
grant execute on function public.is_editor() to anon, authenticated;

create policy "editors see the editor list" on public.editors for select to authenticated
  using (public.is_editor());

-- Comments go in through this function rather than a direct insert, so names and text are
-- trimmed and one sender cannot post more than 5 comments in 10 minutes.
create or replace function public.add_comment(p_post_id uuid, p_author_name text, p_body text)
returns table (id uuid, post_id uuid, author_name text, body text, created_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  headers json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  ip text := btrim(split_part(coalesce(headers ->> 'x-forwarded-for', headers ->> 'x-real-ip', ''), ',', 1));
  who text := encode(extensions.digest(coalesce(nullif(ip, ''), 'unknown'), 'sha256'), 'hex');
  recent int;
begin
  if not exists (select 1 from public.posts p where p.id = p_post_id) then
    raise exception 'That post no longer exists' using errcode = 'P0002';
  end if;
  select count(*) into recent from public.post_comments c
  where c.sender = who and c.created_at > now() - interval '10 minutes';
  if recent >= 5 then
    raise exception 'Too many comments in a short time. Try again in a few minutes.' using errcode = 'P0001';
  end if;
  return query
    insert into public.post_comments as c (post_id, author_name, body, sender)
    values (p_post_id, btrim(p_author_name), btrim(p_body), who)
    returning c.id, c.post_id, c.author_name, c.body, c.created_at;
end;
$$;

revoke execute on function public.add_comment(uuid, text, text) from public;
grant execute on function public.add_comment(uuid, text, text) to anon, authenticated;

-- Row level security.
--   Everyone, signed in or not: reads posts, their assets and comments; comments via add_comment.
--   Editors: write posts and assets, delete comments, and read the stats and markers.
--   The collector: writes stats with the service role, which bypasses these rules.

alter table public.posts enable row level security;
alter table public.post_assets enable row level security;
alter table public.post_comments enable row level security;
alter table public.post_metric_snapshots enable row level security;
alter table public.account_metric_snapshots enable row level security;
alter table public.stat_markers enable row level security;

create policy "anyone reads posts" on public.posts for select to anon, authenticated using (true);
create policy "editors add posts" on public.posts for insert to authenticated with check (public.is_editor());
create policy "editors edit posts" on public.posts for update to authenticated using (public.is_editor()) with check (public.is_editor());
create policy "editors delete unpublished posts" on public.posts for delete to authenticated using (public.is_editor() and status <> 'published');

create policy "anyone reads assets" on public.post_assets for select to anon, authenticated using (true);
create policy "editors add assets" on public.post_assets for insert to authenticated with check (public.is_editor());
create policy "editors edit assets" on public.post_assets for update to authenticated using (public.is_editor()) with check (public.is_editor());
create policy "editors delete assets" on public.post_assets for delete to authenticated using (public.is_editor());

-- The sender hash stays out of public reads: anon and signed-in readers get every column but it.
revoke select on public.post_comments from anon, authenticated;
grant select (id, post_id, author_name, body, created_at) on public.post_comments to anon, authenticated;
create policy "anyone reads comments" on public.post_comments for select to anon, authenticated using (true);
create policy "editors delete comments" on public.post_comments for delete to authenticated using (public.is_editor());

create policy "editors read post stats" on public.post_metric_snapshots for select to authenticated using (public.is_editor());
create policy "editors read account stats" on public.account_metric_snapshots for select to authenticated using (public.is_editor());

create policy "editors read markers" on public.stat_markers for select to authenticated using (public.is_editor());
create policy "editors add markers" on public.stat_markers for insert to authenticated with check (public.is_editor());
create policy "editors edit markers" on public.stat_markers for update to authenticated
  using (public.is_editor()) with check (public.is_editor());
create policy "editors delete markers" on public.stat_markers for delete to authenticated
  using (public.is_editor());

-- Storage: post assets are viewable through signed links by anyone who can see the calendar;
-- only editors upload or change them.

insert into storage.buckets (id, name, public)
values ('post-assets', 'post-assets', false)
on conflict (id) do nothing;

create policy "anyone reads post assets" on storage.objects for select to anon, authenticated
  using (bucket_id = 'post-assets');
create policy "editors upload post assets" on storage.objects for insert to authenticated
  with check (bucket_id = 'post-assets' and public.is_editor());
create policy "editors replace post assets" on storage.objects for update to authenticated
  using (bucket_id = 'post-assets' and public.is_editor());
create policy "editors remove post assets" on storage.objects for delete to authenticated
  using (bucket_id = 'post-assets' and public.is_editor());
