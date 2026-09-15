// CodexMemory Minimalist Control Center Client Logic

document.addEventListener("DOMContentLoaded", () => {
  // Elements
  const pillRedis = document.getElementById("pillRedis");
  const pillOllama = document.getElementById("pillOllama");
  const pillMcp = document.getElementById("pillMcp");
  const btnEngineToggle = document.getElementById("btnEngineToggle");
  const btnReindexAll = document.getElementById("btnReindexAll");

  let isEngineRunning = false;
  let isTogglingEngine = false;

  const quickNoteForm = document.getElementById("quickNoteForm");
  const noteTitle = document.getElementById("noteTitle");
  const noteContent = document.getElementById("noteContent");
  const noteFeedback = document.getElementById("noteFeedback");

  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");
  const uploadFeedback = document.getElementById("uploadFeedback");

  const searchForm = document.getElementById("searchForm");
  const searchQuery = document.getElementById("searchQuery");
  const topK = document.getElementById("topK");
  const searchResults = document.getElementById("searchResults");

  const docTableBody = document.getElementById("docTableBody");
  const docCountBadge = document.getElementById("docCountBadge");

  // Tab switching
  const tabButtons = document.querySelectorAll(".tab-btn");
  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabButtons.forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
      btn.classList.add("active");
      const targetId = btn.getAttribute("data-tab");
      const target = document.getElementById(targetId);
      if (target) target.classList.add("active");
    });
  });

  // Copy buttons
  setupCopyBtn("copyVscodeBtn", "codeVscode");
  setupCopyBtn("copyClaudeBtn", "codeClaude");

  function setupCopyBtn(btnId, codeId) {
    const btn = document.getElementById(btnId);
    const code = document.getElementById(codeId);
    if (!btn || !code) return;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.innerText.trim());
        const original = btn.innerText;
        btn.innerText = "COPIED!";
        setTimeout(() => { btn.innerText = original; }, 1800);
      } catch (err) {
        btn.innerText = "ERROR";
      }
    });
  }

  // Poll engine status
  async function fetchStatus() {
    try {
      const res = await fetch("/api/status");
      if (!res.ok) throw new Error("Status failed");
      const data = await res.json();

      const engineRunning = data.engine ? data.engine.running : (data.redis?.status === "connected");
      const redisOnline = engineRunning && (data.redis?.status === "connected");
      const ollamaOnline = data.ollama?.status === "connected";
      isEngineRunning = engineRunning;

      updatePill(pillRedis, redisOnline, isEngineRunning ? (data.redis?.status || "OFFLINE") : "STOPPED");
      updatePill(pillOllama, ollamaOnline, data.ollama?.model || "OFFLINE");
      updatePill(pillMcp, true, `PORT ${data.mcp?.port || 3001}`);

      if (!isTogglingEngine && btnEngineToggle) {
        if (isEngineRunning) {
          btnEngineToggle.innerText = "■ STOP ENGINE";
          btnEngineToggle.className = "btn btn-sm btn-outline";
          btnEngineToggle.title = "Stop background engine and workers";
        } else {
          btnEngineToggle.innerText = "▶ START ENGINE";
          btnEngineToggle.className = "btn btn-sm btn-primary";
          btnEngineToggle.title = "Start all background engine services and workers";
        }
      }
    } catch {
      isEngineRunning = false;
      updatePill(pillRedis, false, "OFFLINE");
      updatePill(pillOllama, false, "OFFLINE");
      updatePill(pillMcp, false, "OFFLINE");

      if (!isTogglingEngine && btnEngineToggle) {
        btnEngineToggle.innerText = "▶ START ENGINE";
        btnEngineToggle.className = "btn btn-sm btn-primary";
      }
    }
  }

  // Engine Start / Stop Button Handler
  if (btnEngineToggle) {
    btnEngineToggle.addEventListener("click", async () => {
      if (isTogglingEngine) return;
      isTogglingEngine = true;

      const action = isEngineRunning ? "stop" : "start";
      btnEngineToggle.innerText = action === "start" ? "STARTING ENGINE..." : "STOPPING ENGINE...";

      try {
        let result;
        if (window.electronAPI) {
          console.log(`[Control Center] Invoking Electron IPC engine:${action}`);
          result = action === "start"
            ? await window.electronAPI.startEngine()
            : await window.electronAPI.stopEngine();
        } else {
          console.log(`[Control Center] Invoking REST API /api/engine/${action}`);
          const res = await fetch(`/api/engine/${action}`, { method: "POST" });
          result = await res.json();
        }

        if (!result.success && result.error) {
          alert(`Engine ${action} failed: ${result.error}`);
        }
      } catch (err) {
        alert(`Failed to ${action} engine: ${err.message}`);
      } finally {
        isTogglingEngine = false;
        setTimeout(fetchStatus, 1500);
      }
    });
  }

  function updatePill(el, isOnline, text) {
    if (!el) return;
    el.classList.toggle("online", isOnline);
    el.classList.toggle("offline", !isOnline);
    const valSpan = el.querySelector(".val");
    if (valSpan) valSpan.innerText = text.toUpperCase();
  }

  // Fetch document list
  async function fetchDocuments() {
    try {
      const res = await fetch("/api/documents");
      if (!res.ok) throw new Error("Failed to load documents");
      const docs = await res.json();

      docCountBadge.innerText = `${docs.length} DOCS`;

      if (docs.length === 0) {
        docTableBody.innerHTML = `<tr><td colspan="4" class="empty-cell">No documents found in docs/ folder.</td></tr>`;
        return;
      }

      docTableBody.innerHTML = docs
        .map((doc) => {
          return `
          <tr>
            <td class="doc-name">${escapeHtml(doc.name)}</td>
            <td>${formatBytes(doc.size)}</td>
            <td>${doc.chunks !== undefined ? doc.chunks : "—"}</td>
            <td>
              <button class="btn-delete" data-filename="${escapeHtml(doc.name)}">DELETE</button>
            </td>
          </tr>
        `;
        })
        .join("");

      // Attach delete listeners
      docTableBody.querySelectorAll(".btn-delete").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const filename = btn.getAttribute("data-filename");
          if (!confirm(`Delete ${filename}? This removes the file and purges its vector embeddings.`)) return;

          btn.innerText = "DELETING...";
          try {
            const delRes = await fetch(`/api/documents/${encodeURIComponent(filename)}`, {
              method: "DELETE",
            });
            if (!delRes.ok) throw new Error("Delete failed");
            await fetchDocuments();
          } catch (err) {
            alert(`Error deleting document: ${err.message}`);
            btn.innerText = "DELETE";
          }
        });
      });
    } catch (err) {
      docTableBody.innerHTML = `<tr><td colspan="4" class="empty-cell">Failed to load documents: ${escapeHtml(err.message)}</td></tr>`;
    }
  }

  // Quick Note Form Submission
  quickNoteForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const title = noteTitle.value.trim();
    const content = noteContent.value.trim();
    if (!title || !content) return;

    showFeedback(noteFeedback, "Saving & indexing...", "success");

    try {
      const res = await fetch("/api/documents/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save note");

      showFeedback(noteFeedback, `SUCCESS: Saved as ${data.filename} and queued for vector indexing.`, "success");
      quickNoteForm.reset();
      setTimeout(fetchDocuments, 1000);
    } catch (err) {
      showFeedback(noteFeedback, `ERROR: ${err.message}`, "error");
    }
  });

  // Drag & Drop File Upload
  dropzone.addEventListener("click", () => fileInput.click());

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  ["dragleave", "dragend"].forEach((evt) => {
    dropzone.addEventListener(evt, () => dropzone.classList.remove("dragover"));
  });

  dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      await handleFiles(files);
    }
  });

  fileInput.addEventListener("change", async () => {
    if (fileInput.files && fileInput.files.length > 0) {
      await handleFiles(fileInput.files);
      fileInput.value = "";
    }
  });

  async function handleFiles(files) {
    showFeedback(uploadFeedback, `Uploading ${files.length} file(s)...`, "success");
    let uploadedCount = 0;

    for (const file of files) {
      try {
        const content = await readFileAsText(file);
        const res = await fetch("/api/documents/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, content }),
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || "Upload failed");
        }
        uploadedCount++;
      } catch (err) {
        showFeedback(uploadFeedback, `Error uploading ${file.name}: ${err.message}`, "error");
        return;
      }
    }

    showFeedback(uploadFeedback, `SUCCESS: Uploaded and queued ${uploadedCount} file(s) for indexing.`, "success");
    setTimeout(fetchDocuments, 1000);
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Failed to read file"));
      reader.readAsText(file);
    });
  }

  // Vector Search Playground
  searchForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = searchQuery.value.trim();
    const k = parseInt(topK.value, 10) || 4;
    if (!query) return;

    searchResults.innerHTML = `<div class="empty-state">Embedding query and searching LanceDB vectors...</div>`;

    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, topK: k }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Search failed");

      const results = data.results || [];
      if (results.length === 0) {
        searchResults.innerHTML = `<div class="empty-state">No matching document chunks found for query "${escapeHtml(query)}".</div>`;
        return;
      }

      const graphCard = (data.graphContext && data.graphContext.length > 0)
        ? `
        <div class="result-card" style="border-left: 3px solid var(--fg); margin-bottom: 12px; background: var(--surface-alt);">
          <div class="result-header">
            <span class="result-source">KNOWLEDGE GRAPH (GRAPHRAG FACTS)</span>
            <span class="result-badge">GRAPH</span>
          </div>
          <div class="result-text" style="background: var(--bg);">
${data.graphContext.map((g) => `&bull; ${escapeHtml(g.formatted)}`).join("<br>")}
          </div>
        </div>
      `
        : "";

      const cardsHtml = results
        .map((r, idx) => {
          const distance = typeof r._distance === "number" ? r._distance.toFixed(4) : "—";
          const filename = r.sourceFile ? r.sourceFile.split("/").pop() : "document";
          const scorePercent = typeof r.score === "number" ? `${Math.round(r.score * 100)}%` : null;
          const matchBadge = r.matchType === "hybrid"
            ? `<span class="result-badge">HYBRID</span>`
            : (r.matchType === "keyword" ? `<span class="result-badge keyword">KEYWORD</span>` : "");
          const metaInfo = scorePercent ? `SCORE ${scorePercent} &bull; DIST: ${distance}` : `DIST: ${distance}`;
          return `
          <div class="result-card">
            <div class="result-header">
              <span class="result-source">RESULT ${idx + 1} &bull; ${escapeHtml(filename)}${matchBadge}</span>
              <span class="result-distance">${metaInfo}</span>
            </div>
            <div class="result-text">${escapeHtml(r.text || "")}</div>
          </div>
        `;
        })
        .join("");

      searchResults.innerHTML = graphCard + cardsHtml;
    } catch (err) {
      searchResults.innerHTML = `<div class="empty-state">Search error: ${escapeHtml(err.message)}</div>`;
    }
  });

  // Fetch Knowledge Graph Explorer data
  async function fetchKnowledgeGraph(filterFile = "all") {
    const entityBadge = document.getElementById("graphEntityCountBadge");
    const relBadge = document.getElementById("graphRelCountBadge");
    const tableBody = document.getElementById("graphTableBody");
    const filterSelect = document.getElementById("graphSourceFilter");
    if (!tableBody) return;

    try {
      const [statsRes, entitiesRes] = await Promise.all([
        fetch("/api/graph/stats"),
        fetch("/api/graph/entities?limit=200"),
      ]);

      if (statsRes.ok) {
        const stats = await statsRes.json();
        if (entityBadge) entityBadge.innerText = `${stats.totalEntities || 0} ENTITIES`;
        if (relBadge) relBadge.innerText = `${stats.totalRelations || 0} RELATIONS`;
      }

      if (entitiesRes.ok) {
        const allEntities = await entitiesRes.json();
        if (allEntities.length === 0) {
          tableBody.innerHTML = `<tr><td colspan="3" class="empty-cell">No entities in knowledge graph yet. Ingest documents to populate the graph.</td></tr>`;
          return;
        }

        // Build source file filter dropdown
        if (filterSelect) {
          const sources = [...new Set(allEntities.map((e) => e.sourceFile).filter(Boolean))];
          const currentVal = filterSelect.value || "all";
          filterSelect.innerHTML = `<option value="all">All Documents (${allEntities.length})</option>` +
            sources.map((src) => {
              const name = src.split("/").pop();
              const count = allEntities.filter((e) => e.sourceFile === src).length;
              return `<option value="${escapeHtml(src)}" ${currentVal === src ? "selected" : ""}>${escapeHtml(name)} (${count})</option>`;
            }).join("");

          // Attach change listener once
          if (!filterSelect.dataset.bound) {
            filterSelect.dataset.bound = "1";
            filterSelect.addEventListener("change", () => fetchKnowledgeGraph(filterSelect.value));
          }
          filterFile = filterSelect.value || "all";
        }

        // Apply filter
        const entities = filterFile === "all"
          ? allEntities
          : allEntities.filter((e) => e.sourceFile === filterFile);

        if (entities.length === 0) {
          tableBody.innerHTML = `<tr><td colspan="3" class="empty-cell">No entities found for this document.</td></tr>`;
          return;
        }

        // Sort by type then name
        entities.sort((a, b) => (a.type || "").localeCompare(b.type || "") || (a.name || "").localeCompare(b.name || ""));

        tableBody.innerHTML = entities
          .map((e) => {
            const fileName = e.sourceFile ? e.sourceFile.split("/").pop() : "—";
            return `
            <tr>
              <td class="doc-name">${escapeHtml(e.name || e.id)}</td>
              <td><span class="result-badge keyword" style="margin-left: 0;">${escapeHtml(e.type || "Entity")}</span></td>
              <td>${escapeHtml(fileName)}</td>
            </tr>
          `;
          })
          .join("");
      }
    } catch (err) {
      if (tableBody) {
        tableBody.innerHTML = `<tr><td colspan="3" class="empty-cell">Failed to load graph: ${escapeHtml(err.message)}</td></tr>`;
      }
    }
  }

  // ============================================================
  // Graph Canvas Tab Switching
  // ============================================================
  const tabBtnTable  = document.getElementById("tabBtnTable");
  const tabBtnCanvas = document.getElementById("tabBtnCanvas");
  const graphViewTable  = document.getElementById("graphViewTable");
  const graphViewCanvas = document.getElementById("graphViewCanvas");
  let graphCanvasInited = false;

  function switchGraphTab(tab) {
    if (tab === "canvas") {
      graphViewTable.style.display  = "none";
      graphViewCanvas.style.display = "block";
      tabBtnTable.classList.remove("active");
      tabBtnCanvas.classList.add("active");
      if (!graphCanvasInited) { graphCanvasInited = true; initForceGraph(); }
    } else {
      graphViewTable.style.display  = "block";
      graphViewCanvas.style.display = "none";
      tabBtnCanvas.classList.remove("active");
      tabBtnTable.classList.add("active");
    }
  }

  tabBtnTable?.addEventListener("click",  () => switchGraphTab("table"));
  tabBtnCanvas?.addEventListener("click", () => switchGraphTab("canvas"));

  // ============================================================
  // Force-Directed Graph Engine (vanilla JS / Canvas)
  // ============================================================
  function initForceGraph() {
    const canvas  = document.getElementById("graphCanvas");
    const tooltip = document.getElementById("graphNodeTooltip");
    if (!canvas) return;

    const ctx = canvas.getContext("2d");

    // Physics constants
    const K_REPEL    = 6000;   // node-to-node repulsion
    const K_SPRING   = 0.04;   // edge spring constant
    const REST_LEN   = 120;    // natural edge length
    const DAMPING    = 0.82;   // velocity damping (< 1)
    const CENTER_F   = 0.003;  // centering pull strength
    const TICK_DT    = 0.3;    // time step per frame

    // Node appearance by type
    const TYPE_RADIUS = { Document: 18, Technology: 13, Person: 16, Project: 11, Category: 14, Topic: 14 };
    const DEFAULT_R   = 10;

    // Transform state
    let tx = 0, ty = 0, scale = 1, rotation = 0;

    // Interaction state
    let dragNode = null, isPanning = false, isRotating = false;
    let lastMX = 0, lastMY = 0;
    let hoveredNode = null;
    let animFrame = null;
    let running = false;
    let nodes = [], edges = [];

    // Resize canvas to CSS size
    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      canvas.width  = rect.width  * devicePixelRatio;
      canvas.height = rect.height * devicePixelRatio;
      ctx.scale(devicePixelRatio, devicePixelRatio);
    }

    function cssW() { return canvas.getBoundingClientRect().width; }
    function cssH() { return canvas.getBoundingClientRect().height; }

    // Convert mouse → world coordinates
    function mouseToWorld(mx, my) {
      const cx = cssW() / 2 + tx, cy = cssH() / 2 + ty;
      const dx = (mx - cx) / scale, dy = (my - cy) / scale;
      const cos = Math.cos(-rotation), sin = Math.sin(-rotation);
      return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
    }

    // Find node under mouse
    function hitTest(mx, my) {
      const w = mouseToWorld(mx, my);
      let closest = null, minDist = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.x - w.x, n.y - w.y);
        const r = TYPE_RADIUS[n.type] || DEFAULT_R;
        if (d < r + 4 && d < minDist) { minDist = d; closest = n; }
      }
      return closest;
    }

    // Physics tick
    function tick() {
      const W = cssW(), H = cssH();
      const cx = W / 2, cy = H / 2;

      for (const n of nodes) {
        let fx = 0, fy = 0;

        // Repulsion between all pairs
        for (const m of nodes) {
          if (m === n) continue;
          let dx = n.x - m.x, dy = n.y - m.y;
          const d2 = dx * dx + dy * dy + 0.1;
          const d  = Math.sqrt(d2);
          const f  = K_REPEL / d2;
          fx += (dx / d) * f;
          fy += (dy / d) * f;
        }

        // Spring along edges
        for (const e of edges) {
          let other = null;
          if (e.source === n) other = e.target;
          else if (e.target === n) other = e.source;
          if (!other) continue;
          const dx = other.x - n.x, dy = other.y - n.y;
          const d  = Math.hypot(dx, dy) || 1;
          const f  = K_SPRING * (d - REST_LEN);
          fx += (dx / d) * f;
          fy += (dy / d) * f;
        }

        // Centering force
        fx += -n.x * CENTER_F;
        fy += -n.y * CENTER_F;

        n.vx = (n.vx + fx * TICK_DT) * DAMPING;
        n.vy = (n.vy + fy * TICK_DT) * DAMPING;

        if (n !== dragNode) {
          n.x += n.vx;
          n.y += n.vy;
        }
      }
    }

    // Rendering
    function draw() {
      const W = cssW(), H = cssH();
      ctx.save();
      ctx.clearRect(0, 0, W, H);

      // Apply transform: center + pan + rotate + scale
      ctx.translate(W / 2 + tx, H / 2 + ty);
      ctx.rotate(rotation);
      ctx.scale(scale, scale);

      // Draw edges
      ctx.strokeStyle = "#000";
      ctx.lineWidth   = 1 / scale;
      ctx.font        = `${9 / scale}px JetBrains Mono, monospace`;
      ctx.fillStyle   = "#888";
      ctx.textAlign   = "center";
      ctx.textBaseline = "middle";

      for (const e of edges) {
        const sx = e.source.x, sy = e.source.y;
        const tx2 = e.target.x, ty2 = e.target.y;
        const mx = (sx + tx2) / 2, my = (sy + ty2) / 2;

        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.lineTo(tx2, ty2);
        ctx.globalAlpha = 0.35;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Edge label
        if (e.label) {
          ctx.save();
          ctx.translate(mx, my);
          const angle = Math.atan2(ty2 - sy, tx2 - sx);
          if (Math.abs(angle) > Math.PI / 2) ctx.rotate(angle + Math.PI);
          else ctx.rotate(angle);
          ctx.fillStyle = "#555";
          ctx.fillText(e.label, 0, -6 / scale);
          ctx.restore();
        }
      }

      // Draw nodes
      for (const n of nodes) {
        const r = (TYPE_RADIUS[n.type] || DEFAULT_R) / scale * scale; // unscaled r
        const nr = TYPE_RADIUS[n.type] || DEFAULT_R;
        const isHovered = n === hoveredNode;

        ctx.beginPath();
        ctx.arc(n.x, n.y, nr, 0, Math.PI * 2);
        ctx.fillStyle   = isHovered ? "#333" : "#000";
        ctx.strokeStyle = "#000";
        ctx.lineWidth   = isHovered ? 2 / scale : 1 / scale;
        ctx.fill();
        ctx.stroke();

        // Node label
        const labelSize = Math.min(11, Math.max(8, nr * 0.75));
        ctx.font        = `700 ${labelSize / scale}px Inter, sans-serif`;
        ctx.fillStyle   = "#fff";
        ctx.textAlign   = "center";
        ctx.textBaseline = "middle";

        // Truncate long labels
        let label = n.name || n.id || "";
        if (label.length > 14) label = label.slice(0, 12) + "…";
        ctx.fillText(label, n.x, n.y);

        // Type tag below node
        ctx.font        = `${8 / scale}px JetBrains Mono, monospace`;
        ctx.fillStyle   = "#555";
        ctx.fillText((n.type || "").toUpperCase(), n.x, n.y + nr + 10 / scale);
      }

      ctx.restore();
    }

    function loop() {
      if (!running) return;
      tick();
      draw();
      animFrame = requestAnimationFrame(loop);
    }

    // Load graph data and initialise nodes/edges
    async function loadGraphData(filterFile = "all") {
      try {
        const [eRes, rRes] = await Promise.all([
          fetch("/api/graph/entities?limit=200"),
          fetch("/api/graph/relations?limit=500"),
        ]);
        const allEntities = eRes.ok ? await eRes.json() : [];
        const allRelations = rRes.ok ? await rRes.json() : [];

        const filteredEntities = filterFile === "all"
          ? allEntities
          : allEntities.filter((e) => e.sourceFile === filterFile);
        const entityIds = new Set(filteredEntities.map((e) => e.id));

        // Initialise nodes with random positions in a circle
        const W = cssW(), H = cssH();
        nodes = filteredEntities.map((e, i) => {
          const angle = (i / filteredEntities.length) * Math.PI * 2;
          const r = Math.min(W, H) * 0.25;
          return {
            ...e,
            x: Math.cos(angle) * r + (Math.random() - 0.5) * 20,
            y: Math.sin(angle) * r + (Math.random() - 0.5) * 20,
            vx: 0, vy: 0,
          };
        });

        const nodeMap = new Map(nodes.map((n) => [n.id, n]));

        edges = allRelations
          .filter((r) => entityIds.has(r.fromName?.toLowerCase().replace(/[^a-z0-9]/g,"_").replace(/^_+|_+$/g,""))
                      || entityIds.has(r.toName?.toLowerCase().replace(/[^a-z0-9]/g,"_").replace(/^_+|_+$/g,"")))
          .map((r) => {
            // Match by name since snapshot uses names not IDs for relations
            const src = nodes.find((n) => n.name?.toLowerCase() === r.fromName?.toLowerCase());
            const tgt = nodes.find((n) => n.name?.toLowerCase() === r.toName?.toLowerCase());
            if (!src || !tgt || src === tgt) return null;
            return { source: src, target: tgt, label: r.relation || "" };
          })
          .filter(Boolean);

        // Deduplicate edges
        const edgeSeen = new Set();
        edges = edges.filter((e) => {
          const k = `${e.source.id}|${e.target.id}|${e.label}`;
          if (edgeSeen.has(k)) return false;
          edgeSeen.add(k); return true;
        });

        // Reset view
        tx = 0; ty = 0; scale = 1; rotation = 0;
      } catch (err) {
        console.error("[GraphCanvas] Failed to load graph data:", err);
      }
    }

    // Pointer events
    canvas.addEventListener("mousedown", (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const hit = hitTest(mx, my);
      if (hit) {
        dragNode = hit;
        canvas.style.cursor = "grabbing";
      } else if (e.shiftKey) {
        isRotating = true;
        canvas.style.cursor = "crosshair";
      } else {
        isPanning = true;
        canvas.style.cursor = "grabbing";
      }
      lastMX = mx; lastMY = my;
    });

    canvas.addEventListener("mousemove", (e) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const dx = mx - lastMX, dy = my - lastMY;

      if (dragNode) {
        const w = mouseToWorld(mx, my);
        dragNode.x = w.x; dragNode.y = w.y;
        dragNode.vx = 0; dragNode.vy = 0;
      } else if (isPanning) {
        tx += dx; ty += dy;
      } else if (isRotating) {
        rotation += dx * 0.005;
      }

      lastMX = mx; lastMY = my;

      // Tooltip
      const hit = hitTest(mx, my);
      hoveredNode = hit;
      if (hit && tooltip) {
        const src = hit.sourceFile ? hit.sourceFile.split("/").pop() : "—";
        tooltip.innerHTML = `<strong>${hit.name || hit.id}</strong><br>TYPE: ${hit.type || "Entity"}<br>SOURCE: ${src}`;
        tooltip.style.display = "block";
        tooltip.style.left = (e.clientX - rect.left + 14) + "px";
        tooltip.style.top  = (e.clientY - rect.top  - 10) + "px";
        canvas.style.cursor = "pointer";
      } else {
        if (tooltip) tooltip.style.display = "none";
        if (!dragNode && !isPanning && !isRotating) canvas.style.cursor = "grab";
      }
    });

    canvas.addEventListener("mouseup", () => {
      dragNode = null; isPanning = false; isRotating = false;
      canvas.style.cursor = "grab";
    });

    canvas.addEventListener("mouseleave", () => {
      dragNode = null; isPanning = false; isRotating = false;
      hoveredNode = null;
      if (tooltip) tooltip.style.display = "none";
    });

    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.1 : 0.91;
      scale = Math.min(5, Math.max(0.1, scale * factor));
    }, { passive: false });

    // Toolbar buttons
    document.getElementById("graphBtnZoomIn")?.addEventListener("click",     () => { scale = Math.min(5, scale * 1.25); });
    document.getElementById("graphBtnZoomOut")?.addEventListener("click",    () => { scale = Math.max(0.1, scale / 1.25); });
    document.getElementById("graphBtnRotateCCW")?.addEventListener("click",  () => { rotation -= Math.PI / 8; });
    document.getElementById("graphBtnRotateCW")?.addEventListener("click",   () => { rotation += Math.PI / 8; });
    document.getElementById("graphBtnReset")?.addEventListener("click",      () => { tx = 0; ty = 0; scale = 1; rotation = 0; });

    // Source filter also reloads canvas
    document.getElementById("graphSourceFilter")?.addEventListener("change", async (e) => {
      await loadGraphData(e.target.value);
    });

    // Resize observer
    const ro = new ResizeObserver(() => { resizeCanvas(); draw(); });
    ro.observe(canvas);

    // Init
    resizeCanvas();
    loadGraphData("all").then(() => {
      running = true;
      loop();
    });
  }

  // Reindex All Button
  btnReindexAll.addEventListener("click", async () => {
    if (!confirm("Trigger re-indexing for all documents in docs/ folder?")) return;
    btnReindexAll.innerText = "QUEUING...";
    try {
      const res = await fetch("/api/actions/reindex-all", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Re-indexing failed");
      alert(`Queued ${data.queuedCount} documents for re-indexing.`);
    } catch (err) {
      alert(`Failed to trigger re-index: ${err.message}`);
    } finally {
      btnReindexAll.innerText = "REINDEX ALL";
      fetchDocuments();
      fetchKnowledgeGraph();
    }
  });

  // Utility helpers
  function showFeedback(el, msg, type) {
    if (!el) return;
    el.innerText = msg;
    el.className = `feedback-msg show ${type}`;
  }

  function escapeHtml(str) {
    return (str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  // Initial loads & polling
  fetchStatus();
  fetchDocuments();
  fetchKnowledgeGraph();
  setInterval(fetchStatus, 4000);
});

