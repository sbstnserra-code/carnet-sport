-- Carnet Sport : connexion Withings (OAuth2) et synchronisation quotidienne
-- Appliquée le 23/09/2026 (migrations « withings_connexion » et « withings_cron_key_rpc »).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Comptes Withings connectés : jetons lus uniquement par les fonctions serveur (service role), jamais par le client
create table if not exists public.withings_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  withings_userid text,
  access_token text not null,
  refresh_token text not null,
  expires_at timestamptz not null,
  scope text,
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_status text,
  last_summary jsonb
);
alter table public.withings_accounts enable row level security;
revoke all on public.withings_accounts from anon, authenticated;

-- États OAuth en attente (10 minutes)
create table if not exists public.withings_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.withings_oauth_states enable row level security;
revoke all on public.withings_oauth_states from anon, authenticated;

-- Statut visible par l'utilisateur (sans les jetons)
create or replace function public.withings_status() returns jsonb language sql security definer set search_path to 'public' as $$
  select case when a.user_id is null then null else jsonb_build_object(
    'connected_at', a.connected_at, 'last_sync_at', a.last_sync_at, 'last_status', a.last_status, 'last_summary', a.last_summary, 'withings_userid', a.withings_userid) end
  from (select 1) x left join public.withings_accounts a on a.user_id = auth.uid();
$$;
revoke all on function public.withings_status() from public, anon;
grant execute on function public.withings_status() to authenticated;

create or replace function public.withings_disconnect() returns void language plpgsql security definer set search_path to 'public' as $$
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  delete from public.withings_accounts where user_id = auth.uid();
  delete from public.withings_oauth_states where user_id = auth.uid();
end $$;
revoke all on function public.withings_disconnect() from public, anon;
grant execute on function public.withings_disconnect() to authenticated;

-- Secret partagé entre pg_cron et la fonction withings-sync (Vault), lisible par le service role seulement
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'withings_cron_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'withings_cron_key', 'Clé d''appel de withings-sync par pg_cron');
  end if;
end $$;
create or replace function public.withings_cron_key() returns text language sql security definer set search_path to 'public', 'vault' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'withings_cron_key' limit 1; $$;
revoke all on function public.withings_cron_key() from public, anon, authenticated;
grant execute on function public.withings_cron_key() to service_role;

-- Synchronisation de tous les comptes : 05:45 UTC (07:45 Paris en été) et 11:00 UTC
create or replace function public.withings_cron_call() returns void language plpgsql security definer set search_path to 'public', 'extensions', 'vault' as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'withings_cron_key';
  perform net.http_post(url := 'https://uzvqyrghjadfbmwoebht.supabase.co/functions/v1/withings-sync',
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Key', k), body := '{"all":true}'::jsonb, timeout_milliseconds := 30000);
end $$;
revoke all on function public.withings_cron_call() from public, anon, authenticated;
select cron.schedule('withings-sync-matin', '45 5 * * *', 'select public.withings_cron_call()');
select cron.schedule('withings-sync-midi', '0 11 * * *', 'select public.withings_cron_call()');
