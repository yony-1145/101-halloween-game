-- 借り人競争 早押し : セキュリティ強化（001_init.sql の後に1回実行）
-- SQL Editor に全部貼り付けて Run。何度実行しても大丈夫です。
-- 目的：URLを知っている人が書き込めるのは変わらないが、
--       「ゲームが想定していない形のデータ」はDBが拒否する（画面にスクリプトを仕込む攻撃などを防ぐ）

-- ========== 1. 保存できるデータの形を決める ==========
create or replace function public.docs_valid(p_path text, d jsonb) returns boolean
language plpgsql immutable set search_path = public as $$
declare
  c  text := split_part(p_path, '/', 1);
  id text := substr(p_path, char_length(split_part(p_path, '/', 1)) + 2);
  k  text;
  v  jsonb;
  e  jsonb;
begin
  if d is null or jsonb_typeof(d) <> 'object' then return false; end if;

  -- 受付（早押し）1件
  if c = 'buzzes' then
    return id ~ '^r[0-9]{1,2}-t[0-9]{1,2}-[0-9]{1,3}$'
      and jsonb_typeof(d->'round') = 'number' and (d->>'round') ~ '^[0-9]{1,2}$'
      and jsonb_typeof(d->'team') = 'string' and (d->>'team') ~ '^t[0-9]{1,2}$'
      and jsonb_typeof(d->'name') = 'string' and char_length(d->>'name') <= 40
      and jsonb_typeof(d->'at') = 'number'
      and (coalesce(jsonb_typeof(d->'verdict'), 'null') = 'null' or (d->>'verdict') in ('ok', 'ng'))
      and (d->'device' is null or (jsonb_typeof(d->'device') = 'string' and char_length(d->>'device') <= 40));
  end if;

  if c <> 'game' then return false; end if;

  if id = 'state' then
    return coalesce(jsonb_typeof(d->'round'), 'null') in ('null', 'number')
      and coalesce(d->>'round', '0') ~ '^[0-9]{1,2}$'
      and coalesce(d->>'status', 'idle') in ('idle', 'open', 'closed')
      and coalesce(jsonb_typeof(d->'startAt'), 'null') in ('null', 'number')
      and coalesce(jsonb_typeof(d->'closedAt'), 'null') in ('null', 'number');
  end if;

  if id = 'config' then
    return (d->'totalRounds' is null or (jsonb_typeof(d->'totalRounds') = 'number' and (d->>'totalRounds') ~ '^[0-9]{1,2}$'))
      and (d->'passcode' is null or (jsonb_typeof(d->'passcode') = 'string' and char_length(d->>'passcode') <= 20));
  end if;

  if id = 'teams' then
    if jsonb_typeof(d->'list') <> 'array' or jsonb_array_length(d->'list') <> 10 then return false; end if;
    for e in select * from jsonb_array_elements(d->'list') loop
      if jsonb_typeof(e) <> 'object'
        or coalesce(e->>'id', '') !~ '^t[0-9]{1,2}$'
        or coalesce(e->>'color', '') !~ '^#[0-9a-fA-F]{6}$'
        or jsonb_typeof(e->'ja') <> 'string' or char_length(e->>'ja') > 30
        or jsonb_typeof(e->'en') <> 'string' or char_length(e->>'en') > 30 then
        return false;
      end if;
    end loop;
    return true;
  end if;

  if id = 'results' then
    if jsonb_typeof(d->'rounds') <> 'object' then return false; end if;
    for k, v in select * from jsonb_each(d->'rounds') loop
      if k !~ '^[0-9]{1,2}$' or jsonb_typeof(v) <> 'object' then return false; end if;
      if v->'places' is not null then
        if jsonb_typeof(v->'places') <> 'array' or jsonb_array_length(v->'places') > 3 then return false; end if;
        for e in select * from jsonb_array_elements(v->'places') loop
          if jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^t[0-9]{1,2}$' then return false; end if;
        end loop;
      end if;
      if v->'auto' is not null and jsonb_typeof(v->'auto') <> 'boolean' then return false; end if;
      if v->'confirmedBy' is not null and (jsonb_typeof(v->'confirmedBy') <> 'string' or char_length(v->>'confirmedBy') > 20) then return false; end if;
    end loop;
    return true;
  end if;

  return false; -- game/state, config, teams, results 以外は保存できない
end $$;

alter table public.docs drop constraint if exists docs_shape;
alter table public.docs add constraint docs_shape check (public.docs_valid(path, data)) not valid;

-- ========== 2. 受付の件数に上限（大量書き込みでDBを埋められないように） ==========
create or replace function public.docs_limit_rows() returns trigger
language plpgsql set search_path = public as $$
begin
  if (select count(*) from public.docs) >= 1500 then
    raise exception 'too many rows';
  end if;
  return new;
end $$;

drop trigger if exists docs_limit_rows on public.docs;
create trigger docs_limit_rows before insert on public.docs
  for each row execute function public.docs_limit_rows();

-- ========== 3. 削除できるのは「受付」だけ（設定・得点・チームは消せない） ==========
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to anon, authenticated using (coll = 'buzzes');

-- ========== 4. ロック：決まった形の名前だけ・期限切れは自動で掃除 ==========
create or replace function public.acquire_lease(p_key text, p_holder text, p_ttl_ms int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_now  timestamptz := clock_timestamp();
  v_exp  timestamptz;
  v_hold text;
  v_cur  timestamptz;
begin
  if p_key is null or p_key !~ '^(clock/[A-Za-z0-9_-]{1,40}|slots/r[0-9]{1,2}-t[0-9]{1,2})$'
     or p_holder is null or p_holder !~ '^[A-Za-z0-9_-]{1,80}$' then
    raise exception 'bad lease key/holder';
  end if;
  if p_ttl_ms is null or p_ttl_ms < 1 or p_ttl_ms > 60000 then
    raise exception 'bad ttl';
  end if;
  v_exp := v_now + make_interval(secs => p_ttl_ms / 1000.0);

  -- 期限が1分以上前に切れたロックは消す（表が増え続けないように）
  delete from public.leases where expires_at < v_now - interval '1 minute';

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

revoke all on function public.acquire_lease(text, text, int) from public;
grant execute on function public.acquire_lease(text, text, int) to anon, authenticated;
