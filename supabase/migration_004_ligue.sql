-- Carnet Sport v6.5 : classement de ligue entre utilisateurs
-- Chaque client calcule son rang à partir de ses données (XP par jour) et publie une ligne ; tout le monde lit tout le monde.
create table if not exists public.league_board (
  user_id uuid primary key references auth.users(id) on delete cascade,
  name text,
  label text not null default 'Fer IV',
  tier int not null default 0,
  division int not null default 4,
  lp int not null default 0,
  score int not null default 0,
  streak int not null default 0,
  wins int not null default 0,
  games int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.league_board enable row level security;
drop policy if exists "league lecture" on public.league_board;
create policy "league lecture" on public.league_board for select to authenticated using (true);
drop policy if exists "league insertion" on public.league_board;
create policy "league insertion" on public.league_board for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "league mise a jour" on public.league_board;
create policy "league mise a jour" on public.league_board for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
revoke all on public.league_board from anon;
grant select, insert, update on public.league_board to authenticated;
