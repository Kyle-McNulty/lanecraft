// LaneCraft AI advice proxy (Vercel serverless function).
// The OpenRouter key lives ONLY in Vercel environment variables (OPENROUTER_API_KEY).
// It is never written to this repo and never sent to the client.
const { createHash } = require("node:crypto");

const ALLOWED_ORIGIN = "https://kyle-mcnulty.github.io";
const PRIMARY_MODEL = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
const MODEL_FALLBACKS = ["meta-llama/llama-3.3-70b-instruct", "~google/gemini-flash-latest"];
const PROMPT_VERSION = "3";
const CACHE_TTL_SEC = 60 * 60 * 24 * 14; // 14 days, keyed by patch so it self-refreshes
const RATE_LIMIT_PER_HOUR = 40;

const memoryCache = new Map(); // best-effort within a warm instance

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

function kvReady() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}
async function kvGet(key) {
  if (!kvReady()) return memoryCache.has(key) ? memoryCache.get(key) : null;
  try {
    const r = await fetch(process.env.KV_REST_API_URL + "/get/" + encodeURIComponent(key), {
      headers: { Authorization: "Bearer " + process.env.KV_REST_API_TOKEN },
    });
    const d = await r.json();
    return d.result ? JSON.parse(d.result) : null;
  } catch (e) { return null; }
}
async function kvSet(key, val) {
  memoryCache.set(key, val);
  if (!kvReady()) return;
  try {
    await fetch(process.env.KV_REST_API_URL + "/set/" + encodeURIComponent(key) + "/" + encodeURIComponent(JSON.stringify(val)) + "/ex/" + CACHE_TTL_SEC, {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.KV_REST_API_TOKEN },
    });
  } catch (e) { /* cache loss is not fatal */ }
}
async function rateOk(ip) {
  const key = "rl:" + ip;
  if (!kvReady()) return true; // without KV, skip (single-user scale)
  try {
    const r = await fetch(process.env.KV_REST_API_URL + "/pipeline", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.KV_REST_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify([["INCR", key], ["EXPIRE", key, 3600]]),
    });
    const d = await r.json();
    const n = d && d[0] && d[0].result;
    return typeof n !== "number" || n <= RATE_LIMIT_PER_HOUR;
  } catch (e) { return true; }
}

function champBrief(c) {
  // compact, prompt-friendly champ context; keep token spend tight
  const out = {
    name: c.name, lane: c.lane, roleTags: c.tags, attackRange: c.range, resource: c.partype,
    laneWinRate: c.laneWR, laneRank: c.laneRank,
    keySpellToTrack: c.catchSpell, ultimate: c.ult,
    hasHardCC: c.ccCount, hasMobility: c.mobilityCount, hasSustain: !!c.sustainName, sustainSpell: c.sustainName,
    waveclearScore: c.pushScore,
    build: c.build, runes: c.runes, skillMax: c.skillMax,
    winRateByGameLength: c.glCurve,
  };
  Object.keys(out).forEach(k => (out[k] === undefined || out[k] === null) && delete out[k]);
  return out;
}

function buildPrompt(body) {
  const isDuo = body.mode === "duo";
  const ctx = {
    patch: body.patch,
    mode: isDuo ? "bot lane 2v2 (ADC + support vs ADC + support)" : "1v1 in " + body.lane + " lane",
    yourChampions: isDuo ? [champBrief(body.me), champBrief(body.meSup)] : [champBrief(body.me)],
    enemyChampions: isDuo ? [champBrief(body.opp), champBrief(body.oppSup)] : [champBrief(body.opp)],
    matchupWinRate: body.verdict || undefined,
    supportMatchupWinRate: isDuo ? (body.verdictSup || undefined) : undefined,
  };
  const system = "You are a Challenger-tier League of Legends lane coach writing for a ranked player on the current patch. " +
    "You know every champion's kit, cooldowns, power spikes, and wave mechanics. " +
    "Every bullet must be specific to THESE champions: name real spells, real cooldowns, real level timings, real numbers from the data provided. " +
    "Never write generic filler (\"play safe\", \"ward up\", \"farm well\") without tying it to this exact matchup. " +
    "Plain text only. No markdown, no HTML, no asterisks.";
  const user =
    "Here is the matchup data (real ranked stats from OP.GG plus kit facts from Riot Data Dragon):\n" +
    JSON.stringify(ctx) +
    "\n\nWrite the coaching breakdown for the player (they control " +
    (isDuo ? "yourChampions" : "yourChampions[0]") + "). Return ONLY a JSON object, no code fences, exactly this shape:\n" +
    '{"summary": "one sentence, the single most important gameplan for this matchup, max 25 words",' +
    '"trading": ["3 to 5 bullets: when to trade and when not to, keyed to enemy spell cooldowns and windows"],' +
    '"wave": ["2 to 3 bullets: exactly how to play the minion waves in this matchup"],' +
    '"curve": ["3 to 4 bullets: level/item timings where the matchup swings, and who wins when"]}' +
    "\nEach bullet max 40 words. Use the stats: if the win rate favors one side, say what the favored side must do to convert it and what the other side punishes.";
  return { system, user };
}

