const DEFAULT_BODY_LIMIT = process.env.BODY_LIMIT || '10mb';

function parseAllowedOrigins() {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
}

function corsOptions() {
  const allowedOrigins = parseAllowedOrigins();
  return {
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      callback(new Error('Origin is not allowed by CORS'));
    },
  };
}

function authenticate(req, res, next) {
  const apiKey = process.env.PROXY_API_KEY;
  if (!apiKey) return next();

  const authorization = req.get('authorization') || '';
  const suppliedKey = authorization.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : req.get('x-api-key');

  if (suppliedKey !== apiKey) {
    return res.status(401).json({
      error: { message: 'Invalid or missing API key', type: 'authentication_error' },
    });
  }
  next();
}

function validateChatRequest(req, res, next) {
  if (!Array.isArray(req.body?.messages) || req.body.messages.length === 0) {
    return res.status(400).json({
      error: { message: '`messages` must be a non-empty array', type: 'invalid_request_error' },
    });
  }
  next();
}

function installErrorHandler(app) {
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.type === 'entity.too.large' ? 413 : 400;
    res.status(status).json({
      error: { message: error.message || 'Invalid request', type: 'invalid_request_error' },
    });
  });
}

module.exports = {
  DEFAULT_BODY_LIMIT,
  authenticate,
  corsOptions,
  installErrorHandler,
  validateChatRequest,
};
