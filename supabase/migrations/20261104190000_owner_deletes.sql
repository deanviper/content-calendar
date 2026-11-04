-- Only the calendar owner deletes posts.
--
-- Deleting moves a post to the bin (deleted_at is set): it leaves the calendar and the stats, but the
-- row stays, so the collector still recognises the live post and does not add it back, and the owner
-- can restore it. Other editors keep writing and editing posts; they cannot delete, bin or restore.

alter table public.posts add column if not exists deleted_at timestamptz;
alter table public.editors add column if not exists owner boolean not null default false;
update public.editors set owner = true where email = 'joaquin@silencio.network';
insert into public.editors (email, owner) values ('joaquin@silencio.network', true)
  on conflict (email) do update set owner = true;

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.editors
    where owner and email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

revoke execute on function public.is_owner() from public;
grant execute on function public.is_owner() to anon, authenticated;

-- Row rules cannot single out one column, so a trigger guards deleted_at. Calls from the API as a
-- signed-in or anonymous user are checked; the collector (service role) and the SQL editor are not.
create or replace function public.guard_post_bin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(auth.jwt() ->> 'role', '') in ('authenticated', 'anon')
     and (case when tg_op = 'INSERT' then new.deleted_at is not null
               else new.deleted_at is distinct from old.deleted_at end)
     and not public.is_owner() then
    raise exception 'Only the calendar owner can delete or restore posts' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists posts_guard_bin on public.posts;
create trigger posts_guard_bin before insert or update on public.posts
  for each row execute function public.guard_post_bin();

drop policy if exists "editors delete unpublished posts" on public.posts;
drop policy if exists "owner deletes posts" on public.posts;
create policy "owner deletes posts" on public.posts for delete to authenticated using (public.is_owner());

-- Binned posts drop out of the stats views (same columns as before, one more condition each).
create or replace view public.post_performance with (security_invoker = true) as
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
where p.status = 'published' and p.deleted_at is null;

create or replace view public.daily_post_metrics with (security_invoker = true) as
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
  join public.posts p on p.id = s.post_id and p.deleted_at is null
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

-- The post found on X for "Hausa, as it is spoken in Kano and Katsina" went out by mistake from an
-- old schedule (4 Nov 2026) and is being removed from X: it goes to the bin.
update public.posts set deleted_at = now()
where id = '7f00db16-3c44-4fbc-b261-9a741cae7843' and deleted_at is null;
