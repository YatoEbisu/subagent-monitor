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
  const parents = (state.subagents || []).filter((s) => !s.parentId);
  parents.forEach((p) => state.collapsedParents.add(p.id));
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

function renderDAG() {
  const container = $('dag-container');
  if (!container) return;

  const subagents = state.subagents || [];
  const count = subagents.length;

  const hasChildren = subagents.some((s) => !!s.parentId);
  const parents = hasChildren ? subagents.filter((s) => !s.parentId) : subagents;
  const children = hasChildren ? subagents.filter((s) => !!s.parentId) : [];

  // Mapear filhos de cada pai
  const childrenByParent = new Map();
  parents.forEach((p) => childrenByParent.set(p.id, []));
  children.forEach((c) => {
    let p = parents.find(
      (parent) =>
        parent.id === c.parentId ||
        parent.role === c.parentId ||
        (parent.conversationId && parent.conversationId === c.parentId)
    );
    if (!p && parents.length > 0) p = parents[0];
    if (p) {
      if (!childrenByParent.has(p.id)) childrenByParent.set(p.id, []);
      childrenByParent.get(p.id).push(c);
    }
  });

  // Calcular dimensões do grafo somando as alturas de cada família
  const pH = 48;
  const cH = 46;
  const childGap = 8;
  let totalCalculatedH = 30;

  if (hasChildren) {
    parents.forEach((p) => {
      const pChildren = childrenByParent.get(p.id) || [];
      const isCollapsed = state.collapsedParents.has(p.id);
      const famH =
        isCollapsed || pChildren.length === 0
          ? pH
          : Math.max(pH, pChildren.length * cH + (pChildren.length - 1) * childGap);
      totalCalculatedH += famH + 20;
    });
  } else {
    totalCalculatedH = Math.max(1, count) * 58 + 40;
  }

  const graphW = hasChildren ? 660 : 440;
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
    // -------------------------------------------------------------------------
    // CLUSTERED TREE LAYOUT (Families: Parent + Children aligned horizontally)
    // -------------------------------------------------------------------------
    const pX = 220;
    const pW = 175;
    const cX = 445;
    const cW = 170;

    let currentY = 20;

    parents.forEach((p) => {
      const pChildren = childrenByParent.get(p.id) || [];
      const numChildren = pChildren.length;
      const isCollapsed = state.collapsedParents.has(p.id);
      const famH =
        isCollapsed || numChildren === 0
          ? pH
          : Math.max(pH, numChildren * cH + (numChildren - 1) * childGap);

      // Family Visual Grouping Box (when expanded and with children)
      if (numChildren > 0 && !isCollapsed) {
        const boxX = pX - 6;
        const boxY = currentY - 6;
        const boxW = cX + cW - boxX + 6;
        const boxH = famH + 12;

        svgInner += `
          <rect x="${boxX}" y="${boxY}" width="${boxW}" height="${boxH}" rx="8" 
                fill="#131316" fill-opacity="0.8" stroke="#232328" stroke-width="1" stroke-dasharray="3,3" />
          <text x="${boxX + 8}" y="${boxY + 10}" fill="#71717a" font-size="7.5" font-family="monospace">
            Family: ${escapeXml(p.role)} (${numChildren} child${numChildren > 1 ? 'ren' : ''})
          </text>
        `;
      }

      // Posição do Pai: centralizado verticalmente em relação aos seus próprios filhos!
      const pY = currentY + (famH - pH) / 2;
      const pColors = getNodeColors(p);
      const pEdgeClass = pColors.isRunning ? 'class="edge-flow"' : '';

      // Linha Raiz -> Pai
      const rootFromX = rootX + rootW;
      const rootFromY = rootY + rootH / 2;
      const pToX = pX;
      const pToY = pY + pH / 2;

      svgInner += `
        <path d="M ${rootFromX} ${rootFromY} C ${rootFromX + 50} ${rootFromY}, ${pToX - 50} ${pToY}, ${pToX} ${pToY}" 
              stroke="${pColors.strokeCol}" stroke-width="1.5" ${pEdgeClass} marker-end="${pColors.marker}" />
      `;

      // Card do Pai
      const pRing = pColors.isSelected
        ? `stroke-width="2" stroke="#38bdf8"`
        : `stroke="${pColors.strokeCol}" stroke-width="1.2"`;

      // Status indicator no canto superior direito
      let pStatusBadge = '';
      if (pColors.isWaiting) {
        pStatusBadge = `<g><circle cx="${pX + pW - 14}" cy="${pY + 14}" r="5" fill="#f59e0b" /><text x="${pX + pW - 14}" y="${pY + 17}" font-size="8" fill="#000" font-weight="bold" text-anchor="middle">!</text></g>`;
      } else if (pColors.isRunning) {
        pStatusBadge = `<circle cx="${pX + pW - 14}" cy="${pY + 14}" r="4" fill="#38bdf8" class="dot-pulse" />`;
      } else if (pColors.isDone) {
        pStatusBadge = `<g><circle cx="${pX + pW - 14}" cy="${pY + 14}" r="5" fill="#064e3b" stroke="#10b981" stroke-width="0.8" /><text x="${pX + pW - 14}" y="${pY + 17}" font-size="8" fill="#34d399" font-weight="bold" text-anchor="middle">✓</text></g>`;
      }

      // Botão interativo de Colapso / Contagem de Filhos no canto inferior direito
      let collapseBtnSvg = '';
      if (numChildren > 0) {
        const btnW = 60;
        const btnH = 15;
        const btnX = pX + pW - btnW - 8;
        const btnY = pY + pH - btnH - 6;
        const arrow = isCollapsed ? '▸' : '▾';
        const childLabel = numChildren > 1 ? `${numChildren} children` : `${numChildren} child`;
        collapseBtnSvg = `
          <g style="cursor: pointer" onclick="window.toggleParentCollapse('${p.id}', event)">
            <rect x="${btnX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="3" fill="#222227" stroke="#32323a" stroke-width="0.8" />
            <text x="${btnX + btnW / 2}" y="${btnY + 10.5}" fill="#d4d4d8" font-size="7.5" font-weight="600" text-anchor="middle">
              ${arrow} ${childLabel}
            </text>
          </g>
        `;
      }

      svgInner += `
        <g style="cursor: pointer" onclick="window.selectNode('${p.id}')">
          <rect x="${pX}" y="${pY}" width="${pW}" height="${pH}" rx="8" fill="${pColors.bgCol}" ${pRing} />
          ${pStatusBadge}
          <text x="${pX + 12}" y="${pY + 18}" fill="#f8fafc" font-size="10" font-weight="600" text-anchor="start">${escapeXml(p.role)}</text>
          <text x="${pX + 12}" y="${pY + 32}" fill="#94a3b8" font-size="8.5" text-anchor="start">${escapeXml(p.type)}</text>
          ${collapseBtnSvg}
        </g>
      `;

      // Renderizar filhos deste pai no cluster da família (se houver e não estiver recolhido)
      if (numChildren > 0 && !isCollapsed) {
        pChildren.forEach((c, cIdx) => {
          const cY = currentY + cIdx * (cH + childGap);
          const cColors = getNodeColors(c);
          const cEdgeClass = cColors.isRunning ? 'class="edge-flow"' : '';

          // Linha Pai -> Filho (Local, horizontal e sem cruzamento com outros pais)
          const fromX = pX + pW;
          const fromY = pY + pH / 2;
          const toX = cX;
          const toY = cY + cH / 2;

          svgInner += `
            <path d="M ${fromX} ${fromY} C ${fromX + 30} ${fromY}, ${toX - 30} ${toY}, ${toX} ${toY}" 
                  stroke="${cColors.strokeCol}" stroke-width="1.5" ${cEdgeClass} marker-end="${cColors.marker}" />
          `;

          // Card do Filho
          const cRing = cColors.isSelected
            ? `stroke-width="2" stroke="#38bdf8"`
            : `stroke="${cColors.strokeCol}" stroke-width="1.2"`;

          let cStatusBadge = '';
          if (cColors.isWaiting) {
            cStatusBadge = `<g><circle cx="${cX + cW - 14}" cy="${cY + 14}" r="5" fill="#f59e0b" /><text x="${cX + cW - 14}" y="${cY + 17}" font-size="8" fill="#000" font-weight="bold" text-anchor="middle">!</text></g>`;
          } else if (cColors.isRunning) {
            cStatusBadge = `<circle cx="${cX + cW - 14}" cy="${cY + 14}" r="4" fill="#38bdf8" class="dot-pulse" />`;
          } else if (cColors.isDone) {
            cStatusBadge = `<g><circle cx="${cX + cW - 14}" cy="${cY + 14}" r="5" fill="#064e3b" stroke="#10b981" stroke-width="0.8" /><text x="${cX + cW - 14}" y="${cY + 17}" font-size="8" fill="#34d399" font-weight="bold" text-anchor="middle">✓</text></g>`;
          }

          svgInner += `
            <g style="cursor: pointer" onclick="window.selectNode('${c.id}')">
              <rect x="${cX}" y="${cY}" width="${cW}" height="${cH}" rx="8" fill="${cColors.bgCol}" ${cRing} />
              ${cStatusBadge}
              <text x="${cX + 12}" y="${cY + 18}" fill="#f8fafc" font-size="9.5" font-weight="600" text-anchor="start">${escapeXml(c.role)}</text>
              <text x="${cX + 12}" y="${cY + 32}" fill="#94a3b8" font-size="8" text-anchor="start">${escapeXml(c.type)}</text>
            </g>
          `;
        });
      }

      currentY += famH + 20;
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

      svgInner += `
        <g style="cursor: pointer" onclick="window.selectNode('${sub.id}')">
          <rect x="${midX}" y="${subY}" width="${midW}" height="${midH}" rx="8" fill="${colors.bgCol}" ${ringHighlight} />
          ${subStatusBadge}
          <text x="${midX + 12}" y="${subY + 20}" fill="#f8fafc" font-size="10" font-weight="600" text-anchor="start">${escapeXml(sub.role)}</text>
          <text x="${midX + 12}" y="${subY + 34}" fill="#94a3b8" font-size="8.5" text-anchor="start">${escapeXml(sub.type)}</text>
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

// ---------------------------------------------------------------------------
// Renderização da Barra Lateral (Lista)
// ---------------------------------------------------------------------------

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

  const hasChildren = subagents.some((s) => !!s.parentId);
  const parents = hasChildren ? subagents.filter((s) => !s.parentId) : subagents;
  const children = hasChildren ? subagents.filter((s) => !!s.parentId) : [];

  if (hasChildren) {
    // Controls bar for expansion / counts
    html += `
      <div class="sidebar-controls-bar">
        <span class="sidebar-count-label">${parents.length} Families (${subagents.length} Total)</span>
        <div class="sidebar-btn-group">
          <button class="mini-btn" onclick="window.expandAllParents()">Expand All</button>
          <button class="mini-btn" onclick="window.collapseAllParents()">Collapse All</button>
        </div>
      </div>
    `;

    // Map children for each parent
    const childrenByParent = new Map();
    parents.forEach((p) => childrenByParent.set(p.id, []));
    children.forEach((c) => {
      let p = parents.find(
        (parent) =>
          parent.id === c.parentId ||
          parent.role === c.parentId ||
          (parent.conversationId && parent.conversationId === c.parentId)
      );
      if (!p && parents.length > 0) p = parents[0];
      if (p) {
        if (!childrenByParent.has(p.id)) childrenByParent.set(p.id, []);
        childrenByParent.get(p.id).push(c);
      }
    });

    parents.forEach((p) => {
      const pChildren = childrenByParent.get(p.id) || [];
      const numChildren = pChildren.length;
      const isCollapsed = state.collapsedParents.has(p.id);
      const isSelected = state.selectedId === p.id;
      const colors = getNodeColors(p);

      let statusText = colors.badgeText;
      let statusColor = colors.badgeFg;
      let dotPulse = '';

      if (colors.isWaiting) {
        statusText = 'REQUIRES APPROVAL';
        statusColor = '#f59e0b';
        dotPulse = '<span class="live-dot dot-pulse" style="width: 5px; height: 5px; background: #f59e0b;"></span> <span style="font-size: 10px;">⚠️</span>';
      } else if (colors.isRunning) {
        statusText = 'RUNNING';
        statusColor = '#38bdf8';
        dotPulse = '<span class="live-dot dot-pulse" style="width: 5px; height: 5px; background: #38bdf8;"></span>';
      } else if (colors.isDone) {
        statusText = 'COMPLETED';
        statusColor = '#10b981';
        dotPulse = '<span style="color: #10b981;">✓</span>';
      } else if (colors.isErrored) {
        statusText = 'ERROR';
        statusColor = '#f43f5e';
        dotPulse = '<span style="color: #f43f5e;">✕</span>';
      }

      const detailText = p.stateDetail || p.lastTool || 'active';

      let childToggleBtn = '';
      if (numChildren > 0) {
        const arrow = isCollapsed ? '▶' : '▼';
        const labelText = isCollapsed ? 'Expand' : 'Collapse';
        const childLabel = numChildren > 1 ? `${numChildren} children` : `${numChildren} child`;
        childToggleBtn = `
          <button class="child-count-pill" title="${labelText} ${childLabel}" onclick="window.toggleParentCollapse('${p.id}', event)">
            <span class="pill-arrow">${arrow}</span>
            <span>${childLabel}</span>
          </button>
        `;
      }

      html += `
        <div class="subagent-card ${isSelected ? 'active' : ''} ${colors.isWaiting ? 'waiting' : ''}" onclick="window.selectNode('${p.id}')">
          <div class="card-top">
            <div style="display: flex; align-items: center; gap: 6px; min-width: 0;">
              ${dotPulse}
              <span class="agent-role" onclick="numChildren > 0 ? window.toggleParentCollapse('${p.id}', event) : null" style="${numChildren > 0 ? 'cursor: pointer;' : ''}">
                ${escapeXml(p.role)}
              </span>
              <span style="font-family: monospace; font-size: 8.5px; padding: 1px 4px; border-radius: 3px; background: #202025; color: #a1a1aa; flex-shrink: 0; border: 1px solid #2b2b32;">
                ${escapeXml(p.type)}
              </span>
            </div>
            ${childToggleBtn}
          </div>
          <div class="agent-action">
            ${escapeXml(detailText)}
          </div>
          <div class="card-bottom">
            <span>${escapeXml(p.model || 'inherit')}</span>
            <span style="color: ${statusColor}; font-weight: 600;">${colors.isDone ? '✓' : statusText}</span>
          </div>
        </div>
      `;

      // Renderizar filhos aninhados logo abaixo do Pai
      if (numChildren > 0 && !isCollapsed) {
        html += `<div class="child-subagents-container">`;
        pChildren.forEach((c) => {
          const cSelected = state.selectedId === c.id;
          const cColors = getNodeColors(c);

          let cStatusText = cColors.badgeText;
          let cStatusColor = cColors.badgeFg;
          let cDotPulse = '';

          if (cColors.isWaiting) {
            cStatusText = 'REQUIRES APPROVAL';
            cStatusColor = '#f59e0b';
            cDotPulse = '<span style="font-size: 10px;">⚠️</span>';
          } else if (cColors.isRunning) {
            cStatusText = 'RUNNING';
            cStatusColor = '#38bdf8';
            cDotPulse = '<span class="live-dot dot-pulse" style="width: 4px; height: 4px; background: #38bdf8;"></span>';
          } else if (cColors.isDone) {
            cStatusText = 'COMPLETED';
            cStatusColor = '#10b981';
            cDotPulse = '<span style="color: #10b981; font-size: 9px;">✓</span>';
          } else if (cColors.isErrored) {
            cStatusText = 'ERROR';
            cStatusColor = '#f43f5e';
            cDotPulse = '<span style="color: #f43f5e; font-size: 9px;">✕</span>';
          }

          const cDetailText = c.stateDetail || c.lastTool || 'active';

          html += `
            <div class="child-subagent-card ${cSelected ? 'active' : ''} ${cColors.isWaiting ? 'waiting' : ''}" onclick="window.selectNode('${c.id}')">
              <div class="card-top">
                <span class="agent-role" style="font-size: 11px;">
                  <span style="color: #475569; font-family: monospace;">└─</span>
                  ${cDotPulse}
                  <span>${escapeXml(c.role)}</span>
                </span>
                <span style="font-family: monospace; font-size: 8.5px; padding: 1px 3px; border-radius: 2px; background: #202025; color: #a1a1aa; border: 1px solid #2b2b32;">
                  ${escapeXml(c.type)}
                </span>
              </div>
              <div class="agent-action" style="font-size: 9.5px; padding-left: 14px;">
                ${escapeXml(cDetailText)}
              </div>
              <div class="card-bottom" style="font-size: 9px; padding-left: 14px;">
                <span>${escapeXml(c.model || 'inherit')}</span>
                <span style="color: ${cStatusColor}; font-weight: 600;">${cColors.isDone ? '✓' : cStatusText}</span>
              </div>
            </div>
          `;
        });
        html += `</div>`;
      }
    });
  } else {
    // Flat layout for subagents without hierarchy
    subagents.forEach((sub) => {
      const isSelected = state.selectedId === sub.id;
      const colors = getNodeColors(sub);

      let statusText = colors.badgeText;
      let statusColor = colors.badgeFg;
      let dotPulse = '';

      if (colors.isWaiting) {
        statusText = 'REQUIRES APPROVAL';
        statusColor = '#f59e0b';
        dotPulse = '<span class="live-dot dot-pulse" style="width: 5px; height: 5px; background: #f59e0b;"></span> <span style="font-size: 10px;">⚠️</span>';
      } else if (colors.isRunning) {
        statusText = 'RUNNING';
        statusColor = '#38bdf8';
        dotPulse = '<span class="live-dot dot-pulse" style="width: 5px; height: 5px; background: #38bdf8;"></span>';
      } else if (colors.isDone) {
        statusText = 'COMPLETED';
        statusColor = '#10b981';
        dotPulse = '<span style="color: #10b981;">✓</span>';
      } else if (colors.isErrored) {
        statusText = 'ERROR';
        statusColor = '#f43f5e';
        dotPulse = '<span style="color: #f43f5e;">✕</span>';
      }

      const detailText = sub.stateDetail || sub.lastTool || 'active';

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
          <div class="card-bottom">
            <span>${escapeXml(sub.model || 'inherit')}</span>
            <span style="color: ${statusColor}; font-weight: 600;">${statusText}</span>
          </div>
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

  if (state.selectedId === 'root') {
    if (titleEl) titleEl.textContent = 'Main Agent (Chat)';
    if (badgeEl) badgeEl.textContent = 'chat-root';
    if (stateEl) stateEl.textContent = `Status: ${state.mainAgent?.state === 'running' ? 'EXECUTING' : 'IDLE'}`;
    if (promptEl) promptEl.textContent = '"Active session in Antigravity IDE."';
    if (toolEl) toolEl.textContent = state.mainAgent?.lastAction || 'No recent tools';
    return;
  }

  const sub = (state.subagents || []).find((s) => s.id === state.selectedId);
  if (sub) {
    const isWaiting =
      sub.state === 'waiting_for_input' || sub.state === 'blocked' || sub.state === 'needs_attention';
    if (titleEl) titleEl.textContent = sub.role;
    if (badgeEl) badgeEl.textContent = `type: ${sub.type}`;
    if (stateEl) {
      if (isWaiting) {
        stateEl.innerHTML = `<span style="color: #f59e0b; font-weight: 700;">⚠️ WAITING FOR APPROVAL / INPUT</span>`;
      } else {
        stateEl.textContent = `Status: ${sub.state.toUpperCase()}`;
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
  state.selectedId = id;

  // Expand panel if collapsed
  const panel = $('inspector-panel');
  if (panel && panel.classList.contains('is-collapsed')) {
    panel.classList.remove('is-collapsed');
    const toggleIcon = $('insp-toggle-icon');
    if (toggleIcon) toggleIcon.textContent = '▼';
    localStorage.setItem('subagent-monitor-inspector-collapsed', 'false');
    const savedHeight = localStorage.getItem('subagent-monitor-inspector-height') || 210;
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

window.toggleThoughtBlock = (thoughtEl, event) => {
  if (event) event.stopPropagation();
  thoughtEl.classList.toggle('is-open');
};

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
    if (badgeEl) badgeEl.textContent = '0';
    if (emptyEl) {
      emptyEl.textContent = 'No actions recorded for this subagent yet.';
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

    if (events.length === 0) {
      if (emptyEl) {
        emptyEl.textContent = 'No actions recorded for this subagent yet.';
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

    // Preserve open state of thought blocks
    const openIds = new Set();
    if (streamListEl) {
      streamListEl.querySelectorAll('.ag-thought-item.is-open').forEach((el) => {
        const id = el.getAttribute('data-id');
        if (id) openIds.add(id);
      });
    }

    let html = '';
    events.forEach((ev) => {
      if (ev.type === 'thought') {
        const isOpen = openIds.has(ev.id);
        html += `
          <div class="ag-thought-item ${isOpen ? 'is-open' : ''}" data-id="${escapeXml(ev.id)}">
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

        html += `
          <div class="ag-action-item">
            <span class="ag-verb">${escapeXml(ev.verb)}</span>
            ${badgeLabel ? `<span class="ag-badge" style="color: ${badgeColor}">${escapeXml(badgeLabel)}</span>` : ''}
            <span class="ag-target">${escapeXml(ev.target)}</span>
            ${ev.details ? `<span class="ag-details">${escapeXml(ev.details)}</span>` : ''}
            ${diffHtml}
          </div>
        `;
      }
    });

    if (streamListEl) {
      const container = $('execution-log-container');
      const wasAtBottom = container && container.scrollHeight - container.scrollTop <= container.clientHeight + 60;
      streamListEl.innerHTML = html;
      if (container && wasAtBottom) {
        container.scrollTop = container.scrollHeight;
      }
    }

    // Determine working vs done status
    const sub = (state.subagents || []).find((s) => s.id === state.selectedId);
    const isDone = sub ? sub.state === 'done' : (state.mainAgent?.state === 'idle');
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

