import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from '../utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

class TokenManager {
  constructor(filePath = path.join(__dirname,'..','..','data' ,'accounts.json')) {
    this.filePath = filePath;
    this.tokens = [];
    this.currentIndex = 0;
    this.lastLoadTime = 0;
    this.loadInterval = 60000; // 1分钟内不重复加载
    this.cachedData = null; // 缓存文件数据，减少磁盘读取
    this.usageStats = new Map(); // Token 使用统计 { refresh_token -> { requests, lastUsed } }
    this.useEnvAccounts = false; // Flag to track if using env var
    this.tokenCooldowns = new Map(); // Track temporarily disabled tokens { refresh_token -> cooldownUntil }
    this.cooldownDuration = 5 * 60 * 1000; // 5 minutes cooldown for rate-limited tokens
    this.loadTokens();
  }

  // Parse a single ACCOUNTS_JSON env var (supports raw JSON and Base64)
  parseAccountsEnvVar(envVarName) {
    const envValue = process.env[envVarName];
    if (!envValue) return [];
    
    try {
      let jsonStr = envValue;
      
      // Check if it's Base64 encoded (doesn't start with '[')
      if (!jsonStr.trim().startsWith('[')) {
        try {
          jsonStr = Buffer.from(jsonStr, 'base64').toString('utf8');
          log.info(`从 Base64 编码的 ${envVarName} 解码`);
        } catch (decodeError) {
          // Not base64, try as raw JSON
        }
      }
      
      const parsed = JSON.parse(jsonStr);
      // Tag tokens with their source for logging
      parsed.forEach(token => {
        token._source = envVarName;
      });
      log.info(`从 ${envVarName} 加载了 ${parsed.length} 个token`);
      return parsed;
    } catch (parseError) {
      log.error(`解析 ${envVarName} 环境变量失败:`, parseError.message);
      return [];
    }
  }

  loadTokens() {
    try {
      // 避免频繁加载，1分钟内使用缓存
      if (Date.now() - this.lastLoadTime < this.loadInterval && this.tokens.length > 0) {
        return;
      }

      log.info('正在加载token...');
      
      let tokenArray = [];
      
      // Check for ACCOUNTS_JSON, ACCOUNTS_JSON_2 through ACCOUNTS_JSON_10
      const envVarNames = [
        'ACCOUNTS_JSON',
        'ACCOUNTS_JSON_2',
        'ACCOUNTS_JSON_3',
        'ACCOUNTS_JSON_4',
        'ACCOUNTS_JSON_5',
        'ACCOUNTS_JSON_6',
        'ACCOUNTS_JSON_7',
        'ACCOUNTS_JSON_8',
        'ACCOUNTS_JSON_9',
        'ACCOUNTS_JSON_10'
      ];
      
      let loadedFromEnv = false;
      for (const envVarName of envVarNames) {
        if (process.env[envVarName]) {
          const tokens = this.parseAccountsEnvVar(envVarName);
          tokenArray = tokenArray.concat(tokens);
          loadedFromEnv = true;
        }
      }
      
      if (loadedFromEnv) {
        this.useEnvAccounts = true;
        log.info(`从环境变量加载token完成，共 ${tokenArray.length} 个`);
      } else {
        // Fallback to file
        const data = fs.readFileSync(this.filePath, 'utf8');
        tokenArray = JSON.parse(data);
        this.useEnvAccounts = false;
        log.info('从文件加载token');
      }
      
      this.cachedData = tokenArray; // 缓存原始数据
      
      // Filter enabled tokens and check cooldowns
      const now = Date.now();
      this.tokens = tokenArray.filter(token => {
        if (token.enable === false) return false;
        
        // Check if token is in cooldown
        const cooldownUntil = this.tokenCooldowns.get(token.refresh_token);
        if (cooldownUntil && now < cooldownUntil) {
          const remainingSeconds = Math.ceil((cooldownUntil - now) / 1000);
          log.info(`Token 仍在冷却中，剩余 ${remainingSeconds} 秒`);
          return false;
        } else if (cooldownUntil && now >= cooldownUntil) {
          // Cooldown expired, re-enable token
          this.tokenCooldowns.delete(token.refresh_token);
          log.info(`Token 冷却结束，重新启用`);
        }
        return true;
      });
      
      // Keep currentIndex in bounds
      if (this.currentIndex >= this.tokens.length) {
        this.currentIndex = 0;
      }
      
      this.lastLoadTime = Date.now();
      log.info(`成功加载 ${this.tokens.length} 个可用token (共 ${tokenArray.length} 个)`);

      // 触发垃圾回收（如果可用）
      if (global.gc) {
        global.gc();
      }
    } catch (error) {
      log.error('加载token失败:', error.message);
      this.tokens = [];
    }
  }
  
