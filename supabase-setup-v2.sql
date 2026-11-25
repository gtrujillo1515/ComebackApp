-- Stack It Up! 2 shared leaderboard (kept separate from the original game's scores).
-- Paste into the Supabase SQL Editor and click Run (once).

create table public.scores_v2 (
  id         bigint generated always as identity primary key,
  name       text        not null check (name ~ '^[A-Z0-9 .''&-]{1,10}$'),
  score      integer     not null check (score between 1 and 5000000),
  burgers    integer     not null default 0 check (burgers between 0 and 5000),
  level      integer     not null default 1 check (level between 1 and 3),
  created_at timestamptz not null default now()
);

create index scores_v2_score_idx on public.scores_v2 (score desc, created_at asc);

alter table public.scores_v2 enable row level security;
create policy "read scores" on public.scores_v2 for select to anon using (true);
create policy "add a score" on public.scores_v2 for insert to anon with check (true);
grant select, insert on public.scores_v2 to anon;
