# Alpha Harness

A local research studio for the WorldQuant BRAIN platform. It runs entirely on your machine:
a Python backend (FastAPI) talks to BRAIN, and a React frontend runs in your browser.

## Requirements

- [uv](https://docs.astral.sh/uv/) (`pip install uv` works). It fetches Python 3.14 itself.
- Node.js 24 with pnpm (`corepack enable`).

## First run

```powershell
cd backend;  python -m uv sync;  cd ..
cd frontend; pnpm install;       cd ..
```

## Start

```powershell
.\start.ps1
```

This opens the backend and the frontend in two windows and then your browser. To start them
by hand instead:

```powershell
cd backend;  python -m uv run python -m alpha_harness.dev   # window 1
cd frontend; pnpm dev                                       # window 2
```

Run only one backend at a time. The data-field catalog allows a single writer, so a second
backend stops at startup and says which process has the catalog open.

## Configuration

Settings live in `.env` at the repository root, each prefixed `AH_` (see
`backend/src/alpha_harness/config.py`):

| Key | Default | Meaning |
|---|---|---|
| `AH_PORT` | `8005` | Backend port, also the frontend's proxy target |
| `AH_UI_PORT` | `5175` | Frontend dev-server port |
| `AH_DATA_DIR` | `~/.alpha-harness` | Where all data and secrets are kept |
| `AH_LOG_LEVEL` | `INFO` | Backend log level |
| `AH_DAILY_SIMULATION_ALLOWANCE` | `5000` | Shown until BRAIN reports the real figure |

BRAIN credentials never go in `.env`. Type them on the sign-in screen.

## Where your data is

Everything is in `AH_DATA_DIR`:

- `harness.db`: SQLite. Your BRAIN login, session cookies and AI keys, encrypted with
  AES-256-GCM; simulations, templates, studies and chats.
- `catalog.duckdb`: the data-field catalog synced from BRAIN.
- `key`: the encryption key for the secrets in `harness.db`. Anyone with both files can read
  them, so never share or back them up together.

To remove your saved BRAIN login, use **Forget Saved Login** in the account menu. **Sign Out**
alone keeps it, so the next start can sign in by itself. AI keys are removed on the AI screen.

## Keeping the database small

```powershell
cd backend; python -m uv run python -m alpha_harness.compact
```

Run it with the backend stopped. It moves any search-space data still stored in every trial
into one shared copy, drops copies no study uses any more, and reclaims the space on disk.
Trials written by this version are already stored that way.

## Tests

```powershell
cd backend; python -m uv run python tests/run.py
```

They use a throwaway data directory and never touch `~/.alpha-harness` or BRAIN.

## Development tasks

`lefthook run check|format|build|gate` runs the linters, type checkers and build for both
halves (see `lefthook.yml`).
