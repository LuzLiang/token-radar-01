# Token Radar

Pre-token protocols ranked by implied launch value, from a sealed DefiLlama snapshot.

- `main.ts` (Node 22+) reads the snapshot, scores every pre-token protocol with the radar-2
  model in `lib/model.ts`, and writes `board.json`, `data.js`, the dashboard and the dossier.
- `dashboard/` is a static page: sortable and filterable board, a detail view for every protocol,
  and the comps table the multiples come from. It renders with no network.
- `lib/model.ts` holds the model: category-calibrated comps multiples (median FDV/TVL of traded
  protocols, shrunk toward the global median), seven-day growth, age with no token, and chain count.
  No protocol name is special-cased.
- `screenshots/` holds the board, a protocol detail view and a filtered view.

Run it with `mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>`.

[![make.fun](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/LuzLiang/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/LuzLiang/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01)
