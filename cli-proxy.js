require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  DEFAULT_BODY_LIMIT,
  authenticate,
  corsOptions,
  installErrorHandler,
  validateChatRequest,
} = require('./proxy-common');

const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-sonnet-4-6';
const CLAUDE_BIN = process.env.CLAUDE_BIN || path.join(os.homedir(), '.local', 'bin', 'claude');
const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS) || 120000;
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';

app.use(cors(corsOptions()));
app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));
app.use(express.urlencoded({ limit: DEFAULT_BODY_LIMIT, extended: true }));
app.use(authenticate);

const AVAILABLE_MODELS = [
  { id: 'claude-fable-5', object: 'model', created: 1718000000, owned_by: 'anthropic' },
  { id: 'claude-pro', object: 'model', created: 1718000000, owned_by: 'anthropic' },
  { id: 'claude-opus-4-8', object: 'model', created: 1718000000, owned_by: 'anthropic' },
  { id: 'claude-sonnet-4-6', object: 'model', created: 1718000000, owned_by: 'anthropic' },
];

const ASK_USER_TOOL = {
  type: 'function',
  function: {
    name: 'ask_user_question',
    description: 'Ask the user a blocking clarification question and present selectable options.',
    parameters: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'A concise question for the user.',
        },
        options: {
          type: 'array',
          description: 'Two to four short, mutually exclusive choices.',
          minItems: 2,
          maxItems: 4,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Short option label.' },
              description: { type: 'string', description: 'What selecting this option means.' },
            },
            required: ['label'],
          },
        },
      },
      required: ['question', 'options'],
    },
  },
};

function mapModel(model) {
  const modelMap = {
    'gpt-4': 'claude-opus-4-8',
    'gpt-4o': 'claude-sonnet-4-6',
    'gpt-4-turbo': 'claude-opus-4-8',
    'gpt-3.5-turbo': 'claude-sonnet-4-6',
    'claude-pro': 'claude-opus-4-8',
  };
  return modelMap[model] || model || 'claude-opus-4-8';
}

function buildPrompt(messages, images) {
  let prompt = '';
  let imageIndex = 0;

  for (const msg of messages) {
    if (msg.role === 'system') {
      continue;
    }

    const textContent = contentToString(msg.content);
    let msgContent = textContent;

    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const imageParts = msg.content.filter(p => p.type === 'image_url');
      if (imageParts.length > 0) {
        const imgDescs = [];
        for (let i = 0; i < imageParts.length; i++) {
          const img = images[imageIndex];
          if (img) {
            imgDescs.push(`[图片 ${imageIndex + 1}: 请读取文件 ${img.path}]`);
            imageIndex++;
          }
        }
        if (imgDescs.length > 0) {
          msgContent = imgDescs.join('\n') + '\n\n' + textContent;
        }
      }
    }

    if (msg.role === 'user') {
      prompt += `Human: ${msgContent}\n\n`;
    } else if (msg.role === 'assistant') {
      prompt += `Assistant: ${msgContent}\n\n`;
    }
  }

  prompt += 'Assistant: ';
  return prompt;
}

function contentToString(content) {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part.type === 'text' && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return String(content || '');
}

function buildToolsPrompt(tools = []) {
  // Skip the whole block for tool-less requests instead of always paying for
  // the ask_user_question boilerplate on every plain chat completion.
  if (!tools.length) return '';

  const availableTools = [
    ASK_USER_TOOL,
    ...tools.filter(tool => tool?.function?.name !== ASK_USER_TOOL.function.name),
  ];

  let prompt = '你可以调用以下工具来完成任务：\n\n';

  for (const tool of availableTools) {
    if (tool.type === 'function' && tool.function) {
      const fn = tool.function;
      prompt += `工具名称: ${fn.name}\n`;
      prompt += `工具描述: ${fn.description || ''}\n`;
      if (fn.parameters && fn.parameters.properties) {
        prompt += `参数格式 (JSON Schema):\n${JSON.stringify(fn.parameters)}\n`;
      }
      prompt += '\n';
    }
  }

  prompt += `如果缺少完成任务所必需的信息，并且适合让用户从有限选项中选择，请调用 ask_user_question。不要自行猜测，也不要把选择题作为普通文本输出。

当你需要调用工具时，严格使用以下格式输出（不要有其他内容）：
\`\`\`json
{
  "tool_calls": [
    {
      "id": "call_xxx",
      "name": "工具名称",
      "arguments": { "参数名": "参数值" }
    }
  ]
}
\`\`\`

可以同时调用多个工具。调用工具后，等待工具返回结果，再继续回答。
如果不需要调用工具，直接用自然语言回答即可。`;

  return prompt;
}

