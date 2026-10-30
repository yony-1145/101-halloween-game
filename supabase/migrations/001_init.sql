-- 001_init: document store, leases and access policies.
-- Idempotent: safe to run more than once.

-- ---- Documents ----
-- path is "<collection>/<id>", e.g. 'game/state' or 'buzzes/r1-t1-1'.
create sequence if not exists public.docs_ver_seq;

create table if not exists public.docs (
  path       text primary key check (char_length(path) between 3 and 200 and path ~ '^[^/]+/[^/]+$'),
  coll       text generated always as (split_part(path, '/', 1)) stored,
  data       jsonb not null default '{}'::jsonb check (octet_length(data::text) < 100000),
  ver        bigint not null default nextval('public.docs_ver_seq'),
  updated_at timestamptz not null default now()
);
create index if not exists docs_coll_idx on public.docs (coll);

-- Bump ver on every update so clients can discard stale rows.
create or replace function public.docs_bump_ver() returns trigger
language plpgsql set search_path = public as $$
begin
  new.ver := nextval('public.docs_ver_seq');
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists docs_bump_ver on public.docs;
create trigger docs_bump_ver before update on public.docs
  for each row execute function public.docs_bump_ver();

-- Shallow-merge a patch into an existing document.
create or replace function public.doc_update(p_path text, p_patch jsonb) returns void
language sql security invoker set search_path = public as $$
  update public.docs set data = data || p_patch where path = p_path;
$$;

-- ---- Leases ----
-- Short-lived locks (one buzz per team at a time) that also return the server time.
create table if not exists public.leases (
  key        text primary key,
  holder     text not null,
  expires_at timestamptz not null
);

create or replace function public.acquire_lease(p_key text, p_holder text, p_ttl_ms int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_now  timestamptz := clock_timestamp();
  v_exp  timestamptz;
  v_hold text;
  v_cur  timestamptz;
begin
  if p_key is null or char_length(p_key) > 200 or p_holder is null or char_length(p_holder) > 100 then
    raise exception 'bad lease key/holder';
  end if;
  if p_ttl_ms is null or p_ttl_ms < 1 or p_ttl_ms > 60000 then
    raise exception 'bad ttl';
  end if;
  v_exp := v_now + make_interval(secs => p_ttl_ms / 1000.0);

  insert into public.leases as l (key, holder, expires_at)
  values (p_key, p_holder, v_exp)
  on conflict (key) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where l.expires_at <= v_now or l.holder = excluded.holder
  returning l.holder into v_hold;

  if found then
    return jsonb_build_object(
      'acquired', true, 'holder', p_holder,
      'expiresAt', to_char(v_exp at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
  end if;

  select holder, expires_at into v_hold, v_cur from public.leases where key = p_key;
  return jsonb_build_object(
    'acquired', false, 'holder', v_hold,
    'expiresAt', to_char(v_cur at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
end $$;

-- ---- Access ----
-- Public read/write on docs; leases are reachable only through acquire_lease().
alter table public.docs   enable row level security;
alter table public.leases enable row level security;

drop policy if exists docs_select on public.docs;
drop policy if exists docs_insert on public.docs;
drop policy if exists docs_update on public.docs;
drop policy if exists docs_delete on public.docs;
create policy docs_select on public.docs for select to anon, authenticated using (true);
create policy docs_insert on public.docs for insert to anon, authenticated with check (true);
create policy docs_update on public.docs for update to anon, authenticated using (true) with check (true);
create policy docs_delete on public.docs for delete to anon, authenticated using (true);

grant select, insert, update, delete on public.docs to anon, authenticated;
grant usage on sequence public.docs_ver_seq to anon, authenticated;
revoke all on public.leases from anon, authenticated;
revoke all on function public.acquire_lease(text, text, int) from public;
grant execute on function public.acquire_lease(text, text, int) to anon, authenticated;
grant execute on function public.doc_update(text, jsonb) to anon, authenticated;

-- ---- Realtime ----
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs'
  ) then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;
