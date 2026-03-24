"""GTFS Inspector — Flask backend.

Accepts GTFS zip uploads, streams/parses CSV files inside them,
and serves JSON APIs for the frontend (file listing, table preview,
routes, agencies, shapes).
"""

from __future__ import annotations

import csv
import io
import json
import os
import tempfile
import zipfile
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder="static", static_url_path="")

# ---------------------------------------------------------------------------
# In-memory feed store  (slot "A" and slot "B")
# ---------------------------------------------------------------------------
feeds: dict[str, dict[str, Any]] = {}  # key = "A" | "B"

UPLOAD_DIR = Path(tempfile.gettempdir()) / "gtfs_inspector"
UPLOAD_DIR.mkdir(exist_ok=True)


def _auto_reload_feeds():
    """Reload feeds from disk if they exist (survives server restarts)."""
    for slot in ("A", "B"):
        path = UPLOAD_DIR / f"feed_{slot}.zip"
        if path.exists():
            try:
                feeds[slot] = _parse_feed(str(path))
                print(f"  ✓ Auto-loaded Feed {slot} from {path}")
            except Exception as e:
                print(f"  ✗ Failed to auto-load Feed {slot}: {e}")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_in_zip(zf: zipfile.ZipFile, filename: str) -> str | None:
    """Find the actual zip entry name for a GTFS filename."""
    matching = [n for n in zf.namelist() if n.endswith(filename) and not n.startswith("__MACOSX")]
    return matching[0] if matching else None


def _read_csv_from_zip(zf: zipfile.ZipFile, filename: str) -> list[dict[str, str]]:
    """Read a CSV file inside a zip, return list of row dicts."""
    entry = _find_in_zip(zf, filename)
    if not entry:
        return []
    with zf.open(entry) as f:
        text = io.TextIOWrapper(f, encoding="utf-8-sig")
        reader = csv.DictReader(text)
        return [dict(row) for row in reader]


def _read_csv_page(zf: zipfile.ZipFile, filename: str,
                   offset: int = 0, limit: int = 100
                   ) -> tuple[list[dict[str, str]], list[str]]:
    """Read a page of rows from a CSV inside a zip.

    Returns (rows, columns).  Skips *offset* rows and returns at most *limit*.
    """
    entry = _find_in_zip(zf, filename)
    if not entry:
        return [], []
    with zf.open(entry) as f:
        text = io.TextIOWrapper(f, encoding="utf-8-sig")
        reader = csv.DictReader(text)
        columns = reader.fieldnames or []
        rows: list[dict[str, str]] = []
        for i, row in enumerate(reader):
            if i < offset:
                continue
            if len(rows) >= limit:
                break
            rows.append(dict(row))
        return rows, list(columns)


def _count_csv_rows(zf: zipfile.ZipFile, filename: str) -> int:
    """Count rows in a CSV inside a zip without loading them all."""
    entry = _find_in_zip(zf, filename)
    if not entry:
        return 0
    with zf.open(entry) as f:
        text = io.TextIOWrapper(f, encoding="utf-8-sig")
        reader = csv.DictReader(text)
        count = 0
        for _ in reader:
            count += 1
        return count