function extractToolCalls(text) {
  const toolCalls = [];
  if (!text || typeof text !== 'string') return toolCalls;

  const tryParseToolCalls = (jsonStr) => {
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.tool_calls && Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          toolCalls.push({
            // The model is asked to invent its own id, but it isn't asked
            // (or reliable) about uniqueness - it commonly reuses the same
            // placeholder (e.g. "call_001") across unrelated calls in the
            // same conversation. A real API always hands out globally
            // unique ids, and clients may rely on that to correlate a call
            // with its eventual result, so we always mint our own instead
            // of trusting the model's.
            id: `call_${crypto.randomUUID()}`,
            type: 'function',
            function: {
              name: tc.name || '',
              arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}),
            },
          });
        }
        return true;
      }
    } catch (e) {
    }
    return false;
  };

  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const codeContent = match[1].trim();
    if (tryParseToolCalls(codeContent)) {
      return toolCalls;
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    tryParseToolCalls(trimmed);
  }

  return toolCalls;
}

function stripToolCallBlocks(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  result = result.replace(/```(?:json)?\s*\{\s*"tool_calls"[\s\S]*?\}\s*```/gi, '');
  result = result.replace(/^\s*\{\s*"tool_calls"[\s\S]*?\}\s*$/gi, '');
  return result.trim();
}

// A response can only be classified once we've seen enough of its prefix:
// a lone leading backtick is ambiguous (could be inline code or the start of
// a ```json tool-call block), so we wait for up to 3 characters before deciding.
function classifyResponsePrefix(text) {
  const trimmed = text.replace(/^\s+/, '');
  if (!trimmed) return 'undecided';
  const firstChar = trimmed[0];
  if (firstChar === '{') return 'tool-call-like';
  if (firstChar === '`') {
    if (trimmed.length < 3) return 'undecided';
    return trimmed.startsWith('```') ? 'tool-call-like' : 'plain-text';
  }
  return 'plain-text';
}

function extractToolResults(messages) {
  const results = [];
  for (const msg of messages) {
    if (msg.role === 'tool') {
      results.push({
        tool_call_id: msg.tool_call_id,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      });
    }
  }
  return results;
}

const TOOL_RESULT_PROMPT_MARKER = '以下是工具调用的原始返回数据（仅供你分析参考，不是你的回复内容）：';
const TOOL_RESULT_PROMPT_TAIL = '现在请直接回答用户最初的问题。只输出你的分析结论，绝对不要把上面的原始数据或文件内容复制、转述或引用到你的回复中。如果还需要调用其他工具，请严格用 ```json 代码块格式输出 tool_calls；否则请直接用自然语言给出最终回答。';

function buildToolResultPrompt(toolResults) {
  if (toolResults.length === 0) return '';

  let prompt = `${TOOL_RESULT_PROMPT_MARKER}\n\n`;
  for (const result of toolResults) {
    prompt += `--- 工具调用 ID: ${result.tool_call_id} ---\n`;
    prompt += `${result.content}\n`;
    prompt += `--- 工具结果结束 ---\n\n`;
  }
  prompt += TOOL_RESULT_PROMPT_TAIL;
  return prompt;
}

// Defense in depth: the instruction above sometimes isn't followed and the
// model echoes the whole recap block back verbatim instead of answering
// (this is our own fixed template, not user content, so an exact match is
// safe). If that happens, strip it out rather than showing the raw dump to
// the client.
function stripEchoedToolResultPrompt(text) {
  if (!text || typeof text !== 'string' || !text.includes(TOOL_RESULT_PROMPT_MARKER)) return text;

  const markerIndex = text.indexOf(TOOL_RESULT_PROMPT_MARKER);
  const tailIndex = text.indexOf(TOOL_RESULT_PROMPT_TAIL);
  const before = text.slice(0, markerIndex);
  const after = tailIndex === -1 ? '' : text.slice(tailIndex + TOOL_RESULT_PROMPT_TAIL.length);
  return (before + after).trim();
}

