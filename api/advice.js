// LaneCraft AI advice proxy (Vercel serverless function).
// The OpenRouter key lives ONLY in Vercel environment variables (OPENROUTER_API_KEY).
// It is never written to this repo and never sent to the client.
const { createHash } = require("node:crypto");

const ALLOWED_ORIGIN = "https://kyle-mcnulty.github.io";
const PRIMARY_MODEL = process.env.OPENROUTER_MODEL || "google/gemini-2.5-pro";
const MODEL_FALLBACKS = ["anthropic/claude-sonnet-5", "openai/gpt-5-mini"];
const PROMPT_VERSION = "4";
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

function spellBrief(s) {
  // one ability, prompt-friendly: exact cooldowns and mechanical flags from live Data Dragon data
  const out = {
    key: s.key, name: s.name,
    cooldownRank1: s.cdRank1 || undefined,
    cooldownMaxRank: s.cdMaxRank || undefined,
    range: s.range && s.range !== "0" ? s.range : undefined,
    flags: s.flags && s.flags.length ? s.flags : undefined,
  };
  return out;
}

function champBrief(c) {
  // compact, prompt-friendly champ context; spell-level detail is what makes the advice specific
  const out = {
    name: c.name, lane: c.lane, roleTags: c.tags, attackRange: c.range, resource: c.partype,
    passive: c.passiveName,
    spells: Array.isArray(c.spells) ? c.spells.map(spellBrief) : undefined,
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
  const laneNote =
    body.lane === "jungle"
      ? "This is a jungle matchup: cover pathing (which start and which camps race to first gank), who wins the 3:15 scuttle contest and at what HP/cooldown state, invade and vertical-jungle windows, and which lanes each jungler should play through."
      : body.lane === "top"
      ? "This is top lane: cover who controls the first three waves, freeze and slow-push breakpoints, teleport advantages, and how isolated the lane is from jungle help."
      : body.lane === "mid"
      ? "This is mid lane: cover roam timings off crashed waves, who gets first move to river fights, and assassin-vs-control-mage style interplay where relevant."
      : body.lane === "support"
      ? "This is the support matchup inside a 2v2: cover bush control, engage-vs-poke-vs-enchanter triangle, level 2 all-in math, and roam windows after crashing waves."
      : body.lane === "adc"
      ? "Cover the 2v2 as a system: which duo wins the level 1-2 race, whose engage pairs with whose follow-up, and how the support matchup shapes what the ADCs are allowed to do."
      : "";
  const system =
    "You are a Challenger-tier League of Legends coach writing a matchup breakdown for a ranked player on the current patch. " +
    "You know every champion's kit, exact cooldowns, mana costs, power spikes, common rune pages, and wave mechanics. " +
    "The JSON data below is live from Riot Data Dragon and OP.GG for THIS patch: when it conflicts with your memory, the data wins. " +
    "Every bullet must be specific to THESE champions: name actual spells with their rank-1 cooldowns, actual level timings, actual win-rate numbers, actual item and rune names from the data. " +
    "Matchup-specific interactions (which spell cancels, blocks, or outranges which) are exactly what the player wants. " +
    "Never write generic filler (\"play safe\", \"ward up\", \"farm well\", \"punish mistakes\") without tying it to a named spell, cooldown, level, or wave state in this exact matchup. " +
    "Plain text only. No markdown, no HTML, no asterisks.";
  const user =
    "Here is the matchup data (real ranked stats from OP.GG plus exact kit facts from Riot Data Dragon):\n" +
    JSON.stringify(ctx) +
    "\n\nWrite the coaching breakdown for the player (they control " +
    (isDuo ? "yourChampions" : "yourChampions[0]") + "). " + laneNote +
    " Return ONLY a JSON object, no code fences, exactly this shape:\n" +
    '{"summary": "2 sentences max: the single most important gameplan for this matchup and the condition that decides who wins it",' +
    '"threats": ["3 to 4 bullets: the enemy spells that actually decide this matchup, each with its exact rank-1 cooldown from the data, what it enables, and the exact punish window in seconds when it is down"],' +
    '"levels": ["4 to 5 bullets walking through levels 1, 2, 3, and 6 explicitly: who wins each stage and why, keyed to which spells each champion has at that point"],' +
    '"trading": ["3 to 5 bullets: concrete trade patterns - which of your spells to use when, which enemy cooldown to bait first, auto-attack range math where it matters"],' +
    '"wave": ["2 to 3 bullets: exactly how to play the first three waves and the default wave state to hold, keyed to each side\'s waveclear and engage threat"],' +
    '"adapt": ["2 to 3 bullets: matchup-specific changes to the displayed runes, summoner spells, or item build - name what to swap and why (e.g. a defensive shard vs their burst, an early cloth armor, holding exhaust for their ult)"],' +
    '"curve": ["3 to 4 bullets: item and level breakpoints where the matchup swings, using the win-rate-by-game-length numbers, and what the losing side must do to flip it"]}' +
    "\nEach bullet max 45 words. Use the stats: if the win rate favors one side, say what the favored side must do to convert it and what the other side punishes. " +
    "For duo mode, threats/levels/trading cover all four champions and name who does what.";
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
      summary: typeof o.summary === "string" ? o.summary.trim().slice(0, 500) : "",
      threats: clean(o.threats, 4),
      levels: clean(o.levels, 5),
      trading: clean(o.trading, 5),
      wave: clean(o.wave, 3),
      adapt: clean(o.adapt, 3),
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
  if (!/^[A-Za-z' .-]{2,60}$/.test(names.join(""))) { res.status(400).json({ error: "bad champion names" }); return; }

  const ip = (req.headers["x-forwarded-for"] || "anon").toString().split(",")[0].trim();
  if (!(await rateOk(ip))) { res.status(429).json({ error: "rate limited" }); return; }

  const ck = "adv:v" + PROMPT_VERSION + ":" + body.patch + ":" + body.mode + ":" + body.lane + ":" +
    createHash("sha1").update(names.join("|").toLowerCase()).digest("hex").slice(0, 16);

  const hit = await kvGet(ck);
  if (hit) { res.status(200).json({ advice: hit, cached: true, model: "cache", v: PROMPT_VERSION }); return; }

  if (!process.env.OPENROUTER_API_KEY) { res.status(503).json({ error: "advice backend not configured" }); return; }

  const { system, user } = buildPrompt(body);
  const models = [PRIMARY_MODEL].concat(MODEL_FALLBACKS.filter(m => m !== PRIMARY_MODEL));
  let lastErr = "";
  for (const model of models) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(40000), // a stalled provider must not stall the function
        headers: {
          Authorization: "Bearer " + process.env.OPENROUTER_API_KEY,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://kyle-mcnulty.github.io/lanecraft/",
          "X-Title": "LaneCraft",
        },
        body: JSON.stringify({
          model: model,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          max_tokens: 2000,
          temperature: 0.3,
        }),
      });
      if (!r.ok) { lastErr = model + " -> HTTP " + r.status + " " + (await r.text()).slice(0, 150); continue; }
      const d = await r.json();
      const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      const advice = extractJson(text);
      if (!advice || (!advice.trading.length && !advice.wave.length && !advice.curve.length && !advice.threats.length)) {
        lastErr = model + " -> unparseable advice"; continue;
      }
      await kvSet(ck, advice);
      res.status(200).json({ advice, cached: false, model: model, v: PROMPT_VERSION });
      return;
    } catch (e) {
      lastErr = model + " -> " + String(e && e.message || e).slice(0, 120);
    }
  }
  res.status(502).json({ error: "all models failed", detail: lastErr });
};