def _parse_feed(zip_path: str) -> dict[str, Any]:
    """Parse a GTFS zip into an in-memory structure."""
    feed: dict[str, Any] = {
        "zip_path": zip_path,
        "files": [],
        "agencies": [],
        "routes": [],
        "trips": [],
        "shapes_index": {},  # shape_id → list of (lat, lon)
        "row_counts": {},    # filename → int
    }

    with zipfile.ZipFile(zip_path, "r") as zf:
        # List all txt files
        txt_files = sorted(
            n for n in zf.namelist()
            if n.endswith(".txt") and not n.startswith("__MACOSX")
        )
        feed["files"] = txt_files

        # Count rows per file (lightweight — no data kept in memory)
        for fname in txt_files:
            try:
                feed["row_counts"][fname] = _count_csv_rows(zf, fname)
            except Exception:
                feed["row_counts"][fname] = 0

        # Core tables
        feed["agencies"] = _read_csv_from_zip(zf, "agency.txt")
        feed["routes"] = _read_csv_from_zip(zf, "routes.txt")
        feed["trips"] = _read_csv_from_zip(zf, "trips.txt")

        # Build route → agency lookup
        agency_map = {}
        for route in feed["routes"]:
            agency_id = route.get("agency_id", "")
            if not agency_id and len(feed["agencies"]) == 1:
                agency_id = feed["agencies"][0].get("agency_id", "")
                route["agency_id"] = agency_id
            agency_map[route.get("route_id", "")] = agency_id

        # Build route → shape_id lookup (pick first trip per route)
        route_shape: dict[str, str] = {}
        route_trip: dict[str, str] = {}
        for trip in feed["trips"]:
            rid = trip.get("route_id", "")
            sid = trip.get("shape_id", "")
            tid = trip.get("trip_id", "")
            if rid and rid not in route_trip and tid:
                route_trip[rid] = tid
            if rid and sid and rid not in route_shape:
                route_shape[rid] = sid

        # Attach shape_id and trip_id to each route
        for route in feed["routes"]:
            rid = route.get("route_id", "")
            route["_shape_id"] = route_shape.get(rid, "")
            route["_trip_id"] = route_trip.get(rid, "")

        # Parse shapes.txt
        shape_rows = _read_csv_from_zip(zf, "shapes.txt")
        shapes_index: dict[str, list[tuple[float, float]]] = {}
        for row in shape_rows:
            sid = row.get("shape_id", "")
            try:
                lat = float(row.get("shape_pt_lat", 0))
                lon = float(row.get("shape_pt_lon", 0))
                seq = int(row.get("shape_pt_sequence", 0))
            except (ValueError, TypeError):
                continue
            if sid not in shapes_index:
                shapes_index[sid] = []
            shapes_index[sid].append((seq, lat, lon))

        # Sort by sequence
        for sid in shapes_index:
            shapes_index[sid].sort(key=lambda x: x[0])
            shapes_index[sid] = [(lat, lon) for _, lat, lon in shapes_index[sid]]

        feed["shapes_index"] = shapes_index

        # ---------------------------------------------------------------
        # Fallback: synthesize shapes from stop_times + stops
        # when shapes.txt is missing or routes have no shape_id
        # ---------------------------------------------------------------
        routes_needing_fallback = [
            r for r in feed["routes"]
            if not r.get("_shape_id") or r["_shape_id"] not in feed["shapes_index"]
        ]
        if routes_needing_fallback:
            # Build stop location lookup
            stops_rows = _read_csv_from_zip(zf, "stops.txt")
            stop_loc: dict[str, tuple[float, float]] = {}
            for s in stops_rows:
                try:
                    stop_loc[s["stop_id"]] = (float(s["stop_lat"]), float(s["stop_lon"]))
                except (KeyError, ValueError, TypeError):
                    continue

            if stop_loc:
                # Pick one trip_id per route that needs a fallback
                trip_ids_needed = {}
                for r in routes_needing_fallback:
                    rid = r.get("route_id", "")
                    tid = route_trip.get(rid, "")
                    if tid:
                        trip_ids_needed[tid] = rid

                # Read stop_times for those trips
                # (stream to avoid loading entire file for irrelevant trips)
                trip_stops: dict[str, list[tuple[int, str]]] = {tid: [] for tid in trip_ids_needed}
                stop_time_rows = _read_csv_from_zip(zf, "stop_times.txt")
                for row in stop_time_rows:
                    tid = row.get("trip_id", "")
                    if tid in trip_stops:
                        try:
                            seq = int(row.get("stop_sequence", 0))
                        except (ValueError, TypeError):
                            seq = 0
                        trip_stops[tid].append((seq, row.get("stop_id", "")))

                # Build synthetic shapes keyed by a pseudo shape_id
                for tid, rid in trip_ids_needed.items():
                    stops_in_order = sorted(trip_stops.get(tid, []), key=lambda x: x[0])
                    coords = []
                    for _, stop_id in stops_in_order:
                        if stop_id in stop_loc:
                            coords.append(stop_loc[stop_id])
                    if coords:
                        pseudo_sid = f"_synth_{rid}"
                        shapes_index[pseudo_sid] = coords
                        # Update the route
                        for r in feed["routes"]:
                            if r.get("route_id") == rid:
                                r["_shape_id"] = pseudo_sid
                                if not r.get("_trip_id"):
                                    r["_trip_id"] = tid
                                break

                feed["shapes_index"] = shapes_index
                print(f"  ℹ Synthesized {len([s for s in shapes_index if s.startswith('_synth_')])} shapes from stop_times")

    return feed


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    return send_from_directory("static", "index.html")


