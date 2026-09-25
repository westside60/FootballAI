const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8787;
const FOOTBALL_API_KEY = process.env.FOOTBALL_API_KEY || "";
const FOOTBALL_API_BASE = process.env.FOOTBALL_API_BASE || "https://v3.football.api-sports.io";
const ODDS_API_KEY = process.env.ODDS_API_KEY || "";
const ODDS_API_BASE = process.env.ODDS_API_BASE || "https://api.odds-api.io/v3";
const ODDS_BOOKMAKER = process.env.ODDS_BOOKMAKER || "Bet365";
const MIN_PROBABILITY = Number(process.env.MIN_PROBABILITY || 0.70);
const MIN_EDGE = Number(process.env.MIN_EDGE || 0.08);
const MAX_SCAN_FIXTURES = Number(process.env.MAX_SCAN_FIXTURES || 30);
const APP_TIMEZONE = process.env.APP_TIMEZONE || "Europe/Zurich";

const DB = path.join(__dirname, "history.json");
const load = () => { try { return JSON.parse(fs.readFileSync(DB)); } catch { return []; } };
const save = x => fs.writeFileSync(DB, JSON.stringify(x, null, 2));

async function apiFootball(pathname, params = {}) {
  if (!FOOTBALL_API_KEY) throw new Error("FOOTBALL_API_KEY fehlt");
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, v);
  const r = await fetch(`${FOOTBALL_API_BASE}${pathname}?${qs}`);
  const data = await r.json();
  if (!r.ok || (data.errors && Object.keys(data.errors).length)) {
    throw new Error(JSON.stringify(data.errors || { status: r.status }));
  }
  return data;
}

async function oddsApi(pathname, params = {}) {
  if (!ODDS_API_KEY) throw new Error("ODDS_API_KEY fehlt");
  const qs = new URLSearchParams({ apiKey: ODDS_API_KEY });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, v);
  const r = await fetch(`${ODDS_API_BASE}${pathname}?${qs}`);
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

