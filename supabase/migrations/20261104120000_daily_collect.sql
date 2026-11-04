-- Daily stats pull, inside Supabase. pg_cron calls the collect-stats function once a day at
-- 01:00 UTC (09:00 Manila) with the public anon key, the same key the website ships with. The
-- function only allows such a call to do a normal collect, and only when the last capture is
-- 20 hours old, so no secret is needed. Opening the calendar still pulls too, if a run was missed.

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('collect-stats-daily')
where exists (select 1 from cron.job where jobname = 'collect-stats-daily');

select cron.schedule(
  'collect-stats-daily',
  '0 1 * * *',
  $$
  select net.http_post(
    url := 'https://bgqqnykoeegqclxelvmf.supabase.co/functions/v1/collect-stats',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_m-WlGWOvKs42liOCiM782Q_Nv_gY8kQ',
      'Authorization', 'Bearer sb_publishable_m-WlGWOvKs42liOCiM782Q_Nv_gY8kQ'
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  );
  $$
);