  // Temporarily disable a token (rate limit/error) with cooldown
  setCooldown(token, durationMs = this.cooldownDuration) {
    const cooldownUntil = Date.now() + durationMs;
    this.tokenCooldowns.set(token.refresh_token, cooldownUntil);
    const source = token._source || 'file';
    log.warn(`Token (来源: ${source}) 进入冷却期 ${durationMs / 1000} 秒`);
  }
  
  // Force reload tokens (clears cache timer)
  forceReload() {
    this.lastLoadTime = 0;
    this.loadTokens();
  }

  isExpired(token) {
    if (!token.timestamp || !token.expires_in) return true;
    const expiresAt = token.timestamp + (token.expires_in * 1000);
    return Date.now() >= expiresAt - 300000;
  }

  async refreshToken(token) {
    log.info('正在刷新token...');
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Host': 'oauth2.googleapis.com',
        'User-Agent': 'Go-http-client/1.1',
        'Content-Length': body.toString().length.toString(),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept-Encoding': 'gzip'
      },
      body: body.toString()
    });

    if (response.ok) {
      const data = await response.json();
      token.access_token = data.access_token;
      token.expires_in = data.expires_in;
      token.timestamp = Date.now();
      this.saveToFile();
      return token;
    } else {
      throw { statusCode: response.status, message: await response.text() };
    }
  }

  saveToFile() {
    // Skip saving if using environment variable (can't write to env vars)
    if (this.useEnvAccounts) {
      log.info('使用环境变量模式，跳过文件保存（token状态仅在内存中更新）');
      return;
    }
    
    try {
      // 使用缓存数据，减少磁盘读取
      let allTokens = this.cachedData;
      if (!allTokens) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        allTokens = JSON.parse(data);
      }

      this.tokens.forEach(memToken => {
        const index = allTokens.findIndex(t => t.refresh_token === memToken.refresh_token);
        if (index !== -1) allTokens[index] = memToken;
      });

      fs.writeFileSync(this.filePath, JSON.stringify(allTokens, null, 2), 'utf8');
      this.cachedData = allTokens; // 更新缓存
    } catch (error) {
      log.error('保存文件失败:', error.message);
    }
  }

  disableToken(token) {
    log.warn(`禁用token`)
    token.enable = false;
    this.saveToFile();
    this.loadTokens();
  }

  async getToken() {
    // Force reload to check cooldowns
    this.lastLoadTime = 0;
    this.loadTokens();
    
    if (this.tokens.length === 0) {
      log.warn('没有可用token，检查是否所有token都在冷却中...');
      // Check if we have tokens in cooldown that we can wait for
      if (this.tokenCooldowns.size > 0) {
        log.info(`${this.tokenCooldowns.size} 个token在冷却中，等待最近的一个...`);
      }
      return null;
    }

    const startIndex = this.currentIndex;
    let attempts = 0;
    
    while (attempts < this.tokens.length) {
      const token = this.tokens[this.currentIndex];
      const tokenIndex = this.currentIndex;
      const source = token._source || 'file';

      try {
        if (this.isExpired(token)) {
          await this.refreshToken(token);
        }
        
        // Move to next token for round-robin
        this.currentIndex = (this.currentIndex + 1) % this.tokens.length;

        // 记录使用统计
        this.recordUsage(token);
        log.info(`🔄 轮询使用 Token #${tokenIndex} (来源: ${source}) (总请求: ${this.getTokenRequests(token)})`);

        return token;
      } catch (error) {
        const statusCode = error.statusCode || error.status;
        
        if (statusCode === 403) {
          log.warn(`Token #${tokenIndex} (来源: ${source}) 遇到403错误，进入冷却期`);
          this.setCooldown(token, this.cooldownDuration);
        } else if (statusCode === 429) {
          // Rate limited - longer cooldown
          log.warn(`Token #${tokenIndex} (来源: ${source}) 遇到429限流，进入较长冷却期`);
          this.setCooldown(token, this.cooldownDuration * 2); // 10 minutes for rate limit
        } else {
          log.error(`Token #${tokenIndex} (来源: ${source}) 错误:`, error.message);
          // Short cooldown for other errors
          this.setCooldown(token, 60 * 1000); // 1 minute
        }
        
        // Move to next token
        this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
        attempts++;
        
        // Reload to exclude cooldown tokens
        this.lastLoadTime = 0;
        this.loadTokens();
        
        if (this.tokens.length === 0) {
          log.error('所有token都在冷却中');
          return null;
        }
        
        // Adjust currentIndex if needed
        if (this.currentIndex >= this.tokens.length) {
          this.currentIndex = 0;
        }
      }
    }

    log.error('尝试所有token后仍失败');
    return null;
  }

  // 记录 Token 使用
  recordUsage(token) {
    const key = token.refresh_token;
    if (!this.usageStats.has(key)) {
      this.usageStats.set(key, { requests: 0, lastUsed: null });
    }
    const stats = this.usageStats.get(key);
    stats.requests++;
    stats.lastUsed = Date.now();
  }

  // 获取单个 Token 的请求次数
  getTokenRequests(token) {
    const stats = this.usageStats.get(token.refresh_token);
    return stats ? stats.requests : 0;
  }

  // 获取所有 Token 的使用统计
  getUsageStats() {
    const stats = [];
    this.tokens.forEach((token, index) => {
      const usage = this.usageStats.get(token.refresh_token) || { requests: 0, lastUsed: null };
      stats.push({
        index,
        requests: usage.requests,
        lastUsed: usage.lastUsed ? new Date(usage.lastUsed).toISOString() : null,
        isCurrent: index === this.currentIndex
      });
    });
    return {
      totalTokens: this.tokens.length,
      currentIndex: this.currentIndex,
      totalRequests: Array.from(this.usageStats.values()).reduce((sum, s) => sum + s.requests, 0),
      tokens: stats
    };
  }

  disableCurrentToken(token) {
    const found = this.tokens.find(t => t.access_token === token.access_token);
    if (found) {
      this.disableToken(found);
    }
  }

  async handleRequestError(error, currentAccessToken) {
    const statusCode = error.statusCode || error.status;
    
    if (statusCode === 403 || statusCode === 429) {
      const errorType = statusCode === 429 ? '429限流' : '403';
      log.warn(`请求遇到${errorType}错误，尝试切换token`);
      
      // Find the token that was used
      const usedToken = this.tokens.find(t => t.access_token === currentAccessToken);
      if (usedToken) {
        const cooldownTime = statusCode === 429 ? this.cooldownDuration * 2 : this.cooldownDuration;
        this.setCooldown(usedToken, cooldownTime);
      }
      
      // Try to get a new token
      return await this.getToken();
    }
    return null;
  }
  
  // Get status of all tokens including cooldowns
  getTokenPoolStatus() {
    const now = Date.now();
    const allTokens = this.cachedData || [];
    
    return {
      totalConfigured: allTokens.length,
      available: this.tokens.length,
      inCooldown: this.tokenCooldowns.size,
      currentIndex: this.currentIndex,
      tokens: allTokens.map((token, index) => {
        const cooldownUntil = this.tokenCooldowns.get(token.refresh_token);
        const usage = this.usageStats.get(token.refresh_token) || { requests: 0, lastUsed: null };
        
        return {
          index,
          source: token._source || 'file',
          enabled: token.enable !== false,
          inCooldown: cooldownUntil ? now < cooldownUntil : false,
          cooldownRemaining: cooldownUntil ? Math.max(0, Math.ceil((cooldownUntil - now) / 1000)) : 0,
          requests: usage.requests,
          lastUsed: usage.lastUsed ? new Date(usage.lastUsed).toISOString() : null
        };
      })
    };
  }
}
const tokenManager = new TokenManager();
export default tokenManager;
