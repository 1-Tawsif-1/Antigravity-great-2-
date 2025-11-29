import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { generateAssistantResponse, getAvailableModels } from '../api/client.js';
import { generateRequestBody } from '../utils/utils.js';
import { generateAnthropicRequestBody, generateMessageId } from '../utils/anthropic.js';
import logger from '../utils/logger.js';
import config from '../config/config.js';
import adminRoutes, { incrementRequestCount, addLog } from '../admin/routes.js';
import { validateKey, checkRateLimit } from '../admin/key_manager.js';
import idleManager from '../utils/idle_manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 确保必要的目录存在
const ensureDirectories = () => {
  const dirs = ['data', 'uploads'];
  dirs.forEach(dir => {
    const dirPath = path.join(process.cwd(), dir);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
      logger.info(`创建目录: ${dir}`);
    }
  });
};

ensureDirectories();

const app = express();

// Track uptime statistics
let uptimeStats = {
  startTime: Date.now(),
  pingCount: 0,
  lastPing: null
};

// Health check endpoint for UptimeRobot (no auth required)
app.get('/health', (req, res) => {
  uptimeStats.pingCount++;
  uptimeStats.lastPing = new Date().toISOString();
  
  const uptime = Math.floor((Date.now() - uptimeStats.startTime) / 1000);
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = uptime % 60;
  
  logger.info(`[UptimeRobot] Health check ping #${uptimeStats.pingCount} | Uptime: ${hours}h ${minutes}m ${seconds}s`);
  
  res.json({
    status: 'ok',
    timestamp: uptimeStats.lastPing,
    uptime: `${hours}h ${minutes}m ${seconds}s`,
    pingCount: uptimeStats.pingCount,
    service: 'Antigravity Gateway'
  });
});

// Alias endpoints for flexibility
app.get('/ping', (req, res) => {
  uptimeStats.pingCount++;
  uptimeStats.lastPing = new Date().toISOString();
  logger.info(`[UptimeRobot] Ping #${uptimeStats.pingCount} received`);
  res.send('pong');
});

app.use(express.json({ limit: config.security.maxRequestSize }));

// 静态文件服务 - 提供管理控制台页面
app.use(express.static(path.join(process.cwd(), 'client/dist')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `请求体过大，最大支持 ${config.security.maxRequestSize}` });
  }
  next(err);
});

// ... (rest of the file)



