-- X threads: the follow-up tweets that go out as replies to the post itself, in order.
-- The first tweet stays in posts.copy, so matching, stats and LinkedIn posts are unchanged.
alter table public.posts add column if not exists thread text[] not null default '{}';
