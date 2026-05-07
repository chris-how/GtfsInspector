# GTFS Inspector — System Design Document

## Overview

GTFS Inspector is a web-based tool for comparing and visualising GTFS (General Transit Feed Specification) data feeds. It enables the Data Ops team to quickly identify changes between feed versions — added routes, dropped services, field-level modifications — through both tabular and geographic views.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser (Vanilla JS + Leaflet.js)                                  │
│  ┌──────────────┐  ┌──────────────────────┐  ┌──────────────────┐  │
│  │  File        │  │  Side-by-side Diff    │  │  Leaflet Map     │  │
│  │  Explorer    │  │  (row-level aligned)  │  │  (route shapes)  │  │
│  └──────────────┘  └──────────────────────┘  └──────────────────┘  │
└────────────────────────────────┬────────────────────────────────────┘
                                 │ HTTP / JSON
┌────────────────────────────────▼────────────────────────────────────┐
│  Flask Server (Python 3.12)                                         │
│  ┌────────────┐  ┌────────────────┐  ┌──────────────────────────┐  │
│  │  Upload &   │  │  Paginated     │  │  Diff Engine             │  │
│  │  Parse      │  │  Preview       │  │  (PK-based alignment)    │  │
│  └────────────┘  └────────────────┘  └──────────────────────────┘  │
│                                                                     │
│  In-memory feed store (slot A + slot B)                             │
│  Disk persistence: %TEMP%/gtfs_inspector/feed_{A,B}.zip             │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Tech Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| **Backend** | Python 3.12 + Flask 3.1 | Lightweight, stdlib `zipfile`/`csv` handle GTFS parsing natively |
| **Production server** | Gunicorn 23 | Multi-worker WSGI server for deployment |
| **Frontend** | Vanilla JavaScript (ES6+) | Zero build step, no framework overhead |
| **Map** | Leaflet.js 1.9.4 + CartoDB Light tiles | Open-source, no API key required |
| **Fonts** | DM Sans (body) + Space Mono (display/data) | Rome2Rio brand typography |
| **Deployment** | Render.com (free tier) | Auto-deploy from GitHub, zero-config |
| **Version control** | Git + GitHub | Public repo at `chris-how/GtfsInspector` |

---

## Data Model

### Feed Storage

Each uploaded GTFS zip is stored as an in-memory structure with two available slots (`A` and `B`):

```
Feed {
  zip_path: str                              # Path to persisted zip on disk
  files: list[str]                           # All .txt filenames in the zip
  row_counts: dict[filename → int]           # Pre-counted rows per file
  agencies: list[dict]                       # Full agency.txt
  routes: list[dict]                         # Full routes.txt (with _shape_id, _trip_id attached)
  trips: list[dict]                          # Full trips.txt
  shapes_index: dict[shape_id → [(lat, lon)]]  # Coordinate sequences, sorted
}
```

### Key GTFS Relationships

```
agency.txt ──1:N──► routes.txt ──1:N──► trips.txt ──N:1──► shapes.txt
                                              │
                                              └──1:N──► stop_times.txt ──N:1──► stops.txt
```

### Shape Resolution Strategy

1. **Primary:** Parse `shapes.txt` → build `shapes_index[shape_id]`
2. **Link:** `trips.txt` → pick first trip per route → resolve `shape_id`
3. **Fallback:** If a route has no shape, synthesize geometry from `stop_times.txt` + `stops.txt` (connect stops in trip sequence order)

---

## API Design

### Upload & Feed Management

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `POST /api/upload?slot=A\|B` | Upload | Accept GTFS zip, parse into memory, persist to disk |
| `GET /api/feed/<slot>/files` | Read | List files + row counts |
| `GET /api/feed/<slot>/preview/<filename>?offset=0&limit=100` | Read | Paginated CSV preview (cap: 500 rows) |
| `GET /api/feed/<slot>/agencies` | Read | All agency records |
| `GET /api/feed/<slot>/routes?agency_id=` | Read | Routes, optionally filtered |
| `GET /api/feed/<slot>/shapes?route_ids=` | Read | Shape coordinates for given routes |
| `POST /api/feed/<slot>/clear` | Delete | Remove feed from memory |

### Diff API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/diff/routes` | Read | Route-level diff (added/dropped/unchanged) |
| `GET /api/diff/agencies` | Read | Agency diff with field-level change tracking |
| `GET /api/diff/file/<filename>?offset=0&limit=200` | Read | Generic row-level diff with PK alignment |

