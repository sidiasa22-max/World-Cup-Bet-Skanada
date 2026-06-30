// Plain helpers (not Convex functions) shared across modules.

// Never leak salt / passwordHash to clients.
export function publicPlayer(p) {
  if (!p) return null;
  return { _id: p._id, name: p.name, role: p.role, claimed: p.claimed, active: p.active };
}

// Outcome for a finished match. Returns { result: "A" | "B" | "push" } or null.
//
// Voor (handicap) rule:
//   - WITH a handicap  → settled on the 90-minute / regulation result only.
//   - WITHOUT handicap → settled on the FINAL result, incl. extra time & penalties
//                        (i.e. whoever actually advanced / won the match).
export function betOutcome(match, bet) {
  if (!match || match.status !== "Finished") return null;

  const hasVoor = !!(bet.handicapTeam && bet.handicapValue > 0);

  if (hasVoor) {
    // 90-minute score: prefer regulation score, fall back to the stored full-time score.
    let home = match.regHome != null ? match.regHome : match.homeScore;
    let away = match.regAway != null ? match.regAway : match.awayScore;
    if (home == null || away == null) return null;
    if (bet.handicapTeam === match.home) home += bet.handicapValue || 0;
    if (bet.handicapTeam === match.away) away += bet.handicapValue || 0;

    let winningTeam = null;
    if (home > away) winningTeam = match.home;
    else if (away > home) winningTeam = match.away;
    if (!winningTeam) return { result: "push" };
    if (bet.choiceA === winningTeam) return { result: "A" };
    if (bet.choiceB === winningTeam) return { result: "B" };
    return { result: "push" };
  }

  // No voor → overall winner including extra time / penalty shootout.
  let side = match.winner || null; // "HOME" | "AWAY" | "DRAW" | null
  if (!side) {
    // Fallback for matches synced before winner was captured.
    if (match.homeScore == null || match.awayScore == null) return null;
    side = match.homeScore > match.awayScore ? "HOME"
         : match.awayScore > match.homeScore ? "AWAY" : "DRAW";
  }
  if (side === "DRAW") return { result: "push" };
  const winningTeam = side === "HOME" ? match.home : match.away;
  if (bet.choiceA === winningTeam) return { result: "A" };
  if (bet.choiceB === winningTeam) return { result: "B" };
  return { result: "push" };
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}
