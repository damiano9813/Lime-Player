-- Server di sincronizzazione di Xtream Player (Supabase / PostgreSQL 15+).
-- Da eseguire una volta nel progetto Supabase: SQL Editor > New query > incolla > Run.
--
-- Il server conserva solo dati cifrati dai dispositivi (AES-GCM, chiave derivata dal codice di
-- sincronizzazione che il server non vede mai). Le tabelle non sono leggibili con la chiave
-- pubblica "anon": si accede solo dalle funzioni qui sotto, che verificano il segreto del gruppo.

create table if not exists public.xp_spaces (
  id text primary key check (id ~ '^[0-9a-f]{32}$'),
  -- SHA-256 del segreto "auth" derivato dal codice
  auth_hash text not null,
  created_at timestamptz not null default now(),
  seen_at timestamptz not null default now()
);

create sequence if not exists public.xp_seq;

create table if not exists public.xp_items (
  space text not null references public.xp_spaces(id) on delete cascade,
  -- HMAC della chiave (preferiti, ripresa, playlist…): opaco per il server
  id text not null check (id ~ '^[0-9a-f]{32}$'),
  data text not null check (length(data) <= 262144),
  -- data della modifica sul dispositivo (ms): vince la più recente
  t bigint not null,
  seq bigint not null default nextval('public.xp_seq'),
  primary key (space, id)
);
create index if not exists xp_items_space_seq on public.xp_items (space, seq);

-- abbinamento di un nuovo dispositivo: chiave pubblica effimera e risposta cifrata, 10 minuti
create table if not exists public.xp_pairings (
  code text primary key check (code ~ '^[0-9]{8}$'),
  pubkey text not null check (length(pubkey) < 200),
  reply text check (length(reply) < 4096),
  created_at timestamptz not null default now()
);

alter table public.xp_spaces enable row level security;
alter table public.xp_items enable row level security;
alter table public.xp_pairings enable row level security;
revoke all on public.xp_spaces, public.xp_items, public.xp_pairings from anon, authenticated;

create or replace function public.xp_auth_ok(p_space text, p_auth text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from xp_spaces
    where id = p_space and auth_hash = encode(sha256(convert_to(p_auth, 'UTF8')), 'hex')
  );
$$;

-- Entra nel gruppo (lo crea al primo accesso). Errore se esiste con un segreto diverso.
create or replace function public.xp_join(p_space text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into xp_spaces (id, auth_hash)
  values (p_space, encode(sha256(convert_to(p_auth, 'UTF8')), 'hex'))
  on conflict (id) do nothing;
  if not xp_auth_ok(p_space, p_auth) then
    raise exception 'codice non valido' using errcode = '28000';
  end if;
  update xp_spaces set seen_at = now() where id = p_space;
end;
$$;

-- Pubblica le voci modificate: [{ "id": "...", "data": "...", "t": 123 }]. Una voce sul server
-- viene sostituita solo da una modifica più recente. Restituisce l'ultimo numero di sequenza.
create or replace function public.xp_push(p_space text, p_auth text, p_items jsonb) returns bigint
language plpgsql security definer set search_path = public as $$
begin
  if not xp_auth_ok(p_space, p_auth) then
    raise exception 'codice non valido' using errcode = '28000';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'troppe voci in una richiesta';
  end if;
  insert into xp_items (space, id, data, t)
  select p_space, e->>'id', e->>'data', (e->>'t')::bigint
  from jsonb_array_elements(p_items) e
  on conflict (space, id) do update
    set data = excluded.data, t = excluded.t, seq = nextval('public.xp_seq')
    where xp_items.t < excluded.t;
  return coalesce((select max(seq) from xp_items where space = p_space), 0);
end;
$$;

-- Voci cambiate dopo `p_since` (al massimo 1000 per richiesta, in ordine di sequenza).
create or replace function public.xp_pull(p_space text, p_auth text, p_since bigint)
returns table (id text, data text, t bigint, seq bigint)
language plpgsql security definer set search_path = public as $$
begin
  if not xp_auth_ok(p_space, p_auth) then
    raise exception 'codice non valido' using errcode = '28000';
  end if;
  return query
    select i.id, i.data, i.t, i.seq from xp_items i
    where i.space = p_space and i.seq > p_since
    order by i.seq
    limit 1000;
end;
$$;

-- Disattivazione da un dispositivo: cancella il gruppo e tutti i suoi dati.
create or replace function public.xp_delete(p_space text, p_auth text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not xp_auth_ok(p_space, p_auth) then
    raise exception 'codice non valido' using errcode = '28000';
  end if;
  delete from xp_spaces where id = p_space;
end;
$$;

-- La TV pubblica la sua chiave pubblica con un codice di 8 cifre mostrato sullo schermo.
create or replace function public.xp_pair_start(p_code text, p_pubkey text) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from xp_pairings where created_at < now() - interval '10 minutes';
  insert into xp_pairings (code, pubkey) values (p_code, p_pubkey);
end;
$$;

-- Il dispositivo già collegato legge la chiave pubblica della TV…
create or replace function public.xp_pair_get(p_code text) returns text
language sql security definer set search_path = public as $$
  select pubkey from xp_pairings
  where code = p_code and reply is null and created_at > now() - interval '10 minutes';
$$;

-- …e le risponde una sola volta con il codice di sincronizzazione cifrato.
create or replace function public.xp_pair_reply(p_code text, p_reply text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update xp_pairings set reply = p_reply
  where code = p_code and reply is null and created_at > now() - interval '10 minutes';
  get diagnostics n = row_count;
  return n = 1;
end;
$$;

-- La TV ritira la risposta (che sparisce dal server).
create or replace function public.xp_pair_poll(p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  delete from xp_pairings where code = p_code and reply is not null returning reply into r;
  return r;
end;
$$;

revoke all on function public.xp_auth_ok(text, text) from public, anon, authenticated;
-- solo la chiave pubblica (anon): gli utenti registrati del progetto, che l'app non usa, restano fuori
revoke all on function
  public.xp_join(text, text), public.xp_push(text, text, jsonb), public.xp_pull(text, text, bigint),
  public.xp_delete(text, text), public.xp_pair_start(text, text), public.xp_pair_get(text),
  public.xp_pair_reply(text, text), public.xp_pair_poll(text)
from public, authenticated;
grant execute on function
  public.xp_join(text, text), public.xp_push(text, text, jsonb), public.xp_pull(text, text, bigint),
  public.xp_delete(text, text), public.xp_pair_start(text, text), public.xp_pair_get(text),
  public.xp_pair_reply(text, text), public.xp_pair_poll(text)
to anon;