### Diff Algorithm

The diff engine uses **primary key alignment** to produce side-by-side comparable rows:

1. Resolve the file's primary key from `GTFS_PRIMARY_KEYS` lookup table (e.g. `routes.txt` → `["route_id"]`)
2. Index both sides by PK: `a_by_pk`, `b_by_pk`
3. Iterate union of all PKs in insertion order
4. For each key, classify:
   - **Added** — exists only in B
   - **Dropped** — exists only in A
   - **Changed** — exists in both, field values differ
   - **Unchanged** — exists in both, all fields identical
5. For "changed" rows, identify exactly which fields differ (`changed_fields`)
6. Return paginated aligned rows with status metadata

Supported GTFS primary keys:

| File | Primary Key |
|------|-------------|
| `agency.txt` | `agency_id` |
| `routes.txt` | `route_id` |
| `trips.txt` | `trip_id` |
| `stops.txt` | `stop_id` |
| `calendar.txt` | `service_id` |
| `calendar_dates.txt` | `service_id` + `date` |
| `shapes.txt` | `shape_id` + `shape_pt_sequence` |
| `stop_times.txt` | `trip_id` + `stop_sequence` (fallback: first column) |

---

## Frontend Architecture

### State Management

Single `state` object with reactive re-rendering. No virtual DOM — direct DOM manipulation via `innerHTML` and event delegation.

```javascript
state = {
  currentView: "explorer" | "map",
  feedA, feedB,               // Feed metadata + parsed data
  selectedFile,               // Currently viewed file
  selectedRoutes: Set(),      // Multi-select for map filtering
  agencyFilter,               // Selected agency_id
  routeSearch,                // Free-text route name search
  diffStatusFilter,           // "all" | "added" | "dropped" | "unchanged"
  pageSize: 100,              // Rows per page
  tableOffset, diffOffset,    // Pagination cursors
}
```

### View Modes

| Mode | Single Feed | Two Feeds |
|------|------------|-----------|
| **File Explorer** | Paginated table preview | Side-by-side diff with gutter icons, synced scrolling |
| **Map** | Route polylines (pink) | Overlay both feeds, colour-coded by diff status |

### Pagination

- **Single feed table:** Fetches 100 rows at a time via `offset`/`limit` query params
- **Diff view:** Server computes full diff, returns 200-row pages
- **CSV export:** Fetches all pages sequentially (500 rows per batch) before download

### Map Rendering

- Routes drawn as Leaflet polylines
- Colours: Pink (`#DE007B`) for Feed A, Blue (`#0B91DB`) for Feed B
- In diff mode: Green (added), Red (dropped), Grey (unchanged)
- Hover: thicken line; Click: popup with route metadata + diff status
- Fit-bounds button zooms to all visible routes

### Filtering (Global)

Filters apply across both views simultaneously:
- **Agency dropdown** — filters routes, table rows (by `agency_id` or linked `route_id`), and map shapes
- **Route search** — free-text matching on `route_short_name` / `route_long_name`
- **Diff status chips** — isolate added/dropped/unchanged routes

---

## Performance Design

### Large File Handling

| Problem | Solution |
|---------|----------|
| Feeds contain millions of rows (e.g. `stop_times.txt`: 41M rows) | **Lazy pagination** — files are never fully loaded into the frontend |
| Upload time could be slow | **Row counting only at upload** — no data stored per-file, read on demand from zip |
| Diff on large files | **Server-side pagination** — full diff computed, returned in chunks |
| DOM rendering for large tables | **100-row pages** — only visible rows in DOM at any time |
| Shape data for hundreds of routes | **On-demand loading** — shapes fetched only for filtered routes |

### Memory Strategy

- Core tables (`routes`, `agencies`, `trips`) loaded fully — typically < 50K rows each
- File previews **not** pre-loaded — read from zip per request
- Row counts computed at upload via streaming (no data retained)
- Shapes index kept in memory (required for map performance)

---

## UI Design

### Brand Tokens

- **Primary:** `#DE007B` (Rome2Rio Pink)
- **Dark:** `#1F1E1E` (Charcoal)
- **Diff palette:** Green (added), Red (dropped), Amber (changed), Grey (unchanged)
- **Typography:** DM Sans (body), Space Mono (data/display/labels)

### Layout

- Fixed topbar (52px) with logo, view toggle, feed status indicators
- Fixed sidebar (300px) with upload, filters, route/file lists
- Flexible main content area with absolute-positioned view panels
- No mobile breakpoints — desktop-first tool

