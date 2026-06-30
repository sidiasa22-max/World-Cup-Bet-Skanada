import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";
import { publicPlayer } from "./lib.js";

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// --- crypto helpers (run inside actions only) ---
async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(`${salt}:${password}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- internal queries used by auth + http ---
export const getPlayerByName = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    return await ctx.db
      .query("players")
      .withIndex("by_nameLower", (q) => q.eq("nameLower", name.trim().toLowerCase()))
      .unique();
  },
});

export const getPlayer = internalQuery({
  args: { playerId: v.id("players") },
  handler: async (ctx, { playerId }) => ctx.db.get(playerId),
});

export const getSessionByToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    return await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
  },
});

// --- internal mutations ---
export const storeSession = internalMutation({
  args: { playerId: v.id("players"), token: v.string(), expiresAt: v.number() },
  handler: async (ctx, a) => {
    await ctx.db.insert("sessions", a);
  },
});

export const deleteSession = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const s = await ctx.db
      .query("sessions")
      .withIndex("by_token", (q) => q.eq("token", token))
      .unique();
    if (s) await ctx.db.delete(s._id);
  },
});

export const setCredentials = internalMutation({
  args: { playerId: v.id("players"), salt: v.string(), passwordHash: v.string(), claimed: v.boolean() },
  handler: async (ctx, { playerId, salt, passwordHash, claimed }) => {
    await ctx.db.patch(playerId, { salt, passwordHash, claimed });
  },
});

// --- actions (need crypto) ---

// First-time account claim: player sets their own password.
export const claim = internalAction({
  args: { name: v.string(), password: v.string() },
  handler: async (ctx, { name, password }) => {
    if (!password || password.length < 4) throw new Error("Password must be at least 4 characters.");
    const player = await ctx.runQuery(internal.auth.getPlayerByName, { name });
    if (!player) throw new Error("No player with that name. Ask the treasurer to add you.");
    if (!player.active) throw new Error("This account is disabled.");
    if (player.claimed) throw new Error("This account is already claimed. Use Log in instead.");

    const salt = randomHex(16);
    const passwordHash = await hashPassword(password, salt);
    await ctx.runMutation(internal.auth.setCredentials, { playerId: player._id, salt, passwordHash, claimed: true });

    const token = randomHex(24);
    await ctx.runMutation(internal.auth.storeSession, {
      playerId: player._id, token, expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return { token, player: publicPlayer({ ...player, claimed: true }) };
  },
});

export const login = internalAction({
  args: { name: v.string(), password: v.string() },
  handler: async (ctx, { name, password }) => {
    const player = await ctx.runQuery(internal.auth.getPlayerByName, { name });
    if (!player || !player.active) throw new Error("Invalid name or password.");
    if (!player.claimed) throw new Error("Account not claimed yet. Use Claim account to set your password.");

    const hash = await hashPassword(password, player.salt);
    if (hash !== player.passwordHash) throw new Error("Invalid name or password.");

    const token = randomHex(24);
    await ctx.runMutation(internal.auth.storeSession, {
      playerId: player._id, token, expiresAt: Date.now() + SESSION_TTL_MS,
    });
    return { token, player: publicPlayer(player) };
  },
});

export const changePassword = internalAction({
  args: { playerId: v.id("players"), newPassword: v.string() },
  handler: async (ctx, { playerId, newPassword }) => {
    if (!newPassword || newPassword.length < 4) throw new Error("Password must be at least 4 characters.");
    const salt = randomHex(16);
    const passwordHash = await hashPassword(newPassword, salt);
    await ctx.runMutation(internal.auth.setCredentials, { playerId, salt, passwordHash, claimed: true });
    return { ok: true };
  },
});
