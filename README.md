# Subagent Monitor (`subagent-monitor`)

A real-time **Mission Control** UI plugin for **Google Antigravity** that visualizes active subagents, nested hierarchies, approval states, and live conversation/execution streams in an interactive DAG (Directed Acyclic Graph).

---

## ✨ Features

- **Interactive Real-Time DAG**:
  - Visualizes the **Main Agent** and all spawned **Subagents** (including multi-level nested child subagents and family groupings).
  - Smooth pan & zoom (`60 FPS` canvas dragging, mouse wheel zoom, and quick fit-to-screen controls).
  - Live status badges and animated flow edges (`RUNNING`, `COMPLETED`, `REQUIRES APPROVAL`, `ERROR`, `IDLE`).
  - Expand/collapse subagent families directly on the graph or from the sidebar.
- **Approval & Block Detection**:
  - Automatically highlights subagents waiting for user input, tool permissions, or interactive questions (`ask_question`) with prominent amber alerts.
- **Native-Style Inspector & Live Stream**:
  - **Chat & Timeline Tab**: Inspect any agent's real-time conversation history, collapsible `Thought` blocks, and grouped tool actions (`Analyzed`, `Edited` with `+add/-del` line diffs, `Ran`, `Scheduled`, `Spawned`, etc.).
  - **Overview Tab**: Quickly inspect the agent's initial prompt/instruction, active model, and last executed tool.
  - **Direct Messaging**: Send instructions directly to the active chat session from the inspector panel.
- **Customizable Layout**:
  - Resizable right sidebar and bottom inspector panel (with collapse, expand, and maximize controls persisted in `localStorage`).

---

## 📦 Installation

### Option 1: Global Installation (Recommended — Available in all workspaces)

Clone this repository directly into your global Antigravity plugins directory (`~/.gemini/config/plugins/subagent-monitor`):

**macOS / Linux:**
```bash
git clone https://github.com/YatoEbisu/subagent-monitor.git ~/.gemini/config/plugins/subagent-monitor
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/YatoEbisu/subagent-monitor.git "$env:USERPROFILE\.gemini\config\plugins\subagent-monitor"
```

After cloning, **restart Google Antigravity** so the plugin and its sidecar UI panel are discovered.

---

### Option 2: Workspace / Project Installation (Shared with your team)

To bundle this plugin inside a specific project repository so all team members get it automatically:

1. Copy or add the `subagent-monitor` folder into `.agents/plugins/subagent-monitor` at the root of your project:
   ```text
   your-project/
   └── .agents/
       └── plugins/
           └── subagent-monitor/
               ├── plugin.json
               ├── assets/
               └── sidecars/
   ```
2. Restart Antigravity (or reload the workspace).

---

## 🚀 Usage

1. Make sure the **Subagent Monitor** plugin is enabled in the **Plugins** settings page of Google Antigravity.
2. Open the **Auxiliary Side Pane** in Antigravity and select **Subagent Monitor**.
3. Whenever your main agent invokes subagents (`invoke_subagent`), the DAG graph and sidebar will automatically sync every `1.5s`:
   - **Click any node** in the DAG or card in the right sidebar to inspect its live **Chat & Timeline** or **Overview**.
   - **Click `▾ N children`** on parent nodes to collapse or expand nested subagent trees.
   - **Drag** the canvas to pan, **scroll** to zoom, or click **`⟲`** to auto-fit the graph.

---

## 🗂️ Directory Structure

```text
subagent-monitor/
├── plugin.json                  # Antigravity plugin manifest
├── README.md                    # Documentation
├── assets/
│   └── logo.svg                 # Plugin icon
└── sidecars/
    └── panel/
        ├── sidecar.json         # Sidecar Aux Pane UI configuration
        ├── package.json         # Node ES module manifest
        ├── main.mjs             # Sidecar backend (transcript parser & lifecycle detector)
        ├── index.html           # Mission Control UI layout
        ├── app.js               # Interactive DAG renderer, pan/zoom & inspector logic
        └── styles.css           # Native Antigravity Obsidian/Zinc dark theme styles
```

---

## 🔒 Privacy & Local Execution

This plugin runs **100% locally** on your machine via the Antigravity Sidecar SDK (`node main.mjs`). It reads local conversation transcripts from `~/.gemini/antigravity/brain/` in read-only mode to render the execution graph and does not make any external network requests or collect any telemetry.