function extractAndSaveImages(messages) {
  const images = [];
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-proxy-'));

  let imageIndex = 0;
  for (const msg of messages) {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === 'image_url' && part.image_url) {
          const url = part.image_url.url;
          let imagePath = null;
          let imageExt = 'png';

          if (url.startsWith('data:image/')) {
            const match = url.match(/^data:image\/(\w+);base64,(.+)$/);
            if (match) {
              imageExt = match[1] === 'jpeg' ? 'jpg' : match[1];
              const base64Data = match[2];
              imagePath = path.join(tempDir, `image_${imageIndex}.${imageExt}`);
              fs.writeFileSync(imagePath, Buffer.from(base64Data, 'base64'));
            }
          }

          if (imagePath) {
            images.push({ path: imagePath, index: imageIndex });
            imageIndex++;
          }
        }
      }
    }
  }

  return { images, tempDir };
}

function extractSystemPrompt(messages) {
  const systemMessages = messages.filter(m => m.role === 'system');
  return systemMessages.map(m => contentToString(m.content)).join('\n\n') || undefined;
}

function cleanupTempDir(dir) {
  try {
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Failed to cleanup temp dir:', e.message);
  }
}

// The Claude CLI keeps its own on-disk conversation history keyed by session
// id (see --resume). Rebuilding and resending the full flattened history on
// every turn (the original approach) throws that away and pays full input
// tokens for the whole conversation each time. Instead we remember, per
// request, a hash of "the messages array the client should send next" mapped
// to the CLI session that already has that history - so the following turn
// only needs to send its new content via --resume.
//
// This is a pure optimization: any cache miss (first turn, stale/evicted
// session, non-standard client behavior) just falls back to the original
// full-rebuild behavior, so it can never make a request fail that would
// otherwise have succeeded.
const MAX_SESSIONS = 200;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const sessionStore = new Map(); // hash(prefix) -> { sessionId, lastUsed }
const sessionsInFlight = new Set(); // sessionId currently mid-request

// Reduce a message to only the fields that matter for matching, in a fixed
// key order. Different clients reconstruct message objects differently
// (field order, extra provider-specific fields like `refusal` or
// `annotations`) - hashing the raw object would make the hash sensitive to
// those irrelevant differences and silently defeat resume on every turn for
// any client that doesn't echo our exact object shape back byte-for-byte.
function canonicalizeMessage(msg) {
  const canonical = { role: msg.role, content: msg.content ?? null };
  if (msg.tool_call_id !== undefined) canonical.tool_call_id = msg.tool_call_id;
  if (Array.isArray(msg.tool_calls)) {
    canonical.tool_calls = msg.tool_calls.map(tc => ({
      id: tc.id,
      name: tc.function?.name ?? tc.name,
      arguments: tc.function?.arguments ?? tc.arguments,
    }));
  }
  return canonical;
}

function hashMessages(msgs) {
  return crypto.createHash('sha256').update(JSON.stringify(msgs.map(canonicalizeMessage))).digest('hex');
}

function pruneSessionStore() {
  const now = Date.now();
  for (const [key, value] of sessionStore) {
    if (now - value.lastUsed > SESSION_TTL_MS) sessionStore.delete(key);
  }
  while (sessionStore.size > MAX_SESSIONS) {
    const oldestKey = sessionStore.keys().next().value;
    sessionStore.delete(oldestKey);
  }
}

function rememberSession(priorMessages, assistantMessage, sessionId) {
  const key = hashMessages([...priorMessages, assistantMessage]);
  sessionStore.set(key, { sessionId, lastUsed: Date.now() });
  pruneSessionStore();
}

function findResumableSession(messages) {
  if (messages.length < 2) return null;
  const lastMessage = messages[messages.length - 1];
  if (lastMessage.role !== 'user' && lastMessage.role !== 'tool') return null;

  const prefixMessages = messages.slice(0, -1);
  const prefixKey = hashMessages(prefixMessages);
  const hit = sessionStore.get(prefixKey);
  if (!hit || sessionsInFlight.has(hit.sessionId)) return null;

  return { prefixKey, sessionId: hit.sessionId, lastMessage };
}

