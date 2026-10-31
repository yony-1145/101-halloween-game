/* Borrow-a-Person Race: game logic for the team, host and score views.
   Data access goes through window.claude.use('db'), provided by supabase-adapter.js. */
(() => {
  const DUR = 120000, POINTS = [3, 2, 1], DEFAULT_PASS = '1031', DEFAULT_ROUNDS = 5, MIN_ROUNDS = 3, MAX_ROUNDS = 10;
  const DEFAULT_TEAMS = [
    ['t1', '#e53935', '赤', 'Red'], ['t2', '#ff8a1f', 'オレンジ', 'Orange'], ['t3', '#ffd600', '黄', 'Yellow'],
    ['t4', '#9be32b', '黄緑', 'Lime'], ['t5', '#1f9d55', '緑', 'Green'], ['t6', '#5ec8f2', '水色', 'Sky Blue'],
    ['t7', '#2f6fe0', '青', 'Blue'], ['t8', '#8e4ad8', '紫', 'Purple'], ['t9', '#ff6fb5', 'ピンク', 'Pink'], ['t10', '#f4f4f4', '白', 'White'],
  ].map(([id, color, ja, en]) => ({ id, color, ja, en }));

  // In-memory fallback so team choice still works on phones that block storage (in-app browsers, strict iOS settings)
  const mem = {};
  const LS = {
    get(k) { try { const v = localStorage.getItem(k); if (v != null) return v; } catch { } return k in mem ? mem[k] : null; },
    set(k, v) { if (v == null) delete mem[k]; else mem[k] = v; try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { } },
  };
  const rid = () => Math.random().toString(36).slice(2, 10);
  const deviceId = LS.get('kb_dev') || (() => { const id = 'd' + rid(); LS.set('kb_dev', id); return id; })();
  const holder = deviceId + '-' + rid(); // Per tab, so two tabs never share a lease

  const S = {
    db: null, noDb: false, writable: true, view: 'team',
    teams: DEFAULT_TEAMS, state: { round: 0, status: 'idle' }, results: { rounds: {} }, config: {},
    buzzes: [], offset: 0, rtt: Infinity, busy: false, armedUntil: 0, hostUnlocked: LS.get('kb_host') === '1',
  };
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---- Server clock ----
     A granted acquire() returns expiresAt = server time + ttl, which gives us the server time.
     Buzz order always uses server time, never the phone's clock. */
  function parseTs(s) {
    const m = /^(.*T\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:?\d\d)$/i.exec(String(s));
    if (!m) return Date.parse(s);
    return Date.parse(m[1] + m[3]) + (m[2] ? Number('0.' + m[2]) * 1000 : 0);
  }
  function takeSample(serverAt, t0, t1) {
    const rtt = t1 - t0;
    if (rtt <= S.rtt * 1.6 || !isFinite(S.rtt)) { S.offset = serverAt - (t0 + t1) / 2; S.rtt = Math.max(rtt, 20); }
  }
  async function syncClock() {
    const t0 = Date.now();
    const r = await S.db.doc('clock/' + deviceId).acquire({ holder, ttlMs: 1000 });
    const t1 = Date.now();
    if (!r || !r.acquired || !r.expiresAt) return Date.now() + S.offset;
    const srv = parseTs(r.expiresAt) - 1000;
    takeSample(srv, t0, t1);
    return srv + (t1 - t0) / 2;
  }
  const now = () => Date.now() + S.offset;

  /* ---- Derived game state ---- */
  const team = id => S.teams.find(t => t.id === id) || { id, color: '#777777', ja: '?', en: '?' };
  function isLight(hex) {
    const h = String(hex).replace('#', ''); if (h.length < 6) return false;
    const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
    return (0.299 * r + 0.587 * g + 0.114 * b) > 170;
  }
  const chip = (id, withEn = true) => { const t = team(id); return `<span class="chip" style="--c:${esc(t.color)}"><span class="dot"></span>${esc(t.ja)}${withEn ? ` <span class="en">${esc(t.en)}</span>` : ''}</span>`; };
  const ord = n => n + (['th', 'st', 'nd', 'rd'][n] || 'th');
  const deadline = () => S.state.startAt ? Math.min(S.state.startAt + DUR, S.state.closedAt || Infinity) : 0;
  const isOpen = () => S.state.status === 'open' && now() < deadline();
  const confirmed = r => (S.results.rounds || {})[r];
  const totalRounds = () => { const n = Number(S.config.totalRounds); return n >= MIN_ROUNDS && n <= MAX_ROUNDS ? n : DEFAULT_ROUNDS; };
  const gameOver = () => S.state.round >= totalRounds() && !!confirmed(S.state.round);
  function entries(r) {
    return S.buzzes.filter(b => b.round === r).sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1));
  }
  const isLate = b => b.round === S.state.round && S.state.startAt && b.at > deadline();
  function computePlaces(r) {
    const out = [];
    for (const b of entries(r)) {
      if (b.verdict === 'ng' || isLate(b) || out.includes(b.team)) continue;
      out.push(b.team); if (out.length === 3) break;
    }
    return out;
  }
  const placesFor = r => (confirmed(r) ? confirmed(r).places || [] : computePlaces(r));
  function totals() {
    const t = Object.fromEntries(S.teams.map(x => [x.id, 0]));
    for (const [, res] of Object.entries(S.results.rounds || {})) (res.places || []).forEach((id, i) => { if (id in t) t[id] += POINTS[i] || 0; });
    return t;
  }
  /** Status of one buzz: pending | ok | ng | late, plus place index (0-based) or -1 */
  function judge(b) {
    if (b.verdict === 'ng') return { kind: 'ng', place: -1 };
    if (isLate(b)) return { kind: 'late', place: -1 };
    const places = placesFor(b.round);
    const p = places.indexOf(b.team);
    const conf = !!confirmed(b.round);
    if (conf) return { kind: 'ok', place: p };
    return { kind: b.verdict === 'ok' ? 'ok' : 'pending', place: p };
  }
  function fmtTime(ms) { ms = Math.max(0, ms); const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  function timerText() {
    if (S.state.status === 'open') { const left = deadline() - now(); return left > 0 ? fmtTime(left) : '0:00'; }
    return '';
  }

  /* ---- Views ---- */
  const VIEWS = ['team', 'host', 'score'];
  function setView(v, push = true) {
    if (!VIEWS.includes(v)) v = 'team';
    S.view = v;
    VIEWS.forEach(x => { $('view-' + x).hidden = x !== v; $('tab-' + x).setAttribute('aria-selected', String(x === v)); });
    if (push) { try { history.replaceState(null, '', '#' + v); } catch { } }
    wakeLock();
    render();
  }
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));

  function render() {
    renderBanner();
    if (S.view === 'team') renderTeam();
    if (S.view === 'host') renderHost();
    if (S.view === 'score') renderScore();
    tick();
  }
  function renderBanner() {
    const el = $('banner');
    if (S.noDb) {
      el.hidden = false;
      el.innerHTML = '<b>サーバーにつながっていません / Not connected to the live game</b>通信状態を確認して、ページを開き直してください。 Check your connection and reload this page.';
    } else if (!S.writable && S.view !== 'score') {
      el.hidden = false;
      el.innerHTML = '<b>閲覧だけの権限です / You can view but not buzz</b>運営に、このページの編集権限を付けてもらってください。 Ask the organizers to give you edit access to this page.';
    } else el.hidden = true;
  }

  /* ---- Team ---- */
  let lastTeamSig = '';
  function myTeam() { const t = LS.get('kb_team'); return t && S.teams.some(x => x.id === t) ? t : null; }
  function renderTeam() {
    const tid = myTeam();
    $('teamPick').hidden = !!tid; $('teamMain').hidden = !tid;
    if (!tid) {
      $('pickGrid').innerHTML = S.teams.map(t => `<button type="button" class="pick" data-team="${t.id}" style="--c:${esc(t.color)}"><span class="swatch"></span><span><b>${esc(t.ja)}チーム</b><span>${esc(t.en)} Team</span></span></button>`).join('');
      return;
    }
    const t = team(tid);
    $('teamHead').style.setProperty('--c', t.color);
    $('teamHead').innerHTML = `<span class="chip"><span class="dot"></span>${esc(t.ja)}チーム <span class="en">${esc(t.en)} Team</span></span><button type="button" class="btn link" id="changeTeam">チームを変更 / Change team</button>`;
    const r = S.state.round;
    const n = totalRounds();
    $('teamRound').textContent = r ? `第${r}ラウンド（全${n}） / Round ${r} of ${n}` : `開始前・全${n}ラウンド / ${n} rounds`;

    const mine = r ? entries(r).filter(b => b.team === tid) : [];
    const active = mine.find(b => b.verdict !== 'ng');
    const lastNg = !active && mine.length ? mine[mine.length - 1] : null;
    let html = '';
    if (!r) {
      html = `<div class="status-card"><div class="big">まもなく開始</div><div class="muted">Waiting for the first round</div></div>`;
    } else if (active) {
      const all = entries(r), no = all.indexOf(active) + 1, j = judge(active);
      if (j.kind === 'late') {
        html = `<div class="status-card ng"><div class="big">時間切れ</div><div>Too late for this round</div></div>`;
      } else if (j.kind === 'pending' && !confirmed(r)) {
        html = `<div class="status-card pending"><div class="label">受付番号 / Your number</div><div class="big">${no}番目に受付</div><div class="muted">You're #${no}</div>
    <div class="wait-with">${esc(active.name)}さんと一緒にお待ちください<span class="en">Please wait with ${esc(active.name)}.</span></div>
    <div class="muted" style="margin-top:8px">チェック中… / Checking…</div></div>`;
      } else if (j.place >= 0) {
        html = `<div class="status-card ok pop"><div class="label">${no}番目 / #${no} · ${esc(active.name)}</div><div class="big">${j.place + 1}位！ +${POINTS[j.place]}点</div><div>${ord(j.place + 1)} place! +${POINTS[j.place]} pts</div></div>`;
      } else {
        html = `<div class="status-card ok"><div class="label">${no}番目 / #${no} · ${esc(active.name)}</div><div class="big">OK！</div><div>今回は得点圏外でした / Outside the top 3 this time</div></div>`;
      }
    } else if (lastNg) {
      html = `<div class="status-card ng pop"><div class="big">NG</div><div>${esc(lastNg.name)}さんはお題に合いませんでした。もう一度探そう！</div><div class="muted">Not a match. Find someone else and buzz again!</div></div>`;
    } else if (!isOpen()) {
      html = `<div class="status-card"><div class="big">${S.state.status === 'open' ? '時間切れ' : '締め切り'}</div><div class="muted">${S.state.status === 'open' ? "Time's up" : 'Buzzing is closed'}</div></div>`;
    }
    const sig = html;
    if (sig !== lastTeamSig) { $('teamStatus').innerHTML = html; lastTeamSig = sig; }
    updateBuzzButton();
  }
  function buzzBlockReason() {
    const tid = myTeam(); const r = S.state.round;
    if (S.noDb) return 'サーバーにつながっていません / Not connected';
    if (!S.writable) return '編集権限がありません / No edit access';
    if (!r || S.state.status === 'idle') return 'ラウンド開始を待っています / Waiting for the round to start';
    if (S.state.status !== 'open') return '締め切りました / Buzzing is closed';
    if (now() >= deadline()) return '2分を過ぎました / The 2 minutes are up';
    if (entries(r).some(b => b.team === tid && b.verdict !== 'ng')) return '判定待ちです / Waiting for the check';
    return '';
  }
  function updateBuzzButton() {
    if (!myTeam()) return;
    const why = buzzBlockReason();
    $('buzzBtn').disabled = !!why || S.busy;
    const hideForm = S.state.round && entries(S.state.round).some(b => b.team === myTeam() && b.verdict !== 'ng');
    $('buzzForm').hidden = !!hideForm;
    $('buzzWhy').textContent = S.busy ? '送信中… / Sending…' : why;
  }
  $('pickGrid').addEventListener('click', e => { const b = e.target.closest('[data-team]'); if (b) { LS.set('kb_team', b.dataset.team); lastTeamSig = ''; render(); } });
  $('teamHead').addEventListener('click', e => { if (e.target.id === 'changeTeam') { LS.set('kb_team', null); lastTeamSig = ''; render(); } });
  $('buzzForm').addEventListener('submit', e => { e.preventDefault(); buzz(); });

  class UErr extends Error { }
  // Supabase/Postgres errors meaning "the server refused this write" (RLS, check constraint, raise, auth)
  const isPermErr = e => !!e && (['42501', '23514', 'P0001', 'PGRST301'].includes(e.code) || e.status === 401 || e.status === 403);
  async function buzz() {
    const tid = myTeam(), name = $('personName').value.trim();
    $('buzzErr').textContent = '';
    if (!name) { $('buzzErr').textContent = '連れてきた人の名前を入力してください / Enter the name of the person you brought'; $('personName').focus(); return; }
    if (buzzBlockReason() || S.busy) return;
    S.busy = true; updateBuzzButton();
    try {
      const r = S.state.round;
      const t0 = Date.now();
      // One lease per team per round: two phones on the same team can never both get through
      const lease = await S.db.doc(`slots/r${r}-${tid}`).acquire({ holder, ttlMs: 3000 });
      const t1 = Date.now();
      if (!lease.acquired) throw new UErr('同じチームの別のスマホが受付中です / Another phone on your team is buzzing');
      const at = parseTs(lease.expiresAt) - 3000;
      takeSample(at, t0, t1);
      if (S.state.round !== r || S.state.status !== 'open' || at > deadline()) throw new UErr('受付時間外でした / Too late, buzzing is closed');
      const q = await S.db.collection('buzzes').where('round', '==', r).where('team', '==', tid).get();
      if (q.docs.some(d => d.data().verdict !== 'ng')) throw new UErr('このラウンドはもう受付済みです / Your team already buzzed this round');
      await S.db.doc(`buzzes/r${r}-${tid}-${q.size + 1}`).set({ round: r, team: tid, name: name.slice(0, 40), at, verdict: null, device: deviceId });
      $('personName').value = '';
      try { navigator.vibrate && navigator.vibrate(80); } catch { }
    } catch (e) {
      if (e instanceof UErr) $('buzzErr').textContent = e.message;
      else if (isPermErr(e)) { $('buzzErr').textContent = '送信できませんでした。編集権限を確認してください / Could not send. Check your edit access.'; }
      else $('buzzErr').textContent = '通信エラー。もう一度押してください / Network error, please try again';
    } finally { S.busy = false; render(); }
  }

  /* ---- Host ---- */
  const passcode = () => String(S.config.passcode || DEFAULT_PASS);
  $('hostLock').addEventListener('submit', e => {
    e.preventDefault();
    if ($('passInput').value.trim() === passcode()) { S.hostUnlocked = true; LS.set('kb_host', '1'); $('passInput').value = ''; $('passErr').textContent = ''; render(); }
    else $('passErr').textContent = 'パスコードが違います / Wrong passcode';
  });
  $('hostLogout').addEventListener('click', () => { S.hostUnlocked = false; LS.set('kb_host', null); render(); });

  function hostMsg(t) { $('hostMsg').textContent = t || ''; }
  async function run(fn) {
    try { hostMsg(''); await fn(); }
    catch (e) { console.error(e); hostMsg(isPermErr(e) ?'保存できませんでした。このページの編集権限が必要です / Could not save: edit access needed' : '通信エラー。もう一度押してください / Network error, try again'); }
    render();
  }
  // Write first, then update local state, so a failed save never looks saved
  async function writeState(patch) { const st = { round: 0, status: 'idle', startAt: null, closedAt: null, ...S.state, ...patch }; await S.db.doc('game/state').set(st); S.state = st; }
  async function saveRounds(rounds) { await S.db.doc('game/results').set({ rounds }); S.results = { rounds }; }

  function renderHost() {
    const unlocked = S.hostUnlocked;
    $('hostLock').hidden = unlocked; $('hostMain').hidden = !unlocked;
    if (!unlocked) return;
    const r = S.state.round, st = S.state.status, conf = r && confirmed(r);
    const n = totalRounds();
    $('hostRound').textContent = r ? `第${r}ラウンド / 全${n}` : `開始前 / 全${n}`;
    const sel = $('totalRounds');
    if (document.activeElement !== sel) {
      // The host can't pick fewer rounds than have already started
      sel.innerHTML = Array.from({ length: MAX_ROUNDS }, (_, i) => i + 1).filter(k => k >= Math.max(MIN_ROUNDS, r))
        .map(k => `<option value="${k}" ${k === n ? 'selected' : ''}>${k} ラウンド / ${k} rounds</option>`).join('');
    }
    $('roundsNote').textContent = r >= n ? (gameOver() ? '全ラウンド終了 / Game finished' : '最終ラウンド中 / Final round') : `あと${n - r}ラウンド / ${n - r} to go`;
    const pill = conf ? ['done', '確定済み / Confirmed'] : st === 'open' ? (isOpen() ? ['open', '受付中 / Open'] : ['closed', '時間切れ / Time up']) : st === 'closed' ? ['closed', '締切 / Closed'] : ['idle', '待機中 / Idle'];
    $('hostPill').innerHTML = `<span class="pill ${pill[0]}">${pill[1]}</span>`;

    const armed = Date.now() < S.armedUntil;
    const sb = $('btnStart');
    sb.className = 'btn ' + (armed ? 'armed' : 'primary');
    sb.innerHTML = r >= n ? (gameOver() ? `全${n}ラウンド終了<small>All rounds done</small>` : `最終ラウンドです<small>This is the final round</small>`)
      : armed ? `もう一度押すと第${r + 1}ラウンドへ<small>Tap again to start Round ${r + 1}</small>` : `第${r + 1}ラウンド開始<small>Start Round ${r + 1}</small>`;
    sb.disabled = r >= n;
    $('btnClose').disabled = st !== 'open' || !!conf;
    $('btnConfirm').disabled = !r || !!conf;
    $('btnUnconfirm').disabled = !conf;

    const list = r ? entries(r) : [];
    $('hostQueue').innerHTML = list.length ? list.map((b, i) => {
      const j = judge(b), t = team(b.team);
      const place = j.kind === 'ng' ? '<span style="color:var(--ng)">NG</span>' : j.kind === 'late' ? '<span class="muted">遅れ</span>' : j.place >= 0 ? `${j.place + 1}位` : '<span class="muted">—</span>';
      const sec = S.state.startAt ? ((b.at - S.state.startAt) / 1000).toFixed(1) + '秒' : '';
      return `<div class="qrow ${j.kind === 'ng' ? 'is-ng' : ''}" style="--c:${esc(t.color)}">
  <span class="num">${i + 1}</span><span class="team">${chip(b.team)}</span><span class="who">${esc(b.name)}</span><span class="sec">${sec}</span>
  <span class="judge"><button type="button" class="jb ok ${b.verdict === 'ok' ? 'on' : ''}" data-judge="ok" data-id="${esc(b.id)}" aria-pressed="${b.verdict === 'ok'}">OK</button><button type="button" class="jb ng ${b.verdict === 'ng' ? 'on' : ''}" data-judge="ng" data-id="${esc(b.id)}" aria-pressed="${b.verdict === 'ng'}">NG</button></span>
  <span class="place">${place}</span></div>`;
    }).join('') + (conf ? '<p class="note">確定済みです。順位を変えるときは下の「結果の修正」を使ってください。 / Confirmed. Use “Fix results” below to change places.</p>' : '')
      : `<div class="empty">${r ? 'まだ誰も押していません / No buzzes yet' : '「第1ラウンド開始」を押すと受付が始まります / Press “Start Round 1” to open buzzing'}</div>`;

    $('hostStandings').innerHTML = standingsHtml();
    renderFix();
    renderTeamEdit();
  }
  $('totalRounds').addEventListener('change', e => {
    const k = Number(e.target.value);
    run(async () => { const c = { ...S.config, totalRounds: k }; await S.db.doc('game/config').set(c); S.config = c; });
    e.target.blur();
  });
  $('btnStart').addEventListener('click', () => {
    if (S.state.round >= totalRounds()) return;
    if (S.state.status === 'open' && Date.now() >= S.armedUntil) { S.armedUntil = Date.now() + 4000; render(); setTimeout(render, 4100); return; }
    S.armedUntil = 0;
    run(async () => {
      const cur = S.state.round;
      if (cur > 0 && !confirmed(cur)) await saveRounds({ ...(S.results.rounds || {}), [cur]: { places: computePlaces(cur), auto: true } });
      const srv = await syncClock();
      await writeState({ round: cur + 1, status: 'open', startAt: srv, closedAt: null });
      if (cur > 0 && !S.results.rounds[cur].confirmedBy) hostMsg(`第${cur}ラウンドの結果を自動で確定しました / Round ${cur} was confirmed automatically`);
    });
  });
  $('btnClose').addEventListener('click', () => run(async () => { const srv = await syncClock(); await writeState({ status: 'closed', closedAt: srv }); }));
  $('btnConfirm').addEventListener('click', () => run(async () => {
    const r = S.state.round;
    if (S.state.status === 'open') { const srv = await syncClock(); await writeState({ status: 'closed', closedAt: Math.min(srv, deadline()) }); }
    await saveRounds({ ...(S.results.rounds || {}), [r]: { places: computePlaces(r), confirmedBy: 'host' } });
  }));
  $('btnUnconfirm').addEventListener('click', () => run(async () => {
    const rounds = { ...(S.results.rounds || {}) }; delete rounds[S.state.round]; await saveRounds(rounds);
  }));
  $('hostQueue').addEventListener('click', e => {
    const b = e.target.closest('[data-judge]'); if (!b) return;
    const cur = S.buzzes.find(x => x.id === b.dataset.id); if (!cur) return;
    const v = cur.verdict === b.dataset.judge ? null : b.dataset.judge;
    run(async () => {
      await S.db.doc('buzzes/' + cur.id).update({ verdict: v });
      cur.verdict = v;
      // A confirmed round follows later OK/NG changes, unless the host fixed its places by hand
      const res = confirmed(cur.round);
      if (!res) return;
      if (res.edited) { hostMsg('手動修正済みのため順位は変わりません。「結果の修正」で直してください / Manually fixed; places unchanged. Use “Fix results”.'); return; }
      await saveRounds({ ...(S.results.rounds || {}), [cur.round]: { ...res, places: computePlaces(cur.round) } });
    });
  });

  function standingsHtml() {
    const t = totals();
    const rows = S.teams.map(x => ({ ...x, pts: t[x.id] || 0 })).sort((a, b) => b.pts - a.pts);
    const max = Math.max(1, ...rows.map(r => r.pts));
    let rank = 0, prev = null;
    return rows.map((x, i) => {
      if (x.pts !== prev) { rank = i + 1; prev = x.pts; }
      return `<div class="srow ${rank === 1 && x.pts > 0 ? 'top1' : ''}" style="--c:${esc(x.color)}"><span class="rk">${rank}</span>
  <span>${chip(x.id)}<div class="bar"><i style="width:${(x.pts / max) * 100}%"></i></div></span><span class="pts">${x.pts}</span></div>`;
    }).join('');
  }

  let fixSig = '', fixDirty = false;
  function renderFix(force) {
    const rounds = Object.keys(S.results.rounds || {}).map(Number).sort((a, b) => a - b);
    // Compare only what the form shows; server JSON comes back with a different key order
    const sig = JSON.stringify([rounds.map(r => [r, S.results.rounds[r].places || []]), S.teams.map(t => [t.id, t.ja, t.en]), S.state.round]);
    if (!force && (sig === fixSig || fixDirty || ($('fixRounds').contains(document.activeElement) && document.activeElement.matches('select')))) return;
    fixSig = sig; fixDirty = false;
    const r = S.state.round;
    const hint = r && !confirmed(r) ? `<p class="note">第${r}ラウンドは「結果を確定」のあとで修正できます / Round ${r} can be fixed after you confirm it</p>` : '';
    const opts = sel => `<option value="">—</option>` + S.teams.map(t => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.ja)} / ${esc(t.en)}</option>`).join('');
    $('fixRounds').innerHTML = hint + (rounds.length ? rounds.map(r => {
      const p = S.results.rounds[r].places || [];
      return `<div class="fix-round" data-round="${r}"><b>第${r}R</b>${[0, 1, 2].map(i => `<label><span class="label">${i + 1}位 · ${POINTS[i]}点</span><select id="fix-${r}-${i}">${opts(p[i])}</select></label>`).join('')}</div>`;
    }).join('') + `<div class="row-actions"><button type="button" class="btn primary" id="saveFix">保存<small>Save</small></button><span id="fixSaved" class="saved"></span></div>`
      : '<p class="empty">確定したラウンドはまだありません / No confirmed rounds yet</p>');
  }
  $('fixBox').addEventListener('toggle', () => { if (!$('fixBox').open) { fixDirty = false; renderFix(true); } });
  $('fixRounds').addEventListener('change', e => { if (e.target.matches('select')) { fixDirty = true; const s = $('fixSaved'); if (s) s.textContent = ''; } });
  $('fixRounds').addEventListener('click', e => {
    if (e.target.closest('#saveFix') == null) return;
    const rounds = { ...(S.results.rounds || {}) };
    for (const r of Object.keys(rounds)) {
      if (!$(`fix-${r}-0`)) continue; // Round added after the form was drawn: leave it as is
      const picks = [0, 1, 2].map(i => $(`fix-${r}-${i}`).value || '').filter(Boolean);
      if (new Set(picks).size !== picks.length) { $('fixSaved').textContent = ''; hostMsg(`第${r}ラウンドで同じチームが2回選ばれています / Round ${r} has the same team twice`); return; }
      const before = rounds[r].places || [];
      if (picks.join() !== before.join()) rounds[r] = { ...rounds[r], places: picks, edited: true };
    }
    run(async () => { await saveRounds(rounds); renderFix(true); $('fixSaved').textContent = '保存しました / Saved'; });
  });

  let teamEditSig = '';
  function renderTeamEdit(force) {
    const sig = JSON.stringify(S.teams);
    if (sig === teamEditSig && !force) return; teamEditSig = sig;
    $('teamEdit').innerHTML = S.teams.map(t => `<div class="team-edit"><input type="color" id="tc-${t.id}" value="${esc(t.color)}" aria-label="${esc(t.en)} color">
