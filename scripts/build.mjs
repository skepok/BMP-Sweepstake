#!/usr/bin/env node
/**
 * The Blair Mitch Project — WC2026 sweepstake standings builder.
 *
 * Runs in GitHub Actions on a cron. Fixture-aware + heavily cached so it stays
 * far under API-Football's free tier (100 requests/day):
 *
 *   - /fixtures   : full WC fixture list (1 req). Refreshed only when a match
 *                   has just finished, or once/day as a safety net.
 *   - /standings  : group tables (1 req). Gives goals-conceded + group rank
 *                   directly, so no per-fixture maths for that metric.
 *   - /fixtures/events : ONLY for finished GROUP-STAGE fixtures (1 req each,
 *                   fetched once ever and cached forever). Needed for red cards
 *                   and own goals. Knockout matches never need events.
 *
 * If nothing has newly finished since the last fetch, the script exits having
 * made ZERO API calls.
 *
 * Run with no API key (offline) to (re)generate a valid skeleton standings.json
 * from data/players.json — useful for first deploy / local preview.
 *
 * Usage:  node scripts/build.mjs
 * Env:    API_FOOTBALL_KEY, LEAGUE_ID (default 1), SEASON (default 2026)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(ROOT, 'cache');

const API_KEY = process.env.API_FOOTBALL_KEY || '';
const LEAGUE_ID = Number(process.env.LEAGUE_ID || 1);
const SEASON = Number(process.env.SEASON || 2026);
const BASE_URL = 'https://v3.football.api-sports.io';

// --- Tunables -------------------------------------------------------------
const FULL_TIME_BUFFER_MIN = 120;   // kickoff + this => match is certainly over
const DAILY_REQUEST_CAP = 90;       // soft cap below the 100/day hard limit
const MAX_REQUESTS_PER_RUN = 40;    // never blow the whole budget in one run
const FIXTURES_TTL_HOURS = 20;      // daily safety refresh of the fixtures list

// IMPORTANT: API-Football reports an Own Goal event with team/player set to the
// player who put it into their OWN net (the committing team). The sweepstake
// prize is "most own goals" by the committing team, so we attribute to
// event.team. If real data ever shows the opposite, flip this to false.
const OWN_GOAL_TEAM_IS_COMMITTER = true;

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);

// --- tiny helpers ---------------------------------------------------------
const log = (...a) => console.log('[build]', ...a);
const nowMs = () => Date.now();
const iso = (ms) => new Date(ms).toISOString();

function normaliseName(s) {
  return (s || '')
    .normalize('NFD').replace(/\p{Diacritic}/gu, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function readJson(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return fallback; }
}

async function writeJson(file, obj) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

// --- API layer (counts requests, respects caps) --------------------------
let requestsThisRun = 0;
let requestsToday = 0;

async function apiGet(endpoint, params) {
  if (!API_KEY) throw new Error('No API key (offline mode should not call the API)');
  if (requestsThisRun >= MAX_REQUESTS_PER_RUN) throw new Error('Per-run request cap reached');
  if (requestsToday >= DAILY_REQUEST_CAP) throw new Error('Daily request cap reached');

  const url = new URL(BASE_URL + endpoint);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);

  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  requestsThisRun++;
  requestsToday++;
  if (!res.ok) throw new Error(`API ${endpoint} -> HTTP ${res.status}`);
  const json = await res.json();
  if (Array.isArray(json.errors) ? json.errors.length : Object.keys(json.errors || {}).length) {
    throw new Error(`API ${endpoint} -> ${JSON.stringify(json.errors)}`);
  }
  return json.response || [];
}

// --- round classification -------------------------------------------------
const KO_ROUNDS = [
  { key: 'r32', label: 'Round of 32', idx: 1, test: /round of 32/i },
  { key: 'r16', label: 'Round of 16', idx: 2, test: /round of 16/i },
  { key: 'qf',  label: 'Quarter-finals', idx: 3, test: /quarter/i },
  { key: 'sf',  label: 'Semi-finals', idx: 4, test: /semi/i },
  { key: 'final', label: 'Final', idx: 6, test: /(^|[^-])\bfinal\b/i },
];
const THIRD_PLACE = { label: '3rd Place Play-off', idx: 5, test: /3rd place|third place/i };

function classifyRound(round) {
  if (/group/i.test(round)) return { kind: 'group', idx: 0, label: round };
  if (THIRD_PLACE.test.test(round)) return { kind: 'third', idx: THIRD_PLACE.idx, label: THIRD_PLACE.label };
  // check final-like rounds; longest/most-specific first (semi/quarter before final)
  for (const r of KO_ROUNDS) if (r.test.test(round)) return { kind: 'ko', idx: r.idx, label: r.label };
  return { kind: 'other', idx: 0, label: round };
}

// --- main -----------------------------------------------------------------
async function main() {
  const players = await readJson(path.join(DATA_DIR, 'players.json'));
  if (!players) throw new Error('data/players.json not found');

  // Build a normalised-name -> team-record resolver from players.json.
  const teamByCode = new Map();
  const codeByName = new Map();
  for (const p of players.players) {
    for (const t of p.teams) {
      teamByCode.set(t.code, { ...t, player: p.name });
      codeByName.set(normaliseName(t.name), t.code);
      for (const a of t.aliases || []) codeByName.set(normaliseName(a), t.code);
    }
  }
  const resolveCode = (apiName) => codeByName.get(normaliseName(apiName)) || null;

  // ---- PRIMARY SOURCE: SofaScore scrape (cache/raw_matches.json) ----------
  // scripts/scrape.py writes this. If present, build entirely from it (no API).
  const rawPath = path.join(CACHE_DIR, 'raw_matches.json');
  const raw = await readJson(rawPath);
  if (raw && Array.isArray(raw.matches)) {
    log(`Building from SofaScore data (${raw.matches.length} matches, scraped ${raw.fetchedAt || '?'}).`);
    const { fixtures, standings, events } = adaptSofaScore(raw, resolveCode);
    await writeStandings({
      players, teamByCode, fixtures, standings, events, bracketRaw: raw.bracket || null,
      source: 'SofaScore', season: raw.season || SEASON,
      meta: { source: 'SofaScore', matches: raw.matches.length, scrapedAt: raw.fetchedAt || null },
    });
    return;
  }

  // ---- OFFLINE / skeleton mode -------------------------------------------
  if (!API_KEY) {
    log('No SofaScore data and no API key — writing skeleton standings.json (no network).');
    await writeStandings({ players, teamByCode, fixtures: [], standings: [], events: {}, meta: { offline: true } });
    return;
  }

  await mkdir(CACHE_DIR, { recursive: true });

  // ---- load caches --------------------------------------------------------
  const state = (await readJson(path.join(CACHE_DIR, 'state.json'))) || {
    date: '', requestsToday: 0, lastFixturesRefresh: 0, processedFixtureIds: [],
  };
  const today = iso(nowMs()).slice(0, 10);
  if (state.date !== today) { state.date = today; state.requestsToday = 0; } // reset daily counter
  requestsToday = state.requestsToday;
  const processed = new Set(state.processedFixtureIds || []);

  let fixturesCache = await readJson(path.join(CACHE_DIR, 'fixtures.json'));
  let standingsCache = await readJson(path.join(CACHE_DIR, 'standings.json'));
  const eventsCache = (await readJson(path.join(CACHE_DIR, 'events.json'))) || {};

  // ---- decide whether to refresh the fixtures/standings lists ------------
  const cachedFixtures = fixturesCache?.response || [];
  const ageMs = nowMs() - (state.lastFixturesRefresh || 0);
  const staleByTime = ageMs > FIXTURES_TTL_HOURS * 3600 * 1000;

  // A match has "just finished" if its kickoff+buffer is in the past but our
  // cached copy still doesn't show a finished status. That's our trigger.
  const matchJustFinished = cachedFixtures.some((f) => {
    const ko = (f.fixture?.timestamp || 0) * 1000;
    const overdue = ko && nowMs() > ko + FULL_TIME_BUFFER_MIN * 60 * 1000;
    return overdue && !FINISHED_STATUSES.has(f.fixture?.status?.short);
  });

  const needRefresh = !fixturesCache || staleByTime || matchJustFinished;
  let didNetwork = false;

  if (needRefresh && requestsToday < DAILY_REQUEST_CAP) {
    try {
      log(`Refreshing fixtures + standings (stale=${staleByTime}, justFinished=${matchJustFinished})`);
      const fixtures = await apiGet('/fixtures', { league: LEAGUE_ID, season: SEASON });
      fixturesCache = { fetchedAt: iso(nowMs()), response: fixtures };
      await writeJson(path.join(CACHE_DIR, 'fixtures.json'), fixturesCache);
      didNetwork = true;

      try {
        const standings = await apiGet('/standings', { league: LEAGUE_ID, season: SEASON });
        standingsCache = { fetchedAt: iso(nowMs()), response: standings };
        await writeJson(path.join(CACHE_DIR, 'standings.json'), standingsCache);
      } catch (e) {
        log('standings fetch failed (continuing with cached/none):', e.message);
      }
      state.lastFixturesRefresh = nowMs();
    } catch (e) {
      log('fixtures refresh failed, using cache:', e.message);
    }
  } else {
    log(`No refresh needed (age=${Math.round(ageMs / 3600000)}h, justFinished=${matchJustFinished}).`);
  }

  const fixtures = fixturesCache?.response || [];
  const standings = standingsCache?.response || [];

  // ---- fetch events for newly-finished GROUP-STAGE fixtures --------------
  const groupFinishedUnprocessed = fixtures.filter((f) => {
    const id = String(f.fixture?.id);
    const fin = FINISHED_STATUSES.has(f.fixture?.status?.short);
    const grp = classifyRound(f.league?.round || '').kind === 'group';
    return grp && fin && !processed.has(id) && !eventsCache[id];
  });

  for (const f of groupFinishedUnprocessed) {
    if (requestsThisRun >= MAX_REQUESTS_PER_RUN || requestsToday >= DAILY_REQUEST_CAP) {
      log('Hit request cap; remaining fixtures will be processed next run.');
      break;
    }
    const id = String(f.fixture.id);
    try {
      const events = await apiGet('/fixtures/events', { fixture: id });
      eventsCache[id] = summariseEvents(events, resolveCode);
      processed.add(id);
      didNetwork = true;
      log(`Processed events for fixture ${id} (${f.teams?.home?.name} v ${f.teams?.away?.name}).`);
    } catch (e) {
      log(`events fetch failed for fixture ${id}:`, e.message);
    }
  }

  if (didNetwork) {
    await writeJson(path.join(CACHE_DIR, 'events.json'), eventsCache);
  }

  // ---- persist state ------------------------------------------------------
  state.requestsToday = requestsToday;
  state.processedFixtureIds = [...processed];
  await writeJson(path.join(CACHE_DIR, 'state.json'), state);

  // ---- compute + write standings -----------------------------------------
  await writeStandings({
    players, teamByCode, fixtures, standings, events: eventsCache,
    meta: { requestsThisRun, requestsToday, fixturesCount: fixtures.length, processedFixtures: processed.size },
  });

  log(`Done. Requests this run: ${requestsThisRun}. Requests today: ${requestsToday}/${DAILY_REQUEST_CAP}.`);
}

/** Reduce a fixture's raw events to per-team red-card / own-goal counts (by our code). */
function summariseEvents(events, resolveCode) {
  const red = {}; const own = {}; const unmatched = [];
  for (const ev of events) {
    const teamName = ev.team?.name;
    const code = resolveCode(teamName);
    if (ev.type === 'Card' && /red/i.test(ev.detail || '')) {
      if (code) red[code] = (red[code] || 0) + 1; else unmatched.push(teamName);
    } else if (ev.type === 'Goal' && /own goal/i.test(ev.detail || '')) {
      // Attribute to committing team (event.team) per OWN_GOAL_TEAM_IS_COMMITTER.
      const ogCode = OWN_GOAL_TEAM_IS_COMMITTER ? code : null;
      if (ogCode) own[ogCode] = (own[ogCode] || 0) + 1; else unmatched.push(teamName);
    }
  }
  if (unmatched.length) log('  (unmatched team names in events:', [...new Set(unmatched)].join(', '), ')');
  return { red, own };
}

