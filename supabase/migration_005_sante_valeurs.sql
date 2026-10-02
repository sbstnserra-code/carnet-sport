-- v6.9.2 : une mesure corporelle impossible (poids 0 envoyé par le Raccourci, masse grasse 0…) n'est jamais enregistrée.
-- À l'écriture d'un doc « health » : valeur hors bornes -> on garde l'ancienne valeur valide du même jour, sinon la clé est retirée.
create or replace function public.health_val_ok(v jsonb, lo numeric, hi numeric)
returns boolean language plpgsql immutable set search_path = public as $$
begin
  if v is null or jsonb_typeof(v) not in ('number', 'string') then return false; end if;
  return (v #>> '{}')::numeric between lo and hi;
exception when others then return false;
end $$;

create or replace function public.docs_health_sanitize()
returns trigger language plpgsql set search_path = public as $$
declare r record; v jsonb;
begin
  if new.col <> 'health' or new.data is null or jsonb_typeof(new.data) <> 'object' then return new; end if;
  for r in select * from (values ('weight', 20::numeric, 400::numeric), ('fat', 2, 75), ('muscle', 5, 100), ('lean', 10, 250)) as t(k, lo, hi) loop
    v := new.data -> r.k;
    if v is null or jsonb_typeof(v) = 'null' or public.health_val_ok(v, r.lo, r.hi) then continue; end if;
    if tg_op = 'UPDATE' and old.data is not null and public.health_val_ok(old.data -> r.k, r.lo, r.hi) then
      new.data := jsonb_set(new.data, array[r.k], old.data -> r.k);
    else
      new.data := new.data - r.k;
    end if;
  end loop;
  return new;
end $$;

revoke all on function public.docs_health_sanitize() from public, anon, authenticated;
drop trigger if exists docs_health_sanitize_trg on public.docs;
create trigger docs_health_sanitize_trg before insert or update on public.docs for each row execute function public.docs_health_sanitize();
