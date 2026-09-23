-- Carnet Sport : schéma multi-utilisateurs (docs par compte, profils, rôles)

-- Profils : un par compte, rôle admin ou user
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  email      text,
  name       text default '',
  role       text not null default 'user' check (role in ('admin', 'user')),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where user_id = auth.uid() and role = 'admin');
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

drop policy if exists "profiles lecture" on public.profiles;
create policy "profiles lecture" on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- aucune écriture côté client : les fonctions serveur (service role) gèrent les comptes

-- Profil créé automatiquement à la création d'un compte
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', ''))
  on conflict (user_id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Documents : une ligne par document, calqué sur le modèle de l'app
create table if not exists public.docs (
  user_id    uuid not null references auth.users(id) on delete cascade,
  col        text not null check (col in ('exercises', 'sessions', 'nutrition', 'health', 'templates', 'settings', 'favorites', 'coach')),
  doc_id     text not null,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, col, doc_id)
);
create index if not exists docs_user_updated_idx on public.docs (user_id, updated_at desc);
alter table public.docs enable row level security;

drop policy if exists "docs lecture perso"   on public.docs;
drop policy if exists "docs insertion perso" on public.docs;
drop policy if exists "docs update perso"    on public.docs;
drop policy if exists "docs delete perso"    on public.docs;
create policy "docs lecture perso"   on public.docs for select to authenticated using (auth.uid() = user_id);
create policy "docs insertion perso" on public.docs for insert to authenticated with check (auth.uid() = user_id);
create policy "docs update perso"    on public.docs for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "docs delete perso"    on public.docs for delete to authenticated using (auth.uid() = user_id);

create or replace function public.docs_touch() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists docs_touch_trg on public.docs;
create trigger docs_touch_trg before insert or update on public.docs
  for each row execute function public.docs_touch();

-- Synchro temps réel entre appareils (filtrée par RLS)
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs') then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;

-- ===== Administration des comptes (RPC réservées aux administrateurs) =====
create or replace function public._create_user(p_email text, p_password text, p_name text, p_role text) returns uuid
language plpgsql security definer set search_path = public, auth, extensions as $$
declare uid uuid := gen_random_uuid(); em text := lower(trim(p_email));
begin
  if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E-mail invalide'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Mot de passe : 8 caractères minimum'; end if;
  if exists (select 1 from auth.users where lower(email) = em) then raise exception 'Un compte existe déjà avec cet e-mail.'; end if;
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change, email_change_token_current,
    phone_change, phone_change_token, reauthentication_token, is_sso_user, is_anonymous)
  values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', em,
    extensions.crypt(p_password, extensions.gen_salt('bf', 10)), now(), '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', coalesce(p_name, '')), now(), now(), '', '', '', '', '', '', '', '', false, false);
  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), uid, uid::text, jsonb_build_object('sub', uid::text, 'email', em, 'email_verified', true, 'phone_verified', false), 'email', now(), now(), now());
  insert into public.profiles (user_id, email, name, role)
  values (uid, em, coalesce(p_name, ''), case when p_role = 'admin' then 'admin' else 'user' end)
  on conflict (user_id) do update set name = excluded.name, role = excluded.role, email = excluded.email;
  return uid;
end $$;
revoke all on function public._create_user(text, text, text, text) from public, anon, authenticated;

create or replace function public.admin_list_users()
returns table (id uuid, email text, name text, role text, created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  return query select u.id, u.email::text, coalesce(p.name, u.raw_user_meta_data->>'name', '')::text, coalesce(p.role, 'user')::text, u.created_at, u.last_sign_in_at
    from auth.users u left join public.profiles p on p.user_id = u.id
    where u.deleted_at is null and coalesce(u.is_anonymous, false) = false
    order by lower(coalesce(nullif(p.name, ''), u.email));
end $$;

create or replace function public.admin_create_user(p_email text, p_password text, p_name text default '', p_role text default 'user') returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  return public._create_user(p_email, p_password, p_name, p_role);
end $$;

create or replace function public.admin_update_user(p_id uuid, p_name text default null, p_role text default null) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if p_name is not null then
    update public.profiles set name = trim(p_name) where user_id = p_id;
    update auth.users set raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) || jsonb_build_object('name', trim(p_name)), updated_at = now() where id = p_id;
  end if;
  if p_role is not null and p_id <> auth.uid() then
    update public.profiles set role = case when p_role = 'admin' then 'admin' else 'user' end where user_id = p_id;
  end if;
end $$;

create or replace function public.admin_reset_password(p_id uuid, p_password text) returns void
language plpgsql security definer set search_path = public, auth, extensions as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception 'Mot de passe : 8 caractères minimum'; end if;
  update auth.users set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), updated_at = now() where id = p_id;
  delete from auth.sessions where user_id = p_id;
end $$;

create or replace function public.admin_delete_user(p_id uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then raise exception 'Réservé aux administrateurs'; end if;
  if p_id = auth.uid() then raise exception 'Tu ne peux pas supprimer ton propre compte.'; end if;
  delete from auth.users where id = p_id;
end $$;

grant execute on function public.admin_list_users() to authenticated;
grant execute on function public.admin_create_user(text, text, text, text) to authenticated;
grant execute on function public.admin_update_user(uuid, text, text) to authenticated;
grant execute on function public.admin_reset_password(uuid, text) to authenticated;
grant execute on function public.admin_delete_user(uuid) to authenticated;