### Diff View Anatomy

```
┌─────────────────────────────────────────────────────────────┐
│  Feed A (From) — routes.txt          │DIFF│  Feed B (To) — routes.txt  │
├──────────────────────────────────────┼────┼────────────────────────────┤
│  ▉ 2 added · 5 dropped · 1 changed  │    │  ▉ 2 added · 5 dropped     │
├──────────────────────────────────────┼────┼────────────────────────────┤
│  route_id  name       type           │    │  route_id  name       type │
│  R001      Line 1     3              │ ·  │  R001      Line 1     3    │  ← unchanged
│  R002      Line 2     3              │ −  │                            │  ← dropped
│                                      │ +  │  R005      Line 5     2    │  ← added
│  R003      Line 3     3              │ ≠  │  R003      Express 3  3    │  ← changed
├──────────────────────────────────────┴────┴────────────────────────────┤
│                    ‹ Prev    Page 1 of 42    Next ›                     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Deployment

### Configuration (`render.yaml`)

```yaml
services:
  - type: web
    name: gtfs-inspector
    runtime: python
    buildCommand: pip install -r requirements.txt
    startCommand: gunicorn server:app --bind 0.0.0.0:$PORT --timeout 120
    envVars:
      - key: PYTHON_VERSION
        value: "3.12"
```

### Characteristics

- **Free tier:** Spins down after 15 min inactivity, ~30s cold start
- **Timeout:** 120s (accommodates large feed parsing)
- **Disk:** Ephemeral — uploaded feeds lost on redeploy (acceptable for demo)
- **No database:** All state in-memory + temp filesystem

---

## Security Considerations

- No authentication (demo tool)
- File upload accepts only `.zip` via `accept` attribute (client-side) and validates zip structure (server-side)
- No user input rendered without HTML escaping (`esc()` utility)
- GTFS data treated as untrusted — parsed via `csv.DictReader` (no eval/exec)
- Upload size limited by Gunicorn/Render defaults (~100MB)
- Temp files stored in system temp directory with predictable names (acceptable for single-user demo)

---

## File Structure

```
GtfsInspector/
├── server.py              # Flask backend (522 lines)
├── static/
│   ├── index.html         # App shell (212 lines)
│   ├── app.js             # Client application (1076 lines)
│   └── style.css          # Styles + design tokens (812 lines)
├── requirements.txt       # flask, gunicorn
├── render.yaml            # Render.com deployment config
├── PLAN.md                # Original project plan
├── SYSTEM_DESIGN.md       # This document
└── .gitignore
```

---

## How It's Built, Deployed & Hosted

### Build Process

There is **no build step**. The application is designed for zero-toolchain simplicity:

- **Backend:** A single `server.py` file runs directly via the Python interpreter. No compilation, no transpilation, no bundling. Dependencies (`flask`, `gunicorn`) are installed via `pip install -r requirements.txt`.
- **Frontend:** Plain HTML, CSS, and JavaScript served as static files by Flask. No Webpack, no Vite, no npm. External libraries (Leaflet.js, Google Fonts) are loaded from CDNs at runtime.
- **Assets:** All frontend code lives in `static/` and is served directly. The browser loads `index.html` which references `style.css` and `app.js`.

This means any developer can clone the repo and run `python server.py` to have the full application running locally — no environment setup beyond Python 3.12+.

### Local Development

```bash
# Clone
git clone https://github.com/chris-how/GtfsInspector.git
cd GtfsInspector

# Install dependencies
pip install -r requirements.txt

# Run (with auto-reload on code changes)
python server.py
# → Server starts at http://localhost:3000
```

The Flask development server runs with `debug=True`, providing:
- Automatic restart on Python file changes
- Detailed error pages in the browser
- Request logging to stdout

Previously uploaded feeds are persisted to `%TEMP%/gtfs_inspector/` and auto-reloaded on server restart, so you don't lose state between code changes.

### Production Deployment (Render.com)

#### How It Works

Render.com is a platform-as-a-service (PaaS) that deploys directly from a GitHub repository. The deployment pipeline is:

```
GitHub push (main branch)
        │
        ▼
