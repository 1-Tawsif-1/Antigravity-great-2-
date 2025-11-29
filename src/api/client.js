import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import logger from '../utils/logger.js';

async function tryRequest(token, url, requestBody) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Host': config.api.host,
      'User-Agent': config.api.userAgent,
      'Authorization': `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`API请求失败 (${response.status}): ${errorText}`);
    error.status = response.status;
    error.isRetryable = response.status === 429 || response.status === 403 || response.status === 500 || response.status === 503;
    throw error;
  }

  return response;
}

export async function generateAssistantResponse(requestBody, callback) {
  const totalTokens = tokenManager.tokens.length || 3;
  let lastError = null;
  
  // Try all available tokens before giving up
  for (let attempt = 0; attempt < totalTokens; attempt++) {
    const token = await tokenManager.getToken();

    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }

    const url = config.api.url;
    const source = token._source || 'file';

    try {
      const response = await tryRequest(token, url, requestBody);
      
      // Success - process the response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let thinkingStarted = false;
      let toolCalls = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.startsWith('data: '));

        for (const line of lines) {
          const jsonStr = line.slice(6);
          try {
            const data = JSON.parse(jsonStr);
            const parts = data.response?.candidates?.[0]?.content?.parts;
            if (parts) {
              for (const part of parts) {
                if (part.thought === true) {
                  if (!thinkingStarted) {
                    callback({ type: 'thinking', content: '<think>\n' });
                    thinkingStarted = true;
                  }
                  callback({ type: 'thinking', content: part.text || '' });
                } else if (part.text !== undefined) {
                  if (thinkingStarted) {
                    callback({ type: 'thinking', content: '\n</think>\n' });
                    thinkingStarted = false;
                  }
                  let content = part.text || '';
                  if (part.thought_signature) {
                    content += `\n<!-- thought_signature: ${part.thought_signature} -->`;
                  }

                  if (part.inlineData) {
                    const mimeType = part.inlineData.mimeType;
                    const data = part.inlineData.data;
                    content += `\n![Generated Image](data:${mimeType};base64,${data})`;
                  }

                  if (content) {
                    callback({ type: 'text', content: content });
                  }
                } else if (part.functionCall) {
                  toolCalls.push({
                    id: part.functionCall.id,
                    type: 'function',
                    function: {
                      name: part.functionCall.name,
                      arguments: JSON.stringify(part.functionCall.args)
                    }
                  });
                }
              }
            }

            if (data.response?.candidates?.[0]?.finishReason && toolCalls.length > 0) {
              if (thinkingStarted) {
                callback({ type: 'thinking', content: '\n</think>\n' });
                thinkingStarted = false;
              }
              callback({ type: 'tool_calls', tool_calls: toolCalls });
              toolCalls = [];
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }
      
      // Success - return without error
      return;
      
    } catch (error) {
      lastError = error;
      
      if (error.isRetryable && attempt < totalTokens - 1) {
        logger.warn(`Token (来源: ${source}) 请求失败 (${error.status})，尝试下一个token (${attempt + 1}/${totalTokens})`);
        // Continue to next token
        continue;
      }
      
      // Not retryable or last attempt - will throw after loop
      if (!error.isRetryable) {
        throw error;
      }
    }
  }

  // All tokens exhausted
  if (lastError) {
    logger.error('所有token都已尝试，全部失败');
    throw lastError;
  }
}

export async function getAvailableModels() {
  const totalTokens = tokenManager.tokens.length || 3;
  let lastError = null;
  
  for (let attempt = 0; attempt < totalTokens; attempt++) {
    const token = await tokenManager.getToken();

    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }

    try {
      const response = await fetch(config.api.modelsUrl, {
        method: 'POST',
        headers: {
          'Host': config.api.host,
          'User-Agent': config.api.userAgent,
          'Authorization': `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
          'Accept-Encoding': 'gzip'
        },
        body: JSON.stringify({})
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(`获取模型列表失败 (${response.status}): ${errorText}`);
        error.status = response.status;
        error.isRetryable = response.status === 429 || response.status === 403;
        throw error;
      }

      const responseText = await response.text();
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        throw new Error(`JSON解析失败: ${e.message}. 原始响应: ${responseText.substring(0, 200)}`);
      }

      return {
        object: 'list',
        data: Object.keys(data.models).map(id => ({
          id,
          object: 'model',
          created: Math.floor(Date.now() / 1000),
          owned_by: 'google'
        }))
      };
      
    } catch (error) {
      lastError = error;
      
      if (error.isRetryable && attempt < totalTokens - 1) {
        logger.warn(`获取模型列表失败，尝试下一个token (${attempt + 1}/${totalTokens})`);
        continue;
      }
      
      if (!error.isRetryable) {
        throw error;
      }
    }
  }

  if (lastError) {
    throw lastError;
  }
}