<input type="text" id="tj-${t.id}" value="${esc(t.ja)}" maxlength="12" aria-label="日本語名"><input type="text" id="te-${t.id}" value="${esc(t.en)}" maxlength="20" aria-label="English name"></div>`).join('');
  }
  $('saveTeams').addEventListener('click', () => {
    const list = S.teams.map(t => ({ id: t.id, color: $('tc-' + t.id).value, ja: $('tj-' + t.id).value.trim() || t.ja, en: $('te-' + t.id).value.trim() || t.en }));
    run(async () => { await S.db.doc('game/teams').set({ list }); S.teams = list; $('teamsSaved').textContent = '保存しました / Saved'; setTimeout(() => $('teamsSaved').textContent = '', 3000); });
  });
  $('defaultTeams').addEventListener('click', () => { const keep = S.teams; S.teams = DEFAULT_TEAMS; renderTeamEdit(true); S.teams = keep; teamEditSig = ''; $('teamsSaved').textContent = '「保存」で反映 / Press Save to apply'; });
  $('savePass').addEventListener('click', () => {
    const p = $('newPass').value.trim(); if (!p) return;
    run(async () => { await S.db.doc('game/config').set({ ...S.config, passcode: p }); S.config.passcode = p; $('newPass').value = ''; $('passSaved').textContent = '変更しました / Changed'; });
  });
  $('resetAsk').addEventListener('click', () => { $('resetConfirm').hidden = false; });
  $('resetCancel').addEventListener('click', () => { $('resetConfirm').hidden = true; });
  $('resetDo').addEventListener('click', () => run(async () => {
    $('resetDo').disabled = true;
    try {
      const all = await S.db.collection('buzzes').limit(1000).get();
      for (let i = 0; i < all.docs.length; i += 8) await Promise.all(all.docs.slice(i, i + 8).map(d => S.db.doc('buzzes/' + d.id).delete()));
      await saveRounds({});
      await writeState({ round: 0, status: 'idle', startAt: null, closedAt: null });
      $('resetConfirm').hidden = true; hostMsg('テスト結果を消しました / All test results cleared');
    } finally { $('resetDo').disabled = false; }
  }));

  /* ---- Score (projector) ---- */
  function renderScore() {
    const r = S.state.round, conf = r && confirmed(r);
    const n = totalRounds();
    $('scoreRound').innerHTML = !r ? `<small>${n} ROUNDS</small>まもなく開始`
      : gameOver() ? `<small>FINAL RESULTS</small>最終結果` : `<small>ROUND ${r} / ${n}${r === n ? ' · FINAL' : ''}</small>第${r}ラウンド`;
    $('scoreState').textContent = gameOver() ? 'おつかれさまでした！ / Thanks for playing!' : conf ? '結果確定 / Final' : S.state.status === 'open' ? (isOpen() ? '受付中 / Buzzing open' : '時間切れ / Time up') : S.state.status === 'closed' ? '締切 / Closed' : 'Get ready!';
    const list = r ? entries(r) : [];
    $('scoreQueue').innerHTML = list.length ? list.map((b, i) => {
      const j = judge(b), t = team(b.team);
      const [cls, st] = j.kind === 'ng' ? ['ng', 'NG'] : j.kind === 'late' ? ['ng', '時間切れ'] : j.place >= 0 && (j.kind === 'ok') ? ['place', `${j.place + 1}位`] : j.kind === 'ok' ? ['ok', 'OK'] : ['pending', 'チェック中'];
      return `<div class="sqrow ${cls}" style="--c:${esc(t.color)}"><span class="n">${i + 1}</span><span class="who">${chip(b.team)}${esc(b.name)}</span><span class="st">${st}</span></div>`;
    }).join('') : `<div class="empty" style="font-size:clamp(16px,2vw,26px)">${r ? 'お題に合う人を連れてきて、早押し！ / Find someone who fits and buzz!' : '借り人競争 / Borrow-a-Person Race'}</div>`;
    $('scoreStandings').innerHTML = standingsHtml();
  }

  /* ---- Ticking ---- */
  let wasOpen = null;
  function tick() {
    const txt = timerText(), low = S.state.status === 'open' && deadline() - now() <= 15000;
    document.querySelectorAll('[data-timer]').forEach(el => { el.textContent = txt; el.classList.toggle('low', low); });
    const open = isOpen();
    if (wasOpen !== null && open !== wasOpen) { wasOpen = open; render(); return; }
    wasOpen = open;
    if (S.view === 'team') updateBuzzButton();
  }
  setInterval(tick, 250);

  let lock = null;
  async function wakeLock() {
    try { if (!lock && navigator.wakeLock && document.visibilityState === 'visible') { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); } } catch { }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { wakeLock(); if (S.db && S.writable) syncClock().catch(() => { }); } });

  /* ---- Boot ---- */
  async function boot() {
    setView((location.hash || '').slice(1) || 'team', false);
    const db = window.claude && window.claude.use ? await window.claude.use('db') : null;
    if (!db) { S.noDb = true; S.writable = false; render(); return; }
    S.db = db;
    const err = () => { };
    db.doc('game/state').onSnapshot(s => { S.state = s.exists ? { round: 0, status: 'idle', ...s.data() } : { round: 0, status: 'idle' }; render(); }, err);
    db.doc('game/results').onSnapshot(s => { S.results = s.exists ? { rounds: {}, ...s.data() } : { rounds: {} }; render(); }, err);
    db.doc('game/teams').onSnapshot(s => { const l = s.exists && s.data().list; S.teams = Array.isArray(l) && l.length === 10 ? l : DEFAULT_TEAMS; lastTeamSig = ''; render(); }, err);
    db.doc('game/config').onSnapshot(s => { S.config = s.exists ? { ...s.data() } : {}; render(); }, err);
    db.collection('buzzes').limit(1000).onSnapshot(q => { S.buzzes = q.docs.map(d => ({ id: d.id, ...d.data() })); render(); }, err);
    try {
      const user = await window.claude.use('user');
      const can = user ? await user.can('data.write') : null;
      if (can === false) S.writable = false;
    } catch { }
    render();
    if (S.writable) {
      for (let i = 0; i < 3; i++) { try { await syncClock(); } catch { break; } await new Promise(r => setTimeout(r, 300)); }
      setInterval(() => { syncClock().catch(() => { }); }, 180000);
    }
  }
  boot();
})();
