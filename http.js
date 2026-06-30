import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { CORS_HEADERS, jsonResponse } from "./lib.js";

// Resolve the bearer token to a live player (expiry checked here in the action runtime).
async function authPlayer(ctx, request) {
  const header = request.headers.get("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return { token: "", player: null };
  const session = await ctx.runQuery(internal.auth.getSessionByToken, { token });
  if (!session || session.expiresAt < Date.now()) return { token, player: null };
  const player = await ctx.runQuery(internal.auth.getPlayer, { playerId: session.playerId });
  return { token, player: player && player.active ? player : null };
}
async function body(request) {
  try { return await request.json(); } catch { return {}; }
}
const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS }));

const http = httpRouter();
function route(path, method, handler) {
  http.route({ path, method, handler });
  http.route({ path, method: "OPTIONS", handler: preflight });
}

// ---------- auth ----------
route("/claim", "POST", httpAction(async (ctx, req) => {
  const b = await body(req);
  try {
    const out = await ctx.runAction(internal.auth.claim, { name: b.name || "", password: b.password || "" });
    return jsonResponse(out);
  } catch (e) { return jsonResponse({ error: e.message }, 400); }
}));

route("/login", "POST", httpAction(async (ctx, req) => {
  const b = await body(req);
  try {
    const out = await ctx.runAction(internal.auth.login, { name: b.name || "", password: b.password || "" });
    return jsonResponse(out);
  } catch (e) { return jsonResponse({ error: e.message }, 400); }
}));

route("/logout", "POST", httpAction(async (ctx, req) => {
  const { token } = await authPlayer(ctx, req);
  if (token) await ctx.runMutation(internal.auth.deleteSession, { token });
  return jsonResponse({ ok: true });
}));

route("/change-password", "POST", httpAction(async (ctx, req) => {
  const { player } = await authPlayer(ctx, req);
  if (!player) return jsonResponse({ error: "unauthorized" }, 401);
  const b = await body(req);
  try {
    await ctx.runAction(internal.auth.changePassword, { playerId: player._id, newPassword: b.newPassword || "" });
    return jsonResponse({ ok: true });
  } catch (e) { return jsonResponse({ error: e.message }, 400); }
}));

// ---------- state ----------
route("/state", "GET", httpAction(async (ctx, req) => {
  const { player } = await authPlayer(ctx, req);
  const state = await ctx.runQuery(internal.core.buildState, { viewerId: player ? player._id : null });
  return jsonResponse({ ...state, viewer: player ? { _id: player._id, name: player.name, role: player.role } : null });
}));

route("/ledger", "POST", httpAction(async (ctx, req) => {
  const { player } = await authPlayer(ctx, req);
  if (!player) return jsonResponse({ error: "unauthorized" }, 401);
  const rows = await ctx.runQuery(internal.core.listLedger, { playerId: player._id });
  return jsonResponse({ ledger: rows });
}));

// ---------- bets ----------
route("/bet/propose", "POST", httpAction(async (ctx, req) => {
  const { player } = await authPlayer(ctx, req);
  if (!player) return jsonResponse({ error: "unauthorized" }, 401);
  const b = await body(req);
  try {
    const betId = await ctx.runMutation(internal.core.proposeBet, {
      actorId: player._id,
      matchApiId: b.matchApiId,
      opponentId: b.opponentId,
      myChoice: b.myChoice,
      amount: b.amount,
      handicapTeam: b.handicapTeam || null,
      handicapValue: b.handicapValue || 0,
    });
    return jsonResponse({ ok: true, betId });
  } catch (e) { return jsonResponse({ error: e.message }, 400); }
}));

route("/bet/sign", "POST", httpAction(async (ctx, req) => {
  const { player } = await authPlayer(ctx, req);
  if (!player) return jsonResponse({ error: "unauthorized" }, 401);
  const b = await body(req);
  try {
    await ctx.runMutation(internal.core.signBet, { actorId: player._id, betId: b.betId });
    return jsonResponse({ ok: true });
  } catch (e) { return jsonResponse({ error: e.message }, 400); }
}));

route("/bet/reject", "POST", httpAction(async (ctx, req) => {
  const { player } = await authPlayer(ctx, req);
  if (!player) return jsonResponse({ error: "unauthorized" }, 401);
  const b = await body(req);
  try {
    await ctx.runMutation(internal.core.rejectBet, { actorId: player._id, betId: b.betId });
    return jsonResponse({ ok: true });
  } catch (e) { return jsonResponse({ error: e.message }, 400); }
}));

route("/bet/cancel", "POST", httpAction(async (ctx, req) => {
  const { player } = await authPlayer(ctx, req);
  if (!player) return jsonResponse({ error: "unauthorized" }, 401);
  const b = await body(req);
  try {
    await ctx.runMutation(internal.core.cancelBet, { actorId: player._id, betId: b.betId });
    return jsonResponse({ ok: true });
  } catch (e) { return jsonResponse({ error: e.message }, 400); }
}));

// ---------- treasurer / admin ----------
async function requireAdmin(ctx, req) {
  const { player } = await authPlayer(ctx, req);
  if (!player) return { error: jsonResponse({ error: "unauthorized" }, 401) };
  if (player.role !== "admin") return { error: jsonResponse({ error: "treasurer only" }, 403) };
  return { player };
}

route("/admin/sync", "POST", httpAction(async (ctx, req) => {
  const { player, error } = await requireAdmin(ctx, req);
  if (error) return error;
  try {
    const out = await ctx.runAction(internal.football.sync, { force: true });
    return jsonResponse(out);
  } catch (e) { return jsonResponse({ error: e.message }, 502); }
}));

route("/admin/result", "POST", httpAction(async (ctx, req) => {
  const { player, error } = await requireAdmin(ctx, req);
  if (error) return error;
  const b = await body(req);
  try {
    const out = await ctx.runMutation(internal.core.setMatchResult, {
      actorId: player._id, apiId: b.apiId, homeScore: b.homeScore, awayScore: b.awayScore,
      winner: b.winner || null,
    });
    return jsonResponse(out);
  } catch (e) { return jsonResponse({ error: e.message }, 400); }
}));

route("/admin/deposit", "POST", httpAction(async (ctx, req) => {
  const { player, error } = await requireAdmin(ctx, req);
  if (error) return error;
  const b = await body(req);
  try {
    const out = await ctx.runMutation(internal.core.recordDeposit, {
      actorId: player._id, playerId: b.playerId, amount: b.amount, note: b.note || "",
    });
    return jsonResponse(out);
  } catch (e) { return jsonResponse({ error: e.message }, 400); }
}));

route("/admin/create-player", "POST", httpAction(async (ctx, req) => {
  const { error } = await requireAdmin(ctx, req);
  if (error) return error;
  const b = await body(req);
  try {
    const id = await ctx.runMutation(internal.core.createPlayerRecord, { name: b.name || "", role: b.role || "member" });
    return jsonResponse({ ok: true, playerId: id });
  } catch (e) { return jsonResponse({ error: e.message }, 400); }
}));

// One-time bootstrap, protected by a setup secret (set SETUP_SECRET in Convex env).
route("/admin/seed", "POST", httpAction(async (ctx, req) => {
  const b = await body(req);
  const secret = process.env.SETUP_SECRET;
  if (!secret || b.secret !== secret) return jsonResponse({ error: "unauthorized" }, 401);
  const names = Array.isArray(b.names) ? b.names : [];
  const out = await ctx.runMutation(internal.core.seedPlayers, { names, adminName: b.adminName || "" });
  return jsonResponse(out);
}));

export default http;
