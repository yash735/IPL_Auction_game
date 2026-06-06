# IPL Auction Game

A playable IPL auction simulator built with React + Vite.

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Data pipeline

The runtime currently uses a curated sample player pool so the game is playable right away.

The offline pipeline now exists and can be run against a local IPL match dataset clone:

```bash
python3 scripts/generate_auction_pool.py \
  --match-dir /path/to/IPL-DATASET/json/ipl_match \
  --players-out public/data/players.json \
  --meta public/data/player_meta.json \
  --auction-out public/data/auction_pool.json \
  --limit 20 \
  --no-unmatched
```

Outputs:
- `public/data/players.json` — aggregated batting / bowling stats for every player in the dataset
- `public/data/player_meta.json` — curated auction metadata
- `public/data/auction_pool.json` — merged final pool used by the game

The pipeline script lives at:

```bash
scripts/generate_auction_pool.py
```

## Project roots

- Hobby projects: `~/projects/hobby`
- Serious projects: `~/projects/serious`
