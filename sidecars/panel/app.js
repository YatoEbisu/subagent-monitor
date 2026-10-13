// Frontend logic for Subagent Mission Control extension
// Interactive Pan & Zoom support (click-and-drag panning and mouse wheel zooming)

const sidecar = window.sidecar;

const state = {
  conversationId: null,
  subagents: [],
  mainAgent: null,
  selectedId: 'root',
  lastFetched: null,
  collapsedParents: new Set(),
};

window.toggleParentCollapse = (parentId, event) => {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  if (state.collapsedParents.has(parentId)) {
    state.collapsedParents.delete(parentId);
  } else {
    state.collapsedParents.add(parentId);
  }
  renderDAG();
  renderSidebar();
};

window.expandAllParents = () => {
  state.collapsedParents.clear();
  renderDAG();
  renderSidebar();
};

window.collapseAllParents = () => {
  state.collapsedParents.clear();
  const { allNodes } = buildSubagentHierarchy(state.subagents || []);
  allNodes.forEach((n) => {
    if (n.children && n.children.length > 0) {
      state.collapsedParents.add(n.id);
    }
  });
  renderDAG();
  renderSidebar();
};

// Camera State (Pan & Zoom)
const viewport = {
  x: 20,
  y: 20,
  scale: 1,
  isInitialized: false,
  isDragging: false,
  startX: 0,
  startY: 0,
  graphWidth: 640,
  graphHeight: 300,
};

const $ = (id) => document.getElementById(id);