/** Compute the full standings.json payload and write it. */
/**
 * Convert the normalised SofaScore payload (cache/raw_matches.json, written by
 * scripts/scrape.py) into the internal shapes writeStandings already understands:
 * API-Football-style `fixtures`, `standings`, and an `events` map keyed by fixture
 * id -> { red: {CODE:n}, own: {CODE:n} }. This lets the whole tested standings
 * engine run unchanged regardless of where the data came from.
 */
function adaptSofaScore(raw, resolveCode) {
  const fixtures = (raw.matches || []).map((m) => ({
    fixture: {
      id: m.id,
      timestamp: m.startTimestamp || 0,                       // seconds
      date: m.startTimestamp ? iso(m.startTimestamp * 1000) : null,
      status: { short: m.status === 'finished' ? 'FT' : m.status === 'inprogress' ? '1H' : 'NS' },
    },
    league: { round: m.round || '' },
    teams: {
      home: { name: m.home?.name, winner: m.home?.winner ?? null },
      away: { name: m.away?.name, winner: m.away?.winner ?? null },
    },
    goals: { home: m.home?.score ?? null, away: m.away?.score ?? null },
  }));

  // Group tables -> API-Football standings shape (one table; each row carries its group).
  // Skip SofaScore's extra "Third-placed teams" comparison block (it ranks the 12
  // third-place teams together and would otherwise overwrite their real group/position).
  const rows = (raw.standings || [])
    .filter((s) => /^group\s+[a-z]$/i.test((s.group || '').trim()))
    .map((s) => ({
    rank: s.rank ?? null,
    team: { name: s.team },
    points: s.pts ?? 0,
    group: s.group || null,
    all: { played: s.played ?? 0, win: s.w ?? 0, draw: s.d ?? 0, lose: s.l ?? 0, goals: { for: s.gf ?? 0, against: s.ga ?? 0 } },
  }));
  const standings = rows.length ? [{ league: { standings: [rows] } }] : [];

  // Per-match red cards / own goals (by team name) -> events map keyed by id, by code.
  const events = {};
  const unmatched = new Set();
  for (const m of raw.matches || []) {
    if (!m.incidentsFetched) continue;
    const red = {}; const own = {};
    for (const [name, n] of Object.entries(m.redCards || {})) {
      const code = resolveCode(name); if (code && n) red[code] = (red[code] || 0) + n; else if (n) unmatched.add(name);
    }
    for (const [name, n] of Object.entries(m.ownGoals || {})) {
      const code = resolveCode(name); if (code && n) own[code] = (own[code] || 0) + n; else if (n) unmatched.add(name);
    }
    events[String(m.id)] = { red, own };
  }
  if (unmatched.size) log('(unmatched team names — add aliases in players.json):', [...unmatched].join(', '));

  return { fixtures, standings, events };
}

