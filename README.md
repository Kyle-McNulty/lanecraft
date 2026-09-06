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

## Data sources (all live, no API key needed)

- Builds, matchup win rates, game-length curves: OP.GG champion stats API (global ranked, all elos, current patch 16.17)
- Champion kits, cooldowns, ranges, items, icons: Riot Data Dragon (patch 16.17.1)
- Runes and stat shards: CommunityDragon

## What is real vs generated

- All stats shown are real aggregated ranked data from OP.GG. Bot-lane 2v2 win rates are the per-role matchup win rates (ADC vs ADC, support vs support); OP.GG does not publish combined 2v2 stats.
- The advice text is generated on the fly from each champion's actual kit (attack range, ability cooldowns, CC/mobility/sustain detection from ability descriptions) plus the win-rate-by-game-length data. It is specific to the two champions picked, but it is rule-based, not hand-written per matchup.

## Known limits / next steps

- Rank scope is global all-elos (what OP.GG's open API serves). An elo filter (e.g. Emerald+) would need a different data source.
- Counter matchup lists cover roughly the 55 most common opponents per lane; rare pairings fall back to "not enough data" and generic skill-matchup advice.
- Transform champions use primary-form attack range (Gnar, Jayce, Nidalee, Elise handled via overrides).
- Enemy-team itemization hints are limited to their first core build.
- Ideas for v2: elo filter, per-patch trend arrows, hand-written notes for your most-played matchups, combined-duo stats if a data source for them appears.