// Spawns the Claude CLI and turns its stream-json stdout into a small set of
// events, shared by both the streaming and non-streaming response paths.
//
// Events:
//   'text'        (delta: string)                 incremental assistant text
//   'stop'        (state)                          CLI reported message_stop
//   'cli-error'   (message: string)                CLI emitted a `type: error` line
//   'spawn-error' (error: Error)                    the CLI process failed to start
//   'close'       ({ code, timedOut, state })       the CLI process exited
function runClaudeCli(args, prompt) {
  const emitter = new EventEmitter();
  const child = spawn(CLAUDE_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  const state = {
    fullText: '',
    promptTokens: 0,
    completionTokens: 0,
    stopReason: 'stop',
    stderr: '',
    isError: false,
    errorMessage: '',
  };

  let buffer = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, CLI_TIMEOUT_MS);

  child.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        console.error('Parse error:', e.message, 'Line:', trimmed.substring(0, 100));
        continue;
      }

      if (parsed.type === 'stream_event' && parsed.event) {
        const event = parsed.event;

        if (event.type === 'content_block_delta' && typeof event.delta?.text === 'string') {
          state.fullText += event.delta.text;
          emitter.emit('text', event.delta.text);
        }

        if (event.type === 'message_delta' && event.usage) {
          state.promptTokens = event.usage.input_tokens || 0;
          state.completionTokens = event.usage.output_tokens || 0;
          if (event.stop_reason) {
            state.stopReason = event.stop_reason === 'end_turn' ? 'stop' : event.stop_reason;
          }
        }

        if (event.type === 'message_stop') {
          emitter.emit('stop', state);
        }
      }

      if (parsed.type === 'result') {
        if (!state.fullText && typeof parsed.result === 'string') {
          state.fullText = parsed.result;
          emitter.emit('text', state.fullText);
        }
        if (parsed.usage) {
          state.promptTokens = parsed.usage.input_tokens || state.promptTokens;
          state.completionTokens = parsed.usage.output_tokens || state.completionTokens;
        }
        // The CLI can report a logical failure (e.g. "No conversation found
        // with session ID: ...") with exit code 0, so this has to be tracked
        // independently of the process exit code.
        if (parsed.is_error) {
          state.isError = true;
          state.errorMessage = Array.isArray(parsed.errors) && parsed.errors.length
            ? parsed.errors.join('; ')
            : (typeof parsed.result === 'string' ? parsed.result : 'CLI reported an error');
        }
      }

      if (parsed.type === 'error') {
        console.error('CLI error event:', JSON.stringify(parsed));
        let errorMsg = 'Internal server error';
        if (typeof parsed.error === 'string') {
          errorMsg = parsed.error;
        } else if (parsed.error && typeof parsed.error.message === 'string') {
          errorMsg = parsed.error.message;
        }
        emitter.emit('cli-error', errorMsg);
      }
    }
  });

  child.stderr.on('data', (data) => {
    state.stderr += data.toString();
    console.error('CLI stderr:', data.toString());
  });

  child.on('error', (error) => {
    clearTimeout(timer);
    emitter.emit('spawn-error', error);
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    emitter.emit('close', { code, timedOut, state });
  });

  child.stdin.write(prompt);
  child.stdin.end();

  emitter.kill = () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  };

  return emitter;
}