async function writeStandings({ players, teamByCode, fixtures, standings, events, meta, source, season, bracketRaw }) {
  // ---- group tables: code -> { group, rank, played, w,d,l, gf, ga, pts } -
  // Also build full group tables (every team + owner) for the Group Tables tab.
  const groupByCode = new Map();
  const groupTables = new Map(); // groupName -> rows[]
  for (const block of standings) {
    const groups = block?.league?.standings || [];
    for (const table of groups) {
      for (const row of table) {
        const code = lookupCodeByName(row.team?.name, players);
        if (!code) continue;
        const gf = row.all?.goals?.for ?? 0;
        const ga = row.all?.goals?.against ?? 0;
        groupByCode.set(code, {
          group: row.group || null,
          rank: row.rank ?? null,
          played: row.all?.played ?? 0,
          w: row.all?.win ?? 0, d: row.all?.draw ?? 0, l: row.all?.lose ?? 0,
          gf, ga, // ga = goals conceded in group
          pts: row.points ?? 0,
        });
        const ref = teamByCode.get(code);
        const groupName = row.group || 'Group ?';
        if (!groupTables.has(groupName)) groupTables.set(groupName, []);
        groupTables.get(groupName).push({
          code, name: ref?.name || row.team?.name, iso2: ref?.iso2 || null, player: ref?.player || null,
          rank: row.rank ?? null, played: row.all?.played ?? 0,
          w: row.all?.win ?? 0, d: row.all?.draw ?? 0, l: row.all?.lose ?? 0,
          gf, ga, gd: gf - ga, pts: row.points ?? 0,
        });
      }
    }
  }
  const groups = [...groupTables.entries()]
    .map(([name, rows]) => ({ name, rows: rows.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99)) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Third-placed ranking: each group's 3rd team, ranked by points -> goal
  // difference -> goals scored (FIFA criteria 1-3). The top 8 of 12 qualify for
  // the Round of 32. The rare disciplinary/drawing-of-lots tiebreakers aren't applied.
  const thirdPlaced = groups
    .map((g) => { const r = g.rows.find((x) => (x.rank ?? 0) === 3) || g.rows[2]; return r ? { ...r, group: g.name } : null; })
    .filter(Boolean)
    .sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || a.name.localeCompare(b.name))
    .map((r, i) => ({
      pos: i + 1, code: r.code, name: r.name, iso2: r.iso2, player: r.player,
      group: r.group, played: r.played, gd: r.gd, gf: r.gf, pts: r.pts,
      qualifying: i < 8,
    }));

  // ---- fixture indexing ---------------------------------------------------
  const enriched = fixtures.map((f) => {
    const cls = classifyRound(f.league?.round || '');
    return {
      id: String(f.fixture?.id),
      ts: (f.fixture?.timestamp || 0) * 1000,
      date: f.fixture?.date || null,
      statusShort: f.fixture?.status?.short || 'NS',
      finished: FINISHED_STATUSES.has(f.fixture?.status?.short),
      round: f.league?.round || '',
      cls,
      home: { name: f.teams?.home?.name, code: lookupCodeByName(f.teams?.home?.name, players), winner: f.teams?.home?.winner, goals: f.goals?.home },
      away: { name: f.teams?.away?.name, code: lookupCodeByName(f.teams?.away?.name, players), winner: f.teams?.away?.winner, goals: f.goals?.away },
    };
  });

  // ---- knockout bracket (from cuptree + match scores) ---------------------
  const bracket = buildBracket(bracketRaw, new Map(enriched.map((e) => [e.id, e])), teamByCode, (n) => lookupCodeByName(n, players));

  const knockoutsStarted = enriched.some((f) => f.cls.kind === 'ko' && f.finished);
  const koFixturesExist = enriched.some((f) => f.cls.kind === 'ko' || f.cls.kind === 'third');
  const groupStageComplete = enriched.length > 0 &&
    enriched.filter((f) => f.cls.kind === 'group').every((f) => f.finished) &&
    enriched.some((f) => f.cls.kind === 'group');

  // ---- champion / runner-up from the Final --------------------------------
  let champion = null; let runnerUp = null;
  const finalFx = enriched.find((f) => f.cls.kind === 'ko' && f.cls.idx === 6 && f.finished);
  if (finalFx) {
    const winSide = finalFx.home.winner ? finalFx.home : finalFx.away.winner ? finalFx.away : null;
    const loseSide = winSide === finalFx.home ? finalFx.away : finalFx.home;
    if (winSide?.code) champion = teamRef(winSide.code, teamByCode);
    if (loseSide?.code) runnerUp = teamRef(loseSide.code, teamByCode);
  }

  // ---- per-team status ----------------------------------------------------
  const hasFixtures = enriched.length > 0;
  const statusByCode = new Map();
  for (const code of teamByCode.keys()) {
    statusByCode.set(code, computeTeamStatus(code, enriched, groupByCode, koFixturesExist, groupStageComplete, champion, runnerUp, hasFixtures));
  }

  // ---- assemble players ---------------------------------------------------
  const eventTotals = aggregateEvents(events);
  const outPlayers = players.players.map((p) => ({
    name: p.name,
    teams: p.teams.map((t) => {
      const g = groupByCode.get(t.code) || null;
      const st = statusByCode.get(t.code);
      return {
        code: t.code, name: t.name, iso2: t.iso2, pot: t.pot, odds: t.odds,
        matched: !!(g || enriched.some((f) => f.home.code === t.code || f.away.code === t.code)),
        status: st.label, statusKind: st.kind, alive: st.alive,
        group: g,
        goalsConceded: g ? g.ga : 0,
        redCards: eventTotals.red[t.code] || 0,
        ownGoals: eventTotals.own[t.code] || 0,
      };
    }),
  }));

  // ---- leaderboards (frozen once group stage complete) --------------------
  const allTeams = [];
  for (const p of players.players) for (const t of p.teams) {
    const g = groupByCode.get(t.code);
    allTeams.push({
      code: t.code, name: t.name, iso2: t.iso2, player: p.name,
      goalsConceded: g ? g.ga : 0,
      redCards: eventTotals.red[t.code] || 0,
      ownGoals: eventTotals.own[t.code] || 0,
    });
  }
  const board = (key) => [...allTeams]
    .map((t) => ({ code: t.code, name: t.name, iso2: t.iso2, player: t.player, value: t[key] }))
    .sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));

  // ---- banner: next fixture + most recently finished ----------------------
  const upcoming = enriched.filter((f) => !f.finished && f.ts > 0).sort((a, b) => a.ts - b.ts);
  const finishedByTime = enriched.filter((f) => f.finished && f.ts > 0).sort((a, b) => b.ts - a.ts);
  const banner = {
    nextFixture: upcoming[0] ? fixtureRef(upcoming[0], teamByCode) : null,
    lastFinished: finishedByTime[0] ? fixtureRef(finishedByTime[0], teamByCode, true) : null,
  };

  const payload = {
    lastUpdated: iso(nowMs()),
    source: source || 'API-Football (api-sports.io)',
    season: season || SEASON, leagueId: LEAGUE_ID,
    groupStageComplete, knockoutsStarted,
    prizes: players.prizes,
    banner,
    champion, runnerUp,
    players: outPlayers,
    leaderboards: {
      goalsConceded: board('goalsConceded'),
      redCards: board('redCards'),
      ownGoals: board('ownGoals'),
    },
    groups,
    thirdPlaced,
    bracket,
    meta,
  };

  // Only rewrite if the meaningful content changed — keeps the file (and git
  // history) stable when a refresh finds nothing new. `lastUpdated` and `meta`
  // are volatile by nature, so they're excluded from the comparison and we
  // carry over the previous `lastUpdated` when nothing else changed.
  const outPath = path.join(DATA_DIR, 'standings.json');
  const existing = await readJson(outPath);
  const stable = (o) => { if (!o) return null; const { lastUpdated, meta, ...rest } = o; return JSON.stringify(rest); };
  if (existing && stable(existing) === stable(payload)) {
    log('standings.json unchanged — leaving as is (no git churn).');
    return;
  }
  await writeJson(outPath, payload);
  log('Wrote data/standings.json');
}

