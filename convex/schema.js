import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Registered members. Password is claimed by each player themselves.
  players: defineTable({
    name: v.string(),
    nameLower: v.string(),
    role: v.string(),            // "admin" (treasurer) | "member"
    claimed: v.boolean(),        // has the player set their own password yet
    salt: v.string(),
    passwordHash: v.string(),
    active: v.boolean(),
  }).index("by_nameLower", ["nameLower"]),

  // Login sessions (bearer tokens).
  sessions: defineTable({
    token: v.string(),
    playerId: v.id("players"),
    expiresAt: v.number(),
  }).index("by_token", ["token"]),

  // Fixtures, synced from football-data.org.
  matches: defineTable({
    apiId: v.number(),
    home: v.string(),
    away: v.string(),
    crestHome: v.string(),
    crestAway: v.string(),
    utcDate: v.union(v.string(), v.null()),
    date: v.string(),
    stage: v.union(v.string(), v.null()),
    group: v.union(v.string(), v.null()),
    matchday: v.union(v.number(), v.null()),
    minute: v.union(v.number(), v.null()),
    homeScore: v.union(v.number(), v.null()),
    awayScore: v.union(v.number(), v.null()),
    htHome: v.union(v.number(), v.null()),
    htAway: v.union(v.number(), v.null()),
    status: v.string(),          // "Upcoming" | "Live" | "Finished"
    // Knockout-aware result fields (optional; populated on sync / manual result):
    regHome: v.optional(v.union(v.number(), v.null())),   // 90-minute / regulation score
    regAway: v.optional(v.union(v.number(), v.null())),
    winner: v.optional(v.union(v.string(), v.null())),    // "HOME" | "AWAY" | "DRAW" (incl. ET/pens)
    decidedBy: v.optional(v.union(v.string(), v.null())), // "REGULAR" | "EXTRA_TIME" | "PENALTY_SHOOTOUT"
    penHome: v.optional(v.union(v.number(), v.null())),
    penAway: v.optional(v.union(v.number(), v.null())),
  }).index("by_apiId", ["apiId"]),

  // 1-on-1 bets. Becomes binding when both players have signed.
  bets: defineTable({
    matchApiId: v.number(),
    proposerId: v.id("players"),
    playerAId: v.id("players"),
    choiceA: v.string(),
    playerBId: v.id("players"),
    choiceB: v.string(),
    amount: v.number(),
    handicapTeam: v.union(v.string(), v.null()),
    handicapValue: v.number(),
    // "awaiting_opponent" | "agreed" | "settled" | "rejected" | "cancelled"
    status: v.string(),
    outcome: v.union(v.string(), v.null()),     // "A" | "B" | "push" | null
    winnerId: v.union(v.id("players"), v.null()),
    createdAt: v.number(),
    settledAt: v.union(v.number(), v.null()),
  })
    .index("by_match", ["matchApiId"])
    .index("by_status", ["status"]),

  // Immutable agreement records — the "digital signatures".
  signatures: defineTable({
    betId: v.id("bets"),
    playerId: v.id("players"),
    role: v.string(),            // "A" | "B"
    signedAt: v.number(),
  }).index("by_bet", ["betId"]),

  // One treasury account per player.
  accounts: defineTable({
    playerId: v.id("players"),
    deposited: v.number(),       // total ever deposited
    balance: v.number(),         // current remaining
  }).index("by_player", ["playerId"]),

  // Append-only money trail.
  ledger: defineTable({
    playerId: v.id("players"),
    type: v.string(),            // "deposit" | "bet_win" | "bet_loss" | "adjustment"
    amount: v.number(),          // signed
    balanceAfter: v.number(),
    betId: v.union(v.id("bets"), v.null()),
    note: v.string(),
    at: v.number(),
    byId: v.union(v.id("players"), v.null()),
  }).index("by_player", ["playerId"]),

  // Singletons: scorers, standings, lastSync, lastStatsSync.
  meta: defineTable({
    key: v.string(),
    value: v.any(),
  }).index("by_key", ["key"]),
});
