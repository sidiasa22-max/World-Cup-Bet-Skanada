import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const FD_BASE = "https://api.football-data.org/v4";
const WC = "2000";
const WITA = "Asia/Makassar";
const COOLDOWN_MS = 15000;
const STATS_INTERVAL_MS = 5 * 60 * 1000;

class RateLimitError extends Error {
  constructor(reset) { super("rate limited"); this.reset = reset; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mapStatus(s) {
  if (s === "FINISHED" || s === "AWARDED") return "Finished";
  if (s === "IN_PLAY" || s === "PAUSED" || s === "SUSPENDED") return "Live";
  return "Upcoming";
}
function fmtDate(iso) {
  if (!iso) return "TBD";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: WITA, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(iso));
  } catch { return iso; }
}
async function fdGet(path) {
  const token = process.env.FOOTBALL_DATA_TOKEN || process.env.FOOTBALL_DATA_API_KEY;
  if (!token) throw new Error("Missing FOOTBALL_DATA_TOKEN environment variable");
  const res = await fetch(`${FD_BASE}${path}`, { headers: { "X-Auth-Token": token } });
  if (res.status === 429) {
    const reset = parseInt(res.headers.get("X-RequestCounter-Reset") || "60", 10);
    throw new RateLimitError(Number.isNaN(reset) ? 60 : reset);
  }
  if (!res.ok) throw new Error(`football-data ${path} -> ${res.status}`);
  return res.json();
}
function toMatch(api) {
  const score = api.score || {};
  const ft = score.fullTime || {};
  const ht = score.halfTime || {};
  const rt = score.regularTime || null;        // 90-min score when the feed provides it
  const pens = score.penalties || null;
  const status = mapStatus(api.status);
  const hasScore = status === "Finished" || status === "Live";
  const isFinished = status === "Finished";
  const mapWinner = (w) => (w === "HOME_TEAM" ? "HOME" : w === "AWAY_TEAM" ? "AWAY" : w === "DRAW" ? "DRAW" : null);
  return {
    apiId: api.id,
    home: api.homeTeam?.name, away: api.awayTeam?.name,
    crestHome: api.homeTeam?.crest || "", crestAway: api.awayTeam?.crest || "",
    utcDate: api.utcDate || null, date: fmtDate(api.utcDate),
    stage: api.stage || null, group: api.group || null,
    matchday: api.matchday ?? null, minute: api.minute ?? null,
    homeScore: hasScore ? (ft.home ?? 0) : null,
    awayScore: hasScore ? (ft.away ?? 0) : null,
    htHome: ht.home ?? null, htAway: ht.away ?? null,
    status,
    // knockout-aware fields
    regHome: hasScore ? ((rt && rt.home != null) ? rt.home : (ft.home ?? 0)) : null,
    regAway: hasScore ? ((rt && rt.away != null) ? rt.away : (ft.away ?? 0)) : null,
    winner: isFinished ? mapWinner(score.winner) : null,
    decidedBy: score.duration || null,
    penHome: pens ? (pens.home ?? null) : null,
    penAway: pens ? (pens.away ?? null) : null,
  };
}

export const sync = internalAction({
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    const now = Date.now();
    const lastSync = (await ctx.runQuery(internal.core.getMeta, { key: "lastSync" })) || 0;
    const lastSyncMs = lastSync ? Date.parse(lastSync) : 0;
    if (!force && lastSyncMs && now - lastSyncMs < COOLDOWN_MS) {
      return { cached: true, wait: Math.ceil((COOLDOWN_MS - (now - lastSyncMs)) / 1000) };
    }

    try {
      const matchData = await fdGet(`/competitions/${WC}/matches`);
      const incoming = (matchData.matches || [])
        .filter((m) => m.homeTeam?.name && m.awayTeam?.name)
        .map(toMatch);

      const lastStats = (await ctx.runQuery(internal.core.getMeta, { key: "lastStatsSync" })) || 0;
      const lastStatsMs = lastStats ? Date.parse(lastStats) : 0;
      const includeStats = !lastStatsMs || now - lastStatsMs > STATS_INTERVAL_MS;

      let scorersCount = null, standingsCount = null;
      if (includeStats) {
        try {
          await sleep(1200);
          const sd = await fdGet(`/competitions/${WC}/scorers?limit=20`);
          const scorers = (sd.scorers || []).map((s) => ({
            name: s.player?.name || "—", team: s.team?.name || "", crest: s.team?.crest || "",
            goals: s.goals ?? 0, assists: s.assists ?? null,
          }));
          await ctx.runMutation(internal.core.setMeta, { key: "scorers", value: scorers });
          scorersCount = scorers.length;
        } catch (e) { if (e instanceof RateLimitError) throw e; }
        try {
          await sleep(1200);
          const st = await fdGet(`/competitions/${WC}/standings`);
          const standings = (st.standings || []).filter((g) => g.type === "TOTAL").map((g) => ({
            group: g.group || g.stage || "",
            table: (g.table || []).map((r) => ({
              pos: r.position, team: r.team?.name || "", crest: r.team?.crest || "",
              played: r.playedGames, won: r.won, draw: r.draw, lost: r.lost, gd: r.goalDifference, pts: r.points,
            })),
          }));
          await ctx.runMutation(internal.core.setMeta, { key: "standings", value: standings });
          standingsCount = standings.length;
        } catch (e) { if (e instanceof RateLimitError) throw e; }
        await ctx.runMutation(internal.core.setMeta, { key: "lastStatsSync", value: new Date(now).toISOString() });
      }

      const res = await ctx.runMutation(internal.core.upsertMatches, { incoming });
      await ctx.runMutation(internal.core.setMeta, { key: "lastSync", value: new Date(now).toISOString() });

      return {
        ok: true, added: res.added, updated: res.updated, settled: res.settled,
        statsRefreshed: includeStats, scorers: scorersCount, standings: standingsCount,
      };
    } catch (e) {
      if (e instanceof RateLimitError) return { rateLimited: true, wait: e.reset };
      throw e;
    }
  },
});