// --- knockout bracket -----------------------------------------------------
function buildBracket(bracketRaw, matchById, teamByCode, lookupCode) {
  if (!Array.isArray(bracketRaw) || !bracketRaw.length) return null;

  const roundName = (desc) => {
    if (/32/.test(desc)) return 'Round of 32';
    if (/16/.test(desc)) return 'Round of 16';
    if (/quarter/i.test(desc)) return 'Quarter-finals';
    if (/semi/i.test(desc)) return 'Semi-finals';
    if (/final/i.test(desc)) return 'Final';
    return desc || 'Round';
  };

  // Turn a raw SofaScore slot code into a human-readable label.
  const feedsFrom = { 'Round of 16': 'Round of 32', 'Quarter-finals': 'Round of 16', 'Semi-finals': 'Quarter-final', 'Final': 'Semi-final' };
  const prettyPlaceholder = (raw, round) => {
    if (!raw) return 'TBC';
    // Group winner / runner-up: "1F", "2K" or flipped "H1", "G2".
    let pos; let grp;
    let m = raw.match(/^([12])([A-La-l])$/);
    if (m) { pos = m[1]; grp = m[2]; }
    else if ((m = raw.match(/^([A-La-l])([12])$/))) { grp = m[1]; pos = m[2]; }
    if (pos) return (pos === '1' ? 'Winner Group ' : 'Runner-up Group ') + grp.toUpperCase();
    // Best third-placed slot: "3A/3B/3C/3D/3F" (or a lone "3A").
    if (/^3[A-La-l](\/3[A-La-l])*$/.test(raw)) return '3rd: ' + raw.split('/').map((s) => s.replace(/^3/, '').toUpperCase()).join('/');
    // Winner / loser of a previous match: "W74", "L101".
    if (/^W\d+$/i.test(raw)) return `${feedsFrom[round] || 'Previous round'} winner`;
    if (/^L\d+$/i.test(raw)) return 'Semi-final loser';
    return raw;
  };

  // Resolve one participant, attaching score/winner from the joined match if played.
  const side = (p, match, round) => {
    const code = p && !p.placeholder ? lookupCode(p.name) : null;
    const ref = code ? teamByCode.get(code) : null;
    let score = null;
    let winner = !!(p && p.winner);
    if (match && match.finished && p) {
      if (match.home.name === p.name) { score = match.home.goals; winner = match.home.winner === true; }
      else if (match.away.name === p.name) { score = match.away.goals; winner = match.away.winner === true; }
    }
    return {
      name: ref?.name || (code ? p.name : prettyPlaceholder(p?.name, round)),
      code: code || null,
      iso2: ref?.iso2 || null,
      player: ref?.player || null,
      placeholder: !code, // anything we can't resolve to a real team is a slot label
      score, winner,
    };
  };

  const rounds = bracketRaw.map((r) => {
    const name = roundName(r.round);
    const isFinalRound = name === 'Final';
    const blocks = (r.blocks || [])
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((b, idx) => {
        const match = matchById.get(String(b.eventId));
        const ps = (b.participants || []).map((p) => side(p, match, name));
        return {
          // The cuptree's Final round holds the Final (order 1) + 3rd-place play-off (order 2).
          label: isFinalRound ? (idx === 0 ? 'Final' : '3rd place play-off') : null,
          kickoff: b.kickoff ? iso(b.kickoff * 1000) : null,
          status: match?.statusShort || 'NS',
          finished: !!match?.finished,
          home: ps[0] || null,
          away: ps[1] || null,
        };
      });
    return { name, blocks };
  });

  return { rounds };
}

