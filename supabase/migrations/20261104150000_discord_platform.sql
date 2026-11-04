-- Discord posts are planned in the calendar too. They are posted by hand in the server and marked
-- posted from the calendar; the stats collector never reads them.
alter type public.platform add value if not exists 'discord';
