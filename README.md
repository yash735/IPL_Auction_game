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

The next step is the offline data pipeline:

1. aggregate the IPL dataset into `data/derived/players.json`
2. maintain curated player metadata in `data/derived/player_meta.json`
3. merge both into `public/data/auction_pool.json`

The merge script lives at:

```bash
scripts/generate_auction_pool.py
```

## Project roots

- Hobby projects: `~/projects/hobby`
- Serious projects: `~/projects/serious`
