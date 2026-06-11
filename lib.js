// Pure data-mapping helpers (no network), shared by the server and tests.

// V2 wraps payloads under different top-level keys depending on the endpoint.
export function rows(data) {
  if (!data || typeof data !== "object") return [];
  return (
    data.schedule ||
    data.search ||
    data.lookup ||
    data.list ||
    data.livescore ||
    data.results ||
    data.teams ||
    []
  );
}

// Compact an event object down to what matters for prediction.
export function compactEvent(e) {
  const hs = e.intHomeScore;
  const as = e.intAwayScore;
  const played =
    hs !== null && hs !== undefined && hs !== "" &&
    as !== null && as !== undefined && as !== "";
  return {
    date: e.dateEvent,
    kickoff: e.strTimestamp,
    home: e.strHomeTeam,
    away: e.strAwayTeam,
    homeId: e.idHomeTeam,
    awayId: e.idAwayTeam,
    score: played ? `${hs}-${as}` : null,
    status: e.strStatus || null,
    round: e.intRound || null,
    group: e.strGroup || null,
    venue: e.strVenue || null,
    league: e.strLeague || null,
    season: e.strSeason || null,
  };
}

// Summarise a team's recent results (form) from compacted events.
export function formSummary(teamId, events) {
  let w = 0, d = 0, l = 0, gf = 0, ga = 0;
  const line = [];
  for (const e of events) {
    if (e.score == null) continue;
    const [h, a] = e.score.split("-").map(Number);
    const isHome = String(e.homeId) === String(teamId);
    const my = isHome ? h : a;
    const opp = isHome ? a : h;
    gf += my; ga += opp;
    if (my > opp) { w++; line.push("W"); }
    else if (my < opp) { l++; line.push("L"); }
    else { d++; line.push("D"); }
  }
  return { played: w + d + l, w, d, l, goalsFor: gf, goalsAgainst: ga, form: line.join("") };
}
