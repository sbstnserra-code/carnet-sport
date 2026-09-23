-- Carnet Sport : import automatique Apple Santé (Health Auto Export)
-- Appliquée le 23/09/2026 sous le nom « import_sante_automatique ».
create table if not exists public.import_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  token text not null unique,
  created_at timestamptz not null default now(),
  last_import_at timestamptz,
  last_status text,
  last_summary jsonb,
  last_payload jsonb
);
alter table public.import_tokens enable row level security;
create policy "import_tokens lecture perso" on public.import_tokens for select to authenticated using (user_id = auth.uid());
revoke all on public.import_tokens from anon;
grant select on public.import_tokens to authenticated;

-- Un jeton par compte ; le remplacer invalide l'ancien. Seule la fonction edge (service role) lit le jeton pour authentifier l'iPhone.
create or replace function public.import_token_rotate()
returns text
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $$
declare t text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  insert into public.import_tokens (user_id, token) values (auth.uid(), t)
  on conflict (user_id) do update set token = excluded.token, created_at = now(), last_status = null;
  return t;
end $$;
revoke all on function public.import_token_rotate() from public, anon;
grant execute on function public.import_token_rotate() to authenticated;