@app.route("/api/upload", methods=["POST"])
def upload_feed():
    """Upload a GTFS zip. Query param slot=A|B."""
    slot = request.args.get("slot", "A").upper()
    if slot not in ("A", "B"):
        return jsonify({"error": "slot must be A or B"}), 400

    file = request.files.get("file")
    if not file:
        return jsonify({"error": "No file uploaded"}), 400

    # Save to temp
    dest = UPLOAD_DIR / f"feed_{slot}.zip"
    file.save(str(dest))

    try:
        feed = _parse_feed(str(dest))
        feeds[slot] = feed
        return jsonify({
            "slot": slot,
            "files": feed["files"],
            "route_count": len(feed["routes"]),
            "agency_count": len(feed["agencies"]),
            "has_shapes": len(feed["shapes_index"]) > 0,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/feed/<slot>/files")
def feed_files(slot: str):
    slot = slot.upper()
    if slot not in feeds:
        return jsonify({"error": "Feed not loaded"}), 404
    return jsonify({
        "files": feeds[slot]["files"],
        "row_counts": feeds[slot].get("row_counts", {}),
    })


@app.route("/api/feed/<slot>/preview/<path:filename>")
def feed_preview(slot: str, filename: str):
    """Paginated preview of a file.  Query params: offset, limit."""
    slot = slot.upper()
    if slot not in feeds:
        return jsonify({"error": "Feed not loaded"}), 404

    offset = int(request.args.get("offset", 0))
    limit = int(request.args.get("limit", 100))
    limit = min(limit, 500)  # hard cap

    zip_path = feeds[slot]["zip_path"]
    total = feeds[slot]["row_counts"].get(filename, 0)

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            rows, columns = _read_csv_page(zf, filename, offset, limit)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    return jsonify({
        "filename": filename,
        "rows": rows,
        "columns": columns,
        "offset": offset,
        "limit": limit,
        "total": total,
    })


@app.route("/api/feed/<slot>/agencies")
def feed_agencies(slot: str):
    slot = slot.upper()
    if slot not in feeds:
        return jsonify({"error": "Feed not loaded"}), 404
    return jsonify({"agencies": feeds[slot]["agencies"]})


@app.route("/api/feed/<slot>/routes")
def feed_routes(slot: str):
    slot = slot.upper()
    if slot not in feeds:
        return jsonify({"error": "Feed not loaded"}), 404

    agency_filter = request.args.get("agency_id")
    routes = feeds[slot]["routes"]
    if agency_filter:
        routes = [r for r in routes if r.get("agency_id") == agency_filter]

    return jsonify({"routes": routes})


@app.route("/api/feed/<slot>/shapes")
def feed_shapes(slot: str):
    """Return shapes for given route_ids (comma-separated)."""
    slot = slot.upper()
    if slot not in feeds:
        return jsonify({"error": "Feed not loaded"}), 404

    route_ids = request.args.get("route_ids", "").split(",")
    route_ids = [r.strip() for r in route_ids if r.strip()]

    feed = feeds[slot]
    result: dict[str, Any] = {}
    for route in feed["routes"]:
        rid = route.get("route_id", "")
        if route_ids and rid not in route_ids:
            continue
        shape_id = route.get("_shape_id", "")
        if shape_id and shape_id in feed["shapes_index"]:
            result[rid] = {
                "shape_id": shape_id,
                "coords": feed["shapes_index"][shape_id],
            }

    return jsonify({"shapes": result})


@app.route("/api/feed/<slot>/debug")
def feed_debug(slot: str):
    """Diagnostic endpoint to check data linkage."""
    slot = slot.upper()
    if slot not in feeds:
        return jsonify({"error": "Feed not loaded"}), 404
    feed = feeds[slot]
    routes_with_shapes = [r for r in feed["routes"] if r.get("_shape_id")]
    routes_without_shapes = [r for r in feed["routes"] if not r.get("_shape_id")]
    sample_shape_ids = list(feed["shapes_index"].keys())[:5]
    sample_trip_route_ids = list(set(t.get("route_id", "") for t in feed["trips"][:20]))
    sample_route_ids = [r.get("route_id", "") for r in feed["routes"][:5]]
    return jsonify({
        "total_routes": len(feed["routes"]),
        "routes_with_shapes": len(routes_with_shapes),
        "routes_without_shapes": len(routes_without_shapes),
        "total_shapes": len(feed["shapes_index"]),
        "total_trips": len(feed["trips"]),
        "sample_shape_ids": sample_shape_ids,
        "sample_trip_route_ids": sample_trip_route_ids,
        "sample_route_ids": sample_route_ids,
        "sample_routes_with_shapes": [{"route_id": r.get("route_id"), "_shape_id": r.get("_shape_id")} for r in routes_with_shapes[:3]],
        "sample_routes_without_shapes": [{"route_id": r.get("route_id"), "_shape_id": r.get("_shape_id")} for r in routes_without_shapes[:3]],
    })


@app.route("/api/feed/<slot>/clear", methods=["POST"])
def clear_feed(slot: str):
    slot = slot.upper()
    if slot in feeds:
        del feeds[slot]
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Diff API
# ---------------------------------------------------------------------------

@app.route("/api/diff/routes")
def diff_routes():
    """Compare routes between feed A and feed B."""
    if "A" not in feeds or "B" not in feeds:
        return jsonify({"error": "Both feeds must be loaded"}), 400

    a_routes = {r.get("route_id", ""): r for r in feeds["A"]["routes"]}
    b_routes = {r.get("route_id", ""): r for r in feeds["B"]["routes"]}

    all_ids = sorted(set(a_routes.keys()) | set(b_routes.keys()))

    diff_result = []
    for rid in all_ids:
        in_a = rid in a_routes
        in_b = rid in b_routes
        if in_a and in_b:
            status = "unchanged"
            route_data = b_routes[rid]
        elif in_a and not in_b:
            status = "dropped"
            route_data = a_routes[rid]
        else:
            status = "added"
            route_data = b_routes[rid]

        diff_result.append({
            **route_data,
            "_diff_status": status,
        })

    return jsonify({"diff": diff_result})


@app.route("/api/diff/agencies")
def diff_agencies():
    """Compare agencies between feed A and feed B."""
    if "A" not in feeds or "B" not in feeds:
        return jsonify({"error": "Both feeds must be loaded"}), 400

    a_agencies = {a.get("agency_id", a.get("agency_name", "")): a for a in feeds["A"]["agencies"]}
    b_agencies = {a.get("agency_id", a.get("agency_name", "")): a for a in feeds["B"]["agencies"]}

    all_ids = sorted(set(a_agencies.keys()) | set(b_agencies.keys()))

    diff_result = []
    for aid in all_ids:
        in_a = aid in a_agencies
        in_b = aid in b_agencies
        if in_a and in_b:
            a_data = a_agencies[aid]
            b_data = b_agencies[aid]
            changed_fields = [k for k in a_data if a_data.get(k) != b_data.get(k)]
            status = "changed" if changed_fields else "unchanged"
            diff_result.append({**b_data, "_diff_status": status, "_changed_fields": changed_fields})
        elif in_a:
            diff_result.append({**a_agencies[aid], "_diff_status": "dropped", "_changed_fields": []})
        else:
            diff_result.append({**b_agencies[aid], "_diff_status": "added", "_changed_fields": []})

    return jsonify({"diff": diff_result})


# Well-known primary keys for GTFS files
GTFS_PRIMARY_KEYS: dict[str, list[str]] = {
    "agency.txt": ["agency_id"],
    "routes.txt": ["route_id"],
    "trips.txt": ["trip_id"],
    "stops.txt": ["stop_id"],
    "calendar.txt": ["service_id"],
    "calendar_dates.txt": ["service_id", "date"],
    "fare_attributes.txt": ["fare_id"],
    "fare_rules.txt": ["fare_id", "route_id"],
    "shapes.txt": ["shape_id", "shape_pt_sequence"],
    "feed_info.txt": ["feed_publisher_name"],
    "transfers.txt": ["from_stop_id", "to_stop_id"],
    "frequencies.txt": ["trip_id", "start_time"],
}


@app.route("/api/diff/file/<path:filename>")
def diff_file(filename: str):
    """Row-level diff of a specific file between feed A and feed B.

    Returns aligned rows for side-by-side display.
    """
    if "A" not in feeds or "B" not in feeds:
        return jsonify({"error": "Both feeds must be loaded"}), 400

    # Read full files lazily from zip (not from pre-loaded previews)
    try:
        with zipfile.ZipFile(feeds["A"]["zip_path"], "r") as zf:
            rows_a = _read_csv_from_zip(zf, filename)
    except Exception:
        rows_a = []
    try:
        with zipfile.ZipFile(feeds["B"]["zip_path"], "r") as zf:
            rows_b = _read_csv_from_zip(zf, filename)
    except Exception:
        rows_b = []

    # Determine primary key
    base_name = filename.split("/")[-1]
    pk_fields = GTFS_PRIMARY_KEYS.get(base_name, [])

    # If no known PK, try first column
    if not pk_fields and rows_a:
        pk_fields = [list(rows_a[0].keys())[0]]
    elif not pk_fields and rows_b:
        pk_fields = [list(rows_b[0].keys())[0]]

    def pk(row: dict) -> str:
        return "|".join(row.get(f, "") for f in pk_fields)

    # Index both sides
    a_by_pk: dict[str, dict] = {}
    for r in rows_a:
        a_by_pk[pk(r)] = r
    b_by_pk: dict[str, dict] = {}
    for r in rows_b:
        b_by_pk[pk(r)] = r

    all_keys_ordered = list(dict.fromkeys(list(a_by_pk.keys()) + list(b_by_pk.keys())))

    # Determine columns (union of both)
    all_cols: list[str] = []
    seen_cols: set[str] = set()
    for r in rows_a + rows_b:
        for c in r:
            if c not in seen_cols:
                all_cols.append(c)
                seen_cols.add(c)

    aligned: list[dict] = []
    counts = {"added": 0, "dropped": 0, "changed": 0, "unchanged": 0}

    for key in all_keys_ordered:
        in_a = key in a_by_pk
        in_b = key in b_by_pk
        if in_a and in_b:
            # Check for field-level changes
            ra = a_by_pk[key]
            rb = b_by_pk[key]
            changed_fields = [c for c in all_cols if ra.get(c, "") != rb.get(c, "")]
            status = "changed" if changed_fields else "unchanged"
            counts[status] += 1
            aligned.append({
                "status": status,
                "a": {c: ra.get(c, "") for c in all_cols},
                "b": {c: rb.get(c, "") for c in all_cols},
                "changed_fields": changed_fields,
            })
        elif in_a:
            counts["dropped"] += 1
            ra = a_by_pk[key]
            aligned.append({
                "status": "dropped",
                "a": {c: ra.get(c, "") for c in all_cols},
                "b": None,
                "changed_fields": [],
            })
        else:
            counts["added"] += 1
            rb = b_by_pk[key]
            aligned.append({
                "status": "added",
                "a": None,
                "b": {c: rb.get(c, "") for c in all_cols},
                "changed_fields": [],
            })

    # Pagination for diff results
    total_aligned = len(aligned)
    diff_offset = int(request.args.get("offset", 0))
    diff_limit = int(request.args.get("limit", 200))
    diff_limit = min(diff_limit, 500)
    page = aligned[diff_offset:diff_offset + diff_limit]

    return jsonify({
        "filename": filename,
        "columns": all_cols,
        "pk_fields": pk_fields,
        "rows": page,
        "counts": counts,
        "total_a": len(rows_a),
        "total_b": len(rows_b),
        "total_aligned": total_aligned,
        "offset": diff_offset,
        "limit": diff_limit,
    })

if __name__ == "__main__":
    _auto_reload_feeds()
    print("GTFS Inspector running at http://localhost:3000")
    app.run(host="0.0.0.0", port=3000, debug=True)
