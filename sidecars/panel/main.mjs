import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Response, SidecarApp } from 'sidecar_sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const STARTED_AT = Date.now();

const app = new SidecarApp();

const readLocal = (name) => {
  const filePath = join(HERE, name);
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
};

app.page('/', () => readLocal('index.html'));
app.page('/app.js', () => readLocal('app.js'));
app.api('/styles.css', () => new Response(readLocal('styles.css'), { contentType: 'text/css' }), 'GET');

app.api('/api/status', () => ({
  node: process.version,
  platform: `${platform()} ${release()}`,
  uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
}), 'GET');

function safeParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// Detecta com precisão o ciclo de vida real do subagente (running, waiting_for_input, done, errored)
function detectSubagentLifecycle(subConversationId, parentConversationId) {
  if (!subConversationId) {
    return { state: 'running', lastTool: 'invoke_subagent', stateDetail: 'Starting subagent...' };
  }

  const brainRoot = join(homedir(), '.gemini', 'antigravity', 'brain');
  const subBrain = join(brainRoot, subConversationId);

  // 1. Verificar se foi finalizado/morto pelo Antigravity (registro oficial no pai)
  if (parentConversationId) {
    const descriptorPath = join(brainRoot, parentConversationId, '.system_generated', 'subagents', `${subConversationId}.json`);
    if (existsSync(descriptorPath)) {
      try {
        const desc = safeParseJson(readFileSync(descriptorPath, 'utf8'));
        if (desc && desc.state === 'SUBAGENT_STATE_KILLED') {
          return {
            state: 'done',
            lastTool: 'Completed Successfully',
            stateDetail: 'Task completed'
          };
        }
      } catch {}
    }
  }

  // 2. Ler transcript do subagente
  let logFile = join(subBrain, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (!existsSync(logFile)) {
    logFile = join(subBrain, '.system_generated', 'logs', 'transcript.jsonl');
  }

  if (!existsSync(logFile)) {
    return {
      state: 'running',
      lastTool: 'invoke_subagent',
      stateDetail: 'Initializing subagent transcript'
    };
  }

  try {
    const raw = readFileSync(logFile, 'utf8').trim();
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) {
      return {
        state: 'running',
        lastTool: 'invoke_subagent',
        stateDetail: 'Waiting for first step'
      };
    }

    const steps = [];
    for (const l of lines) {
      const parsed = safeParseJson(l);
      if (parsed) steps.push(parsed);
    }

    if (steps.length === 0) {
      return {
        state: 'running',
        lastTool: 'invoke_subagent',
        stateDetail: 'Initializing subagent'
      };
    }

    // 3. Rastrear tarefas assíncronas em segundo plano (timers com schedule, comandos longos)
    const launchedTasks = new Map();
    const finishedTasks = new Set();

    for (let idx = 0; idx < steps.length; idx++) {
      const step = steps[idx];

      if (step.content && typeof step.content === 'string') {
        const taskMatch = step.content.match(/task id:\s*([^\s\r\n]+)/i);
        if (taskMatch && taskMatch[1]) {
          const fullId = taskMatch[1];
          const shortId = fullId.split('/').pop();
          let desc = 'Background task';
          const descMatch = step.content.match(/Task Description:\s*([^\r\n]+)/i);
          if (descMatch && descMatch[1]) desc = descMatch[1].trim();
          const isTimer = desc.toLowerCase().includes('timer') || step.content.toLowerCase().includes('timer:');
          launchedTasks.set(shortId, { fullId, desc, isTimer });
        }

        if (step.source === 'SYSTEM' || step.type === 'SYSTEM_MESSAGE') {
          const senderMatch = step.content.match(/sender=([^\s]+)/i);
          if (senderMatch && senderMatch[1]) {
            const sender = senderMatch[1];
            for (const [sId, info] of launchedTasks.entries()) {
              if (sender.includes(sId) || sender === info.fullId) {
                finishedTasks.add(sId);
              }
            }
          }
        }
      }
    }

    // Verificar arquivos de log de tasks em disco
    const activeTasks = [];
    for (const [sId, info] of launchedTasks.entries()) {
      if (!finishedTasks.has(sId)) {
        const taskLogPath = join(subBrain, '.system_generated', 'tasks', `${sId}.log`);
        if (existsSync(taskLogPath)) {
          try {
            const logTxt = readFileSync(taskLogPath, 'utf8');
            if (
              logTxt.includes('Timer fired') ||
              logTxt.includes('finished with result:') ||
              logTxt.includes('exited with code') ||
              logTxt.includes('was canceled') ||
              logTxt.includes('Task completed')
            ) {
              finishedTasks.add(sId);
              continue;
            }
          } catch {}
        }
        activeTasks.push(info);
      }
    }

    // 4. Verificar conclusão via send_message para o chamador/pai
    let lastSendMessageIndex = -1;
    let toolCallsAfterSendMessage = 0;
    let lastToolCall = null;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (step.tool_calls && Array.isArray(step.tool_calls)) {
        for (const tc of step.tool_calls) {
          lastToolCall = tc;
          if (tc.name === 'send_message') {
            lastSendMessageIndex = i;
            toolCallsAfterSendMessage = 0;
          } else if (lastSendMessageIndex !== -1) {
            toolCallsAfterSendMessage++;
          }
        }
      }
    }

    if (lastSendMessageIndex !== -1 && toolCallsAfterSendMessage === 0) {
      return {
        state: 'done',
        lastTool: 'Completed Successfully',
        stateDetail: 'Report sent to caller'
      };
    }

    // 5. Verificar se o pai recebeu mensagem deste subagente
    if (parentConversationId) {
      const parentMessagesDir = join(brainRoot, parentConversationId, '.system_generated', 'messages');
      if (existsSync(parentMessagesDir)) {
        try {
          const mFiles = readdirSync(parentMessagesDir);
          for (const mf of mFiles) {
            if (mf.endsWith('.json') && mf !== 'read.json') {
              const mData = safeParseJson(readFileSync(join(parentMessagesDir, mf), 'utf8'));
              if (mData && mData.sender === subConversationId && toolCallsAfterSendMessage === 0) {
                return {
                  state: 'done',
                  lastTool: 'Completed Successfully',
                  stateDetail: 'Result delivered to caller'
                };
              }
            }
          }
        } catch {}
      }
    }

    // 6. Verificar se ocorreu erro
    const lastStep = steps[steps.length - 1];
    if (lastStep.status === 'ERROR') {
      return {
        state: 'errored',
        lastTool: 'Error',
        stateDetail: 'Error occurred during execution'
      };
    }

    // 7. Verificar se está aguardando input/aprovação (status nativo, ask_question, prompt de segurança ou texto de bloqueio)
    if (lastStep.status === 'WAITING_FOR_INPUT' || lastStep.type === 'WAITING_FOR_INPUT') {
      return {
        state: 'waiting_for_input',
        lastTool: 'Requires Approval',
        stateDetail: 'Awaiting user response'
      };
    }
    if (lastStep.tool_calls && Array.isArray(lastStep.tool_calls) && lastStep.tool_calls.some(c => c.name === 'ask_question')) {
      return {
        state: 'waiting_for_input',
        lastTool: 'Requires Approval',
        stateDetail: 'Awaiting answer to question'
      };
    }

    if (lastStep.content && typeof lastStep.content === 'string') {
      const cLower = lastStep.content.toLowerCase();
      if (
        cLower.includes('aprovação necessária') ||
        cLower.includes('aguardando aprovação') ||
        cLower.includes('aprovacao necessaria') ||
        cLower.includes('aguardando aprovacao') ||
        cLower.includes('needs approval') ||
        cLower.includes('requires approval') ||
        cLower.includes('travado em requerer aprovação') ||
        cLower.includes('bloqueado aguardando aprovação')
      ) {
        return {
          state: 'waiting_for_input',
          lastTool: 'Requires Approval',
          stateDetail: 'Awaiting user approval'
        };
      }
    }

    // Verificar se o transcript do pai registrou este subagente como waiting_for_input / blocked / needs_attention
    if (parentConversationId) {
      const parentLog = join(brainRoot, parentConversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
      const fallbackLog = join(brainRoot, parentConversationId, '.system_generated', 'logs', 'transcript.jsonl');
      const pLogFile = existsSync(parentLog) ? parentLog : (existsSync(fallbackLog) ? fallbackLog : null);
      if (pLogFile) {
        try {
          const pRaw = readFileSync(pLogFile, 'utf8');
          const lastSubIdx = pRaw.lastIndexOf(subConversationId);
          if (lastSubIdx !== -1) {
            const surrounding = pRaw.slice(Math.max(0, lastSubIdx - 200), Math.min(pRaw.length, lastSubIdx + 300));
            if (
              surrounding.includes('"waiting_for_input"') ||
              surrounding.includes('"blocked"') ||
              surrounding.includes('"needs_attention"')
            ) {
              return {
                state: 'waiting_for_input',
                lastTool: 'Requires Approval',
                stateDetail: 'Awaiting user response'
              };
            }
          }
        } catch {}
      }
    }

    // 8. Se houver tarefa de segundo plano ativa (timers, background tasks)
    if (activeTasks.length > 0) {
      const first = activeTasks[0];
      const descLower = (first.desc || '').toLowerCase();
      if (descLower.includes('aprovação') || descLower.includes('aprovacao') || descLower.includes('approval')) {
        return {
          state: 'waiting_for_input',
          lastTool: 'Requires Approval',
          stateDetail: first.desc || 'Awaiting user approval'
        };
      }
      const detail = first.isTimer
        ? (first.desc || 'Timer in progress')
        : (first.desc || 'Background task running');
      return {
        state: 'running',
        lastTool: first.isTimer ? 'timer' : 'background_task',
        stateDetail: detail
      };
    }

    // 9. Atualmente executando ferramenta ou gerando
    if (lastStep.source === 'MODEL' && lastStep.tool_calls && lastStep.tool_calls.length > 0) {
      const tc = lastStep.tool_calls[lastStep.tool_calls.length - 1];
      const summary = (tc.args?.toolSummary || tc.args?.toolAction || tc.name).replace(/^["']|["']$/g, '');
      return {
        state: 'running',
        lastTool: tc.name,
        stateDetail: summary
      };
    }

    if (lastStep.source === 'MODEL' && lastStep.type === 'GENERIC') {
      const toolName = lastToolCall?.name || 'active';
      return {
        state: 'running',
        lastTool: toolName,
        stateDetail: 'Processing tool output...'
      };
    }

    // Se o último passo for PLANNER_RESPONSE sem tools, sem tasks pendentes e após múltiplos passos
    if (lastStep.source === 'MODEL' && lastStep.type === 'PLANNER_RESPONSE') {
      if (steps.length >= 3 && lastToolCall) {
        return {
          state: 'done',
          lastTool: 'Completed Successfully',
          stateDetail: 'Execution finished'
        };
      }
    }

    return {
      state: 'running',
      lastTool: lastToolCall?.name || 'Working...',
      stateDetail: 'Subagent active'
    };
  } catch (err) {
    console.error(`Error detecting status for subagent ${subConversationId}:`, err);
    return {
      state: 'running',
      lastTool: 'Working...',
      stateDetail: 'Active'
    };
  }
}

// Parser recursivo que extrai subagentes e subagentes aninhados (filhos)
function parseTranscriptForSubagents(targetConversationId, parentId = null, activeModelName = null) {
  let logFile = join(homedir(), '.gemini', 'antigravity', 'brain', targetConversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (!existsSync(logFile)) {
    logFile = join(homedir(), '.gemini', 'antigravity', 'brain', targetConversationId, '.system_generated', 'logs', 'transcript.jsonl');
  }
  if (!existsSync(logFile)) return [];

  try {
    const rawContent = readFileSync(logFile, 'utf8');
    const lines = rawContent.split(/\r?\n/).filter(Boolean);
    const subsMap = new Map();
    let pendingInvokedRoles = [];

    for (let i = 0; i < lines.length; i++) {
      const step = safeParseJson(lines[i]);
      if (!step) continue;

      if (step.tool_calls && Array.isArray(step.tool_calls)) {
        for (const call of step.tool_calls) {
          if (call.name === 'invoke_subagent' && call.args) {
            let subs = call.args.Subagents;
            if (typeof subs === 'string') subs = safeParseJson(subs);
            if (Array.isArray(subs)) {
              pendingInvokedRoles = [];
              for (const s of subs) {
                if (!s || (!s.Role && !s.TypeName && !s.Prompt)) continue;
                const role = s.Role || s.TypeName || 'Subagente';
                pendingInvokedRoles.push(role);
                const rawModel = s.Model || '';
                const effectiveModel = (rawModel && rawModel.toLowerCase() !== 'inherit') ? rawModel : (activeModelName || '');
                subsMap.set(role, {
                  id: role,
                  role: role,
                  type: s.TypeName || 'generic',
                  parentId: parentId,
                  prompt: s.Prompt || '',
                  model: rawModel,
                  effectiveModel: effectiveModel,
                  workspace: s.Workspace || 'inherit',
                  state: 'running',
                  lastTool: 'invoke_subagent',
                  stepIndex: i,
                  createdAt: step.created_at || new Date().toISOString()
                });
              }
            }
          }
        }
      }

      // Extrair conversationIds tanto de manage_subagents quanto de "Created the following subagents"
      if (step.content && step.content.includes('conversationId')) {
        const idMatches = Array.from(step.content.matchAll(/["']conversationId["']\s*:\s*["']([a-f0-9\-]+)["']/gi)).map(m => m[1]);
        if (idMatches.length > 0 && pendingInvokedRoles.length > 0) {
          for (let idx = 0; idx < Math.min(idMatches.length, pendingInvokedRoles.length); idx++) {
            const rName = pendingInvokedRoles[idx];
            const target = subsMap.get(rName);
            if (target && !target.conversationId) {
              target.conversationId = idMatches[idx];
            }
          }
        }

        // Atualizar status de subagentes existentes caso manage_subagents tenha sido chamado
        const jsonStart = step.content.indexOf('[');
        const jsonEnd = step.content.lastIndexOf(']');
        if (jsonStart !== -1 && jsonEnd !== -1 && jsonEnd > jsonStart) {
          const parsedList = safeParseJson(step.content.slice(jsonStart, jsonEnd + 1));
          if (Array.isArray(parsedList)) {
            for (const item of parsedList) {
              if (!item.role && !item.conversationId) continue;
              const key = item.role || item.conversationId;
              let existing = subsMap.get(key);
              if (!existing && item.conversationId) {
                for (const s of subsMap.values()) {
                  if (s.conversationId === item.conversationId) {
                    existing = s;
                    break;
                  }
                }
              }
              if (!existing) continue;

              let state = item.state || 'running';
              if (state === 'idle') {
                state = 'done';
              } else if (state === 'waiting_for_input' || state === 'blocked' || state === 'needs_attention') {
                state = 'waiting_for_input';
              }
              existing.state = state;
              if (item.stateDetail) existing.stateDetail = item.stateDetail;
              if (item.conversationId) existing.conversationId = item.conversationId;
              if (state === 'done') existing.lastTool = 'Completed Successfully';
              if (state === 'waiting_for_input') existing.lastTool = 'Requires Approval';
            }
          }
        }
      }
    }

    const result = [];
    const seenIds = new Set();
    for (const [key, sub] of subsMap.entries()) {
      if (sub.conversationId) {
        const lifecycle = detectSubagentLifecycle(sub.conversationId, targetConversationId);
        // Se já sabemos que este subagente está aguardando aprovação/input (pelo manage_subagents ou por solicitação),
        // só aceitamos transição se ele tiver concluído ('done') ou falhado ('errored').
        // NUNCA rebaixa 'waiting_for_input' para 'running' enquanto a aprovação/permissão estiver pendente!
        if (sub.state === 'waiting_for_input' && lifecycle.state === 'running') {
          sub.lastTool = 'Requires Approval';
          if (!sub.stateDetail || sub.stateDetail === 'invoke_subagent') {
            sub.stateDetail = lifecycle.stateDetail || 'Awaiting user approval';
          }
        } else {
          sub.state = lifecycle.state;
          sub.lastTool = lifecycle.lastTool;
          sub.stateDetail = lifecycle.stateDetail;
        }
      }
      result.push(sub);
      if (sub.conversationId) seenIds.add(sub.conversationId);
      seenIds.add(sub.id);

      // Leitura recursiva de subagentes aninhados (filhos)
      if (sub.conversationId) {
        const nested = parseTranscriptForSubagents(sub.conversationId, sub.id, activeModelName);
        for (const child of nested) {
          const isDuplicate = child.conversationId ? seenIds.has(child.conversationId) : seenIds.has(child.id);
          if (!isDuplicate) {
            result.push(child);
            if (child.conversationId) seenIds.add(child.conversationId);
            seenIds.add(child.id);
          }
        }
      }
    }

    return result;
  } catch (err) {
    console.error(`Error parsing transcript for ${targetConversationId}:`, err);
    return [];
  }
}

app.api('/api/subagents', (query) => {
  const conversationId = String(query.conversationId || '').trim();
  if (!conversationId) {
    return { error: 'No conversationId provided', subagents: [], activeCount: 0 };
  }

  let logFile = join(homedir(), '.gemini', 'antigravity', 'brain', conversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (!existsSync(logFile)) {
    logFile = join(homedir(), '.gemini', 'antigravity', 'brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl');
  }

  if (!existsSync(logFile)) {
    return {
      conversationId,
      found: false,
      subagents: [],
      activeCount: 0,
      mainAgent: { role: 'Main Agent', state: 'idle', lastAction: 'Waiting for requests' }
    };
  }

  try {
    let mainAgentAction = 'Idle';
    let mainAgentState = 'idle';
    let totalSteps = 0;

    const rawContent = readFileSync(logFile, 'utf8');
    const lines = rawContent.split(/\r?\n/).filter(Boolean);
    totalSteps = lines.length;

    let activeModelName = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const step = safeParseJson(lines[i]);
      if (!step) continue;
      // Extrair APENAS de mensagens legítimas do usuário/sistema, nunca de saídas de ferramentas ou código
      if (step.source === 'USER_EXPLICIT' || step.type === 'USER_INPUT') {
        const content = step.content || '';
        if (content.includes('<USER_SETTINGS_CHANGE>') && content.includes('Model Selection')) {
          const m = content.match(/<USER_SETTINGS_CHANGE>[\s\S]*?`Model Selection`\s+(?:changed\s+)?from\s+.*?\s+to\s+([A-Za-z0-9\s._\-()]+?)\.\s+No need[\s\S]*?<\/USER_SETTINGS_CHANGE>/i);
          if (m && m[1]) {
            const candidate = m[1].trim();
            if (candidate.length <= 40 && !candidate.includes('\n') && !candidate.includes('{') && !candidate.includes('}')) {
              activeModelName = candidate;
              break;
            }
          }
        }
      }
    }

    for (let i = lines.length - 1; i >= 0; i--) {
      const step = safeParseJson(lines[i]);
      if (step && step.tool_calls && Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        mainAgentAction = step.tool_calls[step.tool_calls.length - 1].name;
        mainAgentState = 'running';
        break;
      }
    }

    const subagentsList = parseTranscriptForSubagents(conversationId, null, activeModelName);
    const activeCount = subagentsList.filter(s => s.state === 'running').length;

    return {
      conversationId,
      found: true,
      subagents: subagentsList,
      activeCount,
      mainAgent: {
        role: 'Main Agent',
        state: mainAgentState,
        lastAction: mainAgentAction,
        model: activeModelName,
        totalSteps: totalSteps
      }
    };
  } catch (err) {
    console.error(`Error processing transcript: ${err.message}`);
    return {
      conversationId,
      error: err.message,
      subagents: [],
      activeCount: 0
    };
  }
}, 'GET');

function getFileBadge(filepath) {
  if (!filepath) return { label: 'FILE', color: '#94a3b8' };
  const lower = String(filepath).toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return { label: 'JS', color: '#eab308' };
  if (lower.endsWith('.ts') || lower.endsWith('.mts')) return { label: 'TS', color: '#3b82f6' };
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return { label: '</>', color: '#f97316' };
  if (lower.endsWith('.css') || lower.endsWith('.scss')) return { label: '{}', color: '#38bdf8' };
  if (lower.endsWith('.json')) return { label: '{;}', color: '#eab308' };
  if (lower.endsWith('.py')) return { label: 'PY', color: '#3b82f6' };
  if (lower.endsWith('.md')) return { label: 'MD', color: '#a855f7' };
  return { label: 'FILE', color: '#94a3b8' };
}

function cleanUserContent(raw) {
  if (!raw) return '';
  let text = String(raw);
  const matchReq = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (matchReq && matchReq[1]) {
    text = matchReq[1];
  } else {
    const matchSys = text.match(/content=([\s\S]*?)(\n<\/SYSTEM_MESSAGE>|$)/i);
    if (matchSys && matchSys[1]) {
      text = matchSys[1];
    } else {
      text = text.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '');
    }
  }
  text = text.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  text = text.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  text = text.replace(/^The following is a <SYSTEM_MESSAGE>[\s\S]*?<SYSTEM_MESSAGE>/gi, '');
  text = text.replace(/<\/SYSTEM_MESSAGE>/gi, '');
  return text.trim();
}

// Extracts detailed execution and chat history (native Antigravity IDE chat style)
function parseExecutionSteps(targetConversationId) {
  let logFile = join(homedir(), '.gemini', 'antigravity', 'brain', targetConversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
  if (!existsSync(logFile)) {
    logFile = join(homedir(), '.gemini', 'antigravity', 'brain', targetConversationId, '.system_generated', 'logs', 'transcript.jsonl');
  }
  if (!existsSync(logFile)) return { events: [], phase: 'Idle', totalSteps: 0 };

  try {
    const rawContent = readFileSync(logFile, 'utf8');
    const lines = rawContent.split(/\r?\n/).filter(Boolean);
    const events = [];

    let lastTime = null;
    let hasEdit = false;
    let hasAnalyze = false;
    let lastWasQuestion = false;

    for (let i = 0; i < lines.length; i++) {
      const step = safeParseJson(lines[i]);
      if (!step) continue;

      const stepTime = step.created_at ? new Date(step.created_at) : null;
      let durationSeconds = 1;
      if (stepTime && lastTime) {
        durationSeconds = Math.max(1, Math.round((stepTime - lastTime) / 1000));
      }
      if (stepTime) lastTime = stepTime;

      // 1. User messages (USER_EXPLICIT or USER_INPUT)
      if (step.source === 'USER_EXPLICIT' || step.type === 'USER_INPUT') {
        const userText = cleanUserContent(step.content);
        if (userText) {
          events.push({
            type: 'user_message',
            id: `user-${i}`,
            sender: 'User',
            text: userText,
            timestamp: step.created_at || null
          });
        }
        lastWasQuestion = false;
        continue;
      }

      // 1b. Initial system / subagent task instruction (if i === 0 and source is SYSTEM)
      if (i === 0 && step.source === 'SYSTEM' && step.content) {
        const sysText = cleanUserContent(step.content);
        if (sysText) {
          events.push({
            type: 'user_message',
            id: `task-0`,
            sender: 'Task Instruction',
            text: sysText,
            timestamp: step.created_at || null
          });
        }
        lastWasQuestion = false;
        continue;
      }

      // 1c. User answer to ask_question (GENERIC step immediately following ask_question)
      if (lastWasQuestion && step.type === 'GENERIC' && step.content) {
        const ansText = step.content.trim();
        if (ansText) {
          events.push({
            type: 'user_message',
            id: `answer-${i}`,
            sender: 'User Answer',
            text: ansText,
            timestamp: step.created_at || null
          });
        }
        lastWasQuestion = false;
        continue;
      }
      lastWasQuestion = false;

      // 2. Thinking / Reasoning block (Native Antigravity style)
      if (step.thinking && typeof step.thinking === 'string' && step.thinking.trim()) {
        const thoughtSec = durationSeconds || Math.floor(Math.random() * 15 + 3);
        events.push({
          type: 'thought',
          id: `thought-${i}`,
          label: `Thought for ${thoughtSec}s`,
          text: step.thinking.trim(),
          timestamp: step.created_at || null
        });
      }

      // 3. Tool calls
      if (step.tool_calls && Array.isArray(step.tool_calls)) {
        for (let tcIdx = 0; tcIdx < step.tool_calls.length; tcIdx++) {
          const tc = step.tool_calls[tcIdx];
          const args = tc.args || {};
          let verb = 'Action';
          let badge = { label: '⚙', color: '#38bdf8' };
          let target = '';
          let details = '';
          let diffAdd = 0;
          let diffDel = 0;

          if (tc.name === 'ask_question') {
            verb = 'Asked';
            badge = { label: '❓', color: '#f59e0b' };
            lastWasQuestion = true;
            if (args.questions && Array.isArray(args.questions) && args.questions[0]) {
              target = args.questions[0].question || 'Question to user';
            } else {
              target = 'Question to user';
            }
          } else if (tc.name === 'view_file') {
            verb = 'Analyzed';
            hasAnalyze = true;
            const fullPath = args.AbsolutePath || args.TargetFile || '';
            target = fullPath.split(/[\/\\]/).pop() || 'file';
            badge = getFileBadge(fullPath);
            if (args.StartLine && args.EndLine) {
              details = `#L${args.StartLine}-${args.EndLine}`;
            } else if (args.StartLine) {
              details = `#L${args.StartLine}`;
            }
          } else if (tc.name === 'replace_file_content') {
            verb = 'Edited';
            hasEdit = true;
            const fullPath = args.TargetFile || '';
            target = fullPath.split(/[\/\\]/).pop() || 'file';
            badge = getFileBadge(fullPath);
            if (args.ReplacementContent) {
              diffAdd = args.ReplacementContent.split(/\r?\n/).length;
            }
            if (args.TargetContent) {
              diffDel = args.TargetContent.split(/\r?\n/).length;
            }
          } else if (tc.name === 'write_to_file') {
            verb = 'Created';
            hasEdit = true;
            const fullPath = args.TargetFile || '';
            target = fullPath.split(/[\/\\]/).pop() || 'file';
            badge = getFileBadge(fullPath);
            if (args.CodeContent) {
              diffAdd = args.CodeContent.split(/\r?\n/).length;
            }
          } else if (tc.name === 'run_command') {
            verb = 'Ran';
            badge = { label: '>_', color: '#10b981' };
            target = (args.CommandLine || 'command').replace(/^["']|["']$/g, '').slice(0, 75);
          } else if (tc.name === 'schedule') {
            verb = 'Scheduled';
            badge = { label: '⏱️', color: '#f59e0b' };
            target = `timer for ${String(args.DurationSeconds || 0).replace(/^["']|["']$/g, '')}s`;
          } else if (tc.name === 'invoke_subagent') {
            verb = 'Spawned';
            badge = { label: '👥', color: '#38bdf8' };
            target = args.Subagents ? 'child subagents' : 'subagents';
          } else if (tc.name === 'send_message') {
            verb = 'Sent';
            badge = { label: '✉️', color: '#a855f7' };
            target = 'message to parent';
          } else {
            verb = tc.name;
            badge = { label: '⚙', color: '#38bdf8' };
            target = (args.toolSummary || args.toolAction || tc.name).replace(/^["']|["']$/g, '');
          }

          events.push({
            type: 'action',
            id: `action-${i}-${tcIdx}`,
            verb,
            badge,
            target,
            details,
            diffAdd,
            diffDel,
            timestamp: step.created_at || null
          });
        }
      }

      // 4. Assistant visible response text
      if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE' && step.content && typeof step.content === 'string' && step.content.trim()) {
        events.push({
          type: 'assistant_message',
          id: `assistant-${i}`,
          sender: 'Assistant',
          text: step.content.trim(),
          timestamp: step.created_at || null
        });
      }
    }

    let phase = 'Executing tasks';
    if (hasAnalyze && hasEdit) phase = 'Exploring files, editing files';
    else if (hasEdit) phase = 'Editing files';
    else if (hasAnalyze) phase = 'Exploring files';

    return {
      events,
      phase,
      totalSteps: lines.length
    };
  } catch (err) {
    console.error(`Error reading execution stream for ${targetConversationId}:`, err);
    return { events: [], phase: 'Error', totalSteps: 0 };
  }
}

app.api('/api/execution', (query) => {
  const conversationId = String(query.conversationId || '').trim();
  if (!conversationId) {
    return { conversationId: '', events: [], phase: 'Idle', count: 0 };
  }
  const parsed = parseExecutionSteps(conversationId);
  return {
    conversationId,
    ...parsed,
    count: parsed.events.length
  };
}, 'GET');

app.api('/api/restart', () => {
  setTimeout(() => process.exit(0), 100);
  return { restarting: true };
}, 'GET');

app.run();