// Wraps runClaudeCli to make --resume attempts safe: if a resumed session
// turns out to be stale (evicted on the CLI's side, e.g. after a restart or
// disk cleanup) it fails immediately with zero output, before any content
// has been streamed to the client. In that case - and only in that case -
// we transparently retry once with a freshly rebuilt full-history turn.
// Once any text has been emitted we're committed: a later failure is just a
// real error, since we can no longer discard what the client already saw.
//
// `resume` is `{ args, prompt, prefixKey, sessionId } | null`.
// `buildFreshTurn()` lazily builds the full-rebuild `{ args, prompt, sessionId }`
// turn, so it only pays that cost when actually needed.
function runClaudeCliWithFallback({ resume, buildFreshTurn }) {
  const emitter = new EventEmitter();
  emitter.kill = () => {};

  const attach = (cli, { isResumeAttempt, sessionIdUsed, prefixKey, tempDir }) => {
    let sawText = false;
    emitter.kill = () => cli.kill();

    const retryFresh = () => {
      if (isResumeAttempt) {
        sessionStore.delete(prefixKey);
        sessionsInFlight.delete(sessionIdUsed);
      }
      const fresh = buildFreshTurn();
      attach(runClaudeCli(fresh.args, fresh.prompt), {
        isResumeAttempt: false,
        sessionIdUsed: fresh.sessionId,
        tempDir: fresh.tempDir,
      });
    };

    cli.on('text', (delta) => {
      sawText = true;
      emitter.emit('text', delta);
    });

    cli.on('stop', (state) => emitter.emit('stop', { ...state, sessionId: sessionIdUsed }));

    cli.on('spawn-error', (error) => {
      cleanupTempDir(tempDir);
      emitter.emit('spawn-error', error);
    });

    cli.on('cli-error', (message) => {
      if (isResumeAttempt && !sawText) {
        cleanupTempDir(tempDir);
        return retryFresh();
      }
      emitter.emit('cli-error', message);
    });

    cli.on('close', ({ code, timedOut, state }) => {
      cleanupTempDir(tempDir);
      if (isResumeAttempt) sessionsInFlight.delete(sessionIdUsed);
      if (isResumeAttempt && !sawText && state.isError && !timedOut) return retryFresh();
      emitter.emit('close', { code, timedOut, state, sessionId: sessionIdUsed });
    });
  };

  if (resume) {
    sessionsInFlight.add(resume.sessionId);
    attach(runClaudeCli(resume.args, resume.prompt), {
      isResumeAttempt: true,
      sessionIdUsed: resume.sessionId,
      prefixKey: resume.prefixKey,
      tempDir: resume.tempDir,
    });
  } else {
    const fresh = buildFreshTurn();
    attach(runClaudeCli(fresh.args, fresh.prompt), {
      isResumeAttempt: false,
      sessionIdUsed: fresh.sessionId,
      tempDir: fresh.tempDir,
    });
  }

  return emitter;
}

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: AVAILABLE_MODELS,
  });
});

// Single user message or a run of trailing tool-result messages, described
// the same way buildPrompt would describe them, but without the
// "Human:/Assistant:" multi-turn framing - `--resume` only expects the new
// turn's content, not a rebuilt transcript.
function describeUserMessageWithImages(message, images) {
  const textContent = contentToString(message.content);
  if (!Array.isArray(message.content) || images.length === 0) return textContent;
  const imgDescs = images.map((img, i) => `[图片 ${i + 1}: 请读取文件 ${img.path}]`);
  return imgDescs.join('\n') + '\n\n' + textContent;
}

