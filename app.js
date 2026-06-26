/* The Blair Mitch Project — WC2026 sweepstake dashboard (vanilla JS). */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  let countdownTimer = null;

  // --- flag emoji from ISO code (England/Scotland use sub-region tags) -----
  function flag(iso2) {
    if (!iso2) return '🏳️';
    if (iso2 === 'GB-ENG') return '🏴󠁧󠁢󠁥󠁮󠁧󠁿';
    if (iso2 === 'GB-SCT') return '🏴󠁧󠁢󠁳󠁣󠁴󠁿';
    if (iso2 === 'GB-WLS') return '🏴󠁧󠁢󠁷󠁬󠁳󠁿';
    if (!/^[A-Za-z]{2}$/.test(iso2)) return '🏳️';
    return iso2.toUpperCase().replace(/./g, (c) => String.fromCodePoint(127397 + c.charCodeAt(0)));
  }

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  function teamInline(t) {
    return `<span class="flag">${flag(t.iso2)}</span> ${esc(t.name || t.code || 'TBC')}`;
  }

  // --- render: prize pot ----------------------------------------------------
  function renderPrizes(prizes) {
    const el = $('#prizePot');
    if (!prizes) return;
    const items = [`<li><b>£${prizes.total}</b> pot</li>`]
      .concat((prizes.breakdown || []).map((p) => `<li>${esc(p.name)} <b>£${p.amount}</b></li>`));
    el.innerHTML = items.join('');
  }

  // --- render: banner -------------------------------------------------------
  function renderBanner(banner) {
    const el = $('#banner');
    if (!banner || (!banner.nextFixture && !banner.lastFinished)) { el.hidden = true; return; }
    el.hidden = false;
    const cards = [];

    if (banner.lastFinished) {
      const m = banner.lastFinished;
      const score = (m.home.goals != null && m.away.goals != null) ? `${m.home.goals}–${m.away.goals}` : 'FT';
      cards.push(`<div class="b-card">
        <p class="b-label">Last result <span class="b-round">· ${esc(m.round)}</span></p>
        <div class="b-match">${teamInline(m.home)} <span class="b-score">${esc(score)}</span> ${teamInline(m.away)}</div>
      </div>`);
    }
    if (banner.nextFixture) {
      const m = banner.nextFixture;
      cards.push(`<div class="b-card">
        <p class="b-label">Next up <span class="b-round">· ${esc(m.round)}</span></p>
        <div class="b-match">${teamInline(m.home)} <span class="b-round">v</span> ${teamInline(m.away)}</div>
        <div class="b-countdown" data-kickoff="${m.kickoffUnix || ''}">${esc(fmtDate(m.kickoff))}</div>
      </div>`);
    }
    el.innerHTML = cards.join('');
    startCountdown();
  }

  function startCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    const node = document.querySelector('.b-countdown[data-kickoff]');
    if (!node) return;
    const ko = Number(node.getAttribute('data-kickoff'));
    if (!ko) return;
    const base = fmtDate(new Date(ko).toISOString());
    const tick = () => {
      const diff = ko - Date.now();
      if (diff <= 0) { node.textContent = `${base} · kicking off`; clearInterval(countdownTimer); return; }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const parts = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
      node.textContent = `${base} · in ${parts}`;
    };
    tick();
    countdownTimer = setInterval(tick, 60000);
  }

  // --- render: winner/runner-up race ---------------------------------------
  function badge(t) {
    if (t.statusKind === 'champion') return `<span class="badge champion">Champion 🏆</span>`;
    if (t.statusKind === 'runnerup') return `<span class="badge runnerup">Runner-up</span>`;
    return `<span class="badge ${t.alive ? 'alive' : 'dead'}">${t.alive ? 'In' : 'Out'}</span>`;
  }

  function renderPlayers(players) {
    const grid = $('#playersGrid');
    // Sort: champion first, then players still in the hunt, then out; tie-break by name.
    const score = (p) => {
      if (p.teams.some((t) => t.statusKind === 'champion')) return 0;
      if (p.teams.some((t) => t.statusKind === 'runnerup')) return 1;
      if (p.teams.some((t) => t.alive)) return 2;
      return 3;
    };
    const sorted = [...players].sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));

    grid.innerHTML = sorted.map((p) => {
      const inHunt = p.teams.some((t) => t.alive);
      const isChamp = p.teams.some((t) => t.statusKind === 'champion');
      const cls = ['player-card', isChamp ? 'is-champion' : (inHunt ? 'in-hunt' : '')].filter(Boolean).join(' ');
      const rows = p.teams.map((t) => `
        <div class="team-row">
          <span class="flag">${flag(t.iso2)}</span>
          <span class="team-meta">
            <div class="team-name">${esc(t.name)} <span class="pot">· ${esc(t.odds)}</span></div>
            <div class="team-status">${esc(t.status)}</div>
          </span>
          ${badge(t)}
        </div>`).join('');
      return `<div class="${cls}"><p class="player-name">${esc(p.name)}</p>${rows}</div>`;
    }).join('');
  }

  // --- render: leaderboards -------------------------------------------------
  function renderBoards(data) {
    const defs = [
      { key: 'goalsConceded', title: 'Most goals conceded', icon: '🥅' },
      { key: 'redCards', title: 'Most red cards', icon: '🟥' },
      { key: 'ownGoals', title: 'Most own goals', icon: '🙃' },
    ];
    const amt = Object.fromEntries((data.prizes?.breakdown || []).map((b) => [b.name, b.amount]));
    const prizeFor = { goalsConceded: 'Most Goals Conceded (Group)', redCards: 'Most Red Cards (Group)', ownGoals: 'Most Own Goals (Group)' };

    $('#boards').innerHTML = defs.map((def) => {
      const rows = (data.leaderboards?.[def.key] || []).filter((r) => r.value > 0);
      const top = rows.length ? rows[0].value : 0;
      const body = rows.length
        ? `<ol>${rows.slice(0, 10).map((r, i) => `
            <li class="${r.value === top ? 'leader' : ''}">
              <span class="rank">${i + 1}</span>
              <span class="flag">${flag(r.iso2)}</span>
              <span class="who"><div>${esc(r.name)}</div><div class="pl">${esc(r.player)}</div></span>
              <span class="val">${r.value}</span>
            </li>`).join('')}</ol>`
        : `<p class="empty">Nothing yet — nil all round. 🎉</p>`;
      const prize = amt[prizeFor[def.key]] != null ? `£${amt[prizeFor[def.key]]}` : '';
      return `<div class="board"><h3>${def.icon} ${def.title}<span class="amt">${prize}</span></h3>${body}</div>`;
    }).join('');
  }

  // --- render: group tables -------------------------------------------------
  function renderGroups(groups) {
    const el = $('#groupsGrid');
    if (!groups || !groups.length) {
      el.innerHTML = `<p class="empty">Group tables will appear once the tournament data is available.</p>`;
      return;
    }
    el.innerHTML = groups.map((g) => {
      const rows = g.rows.map((r, i) => {
        const pos = r.rank || (i + 1);
        const qual = pos <= 2 ? 'q-top' : pos === 3 ? 'q-third' : '';
        const gd = (r.gd > 0 ? '+' : '') + r.gd;
        return `<tr class="${qual}">
          <td class="pos">${pos}</td>
          <td class="gt-team">
            <span class="flag">${flag(r.iso2)}</span>
            <span class="gt-meta"><span class="gt-name">${esc(r.name)}</span><span class="gt-owner">${esc(r.player || '')}</span></span>
          </td>
          <td>${r.played}</td>
          <td>${r.w}-${r.d}-${r.l}</td>
          <td>${esc(gd)}</td>
          <td class="pts">${r.pts}</td>
        </tr>`;
      }).join('');
      return `<div class="group-card">
        <h3>${esc(g.name)}</h3>
        <table class="group-table">
          <thead><tr><th></th><th>Team</th><th title="Played">P</th><th title="Won-Drawn-Lost">W-D-L</th><th title="Goal difference">GD</th><th>Pts</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }).join('');
  }

  // --- render: best third-placed teams -------------------------------------
  function renderThirds(thirds) {
    const el = $('#thirdsTable');
    if (!thirds || !thirds.length) {
      el.innerHTML = `<p class="empty">The third-placed ranking will appear once group games are under way.</p>`;
      return;
    }
    const rows = thirds.map((r) => {
      const gd = (r.gd > 0 ? '+' : '') + r.gd;
      const grp = (r.group || '').replace(/group\s*/i, '');
      return `<tr class="${r.qualifying ? 'q-top' : 'q-out'}">
        <td class="pos">${r.pos}</td>
        <td class="gt-team">
          <span class="flag">${flag(r.iso2)}</span>
          <span class="gt-meta"><span class="gt-name">${esc(r.name)} <span class="grp-tag">Grp ${esc(grp)}</span></span><span class="gt-owner">${esc(r.player || '')}</span></span>
        </td>
        <td>${r.played}</td>
        <td>${esc(gd)}</td>
        <td class="pts">${r.pts}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="group-table thirds-table">
      <thead><tr><th></th><th>Team</th><th title="Played">P</th><th title="Goal difference">GD</th><th>Pts</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  // --- render: knockout bracket --------------------------------------------
  function renderBracket(bracket) {
    const wrap = $('#bracket');
    const nav = $('#roundNav');
    if (!bracket || !bracket.rounds || !bracket.rounds.length) {
      nav.innerHTML = '';
      wrap.innerHTML = `<p class="empty">The knockout bracket appears once the draw is published.</p>`;
      return;
    }
    const rounds = bracket.rounds;

    // Default to the "live" round: first with an unfinished match, else the last.
    let active = rounds.findIndex((r) => r.blocks.some((b) => !b.finished));
    if (active < 0) active = rounds.length - 1;

    const teamRow = (t) => {
      if (!t) return '';
      const cls = ['bk-team', t.winner ? 'win' : '', t.placeholder ? 'tbc' : ''].filter(Boolean).join(' ');
      const score = (t.score != null) ? `<span class="bk-score">${t.score}</span>` : '';
      const owner = t.player ? `<span class="bk-owner">${esc(t.player)}</span>` : '';
      return `<div class="${cls}">
        <span class="flag">${t.placeholder ? '⚽' : flag(t.iso2)}</span>
        <span class="bk-meta"><span class="bk-name">${esc(t.name)}</span>${owner}</span>
        ${score}
      </div>`;
    };

    wrap.innerHTML = rounds.map((r, i) => {
      const matches = r.blocks.map((b) => {
        const lab = b.label ? `<div class="bk-label">${esc(b.label)}</div>` : '';
        const ko = b.kickoff ? `<div class="bk-ko">${esc(fmtDate(b.kickoff))}</div>` : '';
        return `<div class="bk-match">${lab}${teamRow(b.home)}${teamRow(b.away)}${ko}</div>`;
      }).join('');
      return `<div class="bracket-round${i === active ? ' active' : ''}" data-round="${i}">
        <div class="bracket-round-title">${esc(r.name)}</div>
        ${matches}
      </div>`;
    }).join('');

    nav.innerHTML = rounds.map((r, i) =>
      `<button class="round-btn${i === active ? ' active' : ''}" data-round="${i}" type="button">${esc(r.name)}</button>`
    ).join('');

    nav.querySelectorAll('.round-btn').forEach((btn) => btn.addEventListener('click', () => {
      const idx = btn.getAttribute('data-round');
      nav.querySelectorAll('.round-btn').forEach((b) => b.classList.toggle('active', b === btn));
      wrap.querySelectorAll('.bracket-round').forEach((c) => c.classList.toggle('active', c.getAttribute('data-round') === idx));
    }));
  }

  // --- render: fixtures & results (grouped by day, filterable) -------------
  let fixturesData = [];
  let fixtureFilter = 'all';

  function renderFixtures(fixtures) {
    fixturesData = fixtures || [];
    drawFixtures();
    const fil = $('#fxFilter');
    if (fil && !fil.dataset.wired) {
      fil.dataset.wired = '1';
      fil.querySelectorAll('.round-btn').forEach((btn) => btn.addEventListener('click', () => {
        fixtureFilter = btn.getAttribute('data-filter');
        fil.querySelectorAll('.round-btn').forEach((b) => b.classList.toggle('active', b === btn));
        drawFixtures();
      }));
    }
  }

  function drawFixtures() {
    const list = $('#fixturesList');
    let items = fixturesData;
    if (fixtureFilter === 'results') items = items.filter((f) => f.finished);
    else if (fixtureFilter === 'upcoming') items = items.filter((f) => !f.finished);
    if (!items.length) { list.innerHTML = `<p class="empty">Nothing to show here yet.</p>`; return; }

    const order = []; const byDay = new Map();
    for (const f of items) {
      const d = new Date(f.date);
      const key = isNaN(d) ? 'Date TBC' : d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
      if (!byDay.has(key)) { byDay.set(key, []); order.push(key); }
      byDay.get(key).push(f);
    }
    list.innerHTML = order.map((key) =>
      `<div class="fx-day"><h3 class="fx-date">${esc(key)}</h3>${byDay.get(key).map(fixtureRow).join('')}</div>`
    ).join('');
  }

  function fixtureRow(f) {
    const time = () => { const d = new Date(f.date); return isNaN(d) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
    const mid = f.finished
      ? `<span class="fx-score">${f.home.score ?? ''}–${f.away.score ?? ''}</span>`
      : `<span class="fx-time">${esc(time())}</span>`;
    const owner = (t) => t.player ? `<span class="fx-owner">${esc(t.player)}</span>` : '';
    return `<div class="fx-match">
      <span class="fx-side home ${f.home.winner ? 'win' : ''}">
        <span class="fx-meta r"><span class="fx-name">${esc(f.home.name)}</span>${owner(f.home)}</span>
        <span class="flag">${flag(f.home.iso2)}</span>
      </span>
      <span class="fx-mid">${mid}<span class="fx-round">${esc(f.round)}</span></span>
      <span class="fx-side away ${f.away.winner ? 'win' : ''}">
        <span class="flag">${flag(f.away.iso2)}</span>
        <span class="fx-meta l"><span class="fx-name">${esc(f.away.name)}</span>${owner(f.away)}</span>
      </span>
    </div>`;
  }

  // --- render: bragging-rights (cashless) prizes ---------------------------
  function renderCashless(c) {
    const el = $('#cashless');
    if (!c) { el.innerHTML = `<p class="empty">Not available yet.</p>`; return; }
    const flagName = (t) => `<span class="flag">${flag(t.iso2)}</span> ${esc(t.name)}`;

    const mp = c.mostPoints || [];
    const mpTop = mp.length ? mp[0].points : -1;
    const mostPoints = `<div class="board"><h3>🏅 Most points (combined)</h3><ol>${mp.slice(0, 12).map((p, i) => `
      <li class="${p.points === mpTop ? 'leader' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="who"><div>${esc(p.player)}</div><div class="pl">${p.teams.map((t) => esc(t.name) + ' ' + t.pts).join(' · ')}</div></span>
        <span class="val">${p.points}</span>
      </li>`).join('')}</ol></div>`;

    const wt = c.worstTeam || [];
    const worst = `<div class="board"><h3>🗑️ Worst team</h3><ol>${wt.map((t, i) => `
      <li class="${i === 0 ? 'leader' : ''}">
        <span class="rank">${i + 1}</span><span class="flag">${flag(t.iso2)}</span>
        <span class="who"><div>${esc(t.name)}</div><div class="pl">${esc(t.player)}</div></span>
        <span class="val">${t.pts}<small> pts · GD ${t.gd > 0 ? '+' : ''}${t.gd}</small></span>
      </li>`).join('')}</ol></div>`;

    const e = c.englandKnockedOutBy;
    let eng;
    if (!e) eng = `<p class="cash-pending">Awaiting data.</p>`;
    else if (e.state === 'alive') eng = `<p class="cash-big">England are still in it 🦁</p>`;
    else if (e.state === 'group') eng = `<p class="cash-big">Out in the group stage</p><p class="cash-sub">No single team to credit — England didn't qualify.</p>`;
    else eng = `<p class="cash-big">${flagName(e.team)}</p><p class="cash-sub">beat England ${esc(e.score)} in the ${esc(e.round)}${e.team.player ? ` — owned by ${esc(e.team.player)}` : ''}</p>`;
    const england = `<div class="cash-card"><h3>🦁 Team to knock England out</h3>${eng}</div>`;

    const fast = (f, emoji, title) => {
      if (!f) return `<div class="cash-card"><h3>${emoji} ${title}</h3><p class="cash-pending">Appears after the next data update.</p></div>`;
      const min = `${f.minute}${f.addedTime ? '+' + f.addedTime : ''}'`;
      return `<div class="cash-card"><h3>${emoji} ${title}</h3>
        <p class="cash-big">${esc(min)}</p>
        <p class="cash-sub">${f.scorer ? esc(f.scorer) + ' — ' : ''}${flagName(f)}${f.player ? ` (${esc(f.player)})` : ''}</p>
        <p class="cash-match">${esc(f.match || '')}</p></div>`;
    };

    const okrRows = c.okr || [];
    const okrTop = okrRows.length ? okrRows[0].score : -1;
    const okr = `<div class="board"><h3 title="Goals conceded + losses + yellows + (reds×2), both teams combined">🌀 OKR — chaos index</h3><ol>${okrRows.slice(0, 12).map((p, i) => `
      <li class="${p.score === okrTop ? 'leader' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="who"><div>${esc(p.player)}</div><div class="pl">${p.conceded} conceded · ${p.losses}L · ${p.yellows}🟨 · ${p.reds}🟥</div></span>
        <span class="val">${p.score}</span>
      </li>`).join('')}</ol></div>`;

    el.innerHTML = `<div class="cash-grid">${england}${fast(c.fastestGoal, '⚡', 'Fastest goal')}${fast(c.fastestOwnGoal, '🙃', 'Fastest own goal')}</div>
      <div class="boards">${mostPoints}${worst}${okr}</div>`;
  }

  // --- tab switching --------------------------------------------------------
  function initTabs() {
    const btns = document.querySelectorAll('.tab-btn');
    btns.forEach((btn) => btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      btns.forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-panel').forEach((p) => {
        p.hidden = (p.id !== `tab-${tab}`);
      });
    }));
  }

  // --- main -----------------------------------------------------------------
  async function load() {
    const status = $('#status');
    try {
      const res = await fetch('data/standings.json', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      renderPrizes(data.prizes);
      renderBanner(data.banner);
      renderPlayers(data.players || []);
      renderBoards(data);
      renderThirds(data.thirdPlaced || []);
      renderGroups(data.groups || []);
      renderBracket(data.bracket);
      renderFixtures(data.fixtures || []);
      renderCashless(data.cashless);

      $('#lockState').textContent = data.groupStageComplete ? 'FROZEN — group stage complete' : 'live — group stage in progress';
      $('#lockState').classList.toggle('frozen', !!data.groupStageComplete);

      $('#updated').textContent = data.lastUpdated
        ? `Last updated ${fmtDate(data.lastUpdated)}` + (data.meta?.offline ? ' · awaiting first live data' : '')
        : '';
      status.textContent = '';
    } catch (err) {
      status.className = 'status error';
      status.textContent = `Couldn’t load standings (${err.message}). If this is a fresh deploy, the first update may not have run yet.`;
    }
  }

  initTabs();
  load();
})();
