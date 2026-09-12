# LaneCraft - LoL matchup guide

Live at **https://kyle-mcnulty.github.io/lanecraft/** - works on your phone, no install.

A phone-friendly web app: pick your champion and your lane opponent, and it gives you

- your win rate in that exact matchup (real ranked games, current patch)
- the highest-winrate build for your champ in that lane (summoners, runes, skill order, start/core/boots/situational items)
- matchup advice: when to trade, how to manage the wave, and when you are strong vs weak

All five lanes are supported (top, jungle, mid, ADC, support). Bot lane is a 2v2 view: pick your ADC and support plus their ADC and support, and you get both role matchup win rates, builds for both your champs, and duo advice (engage tracking, wave plan, level 2).

## How to open it

Open https://kyle-mcnulty.github.io/lanecraft/ on any browser. Everything loads from live public APIs, no install or login needed.

You can share a matchup: the URL hash holds it, e.g. `#/Ahri/Yasuo/mid` for a 1v1 or `#/bot/Jinx/Thresh/Caitlyn/Lux` for a bot 2v2.

## Architecture

- Static site on GitHub Pages (this repo's `index.html`).
- `api/advice.js` is a Vercel serverless function that generates the AI coach breakdown via OpenRouter. The OpenRouter API key lives ONLY as a Vercel environment variable (`OPENROUTER_API_KEY`) - never in this repo, never sent to the browser. CORS is locked to `https://kyle-mcnulty.github.io`.
- Advice is cached per matchup + patch (Upstash Redis, 14-day TTL; in-memory fallback) and in the browser's localStorage, so each matchup costs one LLM call per patch, not one per page view.
- Model: `anthropic/claude-sonnet-5` (override with the `OPENROUTER_MODEL` env var), with automatic fallbacks (gemini-2.5-pro, gpt-5-mini). If the proxy is unreachable, the page falls back to a built-in rules engine so advice always renders.

## Data sources (all live, no API key needed)

- Builds, matchup win rates, game-length curves: OP.GG champion stats API (global ranked, all elos, current patch 16.17)
- Champion kits, cooldowns, ranges, items, icons: Riot Data Dragon (patch 16.17.1)
- Runes and stat shards: CommunityDragon

## What is real vs generated

- All stats shown are real aggregated ranked data from OP.GG. Bot-lane 2v2 win rates are the per-role matchup win rates (ADC vs ADC, support vs support); OP.GG does not publish combined 2v2 stats.
- The advice text is written per matchup by the AI coach: the proxy sends each champion's full spell list with exact rank-1 cooldowns, mechanical flags (CC, mobility, sustain, defensive tools), attack ranges, live win rates, builds, runes, and win-rate-by-game-length curves, and the model writes the threats, level-by-level plan, trade patterns, wave plan, matchup-specific rune/item adaptations, and spike breakpoints from that data. A rule-based engine in the page covers proxy outages.

## Known limits / next steps

- Rank scope is global all-elos (what OP.GG's open API serves). An elo filter (e.g. Emerald+) would need a different data source.
- Counter matchup lists cover roughly the 55 most common opponents per lane; rare pairings fall back to "not enough data" and generic skill-matchup advice.
- Transform champions use primary-form attack range (Gnar, Jayce, Nidalee, Elise handled via overrides).
- Enemy-team itemization hints are limited to their first core build.
- Ideas for v2: elo filter, per-patch trend arrows, hand-written notes for your most-played matchups, combined-duo stats if a data source for them appears.
