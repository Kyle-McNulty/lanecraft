# LaneCraft - LoL matchup guide (v1 prototype)

A phone-friendly web app: pick your champion and your lane opponent, and it gives you

- your win rate in that exact matchup (real ranked games, current patch)
- the highest-winrate build for your champ in that lane (summoners, runes, skill order, start/core/boots/situational items)
- matchup advice: when to trade, how to manage the wave, and when you are strong vs weak

## How to open it

Easiest: open `index.html` on your Mac (double-click, it opens in your browser). Everything loads from live public APIs, no install or login needed.

On your phone (same wifi as your Mac):

```
cd /path/to/lol-matchup-guide
python3 -m http.server 8000
```

then on your phone go to `http://<your-mac-ip>:8000` (find the IP in System Settings > Wi-Fi > Details).

You can share a matchup: after searching, the URL hash holds the matchup, e.g. `index.html#/Ahri/Yasuo/mid` opens straight into that result.

## Data sources (all live, no API key needed)

- Builds, matchup win rates, game-length curves: OP.GG champion stats API (global ranked, all elos, current patch 16.17)
- Champion kits, cooldowns, ranges, items, icons: Riot Data Dragon (patch 16.17.1)
- Runes and stat shards: CommunityDragon

## What is real vs generated

- All stats shown are real aggregated ranked data from OP.GG.
- The advice text is generated on the fly from each champion's actual kit (attack range, ability cooldowns, CC/mobility/sustain detection from ability descriptions) plus the win-rate-by-game-length data. It is specific to the two champions picked, but it is rule-based, not hand-written per matchup.

## Known limits / next steps

- Rank scope is global all-elos (what OP.GG's open API serves). An elo filter (e.g. Emerald+) would need a different data source.
- Counter matchup lists cover roughly the 55 most common opponents per lane; rare pairings fall back to "not enough data" and generic skill-matchup advice.
- Transform champions use primary-form attack range (Gnar, Jayce, Nidalee, Elise handled via overrides).
- Enemy-team itemization hints are limited to their first core build.
- Ideas for v2: elo filter, role mirror for support/ADC duos, jungle matchup mode, per-patch trend arrows, hosted version (GitHub Pages / Netlify) so it is a real URL on your phone.
