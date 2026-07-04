require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'claude-3-5-sonnet-20240620';

app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ limit: '100mb', extended: true }));

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const AVAILABLE_MODELS = [
  { id: 'claude-3-5-sonnet-20240620', object: 'model', created: 1718000000, owned_by: 'anthropic' },
  { id: 'claude-3-opus-20240229', object: 'model', created: 1708000000, owned_by: 'anthropic' },
  { id: 'claude-3-sonnet-20240229', object: 'model', created: 1707000000, owned_by: 'anthropic' },
  { id: 'claude-3-haiku-20240307', object: 'model', created: 1709000000, owned_by: 'anthropic' },
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

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemMessages.push(contentToString(msg.content));
    } else if (msg.role === 'user' || msg.role === 'assistant') {
      conversationMessages.push({
        role: msg.role,
        content: contentToString(msg.content),
      });
    }
  }

  return {
    system: systemMessages.join('\n\n') || undefined,
    messages: conversationMessages,
  };
}

function mapModel(model) {
  const modelMap = {
    'gpt-4': 'claude-3-5-sonnet-20240620',
    'gpt-4o': 'claude-3-5-sonnet-20240620',
    'gpt-4-turbo': 'claude-3-opus-20240229',
    'gpt-3.5-turbo': 'claude-3-haiku-20240307',
  };
  return modelMap[model] || model || DEFAULT_MODEL;
}

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: AVAILABLE_MODELS,
  });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { messages, model, stream = false, temperature, max_tokens, top_p } = req.body;

    const anthropicModel = mapModel(model);
    const { system, messages: convertedMessages } = convertMessages(messages);

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const streamResponse = anthropic.messages.stream({
        model: anthropicModel,
        system,
        messages: convertedMessages,
        max_tokens: max_tokens || 4096,
        temperature: temperature !== undefined ? temperature : 0.7,
        top_p,
      });

      let fullText = '';
      let promptTokens = 0;
      let completionTokens = 0;

      streamResponse.on('text', (text) => {
        fullText += text;
        const chunk = {
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: anthropicModel,
          choices: [
            {
              index: 0,
              delta: { content: text },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      });

      streamResponse.on('message', (message) => {
        if (message.usage) {
          promptTokens = message.usage.input_tokens || 0;
          completionTokens = message.usage.output_tokens || 0;
        }
      });

      streamResponse.on('end', () => {
        const finalChunk = {
          id: 'chatcmpl-' + Date.now(),
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: anthropicModel,
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
        res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });

      streamResponse.on('error', (error) => {
        console.error('Stream error:', error);
        const errorChunk = {
          error: {
            message: error.message || 'Internal server error',
            type: 'api_error',
          },
        };
        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
        res.end();
      });

    } else {
      const response = await anthropic.messages.create({
        model: anthropicModel,
        system,
        messages: convertedMessages,
        max_tokens: max_tokens || 4096,
        temperature: temperature !== undefined ? temperature : 0.7,
        top_p,
      });

      const content = response.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      const openAIResponse = {
        id: 'chatcmpl-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: anthropicModel,
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: content,
            },
            finish_reason: response.stop_reason === 'end_turn' ? 'stop' : response.stop_reason,
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

app.listen(PORT, () => {
  console.log(`Claude API proxy server running on http://localhost:${PORT}`);
  console.log(`Default model: ${DEFAULT_MODEL}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
