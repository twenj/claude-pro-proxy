require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3001;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-pro';

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const AVAILABLE_MODELS = [
  { id: 'claude-fable-5', object: 'model', created: 1718000000, owned_by: 'anthropic' },
  { id: 'claude-pro', object: 'model', created: 1718000000, owned_by: 'anthropic' },
  { id: 'claude-opus-4-8', object: 'model', created: 1718000000, owned_by: 'anthropic' },
  { id: 'claude-sonnet-4-6', object: 'model', created: 1718000000, owned_by: 'anthropic' },
];

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

function buildToolsPrompt(tools) {
  if (!tools || tools.length === 0) return '';

  let prompt = '你可以调用以下工具来完成任务：\n\n';

  for (const tool of tools) {
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

  prompt += `当你需要调用工具时，严格使用以下格式输出（不要有其他内容）：
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

  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let jsonStr = text;
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

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
    }
  } catch (e) {
  }

  return toolCalls;
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
    prompt += `工具调用 ID: ${result.tool_call_id}\n`;
    prompt += `返回结果:\n${result.content}\n\n`;
  }
  prompt += '请根据工具返回结果继续完成任务。如果还需要调用其他工具，请继续用 JSON 格式输出工具调用。';
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

app.post('/v1/chat/completions', async (req, res) => {
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
    const hasExternalTools = tools && tools.length > 0;

    const args = ['-p', '--safe-mode', '--model', cliModel];

    if (hasImages) {
      args.push('--tools', 'Read');
      args.push('--add-dir', tempDir);
      args.push('--dangerously-skip-permissions');
    } else if (hasExternalTools) {
      args.push('--tools=');
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

      const child = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let buffer = '';
      let fullText = '';
      let promptTokens = 0;
      let completionTokens = 0;
      let totalCost = 0;

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
                  const chunk = {
                    id: 'chatcmpl-' + Date.now(),
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model: cliModel,
                    choices: [
                      {
                        index: 0,
                        delta: { content: text },
                        finish_reason: null,
                      },
                    ],
                  };
                  const chunkStr = `data: ${JSON.stringify(chunk)}\n\n`;
                  if (typeof chunkStr === 'string') {
                    res.write(chunkStr);
                  }
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
                const finalChunk = {
                  id: 'chatcmpl-' + Date.now(),
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: cliModel,
                  choices: [
                    {
                      index: 0,
                      delta: {},
                      finish_reason: 'stop',
                    },
                  ],
                  usage: {
                    prompt_tokens: promptTokens,
                    completion_tokens: completionTokens,
                    total_tokens: promptTokens + completionTokens,
                  },
                };
                const finalStr = `data: ${JSON.stringify(finalChunk)}\n\n`;
                if (typeof finalStr === 'string') {
                  res.write(finalStr);
                }
                res.write('data: [DONE]\n\n');
                res.end();
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

      child.on('close', (code) => {
        cleanupTempDir(tempDir);
        if (code !== 0 && !res.writableEnded) {
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
          res.write('data: [DONE]\n\n');
          res.end();
        }
      });

      child.stdin.write(prompt);
      child.stdin.end();

    } else {
      const child = spawn('claude', args, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let buffer = '';
      let fullText = '';
      let promptTokens = 0;
      let completionTokens = 0;
      let totalCost = 0;
      let stopReason = 'stop';
      let stderr = '';

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

      child.stdin.write(prompt);
      child.stdin.end();

      child.on('close', (code) => {
        cleanupTempDir(tempDir);
        if (code !== 0) {
          console.error('CLI exited with code', code, 'stderr:', stderr);
          return res.status(500).json({
            error: {
              message: stderr || `CLI exited with code ${code}`,
              type: 'api_error',
            },
          });
        }

        try {
          const answerText = fullText || '';
          const toolCalls = hasExternalTools ? extractToolCalls(answerText) : [];

          let message;
          let finishReason;

          if (toolCalls.length > 0) {
            message = {
              role: 'assistant',
              content: null,
              tool_calls: toolCalls,
            };
            finishReason = 'tool_calls';
          } else {
            message = {
              role: 'assistant',
              content: answerText,
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

app.listen(PORT, () => {
  console.log(`Claude CLI proxy server running on http://localhost:${PORT}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Uses Claude Code CLI (Pro subscription credits)`);
});