async function callApi(path, options = {}) {
  if (!sidecar) return null;
  try {
    const res = await sidecar.fetch(path, options);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return await res.json();
  } catch (err) {
    console.error(`Erro ao chamar API ${path}:`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Atualização de Transform do SVG (Pan & Zoom a 60 FPS)
// ---------------------------------------------------------------------------

function applyTransform() {
  const layer = $('viewport-layer');
  const label = $('zoom-label-text');
  if (layer) {
    layer.setAttribute('transform', `translate(${viewport.x}, ${viewport.y}) scale(${viewport.scale})`);
  }
  if (label) {
    label.textContent = `${Math.round(viewport.scale * 100)}%`;
  }
}

function autoFitGraph(force = false) {
  const container = $('dag-container');
  if (!container) return;

  const rect = container.getBoundingClientRect();
  const availW = rect.width || 600;
  const availH = rect.height || 400;

  if (!viewport.isInitialized || force) {
    const scaleY = (availH - 50) / viewport.graphHeight;
    const scaleX = (availW - 40) / viewport.graphWidth;
    const fitScale = Math.min(1.0, Math.max(0.3, Math.min(scaleX, scaleY)));

    viewport.scale = fitScale;
    viewport.x = Math.max(20, (availW - viewport.graphWidth * fitScale) / 2);
    // Folga confortável no topo para nunca cortar o primeiro nó
    viewport.y = 25;
    viewport.isInitialized = true;
  }

  applyTransform();
}

function zoomAt(targetX, targetY, factor) {
  const newScale = Math.min(Math.max(0.2, viewport.scale * factor), 2.5);
  viewport.x = targetX - (targetX - viewport.x) * (newScale / viewport.scale);
  viewport.y = targetY - (targetY - viewport.y) * (newScale / viewport.scale);
  viewport.scale = newScale;
  applyTransform();
}

// ---------------------------------------------------------------------------
// Configurações de Cores e Estilos dos Nós
// ---------------------------------------------------------------------------

function getNodeColors(sub) {
  const isWaiting = sub.state === 'waiting_for_input' || sub.state === 'blocked' || sub.state === 'needs_attention';
  const isDone = sub.state === 'done';
  const isRunning = sub.state === 'running';
  const isErrored = sub.state === 'errored';
  const isSelected = state.selectedId === sub.id;

  let strokeCol = '#2b2b32';
  let bgCol = '#161619';
  let marker = 'url(#arr-gray)';
  let badgeBg = '#222227';
  let badgeFg = '#a1a1aa';
  let badgeText = 'IDLE';

  if (isWaiting) {
    strokeCol = '#f59e0b';
    bgCol = '#1c1710';
    marker = 'url(#arr-amber)';
    badgeBg = '#382508';
    badgeFg = '#fbbf24';
    badgeText = 'REQUIRES APPROVAL';
  } else if (isRunning) {
    strokeCol = '#38bdf8';
    bgCol = '#121926';
    marker = 'url(#arr-sky)';
    badgeBg = '#0c4a6e';
    badgeFg = '#38bdf8';
    badgeText = 'RUNNING';
  } else if (isDone) {
    strokeCol = '#10b981';
    bgCol = '#101a14';
    marker = 'url(#arr-green)';
    badgeBg = '#064e3b';
    badgeFg = '#34d399';
    badgeText = 'COMPLETED';
  } else if (isErrored) {
    strokeCol = '#f43f5e';
    bgCol = '#201014';
    marker = 'url(#arr-rose)';
    badgeBg = '#4c0519';
    badgeFg = '#fb7185';
    badgeText = 'ERROR';
  }

  return { strokeCol, bgCol, marker, badgeBg, badgeFg, badgeText, isSelected, isRunning, isDone, isErrored, isWaiting };
}

// ---------------------------------------------------------------------------
// Hierarchical Tree Helpers
// ---------------------------------------------------------------------------

function buildSubagentHierarchy(subagents) {
  const nodes = subagents.map((s) => ({
    ...s,
    children: [],
    parent: null,
    depth: 1,
    x: 0,
    y: 0,
    subtreeH: 0
  }));

  const byId = new Map();
  const byRole = new Map();
  const byConvId = new Map();

  nodes.forEach((n) => {
    byId.set(n.id, n);
    if (n.role) byRole.set(n.role, n);
    if (n.conversationId) byConvId.set(n.conversationId, n);
  });

  function isAncestor(potentialAncestor, node) {
    let curr = potentialAncestor;
    while (curr) {
      if (curr === node) return true;
      curr = curr.parent;
    }
    return false;
  }

  const roots = [];
  nodes.forEach((n) => {
    if (!n.parentId || n.parentId === 'root') {
      roots.push(n);
    } else {
      const parent = byId.get(n.parentId) || byRole.get(n.parentId) || byConvId.get(n.parentId);
      if (parent && parent !== n && !isAncestor(parent, n)) {
        parent.children.push(n);
        n.parent = parent;
      } else {
        roots.push(n);
      }
    }
  });

  function assignDepth(node, depth) {
    node.depth = depth;
    node.children.forEach((c) => assignDepth(c, depth + 1));
  }
  roots.forEach((r) => assignDepth(r, 1));

  return { roots, allNodes: nodes };
}

function countAllDescendants(node) {
  let count = 0;
  if (node.children) {
    count += node.children.length;
    node.children.forEach((c) => {
      count += countAllDescendants(c);
    });
  }
  return count;
}

function getVisibleDescendants(node) {
  const list = [];
  if (!state.collapsedParents.has(node.id) && node.children) {
    node.children.forEach((c) => {
      list.push(c);
      list.push(...getVisibleDescendants(c));
    });
  }
  return list;
}

function computeSubtreeH(node, nodeH = 48, gapY = 10) {
  const isCollapsed = state.collapsedParents.has(node.id);
  const visibleChildren = isCollapsed ? [] : node.children;
  if (!visibleChildren || visibleChildren.length === 0) {
    node.subtreeH = nodeH;
    return node.subtreeH;
  }
  let totalH = 0;
  visibleChildren.forEach((c, idx) => {
    const chH = computeSubtreeH(c, nodeH, gapY);
    totalH += chH;
    if (idx > 0) totalH += gapY;
  });
  node.subtreeH = Math.max(nodeH, totalH);
  return node.subtreeH;
}

function renderDAG() {
  const container = $('dag-container');
  if (!container) return;

  const subagents = state.subagents || [];
  const count = subagents.length;

  const { roots, allNodes } = buildSubagentHierarchy(subagents);
  const hasChildren = allNodes.some((n) => n.children.length > 0);

  const nodeW = 175;
  const nodeH = 48;
  const gapX = 55;
  const gapY = 10;
  const startX = 185;

  let totalCalculatedH = 30;
  if (hasChildren) {
    roots.forEach((r) => {
      computeSubtreeH(r, nodeH, gapY);
      totalCalculatedH += r.subtreeH + 24;
    });
  } else {
    totalCalculatedH = Math.max(1, count) * 58 + 40;
  }

  let maxDepth = 1;
  const checkMaxDepth = (node) => {
    if (node.depth > maxDepth) maxDepth = node.depth;
    if (!state.collapsedParents.has(node.id) && node.children) {
      node.children.forEach(checkMaxDepth);
    }
  };
  roots.forEach(checkMaxDepth);

  const graphW = hasChildren ? Math.max(680, startX + maxDepth * (nodeW + gapX) + 40) : 440;
  const graphH = Math.max(260, totalCalculatedH + 30);

  viewport.graphWidth = graphW;
  viewport.graphHeight = graphH;

  const rootX = 15;
  const rootW = hasChildren ? 115 : 120;
  const rootH = 58;
  const rootY = Math.max(20, (graphH - rootH) / 2);

  // Criar SVG interno se ainda não existir
  let svgEl = $('dag-svg-root');
  if (!svgEl) {
    const controlsHtml = `
      <div class="zoom-controls">
        <button id="btn-zoom-in" class="zoom-btn" title="Aumentar Zoom">+</button>
        <button id="btn-zoom-out" class="zoom-btn" title="Diminuir Zoom">−</button>
        <button id="btn-zoom-reset" class="zoom-btn" title="Ajustar Visualização">⟲</button>
        <span id="zoom-label-text" class="zoom-label">100%</span>
      </div>
    `;
    container.innerHTML = controlsHtml + `<svg id="dag-svg-root" width="100%" height="100%"></svg>`;
    setupPanZoomEvents();
    svgEl = $('dag-svg-root');
  }

  // Definições de marcadores SVG
  let svgInner = `
    <defs>
      <marker id="arr-sky" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M 0 0 L 8 4 L 0 8 z" fill="#38bdf8" />
      </marker>
      <marker id="arr-green" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M 0 0 L 8 4 L 0 8 z" fill="#10b981" />
      </marker>
      <marker id="arr-amber" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M 0 0 L 8 4 L 0 8 z" fill="#f59e0b" />
      </marker>
      <marker id="arr-rose" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M 0 0 L 8 4 L 0 8 z" fill="#f43f5e" />
      </marker>
      <marker id="arr-gray" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
        <path d="M 0 0 L 8 4 L 0 8 z" fill="#334155" />
      </marker>
    </defs>
    <g id="viewport-layer">
  `;

  const doneCount = subagents.filter((s) => s.state === 'done').length;
  const runningCount = subagents.filter((s) => s.state === 'running').length;
  const isAllDone = count > 0 && doneCount === count;

  let rootBadgeBg = '#1e293b';
  let rootBadgeFg = '#94a3b8';
  let rootBadgeText = `${doneCount}/${count} Completed`;

  if (isAllDone) {
    rootBadgeBg = '#064e3b';
    rootBadgeFg = '#34d399';
    rootBadgeText = `✓ ${count}/${count} Completed`;
  } else if (runningCount > 0) {
    rootBadgeBg = '#0c4a6e';
    rootBadgeFg = '#38bdf8';
    rootBadgeText = `${runningCount} Active (${doneCount}/${count})`;
  }

  if (count === 0) {
    const mainAction = state.mainAgent?.lastAction || 'Waiting for commands';
    const mainStatus = state.mainAgent?.state === 'running' ? 'RUNNING' : 'IDLE';
    const borderCol = state.mainAgent?.state === 'running' ? '#38bdf8' : '#2b2b32';

    svgInner += `
      <g style="cursor: pointer" onclick="window.selectNode('root')">
        <rect x="220" y="${rootY}" width="180" height="${rootH}" rx="8" fill="#161619" stroke="${borderCol}" stroke-width="1.2" />
        <text x="310" y="${rootY + 22}" fill="#f4f4f5" font-size="11" font-weight="600" text-anchor="middle">Main Agent</text>
        <text x="310" y="${rootY + 37}" fill="#a1a1aa" font-size="9" text-anchor="middle">${escapeXml(mainAction)}</text>
        <rect x="270" y="${rootY + 42}" width="80" height="9" rx="2" fill="#222227" />
        <text x="310" y="${rootY + 49}" fill="#38bdf8" font-size="7" font-family="monospace" text-anchor="middle">${mainStatus}</text>
      </g>
    </g>`;
    svgEl.innerHTML = svgInner;
    autoFitGraph();
    return;
  }

  // Root Node (Main Chat)
  svgInner += `
    <g style="cursor: pointer" onclick="window.selectNode('root')">
      <rect x="${rootX}" y="${rootY}" width="${rootW}" height="${rootH}" rx="8" fill="#161619" stroke="#2b2b32" stroke-width="1.2" />
      <text x="${rootX + rootW / 2}" y="${rootY + 20}" fill="#f4f4f5" font-size="10" font-weight="600" text-anchor="middle">Main Agent</text>
      <text x="${rootX + rootW / 2}" y="${rootY + 33}" fill="#71717a" font-size="8" text-anchor="middle">Active Chat (${count})</text>
      <rect x="${rootX + 10}" y="${rootY + 39}" width="${rootW - 20}" height="11" rx="2" fill="${rootBadgeBg}" />
      <text x="${rootX + rootW / 2}" y="${rootY + 47}" fill="${rootBadgeFg}" font-size="7" font-family="monospace" font-weight="600" text-anchor="middle">${rootBadgeText}</text>
    </g>
  `;

  if (hasChildren) {
    let currentY = 20;
    const visibleNodes = [];

    function layoutSubtree(node, topY) {
      visibleNodes.push(node);
      node.x = startX + (node.depth - 1) * (nodeW + gapX);
      const isCollapsed = state.collapsedParents.has(node.id);
      const visibleChildren = isCollapsed ? [] : node.children;
      if (!visibleChildren || visibleChildren.length === 0) {
        node.y = topY;
        return;
      }
      let childY = topY;
      visibleChildren.forEach((c, idx) => {
        if (idx > 0) childY += gapY;
        layoutSubtree(c, childY);
        childY += c.subtreeH;
      });
      const first = visibleChildren[0];
      const last = visibleChildren[visibleChildren.length - 1];
      node.y = (first.y + last.y) / 2;
    }

    roots.forEach((r) => {
      r.familyTopY = currentY;
      layoutSubtree(r, currentY);
      currentY += r.subtreeH + 24;
    });

    // 1. Render Family Grouping Boxes (behind cards and edges)
    roots.forEach((r) => {
      const isCollapsed = state.collapsedParents.has(r.id);
      const descendants = getVisibleDescendants(r);
      if (descendants.length > 0 && !isCollapsed) {
        const familyNodes = [r, ...descendants];
        const maxX = Math.max(...familyNodes.map((n) => n.x + nodeW));
        const boxX = r.x - 8;
        const boxY = (r.familyTopY !== undefined ? r.familyTopY : r.y) - 8;
        const boxW = maxX - boxX + 8;
        const boxH = r.subtreeH + 16;
        const totalFamilyMembers = countAllDescendants(r) + 1;

        svgInner += `
          <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="8" 
                fill="#131316" fill-opacity="0.8" stroke="#232328" stroke-width="1" stroke-dasharray="3,3" />
          <text x="${boxX + 8}" y="${boxY + 11}" fill="#71717a" font-size="7.5" font-family="monospace">
            Family: ${escapeXml(r.role)} (${totalFamilyMembers} subagents)
          </text>
        `;
      }
    });

    // 2. Render Edges: Main Agent -> Roots
    const rootFromX = rootX + rootW;
    const rootFromY = rootY + rootH / 2;
    roots.forEach((r) => {
      const rColors = getNodeColors(r);
      const rEdgeClass = rColors.isRunning ? 'class="edge-flow"' : '';
      const toX = r.x;
      const toY = r.y + nodeH / 2;

      svgInner += `
        <path d="M ${rootFromX} ${rootFromY} C ${rootFromX + 45} ${rootFromY}, ${toX - 45} ${toY}, ${toX} ${toY}" 
              stroke="${rColors.strokeCol}" stroke-width="1.5" ${rEdgeClass} marker-end="${rColors.marker}" />
      `;
    });

    // 3. Render Edges: Parent -> Direct Child
    visibleNodes.forEach((node) => {
      const isCollapsed = state.collapsedParents.has(node.id);
      if (!isCollapsed && node.children && node.children.length > 0) {
        node.children.forEach((c) => {
          if (visibleNodes.includes(c)) {
            const fromX = node.x + nodeW;
            const fromY = node.y + nodeH / 2;
            const toX = c.x;
            const toY = c.y + nodeH / 2;
            const cColors = getNodeColors(c);
            const cEdgeClass = cColors.isRunning ? 'class="edge-flow"' : '';

            svgInner += `
              <path d="M ${fromX} ${fromY} C ${fromX + 30} ${fromY}, ${toX - 30} ${toY}, ${toX} ${toY}" 
                    stroke="${cColors.strokeCol}" stroke-width="1.5" ${cEdgeClass} marker-end="${cColors.marker}" />
            `;
          }
        });
      }
    });

    // 4. Render Nodes (Cards)
    visibleNodes.forEach((node) => {
      const colors = getNodeColors(node);
      const ring = colors.isSelected
        ? `stroke-width="2" stroke="#38bdf8"`
        : `stroke="${colors.strokeCol}" stroke-width="1.2"`;

      let statusBadge = '';
      if (colors.isWaiting) {
        statusBadge = `<g><circle cx="${node.x + nodeW - 14}" cy="${node.y + 14}" r="5" fill="#f59e0b" /><text x="${node.x + nodeW - 14}" y="${node.y + 17}" font-size="8" fill="#000" font-weight="bold" text-anchor="middle">!</text></g>`;
      } else if (colors.isRunning) {
        statusBadge = `<circle cx="${node.x + nodeW - 14}" cy="${node.y + 14}" r="4" fill="#38bdf8" class="dot-pulse" />`;
      } else if (colors.isDone) {
        statusBadge = `<g><circle cx="${node.x + nodeW - 14}" cy="${node.y + 14}" r="5" fill="#064e3b" stroke="#10b981" stroke-width="0.8" /><text x="${node.x + nodeW - 14}" y="${node.y + 17}" font-size="8" fill="#34d399" font-weight="bold" text-anchor="middle">✓</text></g>`;
      } else if (colors.isErrored) {
        statusBadge = `<g><circle cx="${node.x + nodeW - 14}" cy="${node.y + 14}" r="5" fill="#4c0519" stroke="#f43f5e" stroke-width="0.8" /><text x="${node.x + nodeW - 14}" y="${node.y + 17}" font-size="8" fill="#fb7185" font-weight="bold" text-anchor="middle">✕</text></g>`;
      }

      let collapseBtnSvg = '';
      if (node.children && node.children.length > 0) {
        const isCollapsed = state.collapsedParents.has(node.id);
        const arrow = isCollapsed ? '▸' : '▾';
        const childCount = node.children.length;
        const childLabel = childCount > 1 ? `${childCount} children` : `${childCount} child`;
        const btnW = 60;
        const btnH = 15;
        const btnX = node.x + nodeW - btnW - 8;
        const btnY = node.y + nodeH - btnH - 6;

        collapseBtnSvg = `
          <g style="cursor: pointer" onclick="window.toggleParentCollapse('${escapeXml(node.id)}', event)">
            <rect x="${btnX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="3" fill="#222227" stroke="#32323a" stroke-width="0.8" />
            <text x="${btnX + btnW / 2}" y="${btnY + 10.5}" fill="#d4d4d8" font-size="7.5" font-weight="600" text-anchor="middle">
              ${arrow} ${childLabel}
            </text>
          </g>
        `;
      }

      const modelName = getModelDisplay(node);
      const subtext = modelName ? `${escapeXml(node.type)} • ${escapeXml(modelName)}` : escapeXml(node.type);

      svgInner += `
        <g style="cursor: pointer" onclick="window.selectNode('${escapeXml(node.id)}')">
          <rect x="${node.x}" y="${node.y}" width="${nodeW}" height="${nodeH}" rx="8" fill="${colors.bgCol}" ${ring} />
          ${statusBadge}
          <text x="${node.x + 12}" y="${node.y + 18}" fill="#f8fafc" font-size="9.5" font-weight="600" text-anchor="start">${escapeXml(node.role)}</text>
          <text x="${node.x + 12}" y="${node.y + 32}" fill="#94a3b8" font-size="7.5" text-anchor="start">${subtext}</text>
          ${collapseBtnSvg}
        </g>
      `;
    });
  } else {
    // -------------------------------------------------------------------------
    // LAYOUT PLANO (3 Colunas: Root -> Subagentes -> Síntese)
    // -------------------------------------------------------------------------
    const midX = 195;
    const midW = 210;
    const midH = 50;
    const joinX = 475;
    const joinW = 120;
    const joinH = 56;
    const joinY = Math.max(20, (graphH - joinH) / 2);

    subagents.forEach((sub, idx) => {
      const subY = 20 + idx * 58;
      const colors = getNodeColors(sub);
      const edgeClass = colors.isRunning ? 'class="edge-flow"' : '';

      // Linha Pai -> Subagente
      const fromX = rootX + rootW;
      const fromY = rootY + rootH / 2;
      const toX = midX;
      const toY = subY + midH / 2;

      svgInner += `
        <path d="M ${fromX} ${fromY} C ${fromX + 40} ${fromY}, ${toX - 40} ${toY}, ${toX} ${toY}" 
              stroke="${colors.strokeCol}" stroke-width="1.5" ${edgeClass} marker-end="${colors.marker}" />
      `;

      // Linha Subagente -> Join Node
      const outX = midX + midW;
      const outY = subY + midH / 2;
      const targetJoinX = joinX;
      const targetJoinY = joinY + joinH / 2;

      const joinStrokeCol = colors.isDone
        ? '#10b981'
        : colors.isWaiting
        ? '#f59e0b'
        : colors.isErrored
        ? '#f43f5e'
        : '#24314c';
      const joinMarker = colors.isDone
        ? 'url(#arr-green)'
        : colors.isWaiting
        ? 'url(#arr-amber)'
        : colors.isErrored
        ? 'url(#arr-rose)'
        : 'url(#arr-gray)';
      const joinDash = colors.isDone ? '' : 'stroke-dasharray="3,3"';

      // Caixa do Subagente
      const ringHighlight = colors.isSelected
        ? `stroke-width="2" stroke="#38bdf8"`
        : `stroke="${colors.strokeCol}" stroke-width="1.2"`;

      let subStatusBadge = '';
      if (colors.isWaiting) {
        subStatusBadge = `<g><circle cx="${midX + midW - 14}" cy="${subY + 14}" r="5" fill="#f59e0b" /><text x="${midX + midW - 14}" y="${subY + 17}" font-size="8" fill="#000" font-weight="bold" text-anchor="middle">!</text></g>`;
      } else if (colors.isRunning) {
        subStatusBadge = `<circle cx="${midX + midW - 14}" cy="${subY + 14}" r="4" fill="#38bdf8" class="dot-pulse" />`;
      } else if (colors.isDone) {
        subStatusBadge = `<g><circle cx="${midX + midW - 14}" cy="${subY + 14}" r="5" fill="#064e3b" stroke="#10b981" stroke-width="0.8" /><text x="${midX + midW - 14}" y="${subY + 17}" font-size="8" fill="#34d399" font-weight="bold" text-anchor="middle">✓</text></g>`;
      }

      const subModelName = getModelDisplay(sub);
      const subSubtext = subModelName ? `${escapeXml(sub.type)} • ${escapeXml(subModelName)}` : escapeXml(sub.type);
      svgInner += `
        <g style="cursor: pointer" onclick="window.selectNode('${sub.id}')">
          <rect x="${midX}" y="${subY}" width="${midW}" height="${midH}" rx="8" fill="${colors.bgCol}" ${ringHighlight} />
          ${subStatusBadge}
          <text x="${midX + 12}" y="${subY + 20}" fill="#f8fafc" font-size="10" font-weight="600" text-anchor="start">${escapeXml(sub.role)}</text>
          <text x="${midX + 12}" y="${subY + 34}" fill="#94a3b8" font-size="8" text-anchor="start">${subSubtext}</text>
        </g>
      `;
    });
  }

  svgInner += `</g>`;
  svgEl.innerHTML = svgInner;

  if (!viewport.isInitialized) {
    autoFitGraph();
  } else {
    applyTransform();
  }
}

// ---------------------------------------------------------------------------
// Eventos de Pan & Zoom
// ---------------------------------------------------------------------------

function setupPanZoomEvents() {
  const container = $('dag-container');
  if (!container) return;

  // Zoom via Scroll do Mouse (Wheel)
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    zoomAt(mouseX, mouseY, factor);
  }, { passive: false });

  // Pan (Arrastar com a mãozinha)
  container.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.target.closest('.zoom-controls')) return;
    viewport.isDragging = true;
    viewport.startX = e.clientX - viewport.x;
    viewport.startY = e.clientY - viewport.y;
    container.classList.add('panning');
  });

  window.addEventListener('mousemove', (e) => {
    if (!viewport.isDragging) return;
    viewport.x = e.clientX - viewport.startX;
    viewport.y = e.clientY - viewport.startY;
    applyTransform();
  });

  window.addEventListener('mouseup', () => {
    if (viewport.isDragging) {
      viewport.isDragging = false;
      container.classList.remove('panning');
    }
  });

  // Botões de Zoom Flutuantes
  if ($('btn-zoom-in')) {
    $('btn-zoom-in').addEventListener('click', () => {
      const rect = container.getBoundingClientRect();
      zoomAt(rect.width / 2, rect.height / 2, 1.25);
    });
  }

  if ($('btn-zoom-out')) {
    $('btn-zoom-out').addEventListener('click', () => {
      const rect = container.getBoundingClientRect();
      zoomAt(rect.width / 2, rect.height / 2, 0.8);
    });
  }

  if ($('btn-zoom-reset')) {
    $('btn-zoom-reset').addEventListener('click', () => {
      autoFitGraph(true);
    });
  }
}

