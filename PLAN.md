# GTFS Inspector — Consolidated Project Plan

## Problem Statement

Data Ops engineers manually verify GTFS feed updates before they hit production. The current workflow involves downloading GTFS zip files, manually diffing CSV files, and mentally mapping what changed geographically — with no visual confirmation of coverage changes.

**Pain points:**
1. Time-consuming — hours of manual checking per feed update
2. Error-prone — easy to miss a dropped route in a large CSV
3. No spatial context — you can't see *where* coverage changed
4. No audit trail — hard to document what changed and why

---

## What We're Building

A web tool with two orthogonal dimensions:

### View Modes

1. **File Explorer** — browse zip contents, preview file tables, diff rows when two feeds are loaded
2. **Map** — visualise route geometries on an interactive map; overlay both feeds with colour-coded diffs when comparing

### Feed Loading

- **Single feed** — pure inspection in both views
- **Two feeds** — comparison with diff highlighting in both views
- Feeds may be two versions of the same operator, or two completely different feeds with overlapping coverage

| | 1 feed loaded | 2 feeds loaded |
|---|---|---|
| **File Explorer** | Browse zip contents, preview tables | Side-by-side tables, highlighted diffs |
| **Map** | Visualise routes on map | Overlay both feeds; colour-code added/dropped |

---

## Core Data Model

| File | Fields needed | Purpose |
|------|--------------|---------|
| `agency.txt` | `agency_id`, `agency_name`, `agency_url`, `agency_timezone` | Filter by agency; diff agencies |
| `routes.txt` | `route_id`, `route_short_name`, `route_long_name`, `route_type` | Identify added/dropped routes |
| `shapes.txt` | `shape_id`, `shape_pt_lat`, `shape_pt_lon`, `shape_pt_sequence` | Draw route paths on map |
| `trips.txt` | `route_id`, `shape_id`, `trip_id` | Link routes → shapes; provide trip context |
| Any `.txt` | configurable | Extensible diff framework covers all files |

---

## Key Features

### Filtering

- **Agency filter**: Dropdown or multi-select to isolate by `agency_id` / `agency_name`. Applies globally across table and map.
- **Route filter**: Multi-select or search to isolate specific routes. Applies globally across table and map.
- Filters work in both single-feed and comparison modes.

### Map Interactions

- **Route info popup**: Clicking a route polyline on the map shows a popup with:
  - `agency_id`, `agency_name`
  - `route_id`, `route_short_name`, `route_long_name`, `route_type`
  - `trip_id` (the trip used to resolve the displayed shape)
  - In diff mode: diff status (added / dropped / unchanged)
- **Diff colouring**: Green = added, Red = dropped, Grey = unchanged
- **Click-to-highlight linkage**: Click a row in the table → highlight on map; click a shape on map → highlight in table

### Diff Identity

- Primary match on `route_id`
- Fallback to `route_short_name` when comparing different feeds where IDs may not align

### Non-Compliant Feed Tolerance

- Missing files (`shapes.txt`, `trips.txt`, `agency.txt`) are skipped without error
- If spatial data is unavailable, the map panel is hidden and diff is table-only
- Malformed or empty CSV files are reported as warnings, not fatal errors

### Extensible Diff Framework

Table-driven diff engine. Adding a new file to the diff (e.g. `stops.txt`, `calendar.txt`) requires only a config entry (primary key field, display name, columns to show). No new parsing or diffing code.

---

## Technical Decisions

### Stack

- **Server**: Hono on Node.js, port 3000
- **Zip parsing**: `yauzl` (streaming) — critical for large feeds (hundreds of MBs)
- **CSV parsing**: `csv-parse` streaming
- **Map**: Leaflet.js via CDN, OpenStreetMap tiles (no API key needed)
- **Styling**: Tailwind CSS via CDN + Rome2Rio brand tokens
- **Language**: Vanilla TypeScript (no framework overhead)

### Large File Handling

- Stream zip entries via `yauzl` without full extraction to disk
- Parse CSV row-by-row, not loading full file into memory
- Load `shapes.txt` lazily — only for routes in scope (selected or changed)

---

## Phased Implementation Plan

### Phase 1 — Single Feed (Both Views)

**Goal:** A working GTFS file browser and map visualiser for one feed.

- Upload a single GTFS zip file
- **File Explorer view**: list all `.txt` files in the zip, click to preview first N rows as a table
- **Map view**: routes list from `routes.txt` with name, type, ID
- Agency filter + route filter + route type filter + search by name
- Select a route → load its shapes lazily → draw polyline on Leaflet map
- Route info popup on polyline click (`agency_id`, `route_id`, `route_short_name`, `route_long_name`, `route_type`, `trip_id`)

### Phase 2 — Comparison Mode (Both Views)

**Goal:** Core QA tool — upload two feeds, instantly see what changed.

- Upload a second GTFS zip alongside the first
- Toggle between single-feed and comparison modes
- **Routes diff** (`routes.txt`): Added / Dropped / Unchanged table, colour-coded
- **Agency diff** (`agency.txt`): Added / Dropped / Changed table (field-level changes highlighted)
- Extensible diff framework — any `.txt` file can be added via config
- Map overlay for route changes: red = dropped, green = added, grey = unchanged
- Route info popup includes diff status
- Click-to-highlight linkage between table and map
- Filter by diff status (Added / Dropped / Unchanged) + agency + route filters

### Phase 3 — Polish, Export & Deployment

**Goal:** Demo-ready, shareable, branded tool.

- Rich diff report: rendered HTML with summary stats, full diff tables, embedded map — downloadable as HTML or printable as PDF
- Rome2Rio branding (colours, logo, typography)
- Loading progress indicators per file (important for large feeds)
- Graceful degradation warnings UI
- Live deployment

---

## Out of Scope (for now)

- Stop-level diffs (`stop_times.txt`) — high value but very high data volume
- Schedule/frequency comparison — complex data model
- Historical feed storage / database
- Auth / multi-user support
- Real-time feed monitoring
