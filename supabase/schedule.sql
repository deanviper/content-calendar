-- Runs the stats collector on a schedule. Not a migration, because it needs project secrets:
-- run it once in the Supabase SQL editor after deploying the collect-stats function.
--
-- 1. Store the two values in Vault (replace the placeholders):
select vault.create_secret('https://YOUR-PROJECT-REF.supabase.co/functions/v1/collect-stats', 'collector_url');
select vault.create_secret('YOUR-COLLECTOR-SECRET', 'collector_secret');

-- 2. Schedule it daily at 01:00 UTC (09:00 Manila). Each run marks drafts that have gone live as
--    posted and adds one snapshot per post published in the last LOOKBACK_DAYS. The Resync button
--    on the stats page runs the same thing on demand.
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'collect-stats',
  '0 1 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'collector_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-collector-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'collector_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

-- To stop it:  select cron.unschedule('collect-stats');
-- Run history: select * from cron.job_run_details order by start_time desc limit 20;