// --- status logic ---------------------------------------------------------
function computeTeamStatus(code, enriched, groupByCode, koFixturesExist, groupStageComplete, champion, runnerUp, hasFixtures) {
  if (champion && champion.code === code) return { label: 'Champion 🏆', kind: 'champion', alive: true };
  if (runnerUp && runnerUp.code === code) return { label: 'Runner-up 🥈', kind: 'runnerup', alive: false };

  const teamFx = enriched.filter((f) => f.home.code === code || f.away.code === code);
  if (teamFx.length === 0) {
    // No fixtures anywhere yet -> tournament hasn't started; everyone's in.
    if (!hasFixtures) return { label: 'Yet to kick off', kind: 'group', alive: true };
    return { label: 'Not in data', kind: 'unknown', alive: false };
  }

  const koFx = teamFx.filter((f) => f.cls.kind === 'ko' || f.cls.kind === 'third');

  // 1) A finished knockout match is authoritative (KO only happens after groups).
  const playedKo = koFx.filter((f) => f.finished).sort((a, b) => b.cls.idx - a.cls.idx);
  const latest = playedKo[0];
  if (latest) {
    const side = latest.home.code === code ? latest.home : latest.away;
    const won = side.winner === true;
    // 3rd-place play-off: reaching it means the semi was already lost -> out of the title race.
    if (latest.cls.kind === 'third') {
      return won
        ? { label: '3rd place 🥉', kind: 'eliminated', alive: false }
        : { label: '4th place', kind: 'eliminated', alive: false };
    }
    if (won) {
      const nextKo = koFx.filter((f) => !f.finished).sort((a, b) => a.cls.idx - b.cls.idx)[0];
      if (nextKo) return { label: `Into the ${nextKo.cls.label}`, kind: 'through', alive: true };
      return { label: `Won ${latest.cls.label} — awaiting next round`, kind: 'through', alive: true };
    }
    // Finished a knockout match without winning -> out.
    return { label: `Eliminated — ${latest.cls.label}`, kind: 'eliminated', alive: false };
  }

  // 2) No knockout match played yet. Only judge group survival once the group
  //    stage is ACTUALLY complete — SofaScore publishes the KO bracket early
  //    (partly filled as teams clinch), so we must not treat "not yet in the
  //    bracket" as eliminated while group games are still being played.
  if (groupStageComplete) {
    const nextKo = koFx.filter((f) => !f.finished).sort((a, b) => a.cls.idx - b.cls.idx)[0];
    if (nextKo) return { label: `Into the ${nextKo.cls.label}`, kind: 'through', alive: true };
    if (koFixturesExist) return { label: 'Eliminated — Group Stage', kind: 'eliminated', alive: false };
    // groups done but bracket not published yet -> hold on the group view below.
  }

  // 3) Group stage still in progress (or bracket not out yet) -> show group position; everyone alive.
  const g = groupByCode.get(code);
  if (g) return { label: `Group ${g.group ? g.group.replace(/group\s*/i, '') : '?'} — ${ordinal(g.rank)} (${g.pts} pts)`, kind: 'group', alive: true };
  return { label: 'Group Stage', kind: 'group', alive: true };
}

