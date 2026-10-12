import { existsSync, readFileSync } from 'node:fs';
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

// Verifica se o subagente está aguardando aprovação ou input do usuário
function isSubagentWaitingInput(subConversationId) {
  if (!subConversationId) return false;
  const subLog = join(homedir(), '.gemini', 'antigravity', 'brain', subConversationId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(subLog)) return false;

  try {
    const raw = readFileSync(subLog, 'utf8').trim();
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return false;

    // Apenas os últimos 2 steps representam o estado ATUAL
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 2); i--) {
      const step = safeParseJson(lines[i]);
      if (!step) continue;

      if (step.status === 'WAITING_FOR_INPUT' || step.type === 'WAITING_FOR_INPUT') {
        return true;
      }
      if (step.tool_calls && Array.isArray(step.tool_calls)) {
        if (step.tool_calls.some(c => c.name === 'ask_question')) {
          if (i === lines.length - 1) return true;
        }
      }
    }
  } catch {}
  return false;
}

// Verifica no log próprio do subagente se ele já concluiu
function isSubagentFinished(subConversationId) {
  if (!subConversationId) return false;
  const subLog = join(homedir(), '.gemini', 'antigravity', 'brain', subConversationId, '.system_generated', 'logs', 'transcript.jsonl');
  if (!existsSync(subLog)) return false;

  try {
    const raw = readFileSync(subLog, 'utf8').trim();
    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (lines.length === 0) return false;

    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
      const step = safeParseJson(lines[i]);
      if (!step) continue;

      if (step.tool_calls && Array.isArray(step.tool_calls)) {
        if (step.tool_calls.some(c => c.name === 'send_message')) {
          return true;
        }
      }

      if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE' && (!step.tool_calls || step.tool_calls.length === 0)) {
        return true;
      }
    }
  } catch {}
  return false;
}

// Parser recursivo que extrai subagentes e subagentes aninhados (filhos)
function parseTranscriptForSubagents(targetConversationId, parentId = null) {
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
                subsMap.set(role, {
                  id: role,
                  role: role,
                  type: s.TypeName || 'generic',
                  parentId: parentId,
                  prompt: s.Prompt || '',
                  model: s.Model || 'inherit',
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
              if (!existing) continue; // Apenas atualizar subagentes que foram de fato invocados!

              let state = item.state || 'running';
              if (state === 'idle') {
                state = 'done';
              } else if (state === 'waiting_for_input' || state === 'blocked') {
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
        if (isSubagentFinished(sub.conversationId)) {
          sub.state = 'done';
          sub.lastTool = 'Completed Successfully';
        } else if (isSubagentWaitingInput(sub.conversationId)) {
          sub.state = 'waiting_for_input';
          sub.lastTool = 'Requires Approval';
        }
      }
      result.push(sub);
      if (sub.conversationId) seenIds.add(sub.conversationId);
      seenIds.add(sub.id);

      // Recursive reading of nested subagents (children)
      if (sub.conversationId) {
        const nested = parseTranscriptForSubagents(sub.conversationId, sub.id);
        for (const child of nested) {
          if (!seenIds.has(child.conversationId) && !seenIds.has(child.id)) {
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

    for (let i = lines.length - 1; i >= 0; i--) {
      const step = safeParseJson(lines[i]);
      if (step && step.tool_calls && Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        mainAgentAction = step.tool_calls[step.tool_calls.length - 1].name;
        mainAgentState = 'running';
        break;
      }
    }

    const subagentsList = parseTranscriptForSubagents(conversationId, null);
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

// Extracts detailed execution history (native Antigravity IDE chat style)
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

    for (let i = 0; i < lines.length; i++) {
      const step = safeParseJson(lines[i]);
      if (!step) continue;

      const stepTime = step.created_at ? new Date(step.created_at) : null;
      let durationSeconds = 1;
      if (stepTime && lastTime) {
        durationSeconds = Math.max(1, Math.round((stepTime - lastTime) / 1000));
      }
      if (stepTime) lastTime = stepTime;

      // 1. Thinking / Reasoning block (Native Antigravity style)
      if (step.thinking && typeof step.thinking === 'string' && step.thinking.trim()) {
        const thoughtSec = durationSeconds || Math.floor(Math.random() * 20 + 5);
        events.push({
          type: 'thought',
          id: `thought-${i}`,
          label: `Thought for ${thoughtSec}s`,
          text: step.thinking.trim()
        });
      }

      // 2. Tool calls
      if (step.tool_calls && Array.isArray(step.tool_calls)) {
        for (let tcIdx = 0; tcIdx < step.tool_calls.length; tcIdx++) {
          const tc = step.tool_calls[tcIdx];
          const args = tc.args || {};
          let verb = 'Action';
          let badge = { label: '⚡', color: '#38bdf8' };
          let target = '';
          let details = '';
          let diffAdd = 0;
          let diffDel = 0;

          if (tc.name === 'view_file') {
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
            badge = { label: '⚡', color: '#38bdf8' };
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
            diffDel
          });
        }
      }

      // 3. User instruction / initial message
      if (i === 0 && step.source === 'SYSTEM' && step.content) {
        let msg = step.content;
        const match = msg.match(/content=(.*?)(\n<\/SYSTEM_MESSAGE>|$)/s);
        if (match && match[1]) msg = match[1].trim();
        else msg = msg.replace(/^The following is a <SYSTEM_MESSAGE>[\s\S]*?<SYSTEM_MESSAGE>/, '').replace(/<\/SYSTEM_MESSAGE>$/, '').trim();

        events.unshift({
          type: 'instruction',
          id: 'step-0',
          verb: 'Received',
          badge: { label: 'IN', color: '#38bdf8' },
          target: 'User instruction',
          details: msg.slice(0, 100)
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