function poisson(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

function matchProbabilities(homeXg, awayXg) {
  let home = 0, draw = 0, away = 0, over15 = 0, over25 = 0, under45 = 0;
  for (let h = 0; h <= 10; h++) {
    for (let a = 0; a <= 10; a++) {
      const p = poisson(h, homeXg) * poisson(a, awayXg);
      if (h > a) home += p;
      else if (h === a) draw += p;
      else away += p;
      if (h + a >= 2) over15 += p;
      if (h + a >= 3) over25 += p;
      if (h + a <= 4) under45 += p;
    }
  }
  return {
    "Heimsieg": home,
    "Unentschieden": draw,
    "Auswärtssieg": away,
    "Doppelte Chance 1X": home + draw,
    "Doppelte Chance X2": draw + away,
    "Über 1,5 Tore": over15,
    "Über 2,5 Tore": over25,
    "Unter 4,5 Tore": under45
  };
}

async function recentTeamStats(teamId, last = 10) {
  const data = await apiFootball("/fixtures", { team: teamId, last, status: "FT-AET-PEN" });
  const rows = data.response || [];
  let gf = 0, ga = 0, n = 0, homeN = 0, awayN = 0, homeGF = 0, homeGA = 0, awayGF = 0, awayGA = 0;
  for (const f of rows) {
    const isHome = f.teams?.home?.id === Number(teamId);
    const hg = Number(f.goals?.home), ag = Number(f.goals?.away);
    if (!Number.isFinite(hg) || !Number.isFinite(ag)) continue;
    const scored = isHome ? hg : ag, conceded = isHome ? ag : hg;
    gf += scored; ga += conceded; n++;
    if (isHome) { homeN++; homeGF += scored; homeGA += conceded; }
    else { awayN++; awayGF += scored; awayGA += conceded; }
  }
  return {
    matches: n,
    goalsFor: n ? gf / n : null,
    goalsAgainst: n ? ga / n : null,
    home: { matches: homeN, goalsFor: homeN ? homeGF / homeN : null, goalsAgainst: homeN ? homeGA / homeN : null },
    away: { matches: awayN, goalsFor: awayN ? awayGF / awayN : null, goalsAgainst: awayN ? awayGA / awayN : null },
    raw: rows
  };
}

async function fixtureStats(fixtureId, teamId) {
  try {
    const d = await apiFootball("/fixtures/statistics", { fixture: fixtureId });
    const side = (d.response || []).find(x => Number(x.team?.id) === Number(teamId));
    const st = {};
    for (const x of side?.statistics || []) {
      if (x.type && x.value !== null) st[x.type] = x.value;
    }
    return st;
  } catch { return {}; }
}

async function fixtureAvailability(fixtureId) {
  try {
    const d = await apiFootball("/injuries", { fixture: fixtureId });
    return (d.response || []).map(x => ({
      teamId: x.team?.id, team: x.team?.name, playerId: x.player?.id,
      player: x.player?.name, type: x.type, reason: x.reason
    }));
  } catch { return []; }
}

async function fixtureLineups(fixtureId) {
  try {
    const d = await apiFootball("/fixtures/lineups", { fixture: fixtureId });
    return d.response || [];
  } catch { return []; }
}

function countUnavailable(injuries, teamId) {
  return injuries.filter(x => Number(x.teamId) === Number(teamId)).length;
}

function lineupStrength(lineups, teamId) {
  const x = lineups.find(l => Number(l.team?.id) === Number(teamId));
  return x?.startXI?.length ? 1 : 0;
}

function marketProbability(model, market) {
  return model.probabilities[market];
}

async function buildModel(homeId, awayId, fixtureId) {
  const [home, away, injuries, lineups] = await Promise.all([
    recentTeamStats(homeId, 10),
    recentTeamStats(awayId, 10),
    fixtureAvailability(fixtureId),
    fixtureLineups(fixtureId)
  ]);
  if (!home.matches || !away.matches) throw new Error("Zu wenig historische Spieldaten");

  // Blend overall and venue-specific recent scoring rates.
  const homeAttack = 0.65 * home.goalsFor + 0.35 * (home.home.matches ? home.home.goalsFor : home.goalsFor);
  const homeDefense = 0.65 * home.goalsAgainst + 0.35 * (home.home.matches ? home.home.goalsAgainst : home.goalsAgainst);
  const awayAttack = 0.65 * away.goalsFor + 0.35 * (away.away.matches ? away.away.goalsFor : away.goalsFor);
  const awayDefense = 0.65 * away.goalsAgainst + 0.35 * (away.away.matches ? away.away.goalsAgainst : away.goalsAgainst);

  // Mild home advantage; availability penalty is deliberately capped.
  const homeMissing = Math.min(0.08, countUnavailable(injuries, homeId) * 0.012);
  const awayMissing = Math.min(0.08, countUnavailable(injuries, awayId) * 0.012);
  const homeLineupKnown = lineupStrength(lineups, homeId);
  const awayLineupKnown = lineupStrength(lineups, awayId);

  const homeXg = Math.max(0.15, 0.55 * homeAttack + 0.45 * awayDefense + 0.18 - homeMissing);
  const awayXg = Math.max(0.15, 0.55 * awayAttack + 0.45 * homeDefense - awayMissing);

  return {
    homeXg, awayXg,
    probabilities: matchProbabilities(homeXg, awayXg),
    sample: { homeMatches: home.matches, awayMatches: away.matches },
    availability: {
      homeMissing: countUnavailable(injuries, homeId),
      awayMissing: countUnavailable(injuries, awayId),
      lineupKnown: { home: !!homeLineupKnown, away: !!awayLineupKnown }
    }
  };
}

function devig(prices) {
  const nums = prices.map(Number).filter(x => Number.isFinite(x) && x > 1);
  const inv = nums.map(x => 1 / x), sum = inv.reduce((a,b)=>a+b,0);
  return inv.map(x => x / sum);
}

function settleMarket(market, oddsObj, scoreHome, scoreAway) {
  const h = Number(scoreHome), a = Number(scoreAway);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  if (market === "Heimsieg") return h > a ? "WIN" : "LOSS";
  if (market === "Auswärtssieg") return a > h ? "WIN" : "LOSS";
  if (market === "Doppelte Chance 1X") return h >= a ? "WIN" : "LOSS";
  if (market === "Über 1,5 Tore") return h + a > 1.5 ? "WIN" : "LOSS";
  if (market === "Über 2,5 Tore") return h + a > 2.5 ? "WIN" : "LOSS";
  if (market === "Unter 4,5 Tore") return h + a < 4.5 ? "WIN" : "LOSS";
  return null;
}

async function buildModel(homeId, awayId) {
  const [home, away] = await Promise.all([
    recentTeamStats(homeId, 8),
    recentTeamStats(awayId, 8)
  ]);
  if (!home.matches || !away.matches) throw new Error("Zu wenig historische Spieldaten");

  // Transparent baseline: recent scoring + conceding averages.
  // This is NOT a production-grade predictive model.
  const homeXg = Math.max(0.15, (home.goalsFor + away.goalsAgainst) / 2);
  const awayXg = Math.max(0.15, (away.goalsFor + home.goalsAgainst) / 2);
  return {
    homeXg, awayXg,
    probabilities: matchProbabilities(homeXg, awayXg),
    sample: { homeMatches: home.matches, awayMatches: away.matches }
  };
}

function extractBet365Markets(payload) {
  const books = payload?.bookmakers?.[ODDS_BOOKMAKER] || [];
  const out = [];
  for (const market of books) {
    const odds = market.odds || [];
    if (!odds.length) continue;
    out.push({ name: market.name, updatedAt: market.updatedAt, odds });
  }
  return out;
}

function pickOddsForMarket(markets, market) {
  const aliases = {
    "Heimsieg": ["ML", "Match Winner", "moneyline"],
    "Auswärtssieg": ["ML", "Match Winner", "moneyline"],
    "Über 1,5 Tore": ["Totals", "total goals", "Over/Under"],
    "Über 2,5 Tore": ["Totals", "total goals", "Over/Under"],
    "Unter 4,5 Tore": ["Totals", "total goals", "Over/Under"],
    "Doppelte Chance 1X": ["Double Chance", "double chance"]
  };
  const names = aliases[market] || [];
  return markets.find(m => names.some(a => m.name.toLowerCase() === a.toLowerCase()));
}

function implied(odds) { return 1 / odds; }

function analyze(v) {
  if (!v.home || !v.away || !v.market || !Number.isFinite(v.odds) || v.odds <= 1 || !Number.isFinite(v.probability)) return null;
  const p = Math.max(0.001, Math.min(0.999, v.probability));
  const imp = implied(v.odds);
  const edge = p - imp;
  const fair = 1 / p;
  const threshold = v.risk === "low" ? 0.12 : v.risk === "high" ? 0.05 : 0.08;
  const decision = edge >= threshold && p >= 0.70 ? "BET" : edge >= 0 ? "WATCH" : "NO_BET";
  return {
    ...v, probability: p, fairOdds: fair, edgePct: edge * 100, decision,
    uncertainty: p >= 0.78 ? "niedrig" : p >= 0.62 ? "mittel" : "hoch",
    createdAt: new Date().toISOString()
  };
}

app.get("/api/health", (req, res) => res.json({
  ok: true,
  mode: FOOTBALL_API_KEY && ODDS_API_KEY ? "live-ready" : "setup-required",
  footballProvider: "API-Football",
  oddsProvider: ODDS_BOOKMAKER,
  oddsSource: ODDS_API_KEY ? "configured odds provider" : "API-Football bookmaker odds where available"
}));

app.get("/api/config", (req, res) => res.json({
  footballConfigured: !!FOOTBALL_API_KEY,
  oddsConfigured: !!ODDS_API_KEY,
  bookmaker: ODDS_BOOKMAKER
}));

app.get("/api/fixtures", async (req, res) => {
  try {
    const data = await apiFootball("/fixtures", {
      date: req.query.date || new Date().toISOString().slice(0, 10),
      timezone: req.query.timezone || "Europe/Zurich",
      league: req.query.league,
      season: req.query.season
    });
    res.json(data.response || []);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.get("/api/fixture/:id", async (req, res) => {
  try {
    const data = await apiFootball("/fixtures", { id: req.params.id });
    res.json(data.response?.[0] || null);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.get("/api/team/:id/form", async (req, res) => {
  try {
    res.json(await recentTeamStats(req.params.id, 8));
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.get("/api/odds/events", async (req, res) => {
  try {
    const data = await oddsApi("/events", {
      sport: "football",
      bookmaker: ODDS_BOOKMAKER,
      league: req.query.league
    });
    res.json(data);
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.get("/api/odds/event/:id", async (req, res) => {
  try {
    const data = await oddsApi("/odds", {
      eventId: req.params.id,
      bookmakers: ODDS_BOOKMAKER
    });
    res.json(data);
  } catch (e) { res.status(503).json({ error: e.message }); }
});


app.get("/api/fixture/:id/context", async (req, res) => {
  try {
    const fixtureId = req.params.id;
    const d = await apiFootball("/fixtures", { id: fixtureId });
    const f = d.response?.[0];
    if (!f) return res.status(404).json({ error: "Spiel nicht gefunden" });
    const [injuries, lineups] = await Promise.all([
      fixtureAvailability(fixtureId),
      fixtureLineups(fixtureId)
    ]);
    res.json({
      fixtureId,
      injuries,
      lineups,
      lineupKnown: lineups.length > 0
    });
  } catch (e) { res.status(503).json({ error: e.message }); }
});

app.post("/api/backtest/settle", (req, res) => {
  const { market, odds, scoreHome, scoreAway } = req.body || {};
  const outcome = settleMarket(market, odds, scoreHome, scoreAway);
  if (!outcome) return res.status(400).json({ error: "Markt oder Ergebnis nicht unterstützt" });
  res.json({ outcome, profitUnits: outcome === "WIN" ? Number(odds) - 1 : -1 });
});

app.post("/api/backtest/summary", (req, res) => {
  const rows = Array.isArray(req.body) ? req.body : [];
  const settled = rows.filter(x => x.outcome === "WIN" || x.outcome === "LOSS");
  const wins = settled.filter(x => x.outcome === "WIN").length;
  const stake = settled.length;
  const profit = settled.reduce((a, x) => a + Number(x.profitUnits || 0), 0);
  const roi = stake ? profit / stake : 0;
  const brier = settled.filter(x => Number.isFinite(x.probability) && Number.isFinite(x.result01))
    .reduce((a,x)=>a + (x.probability-x.result01)**2,0) / Math.max(1, settled.filter(x => Number.isFinite(x.probability) && Number.isFinite(x.result01)).length);
  res.json({ bets: stake, wins, losses: stake-wins, hitRate: stake ? wins/stake : 0, profitUnits: profit, roi, brierScore: brier });
});

app.post("/api/analyze-fixture", async (req, res) => {
  try {
    const { fixtureId, market, odds, risk = "medium" } = req.body;
    if (!fixtureId || !market || !Number.isFinite(Number(odds))) {
      return res.status(400).json({ error: "fixtureId, market und odds sind erforderlich" });
    }
    const fixtureData = await apiFootball("/fixtures", { id: fixtureId });
    const f = fixtureData.response?.[0];
    if (!f) return res.status(404).json({ error: "Spiel nicht gefunden" });

    const model = await buildModel(f.teams.home.id, f.teams.away.id, fixtureId);
    const p = model.probabilities[market];
    if (!Number.isFinite(p)) return res.status(400).json({ error: "Markt wird vom Basismodell noch nicht unterstützt" });

    const result = analyze({
      home: f.teams.home.name,
      away: f.teams.away.name,
      market,
      odds: Number(odds),
      risk,
      probability: p,
      fixtureId,
      dataStatus: "LIVE – API-Football + transparentes Poisson-Basismodell",
      model: { homeXg: model.homeXg, awayXg: model.awayXg, sample: model.sample, availability: model.availability }
    });

    const h = load(); h.unshift(result); save(h.slice(0, 200));
    res.json(result);
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});


app.post("/api/scan", async (req, res) => {
  try {
    const {
      date = new Date().toISOString().slice(0, 10),
      markets = ["Über 1,5 Tore", "Über 2,5 Tore", "Unter 4,5 Tore", "Heimsieg", "Auswärtssieg", "Doppelte Chance 1X"],
      minProbability = MIN_PROBABILITY,
      minEdge = MIN_EDGE,
      odds = {}
    } = req.body || {};

    const fixtureData = await apiFootball("/fixtures", {
      date,
      timezone: req.body?.timezone || APP_TIMEZONE
    });
    const fixtures = (fixtureData.response || []).filter(f =>
      ["NS", "TBD"].includes(f.fixture?.status?.short)
    );

    const candidates = [];
    const errors = [];

    // Limit concurrency to avoid exhausting API quotas.
    const queue = fixtures.slice(0, MAX_SCAN_FIXTURES);
    for (const f of queue) {
      try {
        const model = await buildModel(f.teams.home.id, f.teams.away.id, f.fixture.id);
        for (const market of markets) {
          const p = marketProbability(model, market);
          const quote = Number(odds[String(f.fixture.id)]?.[market] ?? odds[market]?.[String(f.fixture.id)]);
          if (!Number.isFinite(p) || !Number.isFinite(quote) || quote <= 1) continue;

          const fairOdds = 1 / p;
          const edge = p - (1 / quote);
          if (p >= Number(minProbability) && edge >= Number(minEdge)) {
            candidates.push({
              fixtureId: f.fixture.id,
              kickoff: f.fixture.date,
              league: f.league?.name,
              home: f.teams.home.name,
              away: f.teams.away.name,
              market,
              odds: quote,
              probability: p,
              fairOdds,
              edgePct: edge * 100,
              decision: "BET_CANDIDATE",
              uncertainty: p >= 0.80 ? "niedrig" : p >= 0.65 ? "mittel" : "hoch",
              availability: model.availability,
              model: { homeXg: model.homeXg, awayXg: model.awayXg }
            });
          }
        }
      } catch (e) {
        errors.push({ fixtureId: f.fixture.id, error: e.message });
      }
    }

    candidates.sort((a,b) => b.edgePct - a.edgePct);
    res.json({
      date,
      scannedFixtures: queue.length,
      candidates: candidates.slice(0, 30),
      errors,
      rules: { minProbability: Number(minProbability), minEdge: Number(minEdge) },
      note: "Ein Kandidat ist kein Gewinnversprechen. Quoten müssen aktuell sein; historische Tests müssen strikt zeitgerecht erfolgen."
    });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});


async function getProviderOddsForFixture(fixtureId) {
  // Preferred route: API-Football's bookmaker odds, when Bet365 is present.
  // If the provider does not expose Bet365 for this fixture, return null rather
  // than inventing a price. A second licensed odds provider can be added here.
  try {
    const data = await apiFootball("/odds", { fixture: fixtureId });
    const books = data.response || [];
    for (const item of books) {
      for (const book of item.bookmakers || []) {
        if (String(book.name).toLowerCase() !== ODDS_BOOKMAKER.toLowerCase()) continue;
        return { source: "API-Football", bookmaker: book.name, markets: book.bets || [] };
      }
    }
  } catch {}
  return null;
}

function findMarketQuote(providerOdds, market) {
  if (!providerOdds) return null;
  const target = market.toLowerCase();
  const bets = providerOdds.markets || [];
  for (const b of bets) {
    const name = String(b.name || "").toLowerCase();
    const values = b.values || [];
    if (target === "heimsieg" && (name.includes("match winner") || name === "winner")) {
      const x = values.find(v => /home/i.test(String(v.value)));
      if (x) return Number(x.odd);
    }
    if (target === "auswärtssieg" && (name.includes("match winner") || name === "winner")) {
      const x = values.find(v => /away/i.test(String(v.value)));
      if (x) return Number(x.odd);
    }
    if (target === "über 1,5 tore" && /over\/under|goals over\/under|total/i.test(name)) {
      const x = values.find(v => /over.*1\.5/i.test(String(v.value)));
      if (x) return Number(x.odd);
    }
    if (target === "über 2,5 tore" && /over\/under|goals over\/under|total/i.test(name)) {
      const x = values.find(v => /over.*2\.5/i.test(String(v.value)));
      if (x) return Number(x.odd);
    }
    if (target === "unter 4,5 tore" && /over\/under|goals over\/under|total/i.test(name)) {
      const x = values.find(v => /under.*4\.5/i.test(String(v.value)));
      if (x) return Number(x.odd);
    }
    if (target === "doppelte chance 1x" && /double chance/i.test(name)) {
      const x = values.find(v => /^1x$/i.test(String(v.value)));
      if (x) return Number(x.odd);
    }
  }
  return null;
}

app.post("/api/scan-live", async (req, res) => {
  try {
    const date = req.body?.date || new Date().toISOString().slice(0,10);
    const markets = req.body?.markets || ["Über 1,5 Tore","Über 2,5 Tore","Unter 4,5 Tore","Heimsieg","Auswärtssieg","Doppelte Chance 1X"];
    const minProbability = Number(req.body?.minProbability ?? MIN_PROBABILITY);
    const minEdge = Number(req.body?.minEdge ?? MIN_EDGE);

    const fd = await apiFootball("/fixtures", { date, timezone: APP_TIMEZONE });
    const fixtures = (fd.response || []).filter(f => ["NS","TBD"].includes(f.fixture?.status?.short)).slice(0, MAX_SCAN_FIXTURES);
    const candidates=[], skipped=[], errors=[];

    for (const f of fixtures) {
      try {
        const model = await buildModel(f.teams.home.id, f.teams.away.id, f.fixture.id);
        const providerOdds = await getProviderOddsForFixture(f.fixture.id);
        if (!providerOdds) { skipped.push({fixtureId:f.fixture.id, reason:"Keine Bet365-Quote über den konfigurierten Datenweg"}); continue; }
        for (const market of markets) {
          const p=model.probabilities[market];
          const q=findMarketQuote(providerOdds,market);
          if (!Number.isFinite(p) || !Number.isFinite(q) || q<=1) continue;
          const edge=p-(1/q);
          if(p>=minProbability && edge>=minEdge){
            candidates.push({
              fixtureId:f.fixture.id,kickoff:f.fixture.date,league:f.league?.name,
              home:f.teams.home.name,away:f.teams.away.name,market,odds:q,
              probability:p,fairOdds:1/p,edgePct:edge*100,
              source:providerOdds.source,bookmaker:providerOdds.bookmaker,
              availability:model.availability,model:{homeXg:model.homeXg,awayXg:model.awayXg}
            });
          }
        }
      } catch(e){ errors.push({fixtureId:f.fixture.id,error:e.message}); }
    }
    candidates.sort((a,b)=>b.edgePct-a.edgePct);
    res.json({date,scannedFixtures:fixtures.length,candidates:candidates.slice(0,30),skipped,errors,
      rules:{minProbability,minEdge},generatedAt:new Date().toISOString(),
      note:"Nur aktuelle, tatsächlich gelieferte Quoten werden verwendet. Kein Preis wird erfunden."});
  } catch(e){res.status(503).json({error:e.message});}
});

app.get("/api/settings", (req,res)=>res.json({
  timezone:APP_TIMEZONE, bookmaker:ODDS_BOOKMAKER,
  minProbability:MIN_PROBABILITY,minEdge:MIN_EDGE,maxScanFixtures:MAX_SCAN_FIXTURES,
  footballConfigured:!!FOOTBALL_API_KEY, oddsConfigured:!!ODDS_API_KEY,
  mode: FOOTBALL_API_KEY ? (ODDS_API_KEY ? "live" : "football-only") : "demo/setup"
}));
app.get("/api/history", (req, res) => res.json(load()));

app.listen(PORT, () => console.log(`FootballAI API läuft auf Port ${PORT}`));
