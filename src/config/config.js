import fs from 'fs';
import log from '../utils/logger.js';

const defaultConfig = {
  server: { port: 8045, host: '127.0.0.1' },
  api: {
    url: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    modelsUrl: 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:fetchAvailableModels',
    host: 'daily-cloudcode-pa.sandbox.googleapis.com',
    userAgent: 'antigravity/1.11.3 windows/amd64'
  },
  defaults: { temperature: 1, top_p: 0.85, top_k: 50, max_tokens: 8096 },
  security: { maxRequestSize: '50mb', apiKey: null, adminPassword: 'admin123' },
  systemInstruction: '你是聊天机器人，专门为用户提供聊天和情绪价值，协助进行小说创作或者角色扮演，也可以提供数学或者代码上的建议'
};

let config = JSON.parse(JSON.stringify(defaultConfig));

// Apply environment variables (takes precedence over config.json)
function applyEnvVars() {
  // Server config
  if (process.env.PORT) config.server.port = parseInt(process.env.PORT, 10);
  if (process.env.HOST) config.server.host = process.env.HOST;

  // Security config
  if (process.env.API_KEY) config.security.apiKey = process.env.API_KEY;
  if (process.env.ADMIN_PASSWORD) config.security.adminPassword = process.env.ADMIN_PASSWORD;
  if (process.env.MAX_REQUEST_SIZE) config.security.maxRequestSize = process.env.MAX_REQUEST_SIZE;

  // Default model params
  if (process.env.DEFAULT_TEMPERATURE) config.defaults.temperature = parseFloat(process.env.DEFAULT_TEMPERATURE);
  if (process.env.DEFAULT_TOP_P) config.defaults.top_p = parseFloat(process.env.DEFAULT_TOP_P);
  if (process.env.DEFAULT_TOP_K) config.defaults.top_k = parseInt(process.env.DEFAULT_TOP_K, 10);
  if (process.env.DEFAULT_MAX_TOKENS) config.defaults.max_tokens = parseInt(process.env.DEFAULT_MAX_TOKENS, 10);

  // System instruction
  if (process.env.SYSTEM_INSTRUCTION) config.systemInstruction = process.env.SYSTEM_INSTRUCTION;
}

export function reloadConfig() {
  try {
    // Try to load config.json if it exists
    if (fs.existsSync('./config.json')) {
      const newConfig = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

      // 递归合并配置
      // 1. 基础合并
      Object.assign(config, newConfig);

      // 2. 深度合并关键部分
      if (newConfig.server) Object.assign(config.server, newConfig.server);
      if (newConfig.api) Object.assign(config.api, newConfig.api);
      if (newConfig.defaults) Object.assign(config.defaults, newConfig.defaults);
      if (newConfig.security) Object.assign(config.security, newConfig.security);

      log.info('✓ 配置文件已重载');
    }

    // Apply env vars (they override config.json)
    applyEnvVars();

    return true;
  } catch (error) {
    log.error('⚠ 重载配置文件失败:', error.message);
    // Still apply env vars even if config.json fails
    applyEnvVars();
    return false;
  }
}

// 初始化加载
reloadConfig();

export default config;