// 请求日志中间件
app.use((req, res, next) => {
  // 记录请求活动，管理空闲状态
  if (req.path.startsWith('/v1/')) {
    idleManager.recordActivity();
  }

  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.request(req.method, req.path, res.statusCode, duration);

    // 记录到管理日志
    if (req.path.startsWith('/v1/')) {
      incrementRequestCount();
      addLog('info', `${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    }
  });
  next();
});

// API 密钥验证和频率限制中间件
app.use(async (req, res, next) => {
  if (req.path.startsWith('/v1/')) {
    const apiKey = config.security?.apiKey;
    if (apiKey) {
      const authHeader = req.headers.authorization;
      const providedKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

      // 先检查配置文件中的密钥（不受频率限制）
      if (providedKey === apiKey) {
        return next();
      }

      // 再检查数据库中的密钥
      const isValid = await validateKey(providedKey);
      if (!isValid) {
        logger.warn(`API Key 验证失败: ${req.method} ${req.path}`);
        await addLog('warn', `API Key 验证失败: ${req.method} ${req.path}`);
        return res.status(401).json({ error: 'Invalid API Key' });
      }

      // 检查频率限制
      const rateLimitCheck = await checkRateLimit(providedKey);
      if (!rateLimitCheck.allowed) {
        logger.warn(`频率限制: ${req.method} ${req.path} - ${rateLimitCheck.error}`);
        await addLog('warn', `频率限制触发: ${providedKey.substring(0, 10)}...`);

        res.setHeader('X-RateLimit-Limit', rateLimitCheck.limit || 0);
        res.setHeader('X-RateLimit-Remaining', 0);
        res.setHeader('X-RateLimit-Reset', rateLimitCheck.resetIn || 0);

        return res.status(429).json({
          error: {
            message: rateLimitCheck.error,
            type: 'rate_limit_exceeded',
            reset_in_seconds: rateLimitCheck.resetIn
          }
        });
      }

      // 设置频率限制响应头
      if (rateLimitCheck.limit) {
        res.setHeader('X-RateLimit-Limit', rateLimitCheck.limit);
        res.setHeader('X-RateLimit-Remaining', rateLimitCheck.remaining);
      }
    }
  }
  next();
});

// 管理路由
app.use('/admin', adminRoutes);

app.get('/v1/models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    res.json(models);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  let { messages, model, stream = true, tools, ...params } = req.body;
  try {

    if (!messages) {
      return res.status(400).json({ error: 'messages is required' });
    }

    // 智能检测：NewAPI测速请求通常消息很简单，强制使用非流式响应
    // 检测条件：单条消息 + 内容很短（如 "hi", "test" 等）
    const isSingleShortMessage = messages.length === 1 &&
      messages[0].content &&
      messages[0].content.length < 20;

    // 如果检测到可能是测速请求，且未明确要求流式，则使用非流式
    if (isSingleShortMessage && req.body.stream === undefined) {
      stream = false;
    }

    const authHeader = req.headers.authorization;
    const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    const requestBody = generateRequestBody(messages, model, params, tools, apiKey);


    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const id = `chatcmpl-${Date.now()}`;
      const created = Math.floor(Date.now() / 1000);
      let hasToolCall = false;

      await generateAssistantResponse(requestBody, (data) => {
        if (data.type === 'tool_calls') {
          hasToolCall = true;
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { tool_calls: data.tool_calls }, finish_reason: null }]
          })}\n\n`);
        } else {
          res.write(`data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{ index: 0, delta: { content: data.content }, finish_reason: null }]
          })}\n\n`);
        }
      });

      res.write(`data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: hasToolCall ? 'tool_calls' : 'stop' }]
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      let fullContent = '';
      let toolCalls = [];
      await generateAssistantResponse(requestBody, (data) => {
        if (data.type === 'tool_calls') {
          toolCalls = data.tool_calls;
        } else {
          fullContent += data.content;
        }
      });

      const message = { role: 'assistant', content: fullContent };
      if (toolCalls.length > 0) {
        message.tool_calls = toolCalls;
      }

      res.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message,
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }]
      });
    }
  } catch (error) {
    logger.error('生成响应失败:', error.message);
    if (!res.headersSent) {
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const id = `chatcmpl-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: `错误: ${error.message}` }, finish_reason: null }]
        })}\n\n`);
        res.write(`data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } else {
        res.status(500).json({ error: error.message });
      }
    }
  }
});

