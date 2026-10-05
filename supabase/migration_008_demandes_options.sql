-- v7.4 (05/10/2026) : un utilisateur demande une brique en option, l'admin accepte ou refuse.
-- Appliquée par execute_sql en étapes, inscrite à la main (20261005200000 demandes_options).
create table if not exists public.option_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (key ~ '^[a-z_]{2,30}$'),
  status text not null default 'en_attente' check (status in ('en_attente', 'acceptee', 'refusee')),
  message text check (message is null or char_length(message) <= 300),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  seen_at timestamptz
);
-- une seule demande en attente par compte et par brique
create unique index if not exists option_requests_une_en_attente on public.option_requests (user_id, key) where status = 'en_attente';
create index if not exists option_requests_statut on public.option_requests (status, created_at);
alter table public.option_requests enable row level security;
-- chacun voit ses demandes, l'admin voit tout ; on ne peut créer qu'une demande en attente, pour soi, pour une brique existante qu'on n'a pas
create policy "demandes lecture" on public.option_requests for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "demandes creation" on public.option_requests for insert to authenticated with check (user_id = auth.uid() and status = 'en_attente' and decided_at is null and seen_at is null
  and exists (select 1 from public.feature_tiers t where t.key = option_requests.key) and not public.has_feature(option_requests.key));

-- décision de l'admin : accepter ajoute la brique aux options du compte
create or replace function public.admin_decide_request(p_id uuid, p_accept boolean) returns void language plpgsql security definer set search_path = public as $$
declare r public.option_requests;
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  select * into r from public.option_requests where id = p_id for update;
  if not found then raise exception 'Demande introuvable'; end if;
  if r.status <> 'en_attente' then raise exception 'Demande déjà traitée'; end if;
  update public.option_requests set status = case when p_accept then 'acceptee' else 'refusee' end, decided_at = now() where id = p_id;
  if p_accept then
    update public.profiles set options = (select array_agg(distinct o order by o) from unnest(options || array[r.key]) o) where user_id = r.user_id;
    perform public._feature_sync();
  end if;
end $$;
revoke all on function public.admin_decide_request(uuid, boolean) from public, anon;
grant execute on function public.admin_decide_request(uuid, boolean) to authenticated, service_role;

-- l'utilisateur a vu la réponse
create or replace function public.option_request_seen(p_id uuid) returns void language sql security definer set search_path = public as $$
  update public.option_requests set seen_at = now() where id = p_id and user_id = auth.uid() and status <> 'en_attente' and seen_at is null;
$$;
revoke all on function public.option_request_seen(uuid) from public, anon;
grant execute on function public.option_request_seen(uuid) to authenticated, service_role;

-- temps réel : l'admin voit arriver les demandes, l'utilisateur voit la réponse
alter publication supabase_realtime add table public.option_requests;
