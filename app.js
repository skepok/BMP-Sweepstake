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

      $('#lockState').textContent = data.groupStageComplete ? 'FROZEN — group stage complete' : 'live — group stage in progress';
      $('#lockState').classList.toggle('frozen', !!data.groupStageComplete);

      $('#updated').textContent = data.lastUpdated
        ? `Last updated ${fmtDate(data.lastUpdated)}` + (data.meta?.offline ? ' · awaiting first live data' : '')
        : '';
      $('#footerSource').textContent = `Data: ${data.source || 'API-Football'} · Season ${data.season || ''}`;
      status.textContent = '';
    } catch (err) {
      status.className = 'status error';
      status.textContent = `Couldn’t load standings (${err.message}). If this is a fresh deploy, the first update may not have run yet.`;
    }
  }

  load();
})();