┌──────────────────┐
│  Render detects  │  ← Webhook on push
│  new commit      │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Build phase     │  pip install -r requirements.txt
│  (Docker-based)  │  (~30 seconds)
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Start phase     │  gunicorn server:app --bind 0.0.0.0:$PORT --timeout 120
│                  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│  Live            │  https://gtfs-inspector.onrender.com
│  (health check)  │
└──────────────────┘
```

#### Configuration

The `render.yaml` file (a "Blueprint") declaratively defines the service:

```yaml
services:
  - type: web
    name: gtfs-inspector
    runtime: python
    buildCommand: pip install -r requirements.txt
    startCommand: gunicorn server:app --bind 0.0.0.0:$PORT --timeout 120
    envVars:
      - key: PYTHON_VERSION
        value: "3.12"
```

Key parameters:
- **`type: web`** — Exposes an HTTP endpoint with a public URL
- **`runtime: python`** — Uses Render's Python buildpack (installs Python, pip)
- **`buildCommand`** — Runs once per deploy; installs Flask and Gunicorn
- **`startCommand`** — The long-running process Render keeps alive
- **`$PORT`** — Render injects the port dynamically (typically 10000)
- **`--timeout 120`** — Allows up to 2 minutes for large feed parsing requests

#### Gunicorn Configuration

In production, `gunicorn` replaces Flask's development server:
- **WSGI interface:** Gunicorn calls `server:app` (the Flask `app` object in `server.py`)
- **Workers:** Defaults to 1 on free tier (sufficient — state is per-process)
- **Concurrency:** Handles multiple requests via worker pre-fork model
- **Graceful shutdown:** Drains in-flight requests on redeploy

#### Deployment Steps (One-Time Setup)

1. Push code to `https://github.com/chris-how/GtfsInspector` (public repo)
2. Log in to [dashboard.render.com](https://dashboard.render.com) with GitHub OAuth
3. Click **New → Web Service** → select `chris-how/GtfsInspector`
4. Render auto-detects `render.yaml` and pre-fills configuration
5. Select **Free** instance type → click **Create Web Service**
6. Wait ~2 minutes for initial build and deploy

After setup, every `git push` to `main` triggers an automatic redeploy.

### Hosting Characteristics

#### Infrastructure

| Aspect | Detail |
|--------|--------|
| **Provider** | Render.com (AWS us-oregon-1 or configurable region) |
| **URL** | `https://gtfs-inspector.onrender.com` (auto-TLS) |
| **SSL** | Automatic Let's Encrypt certificate, HTTPS enforced |
| **CDN** | None (single-origin); Leaflet tiles served from CartoDB CDN |
| **DNS** | Render-managed subdomain (custom domain possible on paid tier) |

#### Free Tier Behaviour

| Behaviour | Impact |
|-----------|--------|
| **Spin-down** | Instance sleeps after 15 minutes of no inbound requests |
| **Cold start** | First request after sleep takes ~30 seconds (Python + Gunicorn boot) |
| **Ephemeral filesystem** | Uploaded feeds are lost on redeploy or sleep (acceptable for demo) |
| **750 free hours/month** | Sufficient for a single always-on service if traffic is continuous |
| **Memory** | 512 MB RAM (sufficient for typical GTFS feeds) |
| **Bandwidth** | 100 GB/month outbound |

#### Limitations & Mitigations

| Limitation | Mitigation |
|------------|-----------|
| No persistent storage | Feeds re-uploaded per session; acceptable for comparison workflow |
| Cold start latency | Users see loading state; subsequent requests are instant |
| Single worker (free) | Adequate for demo/single-user; upgrade to paid for concurrent users |
| 512 MB RAM | Pagination prevents loading entire large files into memory |
| No auth | Acceptable for internal demo; add basic auth via Render env vars if needed |

### Continuous Deployment Workflow

```
Developer machine                    GitHub                         Render
┌──────────────┐              ┌──────────────────┐          ┌──────────────┐
│  Edit code   │──git push──►│  chris-how/       │──webhook─►│  Auto-build  │
│  Run locally │              │  GtfsInspector    │          │  & deploy    │
│  Test        │              │  (main branch)    │          │  (~90 sec)   │
└──────────────┘              └──────────────────┘          └──────────────┘
```

There is no CI/CD pipeline, no test suite, no staging environment. The workflow is intentionally minimal:

1. Make changes locally, test at `http://localhost:3000`
2. `git add . && git commit -m "description" && git push`
3. Render auto-deploys within ~90 seconds
4. Live at the public URL

This simplicity is appropriate for a demo/prototype tool. For production hardening, you would add:
- Automated tests (pytest for backend, Playwright for frontend)
- Staging environment (Render preview environments)
- Health check endpoint (`/api/health`)
- Environment-based config (dev vs. production settings)
- Persistent storage (S3 or Render Disk for uploaded feeds)