function aggregateEvents(events) {
  const red = {}; const own = {};
  for (const id of Object.keys(events || {})) {
    const e = events[id];
    for (const [code, n] of Object.entries(e.red || {})) red[code] = (red[code] || 0) + n;
    for (const [code, n] of Object.entries(e.own || {})) own[code] = (own[code] || 0) + n;
  }
  return { red, own };
}

// --- small ref builders ----------------------------------------------------
function teamRef(code, teamByCode) {
  const t = teamByCode.get(code);
  return t ? { code, name: t.name, iso2: t.iso2, player: t.player } : { code, name: code, iso2: null, player: null };
}
function fixtureRef(f, teamByCode, withScore = false) {
  const sideRef = (s) => {
    const t = s.code ? teamByCode.get(s.code) : null;
    return { code: s.code, name: t?.name || s.name, iso2: t?.iso2 || null, goals: withScore ? (s.goals ?? null) : undefined };
  };
  return { round: f.cls.label, kickoff: f.date, kickoffUnix: f.ts, status: f.statusShort, home: sideRef(f.home), away: sideRef(f.away) };
}

function lookupCodeByName(apiName, players) {
  if (!apiName) return null;
  const target = normaliseName(apiName);
  for (const p of players.players) for (const t of p.teams) {
    const cands = [t.name, ...(t.aliases || [])].map(normaliseName);
    if (cands.includes(target)) return t.code;
  }
  return null;
}

function ordinal(n) {
  if (n == null) return '?';
  const s = ['th', 'st', 'nd', 'rd']; const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

main().catch((e) => { console.error('[build] FATAL:', e); process.exit(1); });
