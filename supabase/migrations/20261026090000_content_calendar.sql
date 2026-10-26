-- Content calendar and stats schema.
--
-- posts                     one row per X or LinkedIn post, planned or published
-- post_assets               images, videos and files attached to a post (files live in storage)
-- post_metric_snapshots     a post's numbers at a moment; collected repeatedly, never overwritten
-- account_metric_snapshots  follower counts per platform over time
-- stat_markers              named points in time to compare against ("baseline", "campaign start")
--
-- Every snapshot is kept, so the first one for a post is its baseline and any later one can be
-- compared with it or with a marker. Reads and planning writes are for listed team members;
-- snapshots are written only by the collector, which uses the service role.

create extension if not exists pgcrypto;

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

-- Who counts as the team. Supabase lets anyone create an account by default, so being signed in
-- is not enough: the email must be listed here. Add people with
--   insert into public.team_members (email) values ('name@example.com');

create table public.team_members (
  email      text primary key check (email = lower(email)),
  added_at   timestamptz not null default now()
);

alter table public.team_members enable row level security;

create or replace function public.is_team() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.team_members
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke execute on function public.is_team() from public;
grant execute on function public.is_team() to authenticated;

create policy "members see the team list" on public.team_members for select to authenticated
  using (public.is_team());

-- Row level security: team members read everything and plan posts and markers.

alter table public.posts enable row level security;
alter table public.post_assets enable row level security;
alter table public.post_metric_snapshots enable row level security;
alter table public.account_metric_snapshots enable row level security;
alter table public.stat_markers enable row level security;

create policy "team reads posts" on public.posts for select to authenticated using (public.is_team());
create policy "team writes posts" on public.posts for insert to authenticated with check (public.is_team());
create policy "team edits posts" on public.posts for update to authenticated using (public.is_team()) with check (public.is_team());
create policy "team deletes unpublished posts" on public.posts for delete to authenticated using (public.is_team() and status <> 'published');

create policy "team reads assets" on public.post_assets for select to authenticated using (public.is_team());
create policy "team writes assets" on public.post_assets for insert to authenticated with check (public.is_team());
create policy "team edits assets" on public.post_assets for update to authenticated using (public.is_team()) with check (public.is_team());
create policy "team deletes assets" on public.post_assets for delete to authenticated using (public.is_team());

create policy "team reads post stats" on public.post_metric_snapshots for select to authenticated using (public.is_team());
create policy "team reads account stats" on public.account_metric_snapshots for select to authenticated using (public.is_team());

create policy "team reads markers" on public.stat_markers for select to authenticated using (public.is_team());
create policy "team adds markers" on public.stat_markers for insert to authenticated with check (public.is_team());
create policy "authors edit markers" on public.stat_markers for update to authenticated
  using (public.is_team() and created_by = auth.uid()) with check (public.is_team() and created_by = auth.uid());
create policy "authors delete markers" on public.stat_markers for delete to authenticated
  using (public.is_team() and created_by = auth.uid());

-- Storage: a private bucket for post assets, readable by the team through signed URLs.

insert into storage.buckets (id, name, public)
values ('post-assets', 'post-assets', false)
on conflict (id) do nothing;

create policy "team reads post assets" on storage.objects for select to authenticated
  using (bucket_id = 'post-assets' and public.is_team());
create policy "team uploads post assets" on storage.objects for insert to authenticated
  with check (bucket_id = 'post-assets' and public.is_team());
create policy "team replaces post assets" on storage.objects for update to authenticated
  using (bucket_id = 'post-assets' and public.is_team());
create policy "team removes post assets" on storage.objects for delete to authenticated
  using (bucket_id = 'post-assets' and public.is_team());
