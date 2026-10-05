-- v7.3 (05/10/2026) : l'app est découpée en briques. L'admin choisit pour chaque brique « gratuite » (tout le monde)
-- ou « option » (formule complète, ou activée compte par compte). Appliquée par execute_sql en étapes, inscrite à la main
-- dans supabase_migrations (20261005190000 briques_gratuites_options).
-- Contrôles côté serveur : IA (fonction ai), import Santé (jeton refusé et révoqué), ligue (écriture et lecture du classement).
-- Les autres briques sont des écrans de l'app : verrouillées dans l'interface.
create table if not exists public.feature_tiers (key text primary key, tier text not null default 'gratuit' check (tier in ('gratuit', 'option')), updated_at timestamptz not null default now());
alter table public.feature_tiers enable row level security;
create policy "briques lecture" on public.feature_tiers for select to authenticated using (true);
insert into public.feature_tiers (key, tier) values
 ('seances_types','gratuit'),('salle','gratuit'),('guide_exos','gratuit'),('coach','gratuit'),('progres','gratuit'),('muscles','gratuit'),
 ('nutrition','gratuit'),('ia_repas','option'),('corps','gratuit'),('sommeil','gratuit'),('ia_sommeil','option'),('import_sante','gratuit'),
 ('withings','gratuit'),('ligue','gratuit'),('rituel','gratuit'),('recap','gratuit'),('partage','gratuit'),('export','gratuit')
on conflict (key) do nothing;
-- options activées compte par compte (en plus des briques gratuites) ; plan 'complet' = toutes les briques
alter table public.profiles add column if not exists options text[] not null default '{}';

create or replace function public._feature_ok(p_uid uuid, p_key text) returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.role = 'admin' or p.plan = 'complet' or p_key = any(p.options) from public.profiles p where p.user_id = p_uid), false)
      or coalesce((select t.tier = 'gratuit' from public.feature_tiers t where t.key = p_key), false);
$$;
revoke all on function public._feature_ok(uuid, text) from public, anon, authenticated;
grant execute on function public._feature_ok(uuid, text) to service_role;

create or replace function public.has_feature(p_key text) returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and public._feature_ok(auth.uid(), p_key);
$$;
revoke all on function public.has_feature(text) from public, anon;
grant execute on function public.has_feature(text) to authenticated, service_role;

-- jeton d'import Santé rendu inutilisable si l'option n'est plus incluse (pas de suppression : jeton remplacé par une valeur aléatoire)
create or replace function public._feature_sync() returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  update public.import_tokens t set token = 'revoque-' || encode(extensions.gen_random_bytes(24), 'hex'), last_status = 'option retirée'
   where t.token not like 'revoque-%' and not public._feature_ok(t.user_id, 'import_sante');
end $$;
revoke all on function public._feature_sync() from public, anon, authenticated;
grant execute on function public._feature_sync() to service_role;

create or replace function public.admin_set_feature(p_key text, p_tier text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if p_key !~ '^[a-z_]{2,30}$' then raise exception 'Brique inconnue'; end if;
  insert into public.feature_tiers (key, tier, updated_at) values (p_key, case when p_tier = 'option' then 'option' else 'gratuit' end, now())
  on conflict (key) do update set tier = excluded.tier, updated_at = now();
  perform public._feature_sync();
end $$;
revoke all on function public.admin_set_feature(text, text) from public, anon;
grant execute on function public.admin_set_feature(text, text) to authenticated, service_role;

create or replace function public.admin_set_options(p_id uuid, p_options text[]) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  update public.profiles set options = coalesce((select array_agg(distinct o order by o) from unnest(p_options) o where o ~ '^[a-z_]{2,30}$'), '{}') where user_id = p_id;
  perform public._feature_sync();
end $$;
revoke all on function public.admin_set_options(uuid, text[]) from public, anon;
grant execute on function public.admin_set_options(uuid, text[]) to authenticated, service_role;

create or replace function public.admin_set_plan(p_id uuid, p_plan text) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  update public.profiles set plan = case when p_plan = 'complet' then 'complet' else 'gratuit' end where user_id = p_id;
  perform public._feature_sync();
end $$;

create or replace function public.import_token_rotate() returns text language plpgsql security definer set search_path = public, extensions as $$
declare t text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  if not public.has_feature('import_sante') then raise exception 'Option non incluse dans ta formule'; end if;
  insert into public.import_tokens (user_id, token) values (auth.uid(), t)
  on conflict (user_id) do update set token = excluded.token, created_at = now(), last_status = null;
  return t;
end $$;

-- ligue : écrire sa ligne et voir le classement demandent la brique ; les comptes sans la brique n'apparaissent plus
alter policy "league insertion" on public.league_board with check (auth.uid() = user_id and public.has_feature('ligue'));
alter policy "league mise a jour" on public.league_board using (auth.uid() = user_id) with check (auth.uid() = user_id and public.has_feature('ligue'));
create or replace function public.league_visible(p_uid uuid) returns boolean language sql stable security definer set search_path = public as $$ select public._feature_ok(p_uid, 'ligue'); $$;
revoke all on function public.league_visible(uuid) from public, anon;
grant execute on function public.league_visible(uuid) to authenticated, service_role;
alter policy "league lecture" on public.league_board using (public.has_feature('ligue') and public.league_visible(user_id));