function getModelDisplay(sub) {
  if (!sub) return '';
  const m = String(sub.effectiveModel || sub.model || state.mainAgent?.model || '').trim();
  if (!m || m.toLowerCase() === 'inherit') return '';
  return m;
}

function renderSidebarNode(node, depth = 1) {
  const isSelected = state.selectedId === node.id;
  const colors = getNodeColors(node);
  const isCollapsed = state.collapsedParents.has(node.id);
  const numChildren = node.children ? node.children.length : 0;

  let dotPulse = '';
  if (colors.isWaiting) {
    dotPulse = '<span style="font-size: 10px;">⚠️</span>';
  } else if (colors.isRunning) {
    dotPulse = '<span class="live-dot dot-pulse" style="width: 5px; height: 5px; background: #38bdf8;"></span>';
  } else if (colors.isDone) {
    dotPulse = '<span class="live-dot" style="width: 5px; height: 5px; background: #10b981;"></span>';
  } else if (colors.isErrored) {
    dotPulse = '<span style="color: #f43f5e; font-size: 9px;">✕</span>';
  }

  const detailText = node.stateDetail || node.lastTool || 'active';
  const modelName = getModelDisplay(node);
  const modelBottom = modelName
    ? `<div class="card-bottom"${depth > 1 ? ' style="font-size: 9px; padding-left: 14px;"' : ''}><span class="model-full-name" title="Modelo: ${escapeXml(modelName)}">${escapeXml(modelName)}</span></div>`
    : '';

  let childToggleBtn = '';
  if (numChildren > 0) {
    const arrow = isCollapsed ? '▶' : '▼';
    const labelText = isCollapsed ? 'Expand' : 'Collapse';
    const childLabel = numChildren > 1 ? `${numChildren} children` : `${numChildren} child`;
    childToggleBtn = `
      <button class="child-count-pill" title="${labelText} ${childLabel}" onclick="window.toggleParentCollapse('${escapeXml(node.id)}', event)">
        <span class="pill-arrow">${arrow}</span>
        <span>${childLabel}</span>
      </button>
    `;
  }

  const isRootLevel = depth === 1;
  const cardClass = isRootLevel ? 'subagent-card' : 'child-subagent-card';
  const prefix = isRootLevel
    ? ''
    : `<span style="color: #475569; font-family: monospace; font-size: 10px; margin-right: 2px;">└─</span>`;

  let nodeHtml = `
    <div class="${cardClass} ${isSelected ? 'active' : ''} ${colors.isWaiting ? 'waiting' : ''}" onclick="window.selectNode('${escapeXml(node.id)}')">
      <div class="card-top">
        <div style="display: flex; align-items: center; gap: 6px; min-width: 0;">
          ${prefix}
          ${dotPulse}
          <span class="agent-role" onclick="${numChildren > 0 ? `window.toggleParentCollapse('${escapeXml(node.id)}', event)` : 'null'}" style="${numChildren > 0 ? 'cursor: pointer;' : ''}; ${!isRootLevel ? 'font-size: 11px;' : ''}">
            ${escapeXml(node.role)}
          </span>
          <span style="font-family: monospace; font-size: 8.5px; padding: 1px 4px; border-radius: 3px; background: #202025; color: #a1a1aa; flex-shrink: 0; border: 1px solid #2b2b32;">
            ${escapeXml(node.type)}
          </span>
        </div>
        ${childToggleBtn}
      </div>
      <div class="agent-action" style="${!isRootLevel ? 'font-size: 9.5px; padding-left: 14px;' : ''}">
        ${escapeXml(detailText)}
      </div>
      ${modelBottom}
    </div>
  `;

  // Render children recursively if not collapsed
  if (numChildren > 0 && !isCollapsed) {
    nodeHtml += `<div class="child-subagents-container">`;
    node.children.forEach((c) => {
      nodeHtml += renderSidebarNode(c, depth + 1);
    });
    nodeHtml += `</div>`;
  }

  return nodeHtml;
}

