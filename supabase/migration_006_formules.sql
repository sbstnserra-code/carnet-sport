-- v7.2 (05/10/2026) : formule par compte, gratuite ou complète. Appliquée par execute_sql en étapes, inscrite à la main
-- dans supabase_migrations (20261005140000 formules_gratuit_complet).
-- Les fonctions qui coûtent (IA : estimation des repas, lecture des captures de sommeil) sont réservées à la formule complète
-- et aux admins ; le blocage est fait côté serveur dans la fonction ai.
-- Le client ne peut pas modifier sa formule : aucune politique d'écriture sur profiles, seule la RPC admin_set_plan la change.
-- L'admin lit les formules directement dans profiles (politique « profiles lecture » : soi-même ou admin).
alter table public.profiles add column if not exists plan text not null default 'gratuit';
alter table public.profiles add constraint profiles_plan_check check (plan in ('gratuit', 'complet'));
-- comptes existants au 05/10 : rien ne change pour eux ; les nouveaux comptes démarrent en gratuit (valeur par défaut)
update public.profiles set plan = 'complet' where plan = 'gratuit';

create or replace function public.admin_set_plan(p_id uuid, p_plan text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  update public.profiles set plan = case when p_plan = 'complet' then 'complet' else 'gratuit' end where user_id = p_id;
end $$;
revoke all on function public.admin_set_plan(uuid, text) from public, anon;
grant execute on function public.admin_set_plan(uuid, text) to authenticated, service_role;
