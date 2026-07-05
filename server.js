require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const {
  DEFAULT_BODY_LIMIT,
  authenticate,
  corsOptions,
  installErrorHandler,
  validateChatRequest,
} = require('./proxy-common');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-sonnet-4-6';

app.use(cors(corsOptions()));
app.use(express.json({ limit: DEFAULT_BODY_LIMIT }));
app.use(express.urlencoded({ limit: DEFAULT_BODY_LIMIT, extended: true }));
app.use(authenticate);

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const AVAILABLE_MODELS = [
  { id: 'claude-opus-4-8', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-sonnet-4-6', object: 'model', owned_by: 'anthropic' },
  { id: 'claude-haiku-4-5', object: 'model', owned_by: 'anthropic' },
];

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

function convertMessages(messages) {
  const systemMessages = [];
  const conversationMessages = [];
  const appendMessage = (role, content) => {
    const previous = conversationMessages[conversationMessages.length - 1];
    if (previous?.role === role) {
      const previousContent = Array.isArray(previous.content)
        ? previous.content
        : [{ type: 'text', text: previous.content }];
      const nextContent = Array.isArray(content) ? content : [{ type: 'text', text: content }];
      previous.content = [...previousContent, ...nextContent];
    } else {
      conversationMessages.push({ role, content });
    }
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessages.push(contentToString(msg.content));
    } else if (msg.role === 'assistant') {
      const content = [];
      const text = contentToString(msg.content);
      if (text) content.push({ type: 'text', text });
      for (const call of msg.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(call.function?.arguments || '{}'); } catch (_) {}
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function?.name || '',
          input,
        });
      }
      appendMessage('assistant', content);
    } else if (msg.role === 'tool') {
      appendMessage('user', [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: contentToString(msg.content),
        }]);
    } else if (msg.role === 'user') {
      appendMessage('user', contentToString(msg.content));
    }
  }

  return {
    system: systemMessages.join('\n\n') || undefined,
    messages: conversationMessages,
  };
}

function convertTools(tools = []) {
  return tools
    .filter(tool => tool.type === 'function' && tool.function?.name)
    .map(tool => ({
      name: tool.function.name,
      description: tool.function.description || '',
      input_schema: tool.function.parameters || { type: 'object', properties: {} },
    }));
}

function parseTextToolCalls(text) {
  if (!text || typeof text !== 'string') return [];

  const trimmed = text.trim();
  const jsonText = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed;

  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed?.tool_calls)) return [];

    return parsed.tool_calls
      .map((call, index) => {
        const name = call.function?.name || call.name;
        if (!name) return null;

        const rawArguments = call.function?.arguments ?? call.arguments ?? {};
        return {
          id: call.id || `call_${Date.now()}_${index}`,
          type: 'function',
          function: {
            name,
            arguments: typeof rawArguments === 'string'
              ? rawArguments
              : JSON.stringify(rawArguments),
          },
        };
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function convertResponseContent(content = []) {
  let text = content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
  let toolCalls = content
    .filter(block => block.type === 'tool_use')
    .map(block => ({
      id: block.id,
      type: 'function',
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input || {}),
      },
    }));

  if (!toolCalls.length) {
    toolCalls = parseTextToolCalls(text);
    if (toolCalls.length) text = '';
  }

  return {
    message: {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    finishReason: toolCalls.length ? 'tool_calls' : 'stop',
  };
}

function mapModel(model) {
  const modelMap = {
    'gpt-4': 'claude-opus-4-8',
    'gpt-4o': 'claude-sonnet-4-6',
    'gpt-4-turbo': 'claude-opus-4-8',
    'gpt-3.5-turbo': 'claude-haiku-4-5',
  };
  return modelMap[model] || model || DEFAULT_MODEL;
}

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: AVAILABLE_MODELS,
  });
});

app.post('/v1/chat/completions', validateChatRequest, async (req, res) => {
  try {
    const { messages, model, stream = false, temperature, max_tokens, top_p, tools } = req.body;

    const anthropicModel = mapModel(model);
    const { system, messages: convertedMessages } = convertMessages(messages);
    
    const anthropicTools = convertTools(tools);
    const requestOptions = {
      model: anthropicModel,
      system,
      messages: convertedMessages,
      max_tokens: max_tokens || 4096,
      temperature: temperature !== undefined ? temperature : 0.7,
      top_p,
      ...(anthropicTools.length ? { tools: anthropicTools } : {}),
    };

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const responseId = 'chatcmpl-' + Date.now();
      const messageStream = anthropic.messages.stream(requestOptions);
      let disconnected = false;
      res.on('close', () => {
        if (!res.writableEnded) {
          disconnected = true;
          messageStream.abort();
        }
      });

      messageStream.on('text', text => {
        if (disconnected || res.writableEnded) return;
        res.write(`data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: anthropicModel,
          choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
        })}\n\n`);
      });

      const response = await messageStream.finalMessage();
      if (disconnected || res.writableEnded) return;
      const { message, finishReason } = convertResponseContent(response.content);
      if (message.tool_calls) {
        res.write(`data: ${JSON.stringify({
          id: responseId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: anthropicModel,
          choices: [{
            index: 0,
            delta: { tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) },
            finish_reason: null,
          }],
        })}\n\n`);
      }

        const finalChunk = {
          id: responseId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: anthropicModel,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
          usage: {
            prompt_tokens: response.usage.input_tokens,
            completion_tokens: response.usage.output_tokens,
            total_tokens: response.usage.input_tokens + response.usage.output_tokens,
          },
        };
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();

    } else {
      const response = await anthropic.messages.create(requestOptions);
      const { message, finishReason } = convertResponseContent(response.content);

      const openAIResponse = {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: anthropicModel,
        choices: [
          {
            index: 0,
            message: message,
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: response.usage.input_tokens,
          completion_tokens: response.usage.output_tokens,
          total_tokens: response.usage.input_tokens + response.usage.output_tokens,
        },
      };

      res.json(openAIResponse);
    }
  } catch (error) {
    console.error('Error:', error);
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({
          error: { message: error.message || 'Internal server error', type: 'api_error' },
        })}\n\n`);
        res.end();
      }
      return;
    }
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'api_error',
      },
    });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Claude API proxy is running' });
});

installErrorHandler(app);

app.listen(PORT, () => {
  console.log(`Claude API proxy server running on http://localhost:${PORT}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
