# immich-same-age

A photo gallery that shows your children at the same chronological age, side by side.

The gallery loads at today's date and shows photos of the youngest child alongside photos of older children taken when they were the exact same age. Scrolling down moves backwards through time, keeping all children in sync at every age.

### **This is 100% vibe-coded. It is intended to run locally, not exposed to the internet.**

## How it works

Photos are grouped by **day of life (DOL)** — the number of days since each person's birth. DOL 365 for a child born in 2025 shows photos from 2026; DOL 365 for a child born in 2022 shows photos from 2023. Both appear in the same gallery row.

The gallery starts at the youngest child's current age and goes back to day 0.

## Requirements

- A running [Immich](https://immich.app) instance
- People (faces) tagged in Immich with birth dates set

## Immich API key permissions

Create the API key under **Account Settings → API Keys**. The app only reads data, so grant the minimum:

| Permission | Why |
|---|---|
| `asset.read` | Search assets by person and date |
| `asset.view` | Fetch thumbnail images |
| `person.read` | List people and their birth dates |

No write permissions are needed.

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```
IMMICH_API_URL=https://your-immich-instance
IMMICH_API_KEY=your_api_key
SAME_AGE_PERSONS=Alice,David
PORT=8080
```

`SAME_AGE_PERSONS` is a comma-separated list of person names exactly as they appear in Immich. All listed people must have a birth date set in Immich.

## Running with Docker (recommended)

```bash
docker compose up -d --build
```

The app will be available at `http://localhost:8080`. The `docker-compose.yml` picks up your `.env` file automatically.

## Running locally

```bash
npm install
npm run dev      # ts-node, hot-ish reload
# or
npm run build && npm start   # compiled
```

## Stack

- **Backend**: Node.js + Express + TypeScript
- **Frontend**: Vanilla JS, [lightGallery](https://www.lightgalleryjs.com/) v2
- **Photos**: Fetched from Immich API, proxied through the server (no API key in the browser)