async function sendDirectMessage() {
  const input = $('direct-msg-input');
  if (!input || !input.value.trim()) return;

  const msg = input.value.trim();
  try {
    if (sidecar && sidecar.agent) {
      await sidecar.agent.sendMessage(msg);
      input.value = '';
      fetchStatus();
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
      // If it was the old default of 280px, raise to 360px
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
// Inspector Collapse / Expand
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
    const savedHeight = localStorage.getItem('subagent-monitor-inspector-height') || 210;
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
      const savedHeight = localStorage.getItem('subagent-monitor-inspector-height') || 210;
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

// ---------------------------------------------------------------------------
// Inspector Height Resizing (Vertical Resizer)
// ---------------------------------------------------------------------------

function setupInspectorResizer() {
  const resizer = $('inspector-resizer');
  const panel = $('inspector-panel');
  const contentArea = panel ? panel.closest('.content-area') : null;
  if (!resizer || !panel || !contentArea) return;

  const defaultHeight = 210;
  const savedHeight = localStorage.getItem('subagent-monitor-inspector-height');
  let currentHeight = defaultHeight;
  if (savedHeight) {
    const parsed = parseInt(savedHeight, 10);
    if (!isNaN(parsed) && parsed >= 100 && parsed <= 700) {
      currentHeight = parsed;
    }
  }

  if (!panel.classList.contains('is-collapsed')) {
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

    isDragging = true;
    resizer.classList.add('is-dragging');
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const rect = contentArea.getBoundingClientRect();
    const newHeight = Math.max(100, Math.min(rect.height - 100, rect.bottom - e.clientY));
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
    $('btn-refresh').addEventListener('click', fetchStatus);
  }

  if ($('direct-msg-send')) {
    $('direct-msg-send').addEventListener('click', sendDirectMessage);
  }

  if ($('direct-msg-input')) {
    $('direct-msg-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') sendDirectMessage();
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
  setupInspectorTabs();
  fetchStatus();
  setInterval(fetchStatus, 1500);
}

document.addEventListener('DOMContentLoaded', init);
