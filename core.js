import { internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { publicPlayer, betOutcome } from "./lib.js";

const MIN_BET = 1000;
const ACTIVE_BET_STATUSES = ["awaiting_opponent", "agreed"];

// ---------- small helpers ----------
async function getMatchByApiId(ctx, apiId) {
  return await ctx.db.query("matches").withIndex("by_apiId", (q) => q.eq("apiId", apiId)).unique();
}
async function getAccount(ctx, playerId) {
  let acct = await ctx.db.query("accounts").withIndex("by_player", (q) => q.eq("playerId", playerId)).unique();
  if (!acct) {
    const id = await ctx.db.insert("accounts", { playerId, deposited: 0, balance: 0 });
    acct = await ctx.db.get(id);
  }
  return acct;
}
async function moveFunds(ctx, playerId, delta, type, betId, note, byId) {
  const acct = await getAccount(ctx, playerId);
  const balance = acct.balance + delta;
  await ctx.db.patch(acct._id, {
    balance,
    deposited: type === "deposit" ? acct.deposited + delta : acct.deposited,
  });
  await ctx.db.insert("ledger", {
    playerId, type, amount: delta, balanceAfter: balance,
    betId: betId || null, note: note || "", at: Date.now(), byId: byId || null,
  });
  return balance;
}
// Sum of amounts a player could still lose (open + agreed bets), optionally excluding one bet.
async function exposure(ctx, playerId, exceptBetId) {
  let total = 0;
  for (const status of ACTIVE_BET_STATUSES) {
    const rows = await ctx.db.query("bets").withIndex("by_status", (q) => q.eq("status", status)).collect();
    for (const b of rows) {
      if (exceptBetId && b._id === exceptBetId) continue;
      if (b.playerAId === playerId || b.playerBId === playerId) total += b.amount;
    }
  }
  return total;
}
async function availableBalance(ctx, playerId, exceptBetId) {
  const acct = await getAccount(ctx, playerId);
  return acct.balance - (await exposure(ctx, playerId, exceptBetId));
}

// Settle every agreed bet whose match is final. Idempotent.
async function settleAll(ctx) {
  const agreed = await ctx.db.query("bets").withIndex("by_status", (q) => q.eq("status", "agreed")).collect();
  let settled = 0;
  for (const bet of agreed) {
    const match = await getMatchByApiId(ctx, bet.matchApiId);
    const oc = betOutcome(match, bet);
    if (!oc) continue;
    if (oc.result === "push") {
      await ctx.db.patch(bet._id, { status: "settled", outcome: "push", winnerId: null, settledAt: Date.now() });
      settled++;
      continue;
    }
    const winnerId = oc.result === "A" ? bet.playerAId : bet.playerBId;
    const loserId = oc.result === "A" ? bet.playerBId : bet.playerAId;
    await moveFunds(ctx, winnerId, bet.amount, "bet_win", bet._id, "Bet won", null);
    await moveFunds(ctx, loserId, -bet.amount, "bet_loss", bet._id, "Bet lost", null);
    await ctx.db.patch(bet._id, { status: "settled", outcome: oc.result, winnerId, settledAt: Date.now() });
    settled++;
  }
  return settled;
}

// ---------- players ----------
export const listPlayers = internalQuery({
  args: {},
  handler: async (ctx) => (await ctx.db.query("players").collect()).map(publicPlayer),
});

export const createPlayerRecord = internalMutation({
  args: { name: v.string(), role: v.string() },
  handler: async (ctx, { name, role }) => {
    const nameLower = name.trim().toLowerCase();
    const existing = await ctx.db.query("players").withIndex("by_nameLower", (q) => q.eq("nameLower", nameLower)).unique();
    if (existing) throw new Error("A player with that name already exists.");
    const playerId = await ctx.db.insert("players", {
      name: name.trim(), nameLower, role: role === "admin" ? "admin" : "member",
      claimed: false, salt: "", passwordHash: "", active: true,
    });
    await ctx.db.insert("accounts", { playerId, deposited: 0, balance: 0 });
    return playerId;
  },
});

// Bootstrap: create all participants once, mark the treasurer as admin.
export const seedPlayers = internalMutation({
  args: { names: v.array(v.string()), adminName: v.string() },
  handler: async (ctx, { names, adminName }) => {
    let created = 0;
    const adminLower = adminName.trim().toLowerCase();
    // Always ensure the admin/treasurer exists, then add any members.
    const all = [adminName.trim(), ...names];
    const seen = new Set();
    for (const raw of all) {
      const name = (raw || "").trim();
      if (!name) continue;
      const nameLower = name.toLowerCase();
      if (seen.has(nameLower)) continue;
      seen.add(nameLower);
      const role = nameLower === adminLower ? "admin" : "member";
      const existing = await ctx.db.query("players").withIndex("by_nameLower", (q) => q.eq("nameLower", nameLower)).unique();
      if (existing) {
        if (existing.role !== role) await ctx.db.patch(existing._id, { role });
        continue;
      }
      const playerId = await ctx.db.insert("players", {
        name, nameLower, role, claimed: false, salt: "", passwordHash: "", active: true,
      });
      await ctx.db.insert("accounts", { playerId, deposited: 0, balance: 0 });
      created++;
    }
    return { created };
  },
});

// ---------- matches ----------
export const listMatches = internalQuery({
  args: {},
  handler: async (ctx) => ctx.db.query("matches").collect(),
});

export const upsertMatches = internalMutation({
  args: { incoming: v.array(v.any()) },
  handler: async (ctx, { incoming }) => {
    let added = 0, updated = 0;
    for (const m of incoming) {
      const existing = await getMatchByApiId(ctx, m.apiId);
      if (!existing) {
        await ctx.db.insert("matches", m);
        added++;
      } else {
        await ctx.db.patch(existing._id, m);
        updated++;
      }
    }
    const settled = await settleAll(ctx);
    return { added, updated, settled };
  },
});

export const setMatchResult = internalMutation({
  args: {
    actorId: v.id("players"), apiId: v.number(),
    homeScore: v.number(), awayScore: v.number(),
    winner: v.optional(v.union(v.string(), v.null())), // "HOME" | "AWAY" | null (auto)
  },
  handler: async (ctx, { actorId, apiId, homeScore, awayScore, winner }) => {
    const actor = await ctx.db.get(actorId);
    if (!actor || actor.role !== "admin") throw new Error("Treasurer only.");
    const match = await getMatchByApiId(ctx, apiId);
    if (!match) throw new Error("Match not found.");
    // Manual entry: treat the entered score as both the displayed and the 90-min basis.
    // Overall winner: use the treasurer's choice if given, else derive from the score.
    const derived = homeScore > awayScore ? "HOME" : awayScore > homeScore ? "AWAY" : "DRAW";
    const finalWinner = winner === "HOME" || winner === "AWAY" ? winner : derived;
    await ctx.db.patch(match._id, {
      homeScore, awayScore, regHome: homeScore, regAway: awayScore,
      winner: finalWinner, status: "Finished",
    });
    const settled = await settleAll(ctx);
    return { ok: true, settled };
  },
});

// ---------- bets ----------
export const proposeBet = internalMutation({
  args: {
    actorId: v.id("players"),
    matchApiId: v.number(),
    opponentId: v.id("players"),
    myChoice: v.string(),
    amount: v.number(),
    handicapTeam: v.union(v.string(), v.null()),
    handicapValue: v.number(),
  },
  handler: async (ctx, a) => {
    if (a.actorId === a.opponentId) throw new Error("You can't bet against yourself.");
    if (a.amount < MIN_BET) throw new Error(`Minimum bet is Rp ${MIN_BET.toLocaleString("id-ID")}.`);
    if (a.handicapValue < 0) throw new Error("Handicap can't be negative.");

    const opponent = await ctx.db.get(a.opponentId);
    if (!opponent || !opponent.active) throw new Error("Opponent not found.");

    const match = await getMatchByApiId(ctx, a.matchApiId);
    if (!match) throw new Error("Match not found.");
    if (match.status !== "Upcoming") throw new Error("Betting is closed — this match has already started.");

    if (a.myChoice !== match.home && a.myChoice !== match.away) throw new Error("Pick must be one of the two teams.");
    const oppChoice = a.myChoice === match.home ? match.away : match.home;
    if (a.handicapTeam && a.handicapTeam !== match.home && a.handicapTeam !== match.away) {
      throw new Error("Handicap team must be one of the two teams.");
    }

    const avail = await availableBalance(ctx, a.actorId, null);
    if (a.amount > avail) throw new Error(`Not enough available balance. You can stake up to Rp ${Math.max(0, avail).toLocaleString("id-ID")}.`);

    const betId = await ctx.db.insert("bets", {
      matchApiId: a.matchApiId,
      proposerId: a.actorId,
      playerAId: a.actorId, choiceA: a.myChoice,
      playerBId: a.opponentId, choiceB: oppChoice,
      amount: a.amount,
      handicapTeam: a.handicapTeam || null,
      handicapValue: a.handicapValue || 0,
      status: "awaiting_opponent",
      outcome: null, winnerId: null,
      createdAt: Date.now(), settledAt: null,
    });
    await ctx.db.insert("signatures", { betId, playerId: a.actorId, role: "A", signedAt: Date.now() });
    return betId;
  },
});

export const signBet = internalMutation({
  args: { actorId: v.id("players"), betId: v.id("bets") },
  handler: async (ctx, { actorId, betId }) => {
    const bet = await ctx.db.get(betId);
    if (!bet) throw new Error("Bet not found.");
    if (bet.status !== "awaiting_opponent") throw new Error("This bet is no longer open for signing.");
    if (bet.playerBId !== actorId) throw new Error("Only the named opponent can sign this bet.");

    const match = await getMatchByApiId(ctx, bet.matchApiId);
    if (!match || match.status !== "Upcoming") throw new Error("Too late — the match has already started.");

    const availB = await availableBalance(ctx, bet.playerBId, bet._id);
    if (bet.amount > availB) throw new Error("You don't have enough available balance for this bet.");
    const availA = await availableBalance(ctx, bet.playerAId, bet._id);
    if (bet.amount > availA) throw new Error("The proposer no longer has enough balance — ask them to re-propose.");

    await ctx.db.insert("signatures", { betId, playerId: actorId, role: "B", signedAt: Date.now() });
    await ctx.db.patch(betId, { status: "agreed" });
    return { ok: true };
  },
});

export const rejectBet = internalMutation({
  args: { actorId: v.id("players"), betId: v.id("bets") },
  handler: async (ctx, { actorId, betId }) => {
    const bet = await ctx.db.get(betId);
    if (!bet) throw new Error("Bet not found.");
    if (bet.status !== "awaiting_opponent") throw new Error("This bet can no longer be rejected.");
    const actor = await ctx.db.get(actorId);
    if (bet.playerBId !== actorId && actor?.role !== "admin") throw new Error("Only the opponent can reject this bet.");
    await ctx.db.patch(betId, { status: "rejected" });
    return { ok: true };
  },
});

export const cancelBet = internalMutation({
  args: { actorId: v.id("players"), betId: v.id("bets") },
  handler: async (ctx, { actorId, betId }) => {
    const bet = await ctx.db.get(betId);
    if (!bet) throw new Error("Bet not found.");
    if (bet.status !== "awaiting_opponent") throw new Error("Only un-signed bets can be cancelled.");
    const actor = await ctx.db.get(actorId);
    if (bet.proposerId !== actorId && actor?.role !== "admin") throw new Error("Only the proposer can cancel this bet.");
    await ctx.db.patch(betId, { status: "cancelled" });
    return { ok: true };
  },
});

// ---------- deposits ----------
export const recordDeposit = internalMutation({
  args: { actorId: v.id("players"), playerId: v.id("players"), amount: v.number(), note: v.string() },
  handler: async (ctx, { actorId, playerId, amount, note }) => {
    const actor = await ctx.db.get(actorId);
    if (!actor || actor.role !== "admin") throw new Error("Only the treasurer can record deposits.");
    if (amount === 0) throw new Error("Amount can't be zero.");
    const type = amount > 0 ? "deposit" : "adjustment";
    const balance = await moveFunds(ctx, playerId, amount, type, null, note || "", actorId);
    return { ok: true, balance };
  },
});

// ---------- aggregate state for the UI ----------
export const buildState = internalQuery({
  args: { viewerId: v.union(v.id("players"), v.null()) },
  handler: async (ctx, { viewerId }) => {
    const players = await ctx.db.query("players").collect();
    const nameById = Object.fromEntries(players.map((p) => [p._id, p.name]));

    const matches = await ctx.db.query("matches").collect();
    const betsRaw = await ctx.db.query("bets").collect();
    const accounts = await ctx.db.query("accounts").collect();

    const bets = [];
    for (const b of betsRaw) {
      if (b.status === "rejected" || b.status === "cancelled") continue;
      const sigs = await ctx.db.query("signatures").withIndex("by_bet", (q) => q.eq("betId", b._id)).collect();
      bets.push({
        _id: b._id,
        matchApiId: b.matchApiId,
        playerAId: b.playerAId, playerA: nameById[b.playerAId], choiceA: b.choiceA,
        playerBId: b.playerBId, playerB: nameById[b.playerBId], choiceB: b.choiceB,
        amount: b.amount, handicapTeam: b.handicapTeam, handicapValue: b.handicapValue,
        status: b.status, outcome: b.outcome,
        winnerId: b.winnerId, winner: b.winnerId ? nameById[b.winnerId] : null,
        createdAt: b.createdAt, settledAt: b.settledAt,
        signatures: sigs.map((s) => ({ role: s.role, playerId: s.playerId, name: nameById[s.playerId], signedAt: s.signedAt })),
      });
    }

    const accountsOut = accounts.map((a) => ({
      playerId: a.playerId, name: nameById[a.playerId], deposited: a.deposited, balance: a.balance,
    }));

    const getMeta = async (key) => {
      const row = await ctx.db.query("meta").withIndex("by_key", (q) => q.eq("key", key)).unique();
      return row ? row.value : null;
    };

    let inbox = [];
    let me = null;
    if (viewerId) {
      inbox = bets.filter((b) => b.status === "awaiting_opponent" && b.playerBId === viewerId).map((b) => b._id);
      me = accountsOut.find((a) => a.playerId === viewerId) || null;
    }

    return {
      players: players.map(publicPlayer),
      matches,
      bets,
      accounts: viewerId ? accountsOut : [], // balances visible to members only
      scorers: (await getMeta("scorers")) || [],
      standings: (await getMeta("standings")) || [],
      lastSync: await getMeta("lastSync"),
      inbox,
      me,
    };
  },
});

export const listLedger = internalQuery({
  args: { playerId: v.id("players") },
  handler: async (ctx, { playerId }) => {
    const rows = await ctx.db.query("ledger").withIndex("by_player", (q) => q.eq("playerId", playerId)).collect();
    return rows.sort((a, b) => b.at - a.at);
  },
});

// ---------- meta ----------
export const getMeta = internalQuery({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await ctx.db.query("meta").withIndex("by_key", (q) => q.eq("key", key)).unique();
    return row ? row.value : null;
  },
});

export const setMeta = internalMutation({
  args: { key: v.string(), value: v.any() },
  handler: async (ctx, { key, value }) => {
    const row = await ctx.db.query("meta").withIndex("by_key", (q) => q.eq("key", key)).unique();
    if (row) await ctx.db.patch(row._id, { value });
    else await ctx.db.insert("meta", { key, value });
  },
});