function extractJson(text) {
  if (!text) return null;
  let t = String(text).trim();
  t = t.replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a === -1 || b === -1 || b <= a) return null;
  try {
    const o = JSON.parse(t.slice(a, b + 1));
    if (!o || typeof o !== "object") return null;
    const clean = (arr, n) => Array.isArray(arr) ? arr.filter(x => typeof x === "string" && x.trim()).slice(0, n) : [];
    return {
      summary: typeof o.summary === "string" ? o.summary.trim().slice(0, 300) : "",
      trading: clean(o.trading, 5),
      wave: clean(o.wave, 3),
      curve: clean(o.curve, 4),
    };
  } catch (e) { return null; }
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  if (req.headers.origin && req.headers.origin !== ALLOWED_ORIGIN) {
    res.status(403).json({ error: "origin not allowed" }); return;
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body || typeof body !== "object") { res.status(400).json({ error: "bad json" }); return; }
  if (JSON.stringify(body).length > 30000) { res.status(413).json({ error: "payload too large" }); return; }

  const isDuo = body.mode === "duo";
  const names = [body.me && body.me.name, body.opp && body.opp.name];
  if (isDuo) names.push(body.meSup && body.meSup.name, body.oppSup && body.oppSup.name);
  if (!body.patch || !body.lane || names.some(n => !n || typeof n !== "string")) {
    res.status(400).json({ error: "missing fields" }); return;
  }
  if (!/^[A-Za-z' .-]{2,30}$/.test(names.join(""))) { res.status(400).json({ error: "bad champion names" }); return; }

  const ip = (req.headers["x-forwarded-for"] || "anon").toString().split(",")[0].trim();
  if (!(await rateOk(ip))) { res.status(429).json({ error: "rate limited" }); return; }

  const ck = "adv:v" + PROMPT_VERSION + ":" + body.patch + ":" + body.mode + ":" + body.lane + ":" +
    createHash("sha1").update(names.join("|").toLowerCase()).digest("hex").slice(0, 16);

  const hit = await kvGet(ck);
  if (hit) { res.status(200).json({ advice: hit, cached: true, model: "cache" }); return; }

  if (!process.env.OPENROUTER_API_KEY) { res.status(503).json({ error: "advice backend not configured" }); return; }

  const { system, user } = buildPrompt(body);
  const models = [PRIMARY_MODEL].concat(MODEL_FALLBACKS.filter(m => m !== PRIMARY_MODEL));
  let lastErr = "";
  for (const model of models) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + process.env.OPENROUTER_API_KEY,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://kyle-mcnulty.github.io/lanecraft/",
          "X-Title": "LaneCraft",
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          max_tokens: 1100,
          temperature: 0.4,
        }),
      });
      if (!r.ok) { lastErr = model + " -> HTTP " + r.status + " " + (await r.text()).slice(0, 150); continue; }
      const d = await r.json();
      const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      const advice = extractJson(text);
      if (!advice || (!advice.trading.length && !advice.wave.length && !advice.curve.length)) {
        lastErr = model + " -> unparseable advice"; continue;
      }
      await kvSet(ck, advice);
      res.status(200).json({ advice, cached: false, model: model });
      return;
    } catch (e) {
      lastErr = model + " -> " + String(e && e.message || e).slice(0, 120);
    }
  }
  res.status(502).json({ error: "all models failed", detail: lastErr });
};