app.post('/v1/chat/completions', validateChatRequest, async (req, res) => {
  let currentTempDir = null;
  try {
    const { messages, model, stream = false, tools } = req.body;
    const cliModel = mapModel(model);

    const computeSystemPrompt = () => {
      const baseSystemPrompt = extractSystemPrompt(messages) || '';
      const toolsPrompt = buildToolsPrompt(tools || []);
      const parts = [];
      if (baseSystemPrompt) parts.push(baseSystemPrompt);
      if (toolsPrompt) parts.push(toolsPrompt);
      // Never leave this unset: without --system-prompt-file the CLI falls
      // back to its own (much longer) default Claude Code system prompt,
      // which costs more tokens than this whole request would otherwise.
      return parts.length > 0 ? parts.join('\n\n') : DEFAULT_SYSTEM_PROMPT;
    };

    const buildCliArgs = ({ hasImages, tempDir, systemPrompt, sessionFlag }) => {
      const args = ['-p', '--safe-mode', '--model', cliModel, ...sessionFlag];

      if (hasImages) {
        args.push('--tools', 'Read');
        args.push('--allowedTools', 'Read');
        args.push('--add-dir', tempDir);
      } else {
        args.push('--tools', '');
      }

      if (systemPrompt) {
        // Passed via a file rather than argv: tool schemas can make this
        // large enough to risk hitting the OS's argv size limit (E2BIG).
        const systemPromptPath = path.join(tempDir, 'system-prompt.txt');
        fs.writeFileSync(systemPromptPath, systemPrompt);
        args.push('--system-prompt-file', systemPromptPath);
      }

      args.push('--output-format', 'stream-json');
      args.push('--include-partial-messages');
      args.push('--verbose');
      return args;
    };

    // Full-rebuild turn: flattens the entire message history into one prompt
    // and starts a brand new CLI session. Used for the first turn of a
    // conversation, and as the fallback if a --resume attempt turns out to
    // be stale.
    const buildFreshTurn = () => {
      const systemPrompt = computeSystemPrompt();
      const { images, tempDir } = extractAndSaveImages(messages);
      currentTempDir = tempDir;
      const hasImages = images.length > 0;

      const conversationMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
      let prompt = buildPrompt(conversationMessages, images);

      const toolResultPrompt = buildToolResultPrompt(extractToolResults(messages));
      if (toolResultPrompt) {
        prompt = prompt.replace(/Assistant: $/, '') + `Human: ${toolResultPrompt}\n\nAssistant: `;
      }

      const sessionId = crypto.randomUUID();
      const args = buildCliArgs({ hasImages, tempDir, systemPrompt, sessionFlag: ['--session-id', sessionId] });
      return { args, prompt, sessionId, tempDir };
    };

    // Incremental turn: the CLI already has this conversation's history under
    // `sessionId` (see sessionStore/findResumableSession), so only the new
    // trailing message(s) need to be sent.
    let resume = null;
    const resumeCandidate = findResumableSession(messages);
    if (resumeCandidate) {
      const { prefixKey, sessionId, lastMessage } = resumeCandidate;
      const systemPrompt = computeSystemPrompt();

      let scopedMessages;
      if (lastMessage.role === 'tool') {
        scopedMessages = [];
        for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) {
          scopedMessages.unshift(messages[i]);
        }
      } else {
        scopedMessages = [lastMessage];
      }

      const { images, tempDir } = extractAndSaveImages(scopedMessages);
      currentTempDir = tempDir;
      const hasImages = images.length > 0;

      const prompt = lastMessage.role === 'tool'
        ? buildToolResultPrompt(extractToolResults(scopedMessages))
        : describeUserMessageWithImages(lastMessage, images);

      const args = buildCliArgs({ hasImages, tempDir, systemPrompt, sessionFlag: ['--resume', sessionId] });
      resume = { args, prompt, prefixKey, sessionId, tempDir };
    }

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const cli = runClaudeCliWithFallback({ resume, buildFreshTurn });
      const responseId = 'chatcmpl-' + Date.now();
      let disconnected = false;
      let streamFinished = false;
      let roleSent = false;

      res.on('close', () => {
        if (!res.writableEnded) {
          disconnected = true;
          cli.kill();
        }
      });

      const writeChunk = (delta, finishReason = null, usage = null) => {
        if (disconnected || res.writableEnded) return;
        if (Object.keys(delta).length && !roleSent) {
          delta = { role: 'assistant', ...delta };
          roleSent = true;
        }
        const chunk = {
          id: responseId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: cliModel,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        };
        if (usage) chunk.usage = usage;
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      };

      // Text can only be forwarded live once we're confident it isn't the
      // start of a ```json tool-call block (see classifyResponsePrefix). But
      // that check only looks at the first few characters - if the model
      // prepends any preamble before the block, the prefix looks like plain
      // text and the block would stream through as literal visible content
      // instead of becoming a tool call. The only case where a tool-call
      // block can appear at all is when tools were offered (that's the only
      // time the tool-calling instructions are in the system prompt at all -
      // see buildToolsPrompt), so passthrough is only safe when there are none.
      let mode = (tools && tools.length) ? 'buffering' : 'undecided';
      let pending = '';

      cli.on('text', (delta) => {
        if (disconnected || res.writableEnded) return;

        if (mode === 'passthrough') {
          writeChunk({ content: delta });
          return;
        }
        if (mode === 'buffering') return;

        pending += delta;
        const verdict = classifyResponsePrefix(pending);
        if (verdict === 'undecided') return;
        if (verdict === 'tool-call-like') {
          mode = 'buffering';
          return;
        }

        mode = 'passthrough';
        writeChunk({ content: pending });
        pending = '';
      });

      const finish = ({ fullText, promptTokens, completionTokens, sessionId }) => {
        if (streamFinished || res.writableEnded) return;
        streamFinished = true;

        // If we were already streaming plain text live, it's all been sent -
        // re-sending the accumulated fullText here would duplicate it. Live
        // streaming only ever happens for tool-less requests (see `mode`
        // above), so there's no tool-result recap to echo in that case.
        const rawText = mode === 'passthrough' ? (fullText || '') : stripEchoedToolResultPrompt(fullText || '');
        const toolCalls = mode === 'passthrough' ? [] : extractToolCalls(rawText);
        const cleanText = toolCalls.length ? stripToolCallBlocks(rawText) : rawText;

        if (mode !== 'passthrough' && (cleanText || toolCalls.length)) {
          const delta = {};
          if (cleanText) delta.content = cleanText;
          if (toolCalls.length) delta.tool_calls = toolCalls.map((call, index) => ({ index, ...call }));
          writeChunk(delta);
        }

        writeChunk({}, toolCalls.length ? 'tool_calls' : 'stop', {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        });
        res.write('data: [DONE]\n\n');
        res.end();

        const assistantMessage = { role: 'assistant', content: cleanText || null };
        if (toolCalls.length) assistantMessage.tool_calls = toolCalls;
        rememberSession(messages, assistantMessage, sessionId);
      };

      cli.on('stop', (state) => finish(state));

      cli.on('cli-error', (message) => {
        if (streamFinished || res.writableEnded) return;
        streamFinished = true;
        res.write(`data: ${JSON.stringify({ error: { message, type: 'api_error' } })}\n\n`);
        res.end();
      });

      cli.on('spawn-error', (error) => {
        if (streamFinished || res.writableEnded) return;
        streamFinished = true;
        console.error('Failed to start Claude CLI:', error);
        res.write(`data: ${JSON.stringify({
          error: { message: `Failed to start Claude CLI: ${error.message}`, type: 'api_error' },
        })}\n\n`);
        res.end();
      });

      cli.on('close', ({ code, timedOut, state }) => {
        if (streamFinished || res.writableEnded) return;
        if ((code !== 0 || state.isError) && !state.fullText) {
          streamFinished = true;
          const message = timedOut
            ? `CLI process timed out after ${CLI_TIMEOUT_MS}ms`
            : (state.errorMessage || `CLI process exited with code ${code}`);
          console.error(message);
          res.write(`data: ${JSON.stringify({ error: { message, type: 'api_error' } })}\n\n`);
          res.end();
        } else {
          finish(state);
        }
      });

    } else {
      const cli = runClaudeCliWithFallback({ resume, buildFreshTurn });
      let responded = false;

      res.on('close', () => {
        if (!res.writableEnded && !responded) cli.kill();
      });

      const respondError = (status, message) => {
        if (responded || res.headersSent) return;
        responded = true;
        res.status(status).json({ error: { message, type: 'api_error' } });
      };

      cli.on('cli-error', (message) => {
        respondError(500, message);
      });

      cli.on('spawn-error', (error) => {
        console.error('Failed to start Claude CLI:', error);
        respondError(500, `Failed to start Claude CLI: ${error.message}`);
      });

      cli.on('close', ({ code, timedOut, state, sessionId }) => {
        if (responded) return;

        if ((code !== 0 || state.isError) && !state.fullText) {
          const message = timedOut
            ? `CLI process timed out after ${CLI_TIMEOUT_MS}ms`
            : (state.errorMessage || state.stderr || `CLI exited with code ${code}`);
          console.error('CLI exited with code', code, 'stderr:', state.stderr);
          return respondError(500, message);
        }

        const rawText = stripEchoedToolResultPrompt(state.fullText || '');
        const toolCalls = extractToolCalls(rawText);

        let message;
        let finishReason;
        if (toolCalls.length > 0) {
          message = { role: 'assistant', content: stripToolCallBlocks(rawText) || null, tool_calls: toolCalls };
          finishReason = 'tool_calls';
        } else {
          message = { role: 'assistant', content: rawText };
          finishReason = state.stopReason;
        }

        responded = true;
        rememberSession(messages, message, sessionId);
        res.json({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: cliModel,
          choices: [{ index: 0, message, finish_reason: finishReason }],
          usage: {
            prompt_tokens: state.promptTokens,
            completion_tokens: state.completionTokens,
            total_tokens: state.promptTokens + state.completionTokens,
          },
        });
      });
    }
  } catch (error) {
    cleanupTempDir(currentTempDir);
    console.error('Error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message: error.message || 'Internal server error',
          type: 'api_error',
        },
      });
    }
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Claude CLI proxy is running', default_model: DEFAULT_MODEL, available_models: AVAILABLE_MODELS.map(model => model.id) });
});

installErrorHandler(app);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Claude CLI proxy server running on http://localhost:${PORT}`);
    console.log(`Default model: ${DEFAULT_MODEL}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Uses Claude Code CLI (Pro subscription credits)`);
  });
}

module.exports = { app, buildToolsPrompt, extractToolCalls };
