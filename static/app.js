/* ============================================================
   GTFS Inspector — Client Application
   ============================================================ */

(function () {
  "use strict";

  // -----------------------------------------------------------
  // State
  // -----------------------------------------------------------
  const state = {
    currentView: "explorer",  // "explorer" | "map"
    feedA: null,               // { files, routes, agencies, ... }
    feedB: null,
    selectedFile: null,
    selectedRoutes: new Set(),
    agencyFilter: "",
    routeSearch: "",
    diffStatusFilter: "all",
    // Pagination
    pageSize: 100,
    tableOffset: 0,
    tableTotal: 0,
    diffOffset: 0,
    diffTotalAligned: 0,
  };

  let map = null;
  let mapLayers = L.layerGroup();

  // -----------------------------------------------------------
  // DOM refs
  // -----------------------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    emptyState: $("#emptyState"),
    explorerView: $("#explorerView"),
    mapView: $("#mapView"),
    sidebar: $("#sidebar"),
    filtersSection: $("#filtersSection"),
    routeListSection: $("#routeListSection"),
    fileListSection: $("#fileListSection"),
    agencyFilter: $("#agencyFilter"),
    routeSearch: $("#routeSearch"),
    routeList: $("#routeList"),
    routeCount: $("#routeCount"),
    fileList: $("#fileList"),
    tableContainer: $("#tableContainer"),
    tableTitle: $("#tableTitle"),
    tableRowCount: $("#tableRowCount"),
    tableHead: $("#dataTableHead"),
    tableBody: $("#dataTableBody"),
    diffContainer: $("#diffContainer"),
    diffTitleA: $("#diffTitleA"),
    diffTitleB: $("#diffTitleB"),
    diffMetaA: $("#diffMetaA"),
    diffMetaB: $("#diffMetaB"),
    diffHeadA: $("#diffHeadA"),
    diffHeadB: $("#diffHeadB"),
    diffBodyA: $("#diffBodyA"),
    diffBodyB: $("#diffBodyB"),
    diffGutter: $("#diffGutter"),
    diffScrollA: $("#diffScrollA"),
    diffScrollB: $("#diffScrollB"),
    diffSummary: $("#diffSummary"),
    diffSummaryB: $("#diffSummaryB"),
    uploadProgress: $("#uploadProgress"),
    progressFill: $(".progress-fill"),
    progressText: $(".progress-text"),
    feedStatusA: $("#feedStatusA"),
    feedStatusB: $("#feedStatusB"),
    diffFilterGroup: $("#diffFilterGroup"),
    mapLegend: $("#mapLegend"),
  };

  // -----------------------------------------------------------
  // Agency-based row filtering helpers
  // -----------------------------------------------------------
  function getAgencyRouteIds(feed) {
    if (!feed?.routes || !state.agencyFilter) return null;
    return new Set(
      feed.routes
        .filter((r) => r.agency_id === state.agencyFilter)
        .map((r) => r.route_id)
    );
  }

  function filterRowsByAgency(rows, feed) {
    if (!state.agencyFilter || !rows.length) return rows;
    const cols = Object.keys(rows[0]);
    if (cols.includes("agency_id")) {
      return rows.filter((r) => r.agency_id === state.agencyFilter);
    }
    if (cols.includes("route_id")) {
      const ids = getAgencyRouteIds(feed);
      if (ids) return rows.filter((r) => ids.has(r.route_id));
    }
    return rows; // no linkable column — show all
  }

  function filterDiffRowsByAgency(alignedRows, columns) {
    if (!state.agencyFilter || !alignedRows.length) return alignedRows;
    const hasAgency = columns.includes("agency_id");
    const hasRoute = columns.includes("route_id");
    if (!hasAgency && !hasRoute) return alignedRows;

    const idsA = getAgencyRouteIds(state.feedA);
    const idsB = getAgencyRouteIds(state.feedB);

    return alignedRows.filter((row) => {
      if (hasAgency) {
        const aMatch = row.a && row.a.agency_id === state.agencyFilter;
        const bMatch = row.b && row.b.agency_id === state.agencyFilter;
        return aMatch || bMatch;
      }
      // route_id path
      const aMatch = row.a && idsA && idsA.has(row.a.route_id);
      const bMatch = row.b && idsB && idsB.has(row.b.route_id);
      return aMatch || bMatch;
    });
  }

  // -----------------------------------------------------------
  // API helpers
  // -----------------------------------------------------------
  async function api(url, opts = {}) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || "API error");
    }
    return res.json();
  }

  async function uploadFeed(file, slot) {
    const form = new FormData();
    form.append("file", file);
    try {
      return await api(`/api/upload?slot=${slot}`, { method: "POST", body: form });
    } catch (e) {
      hideProgress();
      alert("Upload failed: " + e.message);
      return null;
    }
  }

  function showProgress(text, pct) {
    dom.uploadProgress.style.display = "block";
    dom.uploadProgress.classList.remove("done");
    dom.progressFill.style.width = (pct || 0) + "%";
    dom.progressText.textContent = text;
  }
  function completeProgress() {
    dom.progressFill.style.width = "100%";
    dom.progressText.textContent = "Ready ✓";
    dom.uploadProgress.classList.add("done");
    setTimeout(() => {
      dom.uploadProgress.style.display = "none";
      dom.uploadProgress.classList.remove("done");
      dom.progressFill.style.width = "0%";
    }, 1500);
  }
  function hideProgress() {
    dom.uploadProgress.style.display = "none";
    dom.progressFill.style.width = "0%";
  }

  // -----------------------------------------------------------
  // Upload handlers
  // -----------------------------------------------------------
  async function handleUpload(file, slot) {
    const key = slot === "A" ? "feedA" : "feedB";
    showProgress(`Uploading ${file.name}…`, 15);
    const data = await uploadFeed(file, slot);
    if (!data) return;

    state[key] = data;
    state[key]._name = file.name;
    updateFeedStatus(slot, file.name);

    showProgress("Loading file list…", 45);
    const filesData = await api(`/api/feed/${slot}/files`);
    state[key].files = filesData.files;
    state[key].row_counts = filesData.row_counts || {};

    showProgress("Loading agencies & routes…", 70);
    const [agenciesData, routesData] = await Promise.all([
      api(`/api/feed/${slot}/agencies`),
      api(`/api/feed/${slot}/routes`),
    ]);
    state[key].agencies = agenciesData.agencies;
    state[key].routes = routesData.routes;

    completeProgress();
    onFeedChanged();
  }

  function setupUploads() {
    const inputA = document.querySelector('#uploadBtnA input');
    const inputB = document.querySelector('#uploadBtnB input');

    inputA.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await handleUpload(file, "A");
      e.target.value = "";
    });

    inputB.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      await handleUpload(file, "B");
      e.target.value = "";
    });

    // Clear buttons
    $("#clearBtnA").addEventListener("click", async () => {
      await api("/api/feed/A/clear", { method: "POST" });
      state.feedA = null;
      updateFeedStatus("A", null);
      onFeedChanged();
    });
    $("#clearBtnB").addEventListener("click", async () => {
      await api("/api/feed/B/clear", { method: "POST" });
      state.feedB = null;
      updateFeedStatus("B", null);
      onFeedChanged();
    });
  }

  function updateFeedStatus(slot, name) {
    const statusEl = slot === "A" ? dom.feedStatusA : dom.feedStatusB;
    const dot = statusEl.querySelector(".feed-dot");
    const label = statusEl.querySelector(".feed-label");
    const clearBtn = $(`#clearBtn${slot}`);
    const uploadBtn = $(`#uploadBtn${slot}`);
    const uploadText = $(`#uploadText${slot}`);
    const shortName = name ? name.replace(/\.zip$/i, "") : null;

    if (name) {
      dot.className = `feed-dot dot-${slot.toLowerCase()}`;
      label.textContent = shortName;
      statusEl.classList.add("loaded");
      clearBtn.style.display = "block";
      uploadBtn.classList.add("loaded");
      uploadText.textContent = shortName;
      uploadText.title = shortName;
    } else {
      dot.className = "feed-dot dot-empty";
      label.textContent = `Feed ${slot}`;
      statusEl.classList.remove("loaded");
      clearBtn.style.display = "none";
      uploadBtn.classList.remove("loaded");
      uploadText.textContent = `Feed ${slot}`;
      uploadText.title = "";
    }
  }

  async function loadFeedDetails(slot) {
    // Used only for auto-reload path; upload path uses handleUpload
    const key = slot === "A" ? "feedA" : "feedB";
    const [filesData, agenciesData, routesData] = await Promise.all([
      api(`/api/feed/${slot}/files`),
      api(`/api/feed/${slot}/agencies`),
      api(`/api/feed/${slot}/routes`),
    ]);
    state[key].files = filesData.files;
    state[key].row_counts = filesData.row_counts || {};
    state[key].agencies = agenciesData.agencies;
    state[key].routes = routesData.routes;
  }

  // -----------------------------------------------------------
  // View switching
  // -----------------------------------------------------------
  function setupViewToggle() {
    $$(".view-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        if (view === state.currentView) return;
        state.currentView = view;
        $$(".view-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        renderCurrentView();
      });
    });
  }

  function renderCurrentView() {
    const hasFeed = state.feedA || state.feedB;

    dom.emptyState.style.display = hasFeed ? "none" : "flex";
    dom.explorerView.style.display = hasFeed && state.currentView === "explorer" ? "flex" : "none";
    dom.mapView.style.display = hasFeed && state.currentView === "map" ? "flex" : "none";

    // Sidebar sections
    dom.fileListSection.style.display = hasFeed && state.currentView === "explorer" ? "block" : "none";
    dom.routeListSection.style.display = hasFeed && state.currentView === "map" ? "block" : "none";
    dom.filtersSection.style.display = hasFeed ? "block" : "none";

    if (state.currentView === "map") {
      initMap();
      renderMapRoutes();
    }
    if (state.currentView === "explorer") {
      renderFileList();
    }
    renderRouteList();
    renderAgencyFilter();
  }

  // -----------------------------------------------------------
  // Feed changed → rebuild UI
  // -----------------------------------------------------------
  function onFeedChanged() {
    const isDiff = state.feedA && state.feedB;
    dom.diffFilterGroup.style.display = isDiff ? "block" : "none";

    // Show / hide diff legend items
    $$(".legend-diff").forEach((el) => el.style.display = isDiff ? "flex" : "none");

    state.selectedFile = null;
    state.selectedRoutes.clear();

    renderCurrentView();
  }

  // -----------------------------------------------------------
  // Filters
  // -----------------------------------------------------------
  function setupFilters() {
    dom.agencyFilter.addEventListener("change", () => {
      state.agencyFilter = dom.agencyFilter.value;
      renderRouteList();
      renderMapRoutes();
      if (state.selectedFile) {
        if (state.feedA && state.feedB) {
          renderDiffTable(state.selectedFile);
        } else {
          renderTable(state.selectedFile);
        }
      }
    });

    dom.routeSearch.addEventListener("input", () => {
      state.routeSearch = dom.routeSearch.value.toLowerCase();
      renderRouteList();
    });

    // Diff status chips
    $$(".chip[data-status]").forEach((chip) => {
      chip.addEventListener("click", () => {
        $$(".chip[data-status]").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.diffStatusFilter = chip.dataset.status;
        renderRouteList();
        renderMapRoutes();
      });
    });
  }

  function renderAgencyFilter() {
    const agencies = new Map();
    if (state.feedA?.agencies) {
      state.feedA.agencies.forEach((a) => agencies.set(a.agency_id || a.agency_name, a.agency_name || a.agency_id));
    }
    if (state.feedB?.agencies) {
      state.feedB.agencies.forEach((a) => agencies.set(a.agency_id || a.agency_name, a.agency_name || a.agency_id));
    }

    let html = '<option value="">All agencies</option>';
    for (const [id, name] of agencies) {
      html += `<option value="${esc(id)}">${esc(name || id)}</option>`;
    }
    dom.agencyFilter.innerHTML = html;
    dom.agencyFilter.value = state.agencyFilter;
  }

  // -----------------------------------------------------------
  // File Explorer
  // -----------------------------------------------------------
  function renderFileList() {
    const isDiff = state.feedA && state.feedB;

    if (isDiff) {
      // Unified file list — show union of both feeds' files
      const filesA = new Set(state.feedA.files || []);
      const filesB = new Set(state.feedB.files || []);
      const allFiles = [...new Set([...filesA, ...filesB])].sort();

      dom.fileList.innerHTML = allFiles.map((f) => {
        const name = f.split("/").pop();
        const inA = filesA.has(f);
        const inB = filesB.has(f);
        const sel = state.selectedFile === f ? "selected" : "";
        let badge = "";
        if (inA && !inB) badge = '<span class="diff-tag tag-dropped" style="margin-left:auto">A only</span>';
        else if (!inA && inB) badge = '<span class="diff-tag tag-added" style="margin-left:auto">B only</span>';
        // Row counts
        const countA = state.feedA?.row_counts?.[f];
        const countB = state.feedB?.row_counts?.[f];
        const countStr = countA != null || countB != null
          ? `<span class="file-row-count">${(countA ?? countB ?? 0).toLocaleString()} rows</span>`
          : "";

        return `<div class="file-item ${sel}" data-file="${esc(f)}">
          <span class="file-icon">📄</span><span style="flex:1">${esc(name)}</span>${countStr}${badge}
        </div>`;
      }).join("");
    } else {
      // Single feed file list
      const feed = state.feedA || state.feedB;
      const slot = state.feedA ? "A" : "B";
      const files = feed?.files || [];
      dom.fileList.innerHTML = files.map((f) => {
        const name = f.split("/").pop();
        const sel = state.selectedFile === `${slot}:${f}` ? "selected" : "";
        const count = feed?.row_counts?.[f];
        const countStr = count != null ? `<span class="file-row-count">${count.toLocaleString()} rows</span>` : "";
        return `<div class="file-item ${sel}" data-file="${slot}:${esc(f)}">
          <span class="file-icon">📄</span><span style="flex:1">${esc(name)}</span>${countStr}
        </div>`;
      }).join("");
    }

    // Click handler
    $$("#fileList .file-item").forEach((el) => {
      el.addEventListener("click", () => {
        state.selectedFile = el.dataset.file;
        state.tableOffset = 0;
        state.diffOffset = 0;
        renderFileList();
        if (state.feedA && state.feedB) {
          renderDiffTable(state.selectedFile);
        } else {
          renderTable(state.selectedFile);
        }
      });
    });
  }

  async function renderTable(fileKey) {
    // Single-feed table view
    dom.tableContainer.style.display = "flex";
    dom.diffContainer.style.display = "none";

    const [slot, ...rest] = fileKey.split(":");
    const filename = rest.join(":");
    const displayName = filename.split("/").pop();

    dom.tableTitle.textContent = displayName + ` (Feed ${slot})`;

    try {
      const data = await api(
        `/api/feed/${slot}/preview/${encodeURIComponent(filename)}?offset=${state.tableOffset}&limit=${state.pageSize}`
      );
      const rawRows = data.rows || [];
      const total = data.total || 0;
      state.tableTotal = total;
      const feed = slot === "A" ? state.feedA : state.feedB;
      const rows = filterRowsByAgency(rawRows, feed);

      // Page info
      const from = total ? state.tableOffset + 1 : 0;
      const to = Math.min(state.tableOffset + rows.length, total);
      dom.tableRowCount.textContent = total ? `${from}–${to} of ${total.toLocaleString()}` : "Empty";

      if (!rows.length) {
        dom.tableHead.innerHTML = "";
        dom.tableBody.innerHTML = '<tr><td style="padding:20px;color:var(--charcoal-40)">No data</td></tr>';
        renderTablePager(total);
        return;
      }

      const cols = data.columns && data.columns.length ? data.columns : Object.keys(rawRows[0]);
      dom.tableHead.innerHTML = "<tr>" + cols.map((c) => `<th>${esc(c)}</th>`).join("") + "</tr>";
      dom.tableBody.innerHTML = rows.map((row) => {
        return "<tr>" + cols.map((c) => `<td title="${esc(row[c] || '')}">${esc(row[c] || "")}</td>`).join("") + "</tr>";
      }).join("");

      renderTablePager(total);
    } catch (e) {
      dom.tableHead.innerHTML = "";
      dom.tableBody.innerHTML = `<tr><td style="padding:20px;color:var(--dropped)">Error: ${esc(e.message)}</td></tr>`;
    }
  }

  function renderTablePager(total) {
    let pager = $("#tablePager");
    if (!pager) {
      pager = document.createElement("div");
      pager.id = "tablePager";
      pager.className = "pager";
      dom.tableContainer.appendChild(pager);
    }
    if (total <= state.pageSize) {
      pager.style.display = "none";
      return;
    }
    pager.style.display = "flex";
    const page = Math.floor(state.tableOffset / state.pageSize) + 1;
    const totalPages = Math.ceil(total / state.pageSize);
    pager.innerHTML = `
      <button class="pager-btn" id="tablePrev" ${state.tableOffset === 0 ? "disabled" : ""}>‹ Prev</button>
      <span class="pager-info">Page ${page} of ${totalPages}</span>
      <button class="pager-btn" id="tableNext" ${state.tableOffset + state.pageSize >= total ? "disabled" : ""}>› Next</button>
    `;
    $("#tablePrev").addEventListener("click", () => {
      state.tableOffset = Math.max(0, state.tableOffset - state.pageSize);
      renderTable(state.selectedFile);
    });
    $("#tableNext").addEventListener("click", () => {
      state.tableOffset += state.pageSize;
      renderTable(state.selectedFile);
    });
  }

  async function renderDiffTable(filename) {
    // Side-by-side diff view
    dom.tableContainer.style.display = "none";
    dom.diffContainer.style.display = "flex";

    const displayName = filename.split("/").pop();
    const nameA = state.feedA?._name ? state.feedA._name.replace(/\.zip$/i, "") : "Feed A";
    const nameB = state.feedB?._name ? state.feedB._name.replace(/\.zip$/i, "") : "Feed B";
    dom.diffTitleA.textContent = `${nameA} (From) — ${displayName}`;
    dom.diffTitleB.textContent = `${nameB} (To) — ${displayName}`;

    try {
      const data = await api(
        `/api/diff/file/${encodeURIComponent(filename)}?offset=${state.diffOffset}&limit=${state.pageSize}`
      );
      const { columns, counts, total_a, total_b, total_aligned } = data;
      state.diffTotalAligned = total_aligned || 0;
      const rows = filterDiffRowsByAgency(data.rows, columns);

      // Recompute counts after filtering
      const fc = { added: 0, dropped: 0, changed: 0, unchanged: 0 };
      for (const r of rows) fc[r.status]++;
      // Use server-total counts (they cover the full file), page-level for filtered
      const displayCounts = state.agencyFilter ? fc : counts;

      dom.diffMetaA.textContent = `${total_a.toLocaleString()} rows`;
      dom.diffMetaB.textContent = `${total_b.toLocaleString()} rows`;

      // Summary bar
      const summaryHtml = `
        <span class="diff-summary-item"><span class="diff-summary-dot" style="background:var(--added)"></span> ${displayCounts.added} added</span>
        <span class="diff-summary-item"><span class="diff-summary-dot" style="background:var(--dropped)"></span> ${displayCounts.dropped} dropped</span>
        <span class="diff-summary-item"><span class="diff-summary-dot" style="background:var(--changed)"></span> ${displayCounts.changed} changed</span>
        <span class="diff-summary-item"><span class="diff-summary-dot" style="background:var(--unchanged)"></span> ${displayCounts.unchanged} unchanged</span>
      `;
      dom.diffSummary.innerHTML = summaryHtml;
      dom.diffSummaryB.innerHTML = summaryHtml;

      // Table heads
      const headHtml = "<tr>" + columns.map((c) => `<th>${esc(c)}</th>`).join("") + "</tr>";
      dom.diffHeadA.innerHTML = headHtml;
      dom.diffHeadB.innerHTML = headHtml;

      // Table bodies + gutter
      let bodyA = "";
      let bodyB = "";
      let gutterHtml = '<div class="diff-gutter-header">DIFF</div><div class="diff-gutter-icons">';

      for (const row of rows) {
        const status = row.status;
        const changedSet = new Set(row.changed_fields || []);

        if (status === "dropped") {
          // Row exists in A, blank in B
          bodyA += buildDiffRow(row.a, columns, "diff-row-dropped", changedSet, false);
          bodyB += buildBlankRow(columns);
          gutterHtml += `<div class="diff-gutter-icon g-dropped">−</div>`;
        } else if (status === "added") {
          // Blank in A, row exists in B
          bodyA += buildBlankRow(columns);
          bodyB += buildDiffRow(row.b, columns, "diff-row-added", changedSet, false);
          gutterHtml += `<div class="diff-gutter-icon g-added">+</div>`;
        } else if (status === "changed") {
          bodyA += buildDiffRow(row.a, columns, "diff-row-changed", changedSet, true);
          bodyB += buildDiffRow(row.b, columns, "diff-row-changed", changedSet, true);
          gutterHtml += `<div class="diff-gutter-icon g-changed">≠</div>`;
        } else {
          // unchanged
          bodyA += buildDiffRow(row.a, columns, "", changedSet, false);
          bodyB += buildDiffRow(row.b, columns, "", changedSet, false);
          gutterHtml += `<div class="diff-gutter-icon g-unchanged">·</div>`;
        }
      }

      gutterHtml += '</div>';

      dom.diffBodyA.innerHTML = bodyA;
      dom.diffBodyB.innerHTML = bodyB;
      dom.diffGutter.innerHTML = gutterHtml;

      // Sync scrolling between both panes and gutter
      let syncing = false;
      function syncScroll(source, ...targets) {
        source.addEventListener("scroll", () => {
          if (syncing) return;
          syncing = true;
          for (const t of targets) {
            t.scrollTop = source.scrollTop;
            t.scrollLeft = source.scrollLeft;
          }
          syncing = false;
        });
      }
      // Remove old listeners by replacing nodes — simpler than tracking
      syncScroll(dom.diffScrollA, dom.diffScrollB, dom.diffGutter);
      syncScroll(dom.diffScrollB, dom.diffScrollA, dom.diffGutter);
      syncScroll(dom.diffGutter, dom.diffScrollA, dom.diffScrollB);

      renderDiffPager(total_aligned || 0);

    } catch (e) {
      dom.diffBodyA.innerHTML = `<tr><td style="padding:20px;color:var(--dropped)">Error: ${esc(e.message)}</td></tr>`;
      dom.diffBodyB.innerHTML = "";
      dom.diffGutter.innerHTML = "";
    }
  }

  function renderDiffPager(totalAligned) {
    // Insert pager into left pane (it spans visually)
    let pager = $("#diffPager");
    if (!pager) {
      pager = document.createElement("div");
      pager.id = "diffPager";
      pager.className = "pager diff-pager";
      dom.diffContainer.appendChild(pager);
    }
    if (totalAligned <= state.pageSize) {
      pager.style.display = "none";
      return;
    }
    pager.style.display = "flex";
    const page = Math.floor(state.diffOffset / state.pageSize) + 1;
    const totalPages = Math.ceil(totalAligned / state.pageSize);
    pager.innerHTML = `
      <button class="pager-btn" id="diffPrev" ${state.diffOffset === 0 ? "disabled" : ""}>‹ Prev</button>
      <span class="pager-info">Page ${page} of ${totalPages} (${totalAligned.toLocaleString()} rows)</span>
      <button class="pager-btn" id="diffNext" ${state.diffOffset + state.pageSize >= totalAligned ? "disabled" : ""}>› Next</button>
    `;
    $("#diffPrev").addEventListener("click", () => {
      state.diffOffset = Math.max(0, state.diffOffset - state.pageSize);
      renderDiffTable(state.selectedFile);
    });
    $("#diffNext").addEventListener("click", () => {
      state.diffOffset += state.pageSize;
      renderDiffTable(state.selectedFile);
    });
  }

  function buildDiffRow(rowData, columns, rowClass, changedSet, markChanged) {
    const cells = columns.map((c) => {
      const val = rowData[c] || "";
      const cellClass = markChanged && changedSet.has(c) ? ' class="cell-changed"' : "";
      return `<td${cellClass} title="${esc(val)}">${esc(val)}</td>`;
    }).join("");
    return `<tr class="${rowClass}">${cells}</tr>`;
  }

  function buildBlankRow(columns) {
    return `<tr class="diff-row-blank">${columns.map(() => "<td>&nbsp;</td>").join("")}</tr>`;
  }

  // -----------------------------------------------------------
  // Route List (sidebar)
  // -----------------------------------------------------------
  function getRoutesForDisplay() {
    const isDiff = state.feedA && state.feedB;

    if (isDiff) {
      // Build combined list with diff status
      const aRoutes = new Map((state.feedA?.routes || []).map((r) => [r.route_id, { ...r, _feed: "A" }]));
      const bRoutes = new Map((state.feedB?.routes || []).map((r) => [r.route_id, { ...r, _feed: "B" }]));
      const allIds = new Set([...aRoutes.keys(), ...bRoutes.keys()]);
      const result = [];

      for (const id of allIds) {
        const inA = aRoutes.has(id);
        const inB = bRoutes.has(id);
        let status, route;
        if (inA && inB) { status = "unchanged"; route = bRoutes.get(id); }
        else if (inA) { status = "dropped"; route = aRoutes.get(id); }
        else { status = "added"; route = bRoutes.get(id); }
        result.push({ ...route, _diff_status: status });
      }
      return result;
    }

    // Single feed
    const feed = state.feedA || state.feedB;
    return (feed?.routes || []).map((r) => ({ ...r, _diff_status: null }));
  }

  function renderRouteList() {
    let routes = getRoutesForDisplay();

    // Apply filters
    if (state.agencyFilter) {
      routes = routes.filter((r) => r.agency_id === state.agencyFilter);
    }
    if (state.routeSearch) {
      routes = routes.filter((r) => {
        const name = (r.route_short_name || r.route_long_name || r.route_id || "").toLowerCase();
        return name.includes(state.routeSearch);
      });
    }
    if (state.diffStatusFilter !== "all") {
      routes = routes.filter((r) => r._diff_status === state.diffStatusFilter);
    }

    dom.routeCount.textContent = routes.length;

    dom.routeList.innerHTML = routes.map((r) => {
      const name = r.route_short_name || r.route_long_name || r.route_id;
      const longName = r.route_long_name || "";
      const selected = state.selectedRoutes.has(r.route_id) ? "selected" : "";
      const badgeColor = getDiffColor(r._diff_status) || "var(--pink)";
      const diffTag = r._diff_status && r._diff_status !== "unchanged"
        ? `<span class="diff-tag tag-${r._diff_status}">${r._diff_status}</span>`
        : "";

      return `<div class="route-item ${selected}" data-route-id="${esc(r.route_id)}" title="${esc(longName)}">
        <span class="route-badge" style="background:${badgeColor}"></span>
        <span class="route-name">${esc(name)}</span>
        ${diffTag}
        <span class="route-id">${esc(r.route_id)}</span>
      </div>`;
    }).join("");

    // Click handlers
    $$(".route-item").forEach((el) => {
      el.addEventListener("click", () => {
        const rid = el.dataset.routeId;
        if (state.selectedRoutes.has(rid)) {
          state.selectedRoutes.delete(rid);
        } else {
          state.selectedRoutes.add(rid);
        }
        renderRouteList();
        renderMapRoutes();
      });
    });
  }

  // -----------------------------------------------------------
  // Map
  // -----------------------------------------------------------
  function initMap() {
    if (map) {
      map.invalidateSize();
      return;
    }
    map = L.map("map", { zoomControl: true }).setView([0, 0], 2);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
      maxZoom: 19,
    }).addTo(map);
    mapLayers.addTo(map);
  }

  async function renderMapRoutes() {
    if (!map) return;
    mapLayers.clearLayers();

    const isDiff = state.feedA && state.feedB;
    const bounds = [];

    async function drawFeedRoutes(slot, color, feed) {
      if (!feed) return;
      const routeIds = getFilteredRouteIds(feed, slot);
      if (!routeIds.length) return;

      try {
        const data = await api(`/api/feed/${slot}/shapes?route_ids=${routeIds.join(",")}`);
        const shapes = data.shapes || {};

        for (const [rid, shapeData] of Object.entries(shapes)) {
          const coords = shapeData.coords.map(([lat, lon]) => [lat, lon]);
          if (!coords.length) continue;

          // Determine color
          let lineColor = color;
          let diffStatus = null;
          if (isDiff) {
            const route = getRouteById(rid);
            diffStatus = route?._diff_status;
            if (diffStatus === "added") lineColor = "var(--added)";
            else if (diffStatus === "dropped") lineColor = "var(--dropped)";
            else if (diffStatus === "unchanged") lineColor = "var(--unchanged)";
            // Resolve CSS var
            lineColor = diffStatus === "added" ? "#22c55e"
              : diffStatus === "dropped" ? "#ef4444"
              : diffStatus === "unchanged" ? "#94a3b8"
              : color;
          }

          const route = findRoute(rid, slot, feed);
          const polyline = L.polyline(coords, {
            color: lineColor,
            weight: 3,
            opacity: 0.8,
          });

          // Popup
          polyline.bindPopup(buildPopup(route, slot, diffStatus));
          polyline.on("mouseover", function () { this.setStyle({ weight: 5, opacity: 1 }); });
          polyline.on("mouseout", function () { this.setStyle({ weight: 3, opacity: 0.8 }); });

          mapLayers.addLayer(polyline);
          bounds.push(...coords);
        }
      } catch (e) {
        console.warn(`Failed to load shapes for feed ${slot}:`, e);
      }
    }

    if (isDiff) {
      // In diff mode, draw both feeds but use diff colors
      await Promise.all([
        drawFeedRoutes("A", "#DE007B", state.feedA),
        drawFeedRoutes("B", "#0B91DB", state.feedB),
      ]);
    } else if (state.feedA) {
      await drawFeedRoutes("A", "#DE007B", state.feedA);
    } else if (state.feedB) {
      await drawFeedRoutes("B", "#0B91DB", state.feedB);
    }

    if (bounds.length) {
      map.fitBounds(bounds, { padding: [30, 30] });
    }

    // Show legend
    dom.mapLegend.style.display = (state.feedA || state.feedB) ? "block" : "none";
  }

  function getFilteredRouteIds(feed, slot) {
    let routes = feed?.routes || [];

    if (state.agencyFilter) {
      routes = routes.filter((r) => r.agency_id === state.agencyFilter);
    }

    if (state.selectedRoutes.size > 0) {
      routes = routes.filter((r) => state.selectedRoutes.has(r.route_id));
    }

    if (state.diffStatusFilter !== "all" && state.feedA && state.feedB) {
      const diffRoutes = getRoutesForDisplay();
      const statusIds = new Set(diffRoutes.filter((r) => r._diff_status === state.diffStatusFilter).map((r) => r.route_id));
      routes = routes.filter((r) => statusIds.has(r.route_id));
    }

    return routes.map((r) => r.route_id);
  }

  function findRoute(routeId, slot, feed) {
    return (feed?.routes || []).find((r) => r.route_id === routeId) || {};
  }

  function getRouteById(routeId) {
    return getRoutesForDisplay().find((r) => r.route_id === routeId);
  }

  function buildPopup(route, slot, diffStatus) {
    const agencyName = findAgencyName(route.agency_id, slot);
    let html = `<div class="popup-title">${esc(route.route_short_name || route.route_long_name || route.route_id || "Unknown")}</div>`;
    if (route.route_long_name && route.route_short_name) {
      html += `<div style="font-size:12px;color:var(--charcoal-60);margin-bottom:6px">${esc(route.route_long_name)}</div>`;
    }
    html += `
      <div class="popup-row"><span class="popup-label">agency_id</span> ${esc(route.agency_id || "—")}</div>
      <div class="popup-row"><span class="popup-label">agency</span> ${esc(agencyName || "—")}</div>
      <div class="popup-row"><span class="popup-label">route_id</span> ${esc(route.route_id || "—")}</div>
      <div class="popup-row"><span class="popup-label">route_type</span> ${esc(route.route_type || "—")}</div>
      <div class="popup-row"><span class="popup-label">trip_id</span> ${esc(route._trip_id || "—")}</div>
      <div class="popup-row"><span class="popup-label">feed</span> ${slot}</div>
    `;
    if (diffStatus) {
      const color = diffStatus === "added" ? "var(--added)" : diffStatus === "dropped" ? "var(--dropped)" : "var(--unchanged)";
      html += `<div class="popup-row"><span class="popup-label">status</span> <span style="color:${color};font-weight:600">${diffStatus.toUpperCase()}</span></div>`;
    }
    return html;
  }

  function findAgencyName(agencyId, slot) {
    const feed = slot === "A" ? state.feedA : state.feedB;
    if (!feed?.agencies) return "";
    const agency = feed.agencies.find((a) => a.agency_id === agencyId);
    return agency?.agency_name || "";
  }

  // -----------------------------------------------------------
  // Diff coloring helpers
  // -----------------------------------------------------------
  function getDiffColor(status) {
    if (status === "added") return "#22c55e";
    if (status === "dropped") return "#ef4444";
    if (status === "unchanged") return "#94a3b8";
    if (status === "changed") return "#f59e0b";
    return null;
  }

  // -----------------------------------------------------------
  // Utility
  // -----------------------------------------------------------
  function esc(str) {
    if (!str) return "";
    const d = document.createElement("div");
    d.textContent = String(str);
    return d.innerHTML;
  }

  // -----------------------------------------------------------
  // Drag & drop
  // -----------------------------------------------------------
  function setupDragDrop() {
    // Prevent browser from opening dropped files
    document.addEventListener("dragover", (e) => e.preventDefault());
    document.addEventListener("drop", (e) => e.preventDefault());

    function wireDropZone(btnSelector, slot) {
      const btn = document.querySelector(btnSelector);
      btn.addEventListener("dragover", (e) => {
        e.preventDefault();
        btn.classList.add("drag-over");
      });
      btn.addEventListener("dragleave", () => btn.classList.remove("drag-over"));
      btn.addEventListener("drop", async (e) => {
        e.preventDefault();
        btn.classList.remove("drag-over");
        const file = e.dataTransfer.files[0];
        if (!file || !file.name.endsWith(".zip")) { alert("Please drop a .zip file"); return; }
        await handleUpload(file, slot);
      });
    }

    wireDropZone("#uploadBtnA", "A");
    wireDropZone("#uploadBtnB", "B");
  }

  // -----------------------------------------------------------
  // Download CSV
  // -----------------------------------------------------------
  function setupDownload() {
    const btn = $("#downloadBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (!state.selectedFile) return;

      // Figure out which data to export
      const isDiff = state.feedA && state.feedB;
      if (isDiff) {
        // Download the diff view data
        downloadDiffCSV(state.selectedFile);
      } else {
        // Download single feed file
        downloadSingleCSV(state.selectedFile);
      }
    });
  }

  async function downloadSingleCSV(fileKey) {
    const [slot, ...rest] = fileKey.split(":");
    const filename = rest.join(":");
    try {
      // Fetch all rows (paginate through)
      let allRows = [];
      let offset = 0;
      const limit = 500;
      let cols = null;
      while (true) {
        const data = await api(`/api/feed/${slot}/preview/${encodeURIComponent(filename)}?offset=${offset}&limit=${limit}`);
        const rows = data.rows || [];
        if (!cols && data.columns?.length) cols = data.columns;
        if (!cols && rows.length) cols = Object.keys(rows[0]);
        allRows = allRows.concat(rows);
        if (rows.length < limit) break;
        offset += limit;
      }
      if (!allRows.length) return;
      exportCSV(cols, allRows, filename.split("/").pop());
    } catch (e) { console.warn(e); }
  }

  async function downloadDiffCSV(filename) {
    try {
      // Fetch all diff pages
      let allRows = [];
      let offset = 0;
      const limit = 500;
      let columns = null;
      while (true) {
        const data = await api(`/api/diff/file/${encodeURIComponent(filename)}?offset=${offset}&limit=${limit}`);
        if (!columns) columns = data.columns;
        allRows = allRows.concat(data.rows || []);
        if ((data.rows || []).length < limit) break;
        offset += limit;
      }
      const exportRows = [];
      for (const row of allRows) {
        if (row.a) exportRows.push({ _status: row.status === "dropped" ? "DROPPED" : row.status === "changed" ? "CHANGED (A)" : row.status.toUpperCase(), _feed: "A", ...row.a });
        if (row.b) exportRows.push({ _status: row.status === "added" ? "ADDED" : row.status === "changed" ? "CHANGED (B)" : row.status.toUpperCase(), _feed: "B", ...row.b });
      }
      const cols = ["_status", "_feed", ...columns];
      exportCSV(cols, exportRows, `diff_${filename.split("/").pop()}`);
    } catch (e) { console.warn(e); }
  }

  function exportCSV(cols, rows, basename) {
    const csvRows = [cols.join(",")];
    for (const row of rows) {
      csvRows.push(cols.map((c) => {
        let v = String(row[c] || "").replace(/"/g, '""');
        if (v.includes(",") || v.includes('"') || v.includes("\n")) v = `"${v}"`;
        return v;
      }).join(","));
    }
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = basename.replace(/\.txt$/i, "") + ".csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // -----------------------------------------------------------
  // Fit bounds button
  // -----------------------------------------------------------
  function setupFitBounds() {
    const btn = $("#fitBoundsBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      if (!map) return;
      // Collect all bounds from current layers
      const bounds = [];
      mapLayers.eachLayer((layer) => {
        if (layer.getBounds) {
          const b = layer.getBounds();
          if (b.isValid()) bounds.push(b);
        }
      });
      if (bounds.length) {
        const combined = bounds[0];
        for (let i = 1; i < bounds.length; i++) combined.extend(bounds[i]);
        map.fitBounds(combined, { padding: [30, 30] });
      }
    });
  }

  // -----------------------------------------------------------
  // Init
  // -----------------------------------------------------------
  function init() {
    setupViewToggle();
    setupUploads();
    setupFilters();
    setupDragDrop();
    setupDownload();
    setupFitBounds();
    renderCurrentView();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
