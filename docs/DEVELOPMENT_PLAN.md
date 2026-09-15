# Product Development Plan
## "Figmа-to-Code" — Visual UI Builder that Exports Clean React Code

---

## 1. Vision

A browser-based design tool with a **Figma-identical UI (dark theme)** where users visually build interfaces, and instead of locking designs inside a proprietary format, the tool **exports clean, editable React + CSS code as a downloadable ZIP** — ready to drop into any IDE and wire up to a real backend (Express, or anything else).

**Core differentiator vs. Locofy / Anima / Builder.io:**
- No vendor lock-in — code is fully owned once exported.
- Clean, human-readable JSX/CSS (not machine-generated spaghetti).
- Standalone canvas — no dependency on Figma as the design source.
- First-class backend-wiring step (map buttons/forms to real API endpoints).
- Heavy compute kept **client-side** to minimize server cost.

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Frontend framework | React (Vite) |
| State management | Zustand (lightweight, fast for high-frequency canvas updates) |
| Canvas rendering | Custom SVG/Canvas engine (or Konva.js to start faster) |
| Styling | CSS Modules / plain CSS (matches your preference) |
| Code generation | Custom JS serializer (JSON design tree → JSX + CSS strings) |
| Client-side zip export | JSZip + FileSaver.js |
| Backend | Node.js + Express |
| Database | MongoDB (flexible schema fits a design JSON tree) or PostgreSQL |
| Auth | JWT (access + refresh tokens) |
| Realtime (later) | Socket.io (for multiplayer editing) |
| File/asset storage | Cloudinary or S3-compatible storage |

---

## 3. Architecture: Client-Heavy, Server-Light

The guiding principle: **anything that doesn't need persistence, auth, or multi-user sync stays 100% in the browser.**

### Runs entirely on the CLIENT (zero server load)
- Canvas rendering, pan/zoom, snapping, multi-select, drag/resize/rotate math
- Design state (the JSON node tree) — held in memory (Zustand) + autosaved to **IndexedDB** for offline recovery
- Undo/redo (command pattern, in-memory)
- **Code generation**: JSON tree → JSX + CSS is pure string transformation — no need for a compiler or server round trip
- **ZIP export**: JSZip builds the archive in-browser; FileSaver.js triggers the download directly — the generated code never touches your server
- Live code preview: use Babel Standalone (runs in-browser) or `@babel/standalone` to transpile generated JSX and preview it in a sandboxed `<iframe>`

### Runs on the SERVER (kept minimal)
- Auth (signup/login/JWT)
- Save/load projects (persist the JSON design tree, not the generated code)
- Asset upload handling (images used in designs)
- Optional: real-time collaboration relay (Socket.io) — only needed if you build multiplayer editing
- Optional: an AI-assist endpoint (e.g., "clean up this component name") that proxies to an LLM API — kept server-side only to protect API keys

This means your server workload is basically CRUD + auth. The expensive, frequent operations (every drag event, every re-render, every export) never leave the browser.

---

## 4. Figma-Identical UI Spec (Dark Theme)

| Region | Details |
|---|---|
| **Top bar** | File name (editable), zoom %, Share button, Export button (top-right, blue accent) |
| **Left sidebar** | Pages panel + Layers tree (nested, collapsible, drag-to-reorder) |
| **Right sidebar** | Design panel: Position (X/Y/W/H), Fill, Stroke, Corner radius, Typography, Effects, Export settings |
| **Canvas** | Infinite pan/zoom, rulers, alignment guides, multi-select marquee, snapping to grid/objects |
| **Floating toolbar** | Move (V), Frame (F), Rectangle (R), Text (T), Ellipse (O), Comment (C) |
| **Bottom-left** | Zoom controls (%, fit-to-screen) |

**Color tokens (Figma-style dark theme):**
```
--bg-canvas: #1e1e1e
--bg-panel: #2c2c2c
--bg-panel-hover: #383838
--border: #3f3f3f
--text-primary: #ffffff
--text-secondary: #b3b3b3
--accent-blue: #18a0fb   /* selection, primary actions */
--accent-danger: #f24822
```

---

## 5. Data Model (Design JSON Tree)

This is the single source of truth — the canvas renders it, undo/redo mutates it, and code generation reads it.

