-- Stack It Up! shared leaderboard.
-- Paste into the Supabase SQL Editor and click Run (once).

create table public.scores (
  id         bigint generated always as identity primary key,
  name       text        not null check (name ~ '^[A-Z0-9 .''&-]{1,10}$'),
  score      integer     not null check (score between 1 and 200000),
  burgers    integer     not null default 0 check (burgers between 0 and 2000),
  created_at timestamptz not null default now()
);

create index scores_score_idx on public.scores (score desc, created_at asc);

-- Players may read scores and add a score. Nobody can edit or delete from the game.
alter table public.scores enable row level security;
create policy "read scores" on public.scores for select to anon using (true);
create policy "add a score" on public.scores for insert to anon with check (true);
grant select, insert on public.scores to anon;