// Anthropic API endpoint - /v1/messages
app.post('/v1/messages', async (req, res) => {
  let { messages, model, stream = false, max_tokens, system, tools, ...params } = req.body;
  
  try {
    if (!messages) {
      return res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'messages is required' }
      });
    }

    if (!max_tokens) {
      return res.status(400).json({
        type: 'error',
        error: { type: 'invalid_request_error', message: 'max_tokens is required' }
      });
    }

    const authHeader = req.headers.authorization || req.headers['x-api-key'];
    const apiKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    const requestBody = generateAnthropicRequestBody({
      messages,
      model,
      max_tokens,
      system,
      tools,
      ...params
    }, apiKey);

    const messageId = generateMessageId();
    let inputTokens = 0;
    let outputTokens = 0;

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      // Send message_start event
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 1 }
        }
      })}\n\n`);

      let contentBlockIndex = 0;
      let currentBlockType = null;
      let hasToolUse = false;
      let thinkingStarted = false;
      let thinkingBlockIndex = -1;
      let textBlockIndex = -1;

      await generateAssistantResponse(requestBody, (data) => {
        if (data.type === 'thinking') {
          // Handle thinking blocks
          if (data.content === '<think>\n') {
            thinkingStarted = true;
            thinkingBlockIndex = contentBlockIndex;
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'thinking', thinking: '' }
            })}\n\n`);
            contentBlockIndex++;
          } else if (data.content === '\n</think>\n') {
            if (thinkingStarted && thinkingBlockIndex >= 0) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: thinkingBlockIndex
              })}\n\n`);
            }
            thinkingStarted = false;
          } else if (thinkingStarted && data.content) {
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: thinkingBlockIndex,
              delta: { type: 'thinking_delta', thinking: data.content }
            })}\n\n`);
            outputTokens += Math.ceil(data.content.length / 4);
          }
        } else if (data.type === 'tool_calls') {
          hasToolUse = true;
          for (const toolCall of data.tool_calls) {
            // Start tool_use block
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'tool_use', id: toolCall.id, name: toolCall.function.name, input: {} }
            })}\n\n`);

            // Send input delta
            const inputJson = toolCall.function.arguments;
            res.write(`event: content_block_delta\ndata: ${JSON.stringify({
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'input_json_delta', partial_json: inputJson }
            })}\n\n`);

            // Stop tool_use block
            res.write(`event: content_block_stop\ndata: ${JSON.stringify({
              type: 'content_block_stop',
              index: contentBlockIndex
            })}\n\n`);

            contentBlockIndex++;
            outputTokens += Math.ceil(inputJson.length / 4);
          }
        } else if (data.content) {
          // Start text block if not started
          if (textBlockIndex < 0) {
            textBlockIndex = contentBlockIndex;
            res.write(`event: content_block_start\ndata: ${JSON.stringify({
              type: 'content_block_start',
              index: contentBlockIndex,
              content_block: { type: 'text', text: '' }
            })}\n\n`);
            contentBlockIndex++;
          }

          res.write(`event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: textBlockIndex,
            delta: { type: 'text_delta', text: data.content }
          })}\n\n`);
          outputTokens += Math.ceil(data.content.length / 4);
        }
      });

      // Close text block if open
      if (textBlockIndex >= 0) {
        res.write(`event: content_block_stop\ndata: ${JSON.stringify({
          type: 'content_block_stop',
          index: textBlockIndex
        })}\n\n`);
      }

      // Send message_delta with stop_reason
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: {
          stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
          stop_sequence: null
        },
        usage: { output_tokens: outputTokens }
      })}\n\n`);

      // Send message_stop
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
      res.end();

    } else {
      // Non-streaming response
      let fullContent = '';
      let toolCalls = [];
      let thinkingContent = '';
      let thinkingStarted = false;

      await generateAssistantResponse(requestBody, (data) => {
        if (data.type === 'thinking') {
          if (data.content === '<think>\n') {
            thinkingStarted = true;
          } else if (data.content === '\n</think>\n') {
            thinkingStarted = false;
          } else if (thinkingStarted) {
            thinkingContent += data.content;
          }
        } else if (data.type === 'tool_calls') {
          toolCalls = data.tool_calls;
        } else {
          fullContent += data.content;
        }
      });

      const content = [];

      // Add thinking block if present
      if (thinkingContent) {
        content.push({ type: 'thinking', thinking: thinkingContent });
      }

      // Add text block
      if (fullContent) {
        content.push({ type: 'text', text: fullContent });
      }

      // Add tool_use blocks
      for (const toolCall of toolCalls) {
        let parsedInput = {};
        try {
          parsedInput = JSON.parse(toolCall.function.arguments);
        } catch (e) {
          parsedInput = { query: toolCall.function.arguments };
        }
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: parsedInput
        });
      }

      res.json({
        id: messageId,
        type: 'message',
        role: 'assistant',
        content,
        model,
        stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: Math.ceil((fullContent.length + thinkingContent.length) / 4)
        }
      });
    }
  } catch (error) {
    logger.error('Anthropic API 响应失败:', error.message);
    if (!res.headersSent) {
      res.status(500).json({
        type: 'error',
        error: {
          type: 'api_error',
          message: error.message
        }
      });
    }
  }
});

// 所有其他请求返回 index.html (SPA 支持)
// Express 5 requires (.*) instead of * for wildcard
app.get(/(.*)/, (req, res) => {
  res.sendFile(path.join(process.cwd(), 'client/dist', 'index.html'));
});

const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`服务器已启动: ${config.server.host}:${config.server.port}`);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`端口 ${config.server.port} 已被占用`);
    process.exit(1);
  } else if (error.code === 'EACCES') {
    logger.error(`端口 ${config.server.port} 无权限访问`);
    process.exit(1);
  } else {
    logger.error('服务器启动失败:', error.message);
    process.exit(1);
  }
});

const shutdown = () => {
  logger.info('正在关闭服务器...');

  // 清理空闲管理器
  idleManager.destroy();

  server.close(() => {
    logger.info('服务器已关闭');
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