```json
{
  "id": "frame_1",
  "type": "frame",
  "name": "Home Screen",
  "x": 0, "y": 0, "width": 375, "height": 812,
  "fill": "#ffffff",
  "children": [
    {
      "id": "text_1",
      "type": "text",
      "x": 20, "y": 40, "width": 200, "height": 30,
      "content": "Welcome",
      "fontSize": 24,
      "fontWeight": 600,
      "color": "#111111"
    },
    {
      "id": "button_1",
      "type": "button",
      "x": 20, "y": 100, "width": 335, "height": 48,
      "label": "Get Started",
      "fill": "#18a0fb",
      "borderRadius": 8,
      "action": { "type": "api_call", "endpoint": "", "method": "POST" }
    }
  ]
}
```

The `action` field on interactive elements (buttons, forms, inputs) is what powers the **backend-wiring step** later.

---

## 6. Development Phases

### Phase 0 — Foundation (Week 1–2)
- Repo setup (monorepo: `apps/client`, `apps/server`, `packages/codegen`)
- Dark theme design system (CSS variables, base components)
- App shell: top bar, left/right sidebar, canvas placeholder

### Phase 1 — Canvas Engine (Week 3–5)
- Infinite pan/zoom canvas
- Shape primitives: Frame, Rectangle, Text, Ellipse, Image
- Selection, drag, resize, rotate handles
- Snapping + alignment guides
- Multi-select marquee, grouping

### Phase 2 — Layers & Properties Panels (Week 6–7)
- Left sidebar: layer tree (matches canvas z-order, drag to reorder/nest)
- Right sidebar: live-bound property editor (position, fill, stroke, typography, radius)

### Phase 3 — State, Undo/Redo, Autosave (Week 8)
- Zustand store for the design tree
- Command-pattern undo/redo stack
- IndexedDB autosave (client-only, no server hit)

### Phase 4 — Code Generation Engine (Week 9–11)
- `packages/codegen`: pure JS functions, JSON tree → JSX string + CSS string
- Component splitting (each Frame → its own `.jsx` file)
- Naming/formatting pass (Prettier, run client-side via `prettier/standalone`)
- Live preview via Babel Standalone in a sandboxed iframe

### Phase 5 — Export Pipeline (Week 12)
- JSZip: assemble generated files into a project structure (`src/components/*.jsx`, `*.css`, `package.json`, `README.md`)
- FileSaver.js: trigger direct browser download — no server involved

### Phase 6 — Backend Integration Wizard (Week 13–14)
- UI to map a Button/Form element to an API endpoint (URL, method, headers)
- Generates corresponding `fetch`/`axios` call inside the exported component
- Optional `.env.example` generation for base API URL

### Phase 7 — Auth & Persistence (Week 15–16)
- Express + JWT auth
- Save/load design JSON trees to MongoDB/Postgres
- Project dashboard (list, rename, delete, duplicate)

### Phase 8 — Collaboration (Optional, Week 17–19)
- Socket.io presence + live cursors
- Operational transform or simple last-write-wins sync for the design tree

### Phase 9 — Polish & Launch (Week 20+)
- Component library / reusable components across projects
- Plugin system (community shape/component packs)
- Performance pass (virtualize large layer trees, canvas render batching)
- Testing (unit tests for codegen, e2e for canvas interactions)

---

## 7. Suggested Repo Structure

```
figma-to-code/
├── apps/
│   ├── client/          # React + Vite app (canvas, panels, codegen UI)
│   └── server/          # Express API (auth, persistence, assets)
├── packages/
│   ├── codegen/         # Shared: JSON tree -> JSX/CSS (pure functions, no deps on React/Express)
│   └── design-schema/   # Shared TypeScript/JSDoc types for the node tree
└── DEVELOPMENT_PLAN.md
```

Keeping `codegen` as an isolated package (no server or DOM dependencies) is what makes it runnable identically in the browser (for instant export) or on the server later if you ever need server-side rendering of exports.

---

## 8. Key Risks / Things to Validate Early

- **Codegen quality**: prototype the JSON → JSX transform early with a few real layouts to make sure output actually looks like code a developer would write by hand.
- **Canvas performance**: test with large trees (100+ nested nodes) before committing to a rendering approach (SVG vs Canvas vs WebGL).
- **In-browser transpilation**: Babel Standalone bundle size is nontrivial (~2MB) — lazy-load it only when the live preview panel is opened.
