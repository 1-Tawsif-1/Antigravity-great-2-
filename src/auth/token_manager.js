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
    this.cachedData = null;
    this.usageStats = new Map();
    this.useEnvAccounts = false;
    this.loadTokens();
  }

  parseAccountsEnvVar(envVarName) {
    const envValue = process.env[envVarName];
    if (!envValue) return [];
    
    try {
      let jsonStr = envValue;
      
      if (!jsonStr.trim().startsWith('[')) {
        try {
          jsonStr = Buffer.from(jsonStr, 'base64').toString('utf8');
          log.info(`从 Base64 编码的 ${envVarName} 解码`);
        } catch (decodeError) {
          // Not base64, try as raw JSON
        }
      }
      
      const parsed = JSON.parse(jsonStr);
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
      if (Date.now() - this.lastLoadTime < this.loadInterval && this.tokens.length > 0) {
        return;
      }

      log.info('正在加载token...');
      
      let tokenArray = [];
      
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
        const data = fs.readFileSync(this.filePath, 'utf8');
        tokenArray = JSON.parse(data);
        this.useEnvAccounts = false;
        log.info('从文件加载token');
      }
      
      this.cachedData = tokenArray;
      this.tokens = tokenArray.filter(token => token.enable !== false);
      
      if (this.currentIndex >= this.tokens.length) {
        this.currentIndex = 0;
      }
      
      this.lastLoadTime = Date.now();
      log.info(`成功加载 ${this.tokens.length} 个可用token`);

      if (global.gc) {
        global.gc();
      }
    } catch (error) {
      log.error('加载token失败:', error.message);
      this.tokens = [];
    }
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
    if (this.useEnvAccounts) {
      return;
    }
    
    try {
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
      this.cachedData = allTokens;
    } catch (error) {
      log.error('保存文件失败:', error.message);
    }
  }

  async getToken() {
    this.loadTokens();
    
    if (this.tokens.length === 0) {
      return null;
    }

    // Simple round-robin rotation - no cooldown
    for (let i = 0; i < this.tokens.length; i++) {
      const token = this.tokens[this.currentIndex];
      const tokenIndex = this.currentIndex;
      const source = token._source || 'file';

      // Move to next token immediately for round-robin
      this.currentIndex = (this.currentIndex + 1) % this.tokens.length;

      try {
        if (this.isExpired(token)) {
          await this.refreshToken(token);
        }
        
        this.recordUsage(token);
        log.info(`🔄 轮询使用 Token #${tokenIndex} (来源: ${source}) (总请求: ${this.getTokenRequests(token)})`);

        return token;
      } catch (error) {
        log.warn(`Token #${tokenIndex} 刷新失败，尝试下一个: ${error.message}`);
        // Continue to next token without cooldown
      }
    }

    // If all tokens failed to refresh, return the first one anyway
    // Let the API call handle the error
    const fallbackToken = this.tokens[0];
    if (fallbackToken) {
      log.warn('所有token刷新失败，使用第一个token');
      return fallbackToken;
    }

    return null;
  }

  recordUsage(token) {
    const key = token.refresh_token;
    if (!this.usageStats.has(key)) {
      this.usageStats.set(key, { requests: 0, lastUsed: null });
    }
    const stats = this.usageStats.get(key);
    stats.requests++;
    stats.lastUsed = Date.now();
  }

  getTokenRequests(token) {
    const stats = this.usageStats.get(token.refresh_token);
    return stats ? stats.requests : 0;
  }

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

  // Get total number of tokens
  getTokenCount() {
    this.loadTokens();
    return this.tokens.length;
  }

  // Get token by specific index (for retry logic)
  async getTokenByIndex(index) {
    this.loadTokens();
    
    if (this.tokens.length === 0 || index >= this.tokens.length) {
      return null;
    }

    const token = this.tokens[index];
    const source = token._source || 'file';

    try {
      if (this.isExpired(token)) {
        await this.refreshToken(token);
      }
      
      this.recordUsage(token);
      log.info(`🔄 使用 Token #${index} (来源: ${source}) (总请求: ${this.getTokenRequests(token)})`);

      return token;
    } catch (error) {
      log.warn(`Token #${index} 刷新失败: ${error.message}`);
      // Return the token anyway, let API call handle it
      return token;
    }
  }
}

const tokenManager = new TokenManager();
export default tokenManager;
