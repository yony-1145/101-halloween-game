/* Supabase data layer.
   Exposes a small document-store API (doc / collection / onSnapshot / acquire) through
   window.claude.use('db'), so the game code does not depend on Supabase directly.
   Backed by the `docs` table and the `acquire_lease` RPC (see supabase/migrations). */
(() => {
  const CFG = window.HAYAOSHI_CONFIG || {};
  const configured = CFG.SUPABASE_URL && CFG.SUPABASE_KEY &&
    !/YOUR_|xxxx/i.test(CFG.SUPABASE_URL + CFG.SUPABASE_KEY);
  if (!configured || !window.supabase || !window.supabase.createClient) {
    console.warn('[hayaoshi] Supabase is not configured; running offline.');
    return; // The game shows its "not connected" banner
  }
  const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 20 } },
  });

  const clone = v => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const collOf = p => p.split('/')[0];
  const idOf = p => p.slice(p.indexOf('/') + 1);

  // path -> { data, ver } (the whole table is small: game docs + buzzes)
  const cache = new Map();
  let loaded = false;
  const docSubs = new Map();  // path -> Set(fn)
  const collSubs = new Map(); // coll -> Set({ fn, limit })

  function docSnap(path) {
    const e = cache.get(path);
    return { id: idOf(path), exists: !!e, data: () => (e ? clone(e.data) : undefined) };
  }
  function collSnap(coll, limit, filters) {
    let docs = [];
    for (const [p, e] of cache) {
      if (collOf(p) !== coll) continue;
      if (filters && !filters.every(([f, v]) => e.data && e.data[f] === v)) continue;
      docs.push({ id: idOf(p), exists: true, data: () => clone(e.data) });
    }
    docs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (limit) docs = docs.slice(0, limit);
    return { docs, size: docs.length, empty: docs.length === 0 };
  }
  const safe = fn => { try { fn(); } catch (e) { console.error(e); } };
  function notify(paths) {
    if (!loaded) return;
    const colls = new Set();
    for (const p of paths) {
      colls.add(collOf(p));
      const s = docSubs.get(p);
      if (s) for (const fn of s) safe(() => fn(docSnap(p)));
    }
    for (const c of colls) {
      const s = collSubs.get(c);
      if (s) for (const sub of s) safe(() => sub.fn(collSnap(c, sub.limit)));
    }
  }
  function notifyAll() {
    if (!loaded) return;
    for (const [p, s] of docSubs) for (const fn of s) safe(() => fn(docSnap(p)));
    for (const [c, s] of collSubs) for (const sub of s) safe(() => sub.fn(collSnap(c, sub.limit)));
  }
  // Apply one row, ignoring anything older than what we already have
  function applyRow(path, data, ver) {
    const cur = cache.get(path);
    if (cur && ver != null && cur.ver != null && ver < cur.ver) return false;
    cache.set(path, { data, ver });
    return true;
  }

  /* ---- Full reload ----
     Runs on start, after reconnect, when the page becomes visible, and every 10s as a safety net. */
  let refreshing = null;
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const { data, error } = await sb.from('docs').select('path,data,ver').limit(5000);
      if (error) throw error;
      const seen = new Set();
      for (const r of data) { seen.add(r.path); applyRow(r.path, r.data, r.ver); }
      for (const p of [...cache.keys()]) if (!seen.has(p)) cache.delete(p);
      loaded = true;
      notifyAll();
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  /* ---- Realtime ---- */
  let channel = null;
  function subscribe() {
    if (channel) sb.removeChannel(channel);
    channel = sb.channel('docs-all')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, msg => {
        if (msg.eventType === 'DELETE') {
          const p = msg.old && msg.old.path;
          if (p && cache.delete(p)) notify([p]);
        } else if (msg.new && msg.new.path) {
          if (applyRow(msg.new.path, msg.new.data, msg.new.ver)) notify([msg.new.path]);
        }
      })
      // Changes are delivered only after this message; reload so nothing in the gap is missed
  .on('system', {}, m => {
    if (m && m.extension === 'postgres_changes' && m.status === 'ok') refresh().catch(console.error);
  })
  .subscribe(status => {
        if (status === 'SUBSCRIBED') refresh().catch(console.error);
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setTimeout(() => { if (channel && channel.state !== 'joined') subscribe(); }, 2000);
        }
      });
  }
  subscribe();
  setInterval(() => { if (document.visibilityState === 'visible') refresh().catch(() => { }); }, 10000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh().catch(() => { });
  });
  window.addEventListener('online', () => { subscribe(); });

  const ok = ({ error }) => { if (error) throw error; };

  /* ---- Public API ---- */
  function docRef(path) {
    return {
      id: idOf(path),
      onSnapshot(fn) {
        if (!docSubs.has(path)) docSubs.set(path, new Set());
        docSubs.get(path).add(fn);
        if (loaded) safe(() => fn(docSnap(path)));
        return () => docSubs.get(path).delete(fn);
      },
      async get() {
        const { data, error } = await sb.from('docs').select('path,data,ver').eq('path', path).maybeSingle();
        if (error) throw error;
        if (data) applyRow(data.path, data.data, data.ver); else cache.delete(path);
        return docSnap(path);
      },
      async set(obj) {
        const { data, error } = await sb.from('docs').upsert({ path, data: obj }).select('path,data,ver').single();
        if (error) throw error;
        if (applyRow(data.path, data.data, data.ver)) notify([path]);
      },
      async update(patch) {
        ok(await sb.rpc('doc_update', { p_path: path, p_patch: patch }));
        const cur = cache.get(path);
        if (cur) { cache.set(path, { data: { ...cur.data, ...clone(patch) }, ver: cur.ver }); notify([path]); }
      },
      async delete() {
        ok(await sb.from('docs').delete().eq('path', path));
        if (cache.delete(path)) notify([path]);
      },
      async acquire({ holder, ttlMs }) {
        const { data, error } = await sb.rpc('acquire_lease', { p_key: path, p_holder: holder, p_ttl_ms: ttlMs });
        if (error) throw error;
        return data; // { acquired, holder, expiresAt }
      },
    };
  }
  function query(coll, filters, limit) {
    return {
      where(field, op, value) {
        if (op !== '==') throw new Error('only == is supported');
        return query(coll, [...filters, [field, value]], limit);
      },
      limit(n) { return query(coll, filters, n); },
      onSnapshot(fn) {
        if (!collSubs.has(coll)) collSubs.set(coll, new Set());
        const sub = { fn, limit };
        collSubs.get(coll).add(sub);
        if (loaded) safe(() => fn(collSnap(coll, limit)));
        return () => collSubs.get(coll).delete(sub);
      },
      async get() { // Always ask the server, never the cache
        const { data, error } = await sb.from('docs').select('path,data,ver').eq('coll', coll).limit(5000);
        if (error) throw error;
        for (const r of data) applyRow(r.path, r.data, r.ver);
        let docs = data
          .filter(r => filters.every(([f, v]) => r.data && r.data[f] === v))
          .map(r => ({ id: idOf(r.path), exists: true, data: () => clone(r.data) }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (limit) docs = docs.slice(0, limit);
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
    };
  }
  const db = {
    doc: docRef,
    collection: c => query(c, [], null),
  };

  // Load once before the game boots so its first render has data
  const ready = refresh().catch(e => { console.error('[hayaoshi] first load failed', e); });

  window.claude = {
    async use(name) {
      if (name === 'db') { await ready; return db; }
      return null; // No user accounts on the public site
    },
  };
})();