function renderSidebar() {
  const listEl = $('subagents-list');
  const totalEl = $('sidebar-total');
  const countChip = $('active-count-label');
  if (!listEl) return;

  const subagents = state.subagents || [];
  const waitingSubs = subagents.filter(
    (s) => s.state === 'waiting_for_input' || s.state === 'blocked' || s.state === 'needs_attention'
  );
  const activeCount = subagents.filter((s) => s.state === 'running').length;

  if (totalEl) totalEl.textContent = `${subagents.length} total`;
  if (countChip) {
    if (waitingSubs.length > 0) {
      countChip.innerHTML = `<span style="color: #f59e0b;">⚠️ ${waitingSubs.length} Requires Approval</span>`;
    } else {
      countChip.textContent = `${activeCount} Active`;
    }
  }

  if (subagents.length === 0) {
    const mainAction = state.mainAgent?.lastAction || 'Waiting for commands';
    listEl.innerHTML = `
      <div style="padding: 16px 10px; text-align: center; color: var(--muted-foreground, #64748b)">
        <div style="font-size: 11px; font-weight: 500; color: var(--foreground, #cbd5e1); margin-bottom: 4px;">No subagents launched</div>
        <div style="font-size: 10px; line-height: 1.4;">When the chat launches subagents in parallel, they will be listed here automatically.</div>
        <div style="margin-top: 10px; padding: 6px; background: #0c111c; border-radius: 6px; font-family: monospace; font-size: 9px; color: #38bdf8;">
          Parent Action: ${escapeXml(mainAction)}
        </div>
      </div>
    `;
    return;
  }

  let html = '';

  // 1. Alert Banner on top if any subagent is waiting for approval
  if (waitingSubs.length > 0) {
    html += `
      <div class="approval-alert-card">
        <span class="alert-icon">⚠️</span>
        <div class="alert-content">
          <div class="alert-title">${waitingSubs.length} Subagent(s) Require Approval</div>
          <div class="alert-desc">Action blocked waiting for permission or tool confirmation in chat.</div>
        </div>
      </div>
    `;
  }

  const { roots, allNodes } = buildSubagentHierarchy(subagents);
  const hasChildren = allNodes.some((n) => n.children.length > 0);

  if (hasChildren) {
    // Controls bar for expansion / counts
    html += `
      <div class="sidebar-controls-bar">
        <span class="sidebar-count-label">${roots.length} Families (${subagents.length} Total)</span>
        <div class="sidebar-btn-group">
          <button class="mini-btn" onclick="window.expandAllParents()">Expand All</button>
          <button class="mini-btn" onclick="window.collapseAllParents()">Collapse All</button>
        </div>
      </div>
    `;

    roots.forEach((r) => {
      html += renderSidebarNode(r, 1);
    });
  } else {
    // Flat layout for subagents without hierarchy
    subagents.forEach((sub) => {
      const isSelected = state.selectedId === sub.id;
      const colors = getNodeColors(sub);

      let dotPulse = '';
      if (colors.isWaiting) {
        dotPulse = '<span class="live-dot dot-pulse" style="width: 5px; height: 5px; background: #f59e0b;"></span> <span style="font-size: 10px;">⚠️</span>';
      } else if (colors.isRunning) {
        dotPulse = '<span class="live-dot dot-pulse" style="width: 5px; height: 5px; background: #38bdf8;"></span>';
      } else if (colors.isDone) {
        dotPulse = '<span class="live-dot" style="width: 5px; height: 5px; background: #10b981;"></span>';
      } else if (colors.isErrored) {
        dotPulse = '<span style="color: #f43f5e;">✕</span>';
      }

      const detailText = sub.stateDetail || sub.lastTool || 'active';
      const subModelName = getModelDisplay(sub);
      const subModelBottom = subModelName
        ? `<div class="card-bottom"><span class="model-full-name" title="Modelo: ${escapeXml(subModelName)}">${escapeXml(subModelName)}</span></div>`
        : '';

      html += `
        <div class="subagent-card ${isSelected ? 'active' : ''} ${colors.isWaiting ? 'waiting' : ''}" onclick="window.selectNode('${sub.id}')">
          <div class="card-top">
            <span class="agent-role">
              ${dotPulse}
              <span>${escapeXml(sub.role)}</span>
            </span>
            <span style="font-family: monospace; font-size: 9px; padding: 1px 4px; border-radius: 3px; background: #202025; color: #a1a1aa; border: 1px solid #2b2b32;">
              ${escapeXml(sub.type)}
            </span>
          </div>
          <div class="agent-action">
            ${escapeXml(detailText)}
          </div>
          ${subModelBottom}
        </div>
      `;
    });
  }

  listEl.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Painel de Inspeção
// ---------------------------------------------------------------------------

function updateInspector() {
  const titleEl = $('insp-title');
  const badgeEl = $('insp-badge');
  const stateEl = $('insp-state');
  const promptEl = $('insp-prompt');
  const toolEl = $('insp-tool');
  const statusDot = $('insp-status-dot');
  const chatInput = $('chat-msg-input');

  if (state.selectedId === 'root') {
    if (titleEl) titleEl.textContent = 'Main Agent';
    const mainModel = state.mainAgent?.model || '';
    if (badgeEl) badgeEl.textContent = mainModel ? `chat-root • ${mainModel}` : 'chat-root';
    const isRunning = state.mainAgent?.state === 'running';
    if (stateEl) stateEl.textContent = `Status: ${isRunning ? 'Executing' : 'Monitoring'}`;
    if (statusDot) {
      statusDot.className = 'live-dot';
      if (isRunning) statusDot.classList.add('dot-pulse');
      statusDot.style.background = isRunning ? 'var(--status-green)' : '#38bdf8';
    }
    if (promptEl) promptEl.textContent = '"Active session in Antigravity IDE."';
    if (toolEl) toolEl.textContent = state.mainAgent?.lastAction || 'No recent tools';
    if (chatInput) chatInput.placeholder = 'Send instruction to Main Agent (Enter to send)...';
    return;
  }

  const sub = (state.subagents || []).find((s) => s.id === state.selectedId);
  if (sub) {
    const isWaiting =
      sub.state === 'waiting_for_input' || sub.state === 'blocked' || sub.state === 'needs_attention';
    const isRunning = sub.state === 'running';
    const isDone = sub.state === 'done';

    const subModelName = getModelDisplay(sub);
    if (titleEl) titleEl.textContent = sub.role;
    if (badgeEl) badgeEl.textContent = subModelName
      ? `${sub.type || 'subagent'} • ${subModelName}`
      : (sub.type || 'subagent');
    if (chatInput) chatInput.placeholder = `Send instruction to ${sub.role} (Enter to send)...`;

    if (statusDot) {
      statusDot.className = 'live-dot';
      if (isWaiting) {
        statusDot.style.background = 'var(--status-amber)';
        statusDot.classList.add('dot-pulse');
      } else if (isRunning) {
        statusDot.style.background = 'var(--status-green)';
        statusDot.classList.add('dot-pulse');
      } else if (isDone) {
        statusDot.style.background = '#38bdf8';
        statusDot.classList.remove('dot-pulse');
      } else {
        statusDot.style.background = 'var(--muted-foreground)';
      }
    }

    if (stateEl) {
      if (isWaiting) {
        stateEl.innerHTML = `<span style="color: #f59e0b; font-weight: 600;">⚠️ Needs Approval</span>`;
      } else {
        stateEl.textContent = `Status: ${sub.state.charAt(0).toUpperCase() + sub.state.slice(1)}`;
      }
    }
    if (promptEl) promptEl.textContent = `"${sub.prompt || sub.stateDetail || 'No detailed prompt'}"`;
    if (toolEl) {
      if (isWaiting) {
        toolEl.innerHTML = `<span style="color: #f59e0b;">Waiting for tool authorization or confirmation in chat</span>`;
      } else {
        toolEl.textContent = sub.stateDetail || sub.lastTool || 'invoke_subagent';
      }
    }
  }
}

window.selectNode = (id) => {
  lastExecutionRenderKey = '';
  state.selectedId = id;

  // Expand panel if collapsed
  const panel = $('inspector-panel');
  if (panel && panel.classList.contains('is-collapsed')) {
    panel.classList.remove('is-collapsed');
    const toggleIcon = $('insp-toggle-icon');
    if (toggleIcon) toggleIcon.textContent = '▼';
    localStorage.setItem('subagent-monitor-inspector-collapsed', 'false');
    const savedHeight = localStorage.getItem('subagent-monitor-inspector-height') || 340;
    panel.style.height = `${savedHeight}px`;
  }

  // Open execution log view for this node
  switchInspectorTab('execution');

  renderDAG();
  renderSidebar();
  updateInspector();
  fetchExecutionSteps();
};

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function formatMessageText(raw) {
  if (!raw) return '';

  // Extract and preserve code blocks first
  const codeBlocks = [];
  let text = String(raw).replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (match, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang: lang || '', code: code.trim() });
    return `___CODE_BLOCK_${idx}___`;
  });

  // Extract and preserve inline code
  const inlineCodes = [];
  text = text.replace(/`([^`\r\n]+)`/g, (match, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(code);
    return `___INLINE_CODE_${idx}___`;
  });

  // Escape HTML on the rest
  text = escapeXml(text);

  // Split into lines for block-level parsing
  const lines = text.split(/\r?\n/);
  const outLines = [];
  let inAlert = null;
  let alertContent = [];
  // Stack-based nested list tracker
  // Each entry: { type: 'ul'|'ol', indent: number }
  const listStack = [];

  function closeListsToIndent(targetIndent = -1, nextType = null) {
    while (listStack.length > 0) {
      const top = listStack[listStack.length - 1];
      if (top.indent > targetIndent || (top.indent === targetIndent && nextType && top.type !== nextType)) {
        outLines.push(top.type === 'ul' ? '</ul>' : '</ol>');
        listStack.pop();
      } else {
        break;
      }
    }
  }

  function closeAllLists() {
    closeListsToIndent(-1);
  }

  function closeAlert() {
    if (inAlert) {
      const type = inAlert.type.toLowerCase();
      const title = inAlert.type.toUpperCase();
      const innerHtml = alertContent.join('<br/>');
      outLines.push(`
        <div class="ag-callout ag-callout-${type}">
          <div class="ag-callout-header">
            <span class="ag-callout-icon">${inAlert.icon}</span>
            <span class="ag-callout-title">${title}</span>
          </div>
          <div class="ag-callout-body">${innerHtml}</div>
        </div>
      `);
      inAlert = null;
      alertContent = [];
    }
  }

  const alertIcons = {
    TIP: '💡',
    NOTE: 'ℹ️',
    IMPORTANT: '⚡',
    WARNING: '⚠️',
    CAUTION: '🛑'
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // GitHub alert blockquote start: > [!TIP], > [!NOTE], etc.
    const alertMatch = trimmed.match(/^&gt;\s*\[!(TIP|NOTE|IMPORTANT|WARNING|CAUTION)\]/i);
    if (alertMatch) {
      closeAllLists();
      closeAlert();
      const type = alertMatch[1].toUpperCase();
      inAlert = {
        type,
        icon: alertIcons[type] || 'ℹ️'
      };
      alertContent = [];
      continue;
    }

    // Inside Alert Blockquote
    if (inAlert) {
      if (trimmed.startsWith('&gt;')) {
        const bodyLine = trimmed.replace(/^&gt;\s?/, '');
        if (bodyLine) alertContent.push(formatInline(bodyLine));
        continue;
      } else if (trimmed === '') {
        continue;
      } else {
        closeAlert();
      }
    }

    // Normal Blockquote
    if (trimmed.startsWith('&gt;')) {
      closeAllLists();
      const quoteText = formatInline(trimmed.replace(/^&gt;\s?/, ''));
      outLines.push(`<blockquote class="ag-blockquote">${quoteText}</blockquote>`);
      continue;
    }

    // Horizontal Rule
    if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) {
      closeAllLists();
      outLines.push('<hr class="ag-hr" />');
      continue;
    }

    // Headings: ### H3, ## H2, # H1
    const hMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      closeAllLists();
      const level = hMatch[1].length;
      const hText = formatInline(hMatch[2]);
      outLines.push(`<h${level + 1} class="ag-heading ag-h${level}">${hText}</h${level + 1}>`);
      continue;
    }

    // Check for Unordered List Item: e.g. "   - item", " * item"
    const ulMatch = line.match(/^(\s*)(?:[-*+]|\&#42;)\s+(.+)$/);
    // Check for Ordered List Item: e.g. "  1. item"
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);

    if (ulMatch || olMatch) {
      const match = ulMatch || olMatch;
      const type = ulMatch ? 'ul' : 'ol';
      const indentStr = match[1] || '';
      // Approximate indentation level (tabs or spaces: 2 spaces or 1 tab = 1 level)
      const indentSpaces = indentStr.replace(/\t/g, '  ').length;

      // Close deeper lists or different type at same indentation level
      closeListsToIndent(indentSpaces, type);

      // Open new list if this is deeper than current top or list is empty
      if (listStack.length === 0 || indentSpaces > listStack[listStack.length - 1].indent) {
        outLines.push(`<${type} class="ag-${type}">`);
        listStack.push({ type, indent: indentSpaces });
      }

      outLines.push(`<li>${formatInline(match[2])}</li>`);
      continue;
    }

    // Regular line / Paragraph
    closeAllLists();
    if (trimmed === '') {
      outLines.push('<div class="ag-spacer"></div>');
    } else {
      outLines.push(`<p class="ag-p">${formatInline(line)}</p>`);
    }
  }

  closeAllLists();
  closeAlert();

  let rendered = outLines.join('\n');

  // Inline format helper
  function formatInline(str) {
    if (!str) return '';
    // Bold
    str = str.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    str = str.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    // Strikethrough
    str = str.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    // Links: [text](url)
    str = str.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="ag-link" target="_blank" rel="noopener">$1</a>');
    return str;
  }

  // Restore Inline Code
  rendered = rendered.replace(/___INLINE_CODE_(\d+)___/g, (m, idx) => {
    const code = inlineCodes[Number(idx)] || '';
    return `<code class="ag-code-inline">${escapeXml(code)}</code>`;
  });

  // Restore Code Blocks
  rendered = rendered.replace(/___CODE_BLOCK_(\d+)___/g, (m, idx) => {
    const block = codeBlocks[Number(idx)];
    if (!block) return '';
    return `
      <div class="ag-code-block">
        ${block.lang ? `<div class="ag-code-header"><span class="ag-code-lang">${escapeXml(block.lang)}</span></div>` : ''}
        <pre><code class="language-${escapeXml(block.lang)}">${escapeXml(block.code)}</code></pre>
      </div>
    `;
  });

  return rendered;
}

window.toggleThoughtBlock = (thoughtEl, event) => {
  if (event) event.stopPropagation();
  thoughtEl.classList.toggle('is-open');
};

window.toggleActivityGroup = (groupEl, event) => {
  if (event) event.stopPropagation();
  groupEl.classList.toggle('is-open');
};

let lastExecutionRenderKey = '';

// ---------------------------------------------------------------------------
// Execution Stream Feed (Antigravity Native Chat Style)
// ---------------------------------------------------------------------------

async function fetchExecutionSteps() {
  let targetConvId = null;
  if (state.selectedId === 'root') {
    targetConvId = state.conversationId;
  } else {
    const sub = (state.subagents || []).find((s) => s.id === state.selectedId);
    if (sub && sub.conversationId) {
      targetConvId = sub.conversationId;
    }
  }

  const badgeEl = $('execution-badge');
  const emptyEl = $('execution-empty');
  const streamListEl = $('execution-stream-list');
  const phaseTextEl = $('ag-phase-text');
  const statusFooter = $('ag-status-footer');
  const statusText = $('ag-status-text');

  if (!targetConvId) {
    lastExecutionRenderKey = '';
    if (badgeEl) badgeEl.textContent = '0';
    if (emptyEl) {
      emptyEl.textContent = 'No actions recorded for this agent yet.';
      emptyEl.style.display = 'block';
    }
    if (streamListEl) streamListEl.innerHTML = '';
    if (phaseTextEl) phaseTextEl.textContent = 'Idle';
    if (statusFooter) statusFooter.style.display = 'none';
    return;
  }

  try {
    const res = await callApi(`/api/execution?conversationId=${encodeURIComponent(targetConvId)}`);
    if (!res || !res.events) return;

    const events = res.events || [];
    if (badgeEl) badgeEl.textContent = events.length;

    const sub = (state.subagents || []).find((s) => s.id === state.selectedId);
    const isDone = sub ? sub.state === 'done' : (state.mainAgent?.state === 'idle');

    // Anti-flicker: if nothing changed in data or status, do NOT touch DOM
    const renderKey = `${targetConvId}:${events.length}:${events.length > 0 ? events[events.length - 1].id : ''}:${res.phase}:${isDone ? 1 : 0}`;
    if (streamListEl && streamListEl.children.length > 0 && renderKey === lastExecutionRenderKey) {
      if (statusFooter) {
        if (isDone) {
          statusFooter.classList.add('is-done');
          if (statusText) statusText.textContent = 'Done';
        } else {
          statusFooter.classList.remove('is-done');
          if (statusText) statusText.textContent = 'Working';
        }
      }
      return;
    }
    lastExecutionRenderKey = renderKey;

    if (events.length === 0) {
      if (emptyEl) {
        emptyEl.textContent = 'No conversation or actions recorded for this agent yet.';
        emptyEl.style.display = 'block';
      }
      if (streamListEl) streamListEl.innerHTML = '';
      if (phaseTextEl) phaseTextEl.textContent = res.phase || 'Waiting for commands';
      if (statusFooter) statusFooter.style.display = 'none';
      return;
    }

    if (emptyEl) emptyEl.style.display = 'none';
    if (statusFooter) statusFooter.style.display = 'flex';

    if (phaseTextEl) {
      phaseTextEl.textContent = res.phase || 'Executing tasks';
    }

    // Preserve open state of groups and thoughts
    const openGroupIds = new Set();
    const openThoughtIds = new Set();
    if (streamListEl) {
      streamListEl.querySelectorAll('.ag-activity-group.is-open').forEach((el) => {
        const id = el.getAttribute('data-id');
        if (id) openGroupIds.add(id);
      });
      streamListEl.querySelectorAll('.ag-thought-item.is-open').forEach((el) => {
        const id = el.getAttribute('data-id');
        if (id) openThoughtIds.add(id);
      });
    }

    let html = '';
    let pendingActivities = [];
    let groupIdx = 0;

    function flushActivities(isFinal = false) {
      if (pendingActivities.length === 0) return;
      const gid = `act-${groupIdx++}`;
      const isOpen = openGroupIds.has(gid) || (isFinal && !isDone && !openGroupIds.has(gid));
      const actionCount = pendingActivities.filter((a) => a.type === 'action' || a.type === 'instruction').length;
      const thoughtCount = pendingActivities.filter((a) => a.type === 'thought').length;

      let summaryText = '';
      if (actionCount > 0 && thoughtCount > 0) {
        summaryText = `Thought & executed ${actionCount} action${actionCount > 1 ? 's' : ''}`;
      } else if (actionCount > 0) {
        summaryText = `Executed ${actionCount} action${actionCount > 1 ? 's' : ''}`;
      } else {
        summaryText = `Thought Process (${thoughtCount} step${thoughtCount > 1 ? 's' : ''})`;
      }

      let itemsHtml = '';
      pendingActivities.forEach((ev) => {
        if (ev.type === 'thought') {
          const isThoughtOpen = openThoughtIds.has(ev.id);
          itemsHtml += `
            <div class="ag-thought-item ${isThoughtOpen ? 'is-open' : ''}" data-id="${escapeXml(ev.id)}">
              <div class="ag-thought-header" onclick="toggleThoughtBlock(this.parentElement, event)">
                <span>${escapeXml(ev.label)}</span>
                <span class="ag-chevron">›</span>
              </div>
              <div class="ag-thought-body">${escapeXml(ev.text)}</div>
            </div>
          `;
        } else if (ev.type === 'action' || ev.type === 'instruction') {
          let diffHtml = '';
          if (ev.diffAdd || ev.diffDel) {
            diffHtml = `<span class="ag-diff">`;
            if (ev.diffAdd) diffHtml += `<span class="ag-diff-add">+${ev.diffAdd}</span> `;
            if (ev.diffDel) diffHtml += `<span class="ag-diff-del">-${ev.diffDel}</span>`;
            diffHtml += `</span>`;
          }

          const badgeLabel = ev.badge?.label || '';
          const badgeColor = ev.badge?.color || '#94a3b8';

          itemsHtml += `
            <div class="ag-action-item">
              <span class="ag-verb">${escapeXml(ev.verb)}</span>
              ${badgeLabel ? `<span class="ag-badge" style="color: ${badgeColor}">${escapeXml(badgeLabel)}</span>` : ''}
              <span class="ag-target" title="${escapeXml(ev.target)}">${escapeXml(ev.target)}</span>
              ${ev.details ? `<span class="ag-details">${escapeXml(ev.details)}</span>` : ''}
              ${diffHtml}
            </div>
          `;
        }
      });

      html += `
        <div class="ag-activity-group ${isOpen ? 'is-open' : ''}" data-id="${gid}">
          <div class="ag-activity-header" onclick="toggleActivityGroup(this.parentElement, event)">
            <div class="ag-activity-summary">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0;">
                <path d="M12 2a7 7 0 0 0-7 7c0 2.5 1.3 4.7 3.3 6 .4.3.7.8.7 1.3V17h6v-.7c0-.5.3-1 .7-1.3 2-1.3 3.3-3.5 3.3-6a7 7 0 0 0-7-7z"/>
                <path d="M9 21h6"/>
              </svg>
              <span>${escapeXml(summaryText)}</span>
              <span class="ag-activity-badge">${actionCount + thoughtCount} step${actionCount + thoughtCount > 1 ? 's' : ''}</span>
            </div>
            <span class="ag-activity-chevron">›</span>
          </div>
          <div class="ag-activity-body">
            ${itemsHtml}
          </div>
        </div>
      `;

      pendingActivities = [];
    }

    events.forEach((ev) => {
      if (ev.type === 'user_message') {
        flushActivities();
        const timeStr = ev.timestamp
          ? new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '';
        html += `
          <div class="chat-msg-user">
            <div class="msg-meta">
              <span>${escapeXml(ev.sender || 'User')}</span>
              ${timeStr ? `<span>${escapeXml(timeStr)}</span>` : ''}
            </div>
            <div class="msg-text">${formatMessageText(ev.text)}</div>
          </div>
        `;
      } else if (ev.type === 'assistant_message') {
        flushActivities();
        const timeStr = ev.timestamp
          ? new Date(ev.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : '';
        const agentName = state.selectedId === 'root' ? 'Antigravity' : (sub?.role || 'Assistant');
        html += `
          <div class="chat-msg-assistant">
            <div class="msg-meta">
              <span class="msg-avatar" title="${escapeXml(agentName)}">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 1c.5 5 4.5 9 9.5 9.5-5 .5-9 4.5-9.5 9.5-.5-5-4.5-9-9.5-9.5 5-.5 9-4.5 9.5-9.5z"/>
                </svg>
              </span>
              <span>${escapeXml(agentName)}</span>
              ${timeStr ? `<span style="margin-left: auto; color: #71717a; font-weight: normal; font-size: 10px;">${escapeXml(timeStr)}</span>` : ''}
            </div>
            <div class="msg-text">${formatMessageText(ev.text)}</div>
          </div>
        `;
      } else {
        pendingActivities.push(ev);
      }
    });

    flushActivities(true);

    if (streamListEl) {
      const container = $('execution-log-container');
      const wasAtBottom = container && container.scrollHeight - container.scrollTop <= container.clientHeight + 60;
      streamListEl.innerHTML = html;
      if (container && wasAtBottom) {
        container.scrollTop = container.scrollHeight;
      }
    }

    // Determine working vs done status
    if (statusFooter) {
      if (isDone) {
        statusFooter.classList.add('is-done');
        if (statusText) statusText.textContent = 'Done';
      } else {
        statusFooter.classList.remove('is-done');
        if (statusText) statusText.textContent = 'Working';
      }
    }
  } catch (err) {
    console.error('Error fetching execution stream:', err);
  }
}

function switchInspectorTab(tabName) {
  state.activeTab = tabName;
  localStorage.setItem('subagent-monitor-inspector-tab', tabName);

  const tabOverview = $('tab-overview');
  const tabExecution = $('tab-execution');
  const paneOverview = $('pane-overview');
  const paneExecution = $('pane-execution');

  if (tabName === 'execution') {
    if (tabOverview) tabOverview.classList.remove('active');
    if (tabExecution) tabExecution.classList.add('active');
    if (paneOverview) paneOverview.classList.remove('active');
    if (paneExecution) paneExecution.classList.add('active');
    fetchExecutionSteps();
  } else {
    if (tabOverview) tabOverview.classList.add('active');
    if (tabExecution) tabExecution.classList.remove('active');
    if (paneOverview) paneOverview.classList.add('active');
    if (paneExecution) paneExecution.classList.remove('active');
  }
}

function setupInspectorTabs() {
  const tabOverview = $('tab-overview');
  const tabExecution = $('tab-execution');
  const quickBtn = $('btn-quick-view-exec');
  const toggleAllBtn = $('btn-toggle-all-steps');

  if (tabOverview) {
    tabOverview.addEventListener('click', (e) => {
      e.stopPropagation();
      switchInspectorTab('overview');
    });
  }

  if (tabExecution) {
    tabExecution.addEventListener('click', (e) => {
      e.stopPropagation();
      switchInspectorTab('execution');
    });
  }

  if (quickBtn) {
    quickBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      switchInspectorTab('execution');
    });
  }

  if (toggleAllBtn) {
    toggleAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.toggleAllTimelineSteps();
    });
  }

  const saved = localStorage.getItem('subagent-monitor-inspector-tab');
  if (saved === 'execution') {
    switchInspectorTab('execution');
  }
}

// ---------------------------------------------------------------------------
// Sincronização Periódica
// ---------------------------------------------------------------------------

async function fetchStatus() {
  if (!sidecar || !sidecar.conversationId) return;

  const convId = sidecar.conversationId;
  const res = await callApi(`/api/subagents?conversationId=${encodeURIComponent(convId)}`);
  if (!res) return;

  state.conversationId = convId;
  state.subagents = res.subagents || [];
  state.mainAgent = res.mainAgent || null;

  renderDAG();
  renderSidebar();
  updateInspector();

  if (state.activeTab === 'execution') {
    fetchExecutionSteps();
  }
}

async function sendDirectMessage(sourceInputId = 'chat-msg-input') {
  let input = $(sourceInputId);
  if (!input || !input.value.trim()) {
    input = $(sourceInputId === 'chat-msg-input' ? 'direct-msg-input' : 'chat-msg-input');
  }
  if (!input || !input.value.trim()) return;

  const msg = input.value.trim();
  try {
    if (sidecar && sidecar.agent) {
      await sidecar.agent.sendMessage(msg);
      if ($('chat-msg-input')) $('chat-msg-input').value = '';
      if ($('direct-msg-input')) $('direct-msg-input').value = '';
      fetchStatus();
      if (state.activeTab === 'execution') {
        fetchExecutionSteps();
      }
    }
  } catch (err) {
    console.error('Error sending message:', err);
  }
}

// ---------------------------------------------------------------------------
// Aside (Sidebar) Resizing
// ---------------------------------------------------------------------------

function setupSidebarResizer() {
  const resizer = $('sidebar-resizer');
  const sidebar = $('sidebar-right');
  if (!resizer || !sidebar) return;

  const savedWidth = localStorage.getItem('subagent-monitor-sidebar-width');
  if (savedWidth) {
    const parsed = parseInt(savedWidth, 10);
    if (!isNaN(parsed) && parsed >= 240 && parsed <= 700) {
      const widthToApply = parsed === 280 ? 360 : parsed;
      sidebar.style.width = `${widthToApply}px`;
    }
  } else {
    sidebar.style.width = '360px';
  }

  let isDragging = false;

  resizer.addEventListener('mousedown', (e) => {
    isDragging = true;
    resizer.classList.add('is-dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const windowWidth = window.innerWidth;
    const newWidth = Math.max(200, Math.min(windowWidth - 250, windowWidth - e.clientX));
    sidebar.style.width = `${newWidth}px`;
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    resizer.classList.remove('is-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const finalWidth = sidebar.getBoundingClientRect().width;
    localStorage.setItem('subagent-monitor-sidebar-width', Math.round(finalWidth));
    autoFitGraph(false);
  });
}

// ---------------------------------------------------------------------------
// Inspector Collapse / Expand / Maximize
// ---------------------------------------------------------------------------

function setupInspectorToggle() {
  const panel = $('inspector-panel');
  const toggleBtn = $('btn-toggle-inspector');
  const toggleIcon = $('insp-toggle-icon');
  if (!panel || !toggleBtn) return;

  const isCollapsed = localStorage.getItem('subagent-monitor-inspector-collapsed') === 'true';
  if (isCollapsed) {
    panel.classList.add('is-collapsed');
    panel.style.height = 'auto';
    if (toggleIcon) toggleIcon.textContent = '▶';
  } else {
    panel.classList.remove('is-collapsed');
    const savedHeight = localStorage.getItem('subagent-monitor-inspector-height') || 340;
    panel.style.height = `${savedHeight}px`;
    if (toggleIcon) toggleIcon.textContent = '▼';
  }

  const toggle = () => {
    const collapsed = panel.classList.toggle('is-collapsed');
    if (toggleIcon) toggleIcon.textContent = collapsed ? '▶' : '▼';
    localStorage.setItem('subagent-monitor-inspector-collapsed', collapsed ? 'true' : 'false');
    if (collapsed) {
      panel.style.height = 'auto';
    } else {
      const savedHeight = localStorage.getItem('subagent-monitor-inspector-height') || 340;
      panel.style.height = `${savedHeight}px`;
    }
    autoFitGraph(false);
  };

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });

  const header = panel.querySelector('.inspector-header');
  if (header) {
    header.style.cursor = 'pointer';
    header.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('input')) return;
      toggle();
    });
  }
}

function setupInspectorMaximize() {
  const expandBtn = $('btn-expand-inspector');
  const panel = $('inspector-panel');
  const icon = $('insp-expand-icon');
  if (!expandBtn || !panel) return;

  expandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (panel.classList.contains('is-collapsed')) {
      panel.classList.remove('is-collapsed');
      const toggleIcon = $('insp-toggle-icon');
      if (toggleIcon) toggleIcon.textContent = '▼';
    }
    panel.classList.toggle('is-maximized');
    const isMax = panel.classList.contains('is-maximized');
    if (icon) icon.textContent = isMax ? '⤡' : '⤢';
    autoFitGraph(false);
  });
}

// ---------------------------------------------------------------------------
// Inspector Height Resizing (Vertical Resizer)
// ---------------------------------------------------------------------------

function setupInspectorResizer() {
  const resizer = $('inspector-resizer');
  const panel = $('inspector-panel');
  const contentArea = panel ? panel.closest('.content-area') : null;
  if (!resizer || !panel || !contentArea) return;

  const defaultHeight = 340;
  const savedHeight = localStorage.getItem('subagent-monitor-inspector-height');
  let currentHeight = defaultHeight;
  if (savedHeight) {
    const parsed = parseInt(savedHeight, 10);
    if (!isNaN(parsed) && parsed >= 120 && parsed <= 800) {
      currentHeight = parsed;
    }
  }

  if (!panel.classList.contains('is-collapsed') && !panel.classList.contains('is-maximized')) {
    panel.style.height = `${currentHeight}px`;
  }

  let isDragging = false;

  resizer.addEventListener('mousedown', (e) => {
    if (panel.classList.contains('is-collapsed')) {
      panel.classList.remove('is-collapsed');
      const toggleIcon = $('insp-toggle-icon');
      if (toggleIcon) toggleIcon.textContent = '▼';
      localStorage.setItem('subagent-monitor-inspector-collapsed', 'false');
    }
    if (panel.classList.contains('is-maximized')) {
      panel.classList.remove('is-maximized');
      const icon = $('insp-expand-icon');
      if (icon) icon.textContent = '⤢';
    }

    isDragging = true;
    resizer.classList.add('is-dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = contentArea.getBoundingClientRect();
    const newHeight = Math.max(120, Math.min(rect.height - 80, rect.bottom - e.clientY));
    panel.style.height = `${newHeight}px`;
    currentHeight = newHeight;
  });

  window.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    resizer.classList.remove('is-dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    const finalHeight = panel.getBoundingClientRect().height;
    localStorage.setItem('subagent-monitor-inspector-height', Math.round(finalHeight));
    autoFitGraph(false);
  });
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

async function init() {
  if ($('btn-refresh')) {
    $('btn-refresh').addEventListener('click', async () => {
      const btn = $('btn-refresh');
      btn.classList.add('is-refreshing');
      try {
        await fetchStatus();
      } finally {
        setTimeout(() => {
          btn.classList.remove('is-refreshing');
        }, 650);
      }
    });
  }

  if ($('direct-msg-send')) {
    $('direct-msg-send').addEventListener('click', () => sendDirectMessage('direct-msg-input'));
  }
  if ($('direct-msg-input')) {
    $('direct-msg-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendDirectMessage('direct-msg-input');
    });
  }

  if ($('chat-msg-send')) {
    $('chat-msg-send').addEventListener('click', () => sendDirectMessage('chat-msg-input'));
  }
  if ($('chat-msg-input')) {
    $('chat-msg-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendDirectMessage('chat-msg-input');
    });
  }

  if ($('btn-scroll-bottom')) {
    $('btn-scroll-bottom').addEventListener('click', (e) => {
      e.stopPropagation();
      const container = $('execution-log-container');
      if (container) container.scrollTop = container.scrollHeight;
    });
  }

  if (sidecar && sidecar.getWorkspaceUris) {
    try {
      const uris = await sidecar.getWorkspaceUris();
      if (uris && uris.length > 0) {
        const folder = uris[0].split('/').pop();
        $('workspace-label').textContent = `Workspace: ${folder}`;
      }
    } catch {}
  }

  setupPanZoomEvents();
  setupSidebarResizer();
  setupInspectorToggle();
  setupInspectorResizer();
  setupInspectorMaximize();
  setupInspectorTabs();
  fetchStatus();
  setInterval(fetchStatus, 1500);
}

document.addEventListener('DOMContentLoaded', init);
