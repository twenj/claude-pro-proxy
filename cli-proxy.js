require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
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
        prompt += `参数格式 (JSON Schema):\n${JSON.stringify(fn.parameters, null, 2)}\n`;
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
            id: tc.id || `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
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

function buildToolResultPrompt(toolResults) {
  if (toolResults.length === 0) return '';

  let prompt = '以下是工具调用的返回结果：\n\n';
  for (const result of toolResults) {
    prompt += `--- 工具调用 ID: ${result.tool_call_id} ---\n`;
    prompt += `${result.content}\n`;
    prompt += `--- 工具结果结束 ---\n\n`;
  }
  prompt += '请根据以上工具返回结果继续完成任务。不要重复输出工具结果。如果还需要调用其他工具，请严格用 ```json 代码块格式输出 tool_calls。';
  return prompt;
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

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: AVAILABLE_MODELS,
  });
});

app.post('/v1/chat/completions', validateChatRequest, async (req, res) => {
  try {
    const { messages, model, stream = false, temperature, max_tokens, tools } = req.body;

    const baseSystemPrompt = extractSystemPrompt(messages) || '';
    const toolsPrompt = buildToolsPrompt(tools || []);
    const toolResults = extractToolResults(messages);
    const toolResultPrompt = buildToolResultPrompt(toolResults);

    let systemPromptParts = [];
    if (baseSystemPrompt) systemPromptParts.push(baseSystemPrompt);
    if (toolsPrompt) systemPromptParts.push(toolsPrompt);
    const systemPrompt = systemPromptParts.length > 0 ? systemPromptParts.join('\n\n') : undefined;

    const { images, tempDir } = extractAndSaveImages(messages);
    const hasImages = images.length > 0;

    const conversationMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    let prompt = buildPrompt(conversationMessages, images);

    if (toolResultPrompt) {
      prompt = prompt.replace(/Assistant: $/, '') + `Human: ${toolResultPrompt}\n\nAssistant: `;
    }

    const cliModel = mapModel(model);
    const args = ['-p', '--safe-mode', '--model', cliModel];

    if (hasImages) {
      args.push('--tools', 'Read');
      args.push('--allowedTools', 'Read');
      args.push('--add-dir', tempDir);
    } else {
      args.push('--tools', '');
    }

    if (systemPrompt) {
      args.push('--system-prompt', systemPrompt);
    }

    args.push('--output-format', 'stream-json');
    args.push('--include-partial-messages');
    args.push('--verbose');

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const child = spawn(CLAUDE_BIN, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let buffer = '';
      let fullText = '';
      let promptTokens = 0;
      let completionTokens = 0;
      let totalCost = 0;
      let streamFinished = false;

      res.on('close', () => {
        if (!res.writableEnded && child.exitCode === null) child.kill('SIGTERM');
      });

      const finishStream = () => {
        if (streamFinished || res.writableEnded) return;
        streamFinished = true;

        const rawText = fullText || '';
        const toolCalls = extractToolCalls(rawText);
        const cleanText = toolCalls.length ? stripToolCallBlocks(rawText) : rawText;
        const delta = { role: 'assistant' };

        if (cleanText) delta.content = cleanText;
        if (toolCalls.length) {
          delta.tool_calls = toolCalls.map((call, index) => ({ index, ...call }));
        }

        if (cleanText || toolCalls.length) {
          res.write(`data: ${JSON.stringify({
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: cliModel,
            choices: [{ index: 0, delta, finish_reason: null }],
          })}\n\n`);
        }

        res.write(`data: ${JSON.stringify({
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: cliModel,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
          }],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: completionTokens,
            total_tokens: promptTokens + completionTokens,
          },
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      };

      child.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);

            if (parsed.type === 'stream_event' && parsed.event) {
              const event = parsed.event;

              if (event.type === 'content_block_delta' && event.delta) {
                let text = '';
                if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
                  text = event.delta.text;
                } else if (typeof event.delta.text === 'string') {
                  text = event.delta.text;
                }

                if (text) {
                  fullText += text;
                }
              }

              if (event.type === 'message_delta' && event.usage) {
                promptTokens = event.usage.input_tokens || 0;
                completionTokens = event.usage.output_tokens || 0;
                if (event.usage.cost) {
                  totalCost = event.usage.cost;
                }
              }

              if (event.type === 'message_stop') {
                finishStream();
              }
            }

            if (parsed.type === 'result') {
              if (!fullText && parsed.result) {
                if (typeof parsed.result === 'string') {
                  fullText = parsed.result;
                }
              }
              if (parsed.usage) {
                promptTokens = parsed.usage.input_tokens || promptTokens;
                completionTokens = parsed.usage.output_tokens || completionTokens;
              }
              if (parsed.total_cost_usd) {
                totalCost = parsed.total_cost_usd;
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
              const errorChunk = {
                error: {
                  message: errorMsg,
                  type: 'api_error',
                },
              };
              const errorStr = `data: ${JSON.stringify(errorChunk)}\n\n`;
              if (typeof errorStr === 'string') {
                res.write(errorStr);
              }
              res.end();
            }
          } catch (e) {
            console.error('Parse error:', e.message, 'Line:', trimmed.substring(0, 100));
          }
        }
      });

      child.stderr.on('data', (data) => {
        console.error('CLI stderr:', data.toString());
      });

      child.on('error', (error) => {
        cleanupTempDir(tempDir);
        if (res.writableEnded) return;
        streamFinished = true;
        console.error('Failed to start Claude CLI:', error);
        res.write(`data: ${JSON.stringify({
          error: {
            message: `Failed to start Claude CLI: ${error.message}`,
            type: 'api_error',
          },
        })}\n\n`);
        res.end();
      });

      child.on('close', (code) => {
        cleanupTempDir(tempDir);
        if (code !== 0 && !res.writableEnded && !fullText) {
          console.error(`CLI process exited with code ${code}`);
          const errorChunk = {
            error: {
              message: `CLI process exited with code ${code}`,
              type: 'api_error',
            },
          };
          res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
          res.end();
        } else if (!res.writableEnded) {
          finishStream();
        }
      });

      child.stdin.write(prompt);
      child.stdin.end();

    } else {
      const child = spawn(CLAUDE_BIN, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let buffer = '';
      let fullText = '';
      let promptTokens = 0;
      let completionTokens = 0;
      let totalCost = 0;
      let stopReason = 'stop';
      let stderr = '';

      res.on('close', () => {
        if (!res.writableEnded && child.exitCode === null) child.kill('SIGTERM');
      });

      child.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);

            if (parsed.type === 'stream_event' && parsed.event) {
              const event = parsed.event;

              if (event.type === 'content_block_delta' && event.delta) {
                let text = '';
                if (event.delta.type === 'text_delta' && typeof event.delta.text === 'string') {
                  text = event.delta.text;
                } else if (typeof event.delta.text === 'string') {
                  text = event.delta.text;
                }

                if (text) {
                  fullText += text;
                }
              }

              if (event.type === 'message_delta' && event.usage) {
                promptTokens = event.usage.input_tokens || 0;
                completionTokens = event.usage.output_tokens || 0;
                if (event.usage.cost) {
                  totalCost = event.usage.cost;
                }
                if (event.stop_reason) {
                  stopReason = event.stop_reason === 'end_turn' ? 'stop' : event.stop_reason;
                }
              }
            }

            if (parsed.type === 'result') {
              if (!fullText && parsed.result) {
                if (typeof parsed.result === 'string') {
                  fullText = parsed.result;
                }
              }
              if (parsed.usage) {
                promptTokens = parsed.usage.input_tokens || promptTokens;
                completionTokens = parsed.usage.output_tokens || completionTokens;
              }
              if (parsed.total_cost_usd) {
                totalCost = parsed.total_cost_usd;
              }
            }
          } catch (e) {
          }
        }
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
        console.error('CLI stderr:', data.toString());
      });

      child.on('error', (error) => {
        cleanupTempDir(tempDir);
        if (res.headersSent) return res.end();
        console.error('Failed to start Claude CLI:', error);
        res.status(500).json({
          error: {
            message: `Failed to start Claude CLI: ${error.message}`,
            type: 'api_error',
          },
        });
      });

      child.stdin.write(prompt);
      child.stdin.end();

      child.on('close', (code) => {
        cleanupTempDir(tempDir);
        if (code !== 0 && !fullText) {
          console.error('CLI exited with code', code, 'stderr:', stderr);
          return res.status(500).json({
            error: {
              message: stderr || `CLI exited with code ${code}`,
              type: 'api_error',
            },
          });
        }

        try {
          const rawText = fullText || '';
          const toolCalls = extractToolCalls(rawText);

          let message;
          let finishReason;

          if (toolCalls.length > 0) {
            const cleanText = stripToolCallBlocks(rawText);
            message = {
              role: 'assistant',
              content: cleanText || null,
              tool_calls: toolCalls,
            };
            finishReason = 'tool_calls';
          } else {
            message = {
              role: 'assistant',
              content: rawText,
            };
            finishReason = stopReason;
          }

          const openAIResponse = {
            id: 'chatcmpl-' + Date.now(),
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: cliModel,
            choices: [
              {
                index: 0,
                message: message,
                finish_reason: finishReason,
              },
            ],
            usage: {
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens,
            },
          };

          res.json(openAIResponse);
        } catch (error) {
          console.error('Parse error:', error);
          res.status(500).json({
            error: {
              message: error.message || 'Internal server error',
              type: 'api_error',
            },
          });
        }
      });
    }
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'api_error',
      },
    });
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
