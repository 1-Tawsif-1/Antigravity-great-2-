import { randomUUID } from 'crypto';
import config from '../config/config.js';

// Generate unique message ID for Anthropic format
function generateMessageId() {
  return `msg_${randomUUID().replace(/-/g, '').substring(0, 24)}`;
}

// Extract system message from Anthropic request (it's a separate field)
function extractSystemMessage(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map(block => {
      if (typeof block === 'string') return block;
      if (block.type === 'text') return block.text;
      return '';
    }).join('\n');
  }
  return '';
}

// Extract images from Anthropic content blocks
function extractImagesFromAnthropicContent(content) {
  const result = { text: '', images: [] };

  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'text') {
        result.text += block.text;
      } else if (block.type === 'image') {
        const source = block.source;
        if (source?.type === 'base64') {
          result.images.push({
            inlineData: {
              mimeType: source.media_type,
              data: source.data
            }
          });
        }
      }
    }
  }

  return result;
}

// Convert Anthropic messages to Antigravity format
function anthropicMessageToAntigravity(messages) {
  const antigravityMessages = [];

  for (const message of messages) {
    if (message.role === 'user') {
      const extracted = extractImagesFromAnthropicContent(message.content);
      antigravityMessages.push({
        role: 'user',
        parts: [
          { text: extracted.text },
          ...extracted.images
        ]
      });
    } else if (message.role === 'assistant') {
      const parts = [];
      
      if (typeof message.content === 'string') {
        if (message.content.trim()) {
          parts.push({ text: message.content });
        }
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text?.trim()) {
            parts.push({ text: block.text });
          } else if (block.type === 'tool_use') {
            parts.push({
              functionCall: {
                id: block.id,
                name: block.name,
                args: block.input
              }
            });
          }
        }
      }

      if (parts.length > 0) {
        antigravityMessages.push({
          role: 'model',
          parts
        });
      }
    } else if (message.role === 'tool_result' || message.role === 'user' && message.content?.[0]?.type === 'tool_result') {
      // Handle tool results
      const toolResults = message.role === 'tool_result' 
        ? [message] 
        : message.content.filter(b => b.type === 'tool_result');

      for (const result of toolResults) {
        const toolUseId = result.tool_use_id;
        
        // Find the function name from previous assistant message
        let functionName = '';
        for (let i = antigravityMessages.length - 1; i >= 0; i--) {
          if (antigravityMessages[i].role === 'model') {
            const modelParts = antigravityMessages[i].parts;
            for (const part of modelParts) {
              if (part.functionCall && part.functionCall.id === toolUseId) {
                functionName = part.functionCall.name;
                break;
              }
            }
            if (functionName) break;
          }
        }

        const resultContent = typeof result.content === 'string' 
          ? result.content 
          : JSON.stringify(result.content);

        const lastMessage = antigravityMessages[antigravityMessages.length - 1];
        const functionResponse = {
          functionResponse: {
            id: toolUseId,
            name: functionName,
            response: { output: resultContent }
          }
        };

        if (lastMessage?.role === 'user' && lastMessage.parts.some(p => p.functionResponse)) {
          lastMessage.parts.push(functionResponse);
        } else {
          antigravityMessages.push({
            role: 'user',
            parts: [functionResponse]
          });
        }
      }
    }
  }

  return antigravityMessages;
}

// Convert Anthropic tools to Antigravity format
function convertAnthropicToolsToAntigravity(tools) {
  if (!tools || tools.length === 0) return [];
  
  return tools.map(tool => {
    const schema = { ...tool.input_schema };
    delete schema.$schema;
    
    return {
      functionDeclarations: [{
        name: tool.name,
        description: tool.description,
        parameters: schema
      }]
    };
  });
}

// Generate Antigravity request body from Anthropic request
function generateAnthropicRequestBody(anthropicRequest, apiKey) {
  const { messages, model, max_tokens, system, tools, temperature, top_p, top_k } = anthropicRequest;

  const enableThinking = model.endsWith('-thinking') ||
    model === 'gemini-2.5-pro' ||
    model === 'gemini-2.5-pro-image' ||
    model.startsWith('gemini-3-pro-') ||
    model === 'rev19-uic3-1p' ||
    model === 'gpt-oss-120b-medium';

  const actualModelName = model.endsWith('-thinking') ? model.slice(0, -9) : model;

  // Get cached IDs (reuse from utils.js logic)
  const projectId = generateProjectId();
  const sessionId = generateSessionId();

  const systemText = extractSystemMessage(system) || config.systemInstruction || '';

  const generationConfig = {
    topP: top_p ?? config.defaults.top_p,
    topK: top_k ?? config.defaults.top_k,
    temperature: temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: max_tokens ?? config.defaults.max_tokens,
    stopSequences: [
      '<|user|>',
      '<|bot|>',
      '<|context_request|>',
      '<|endoftext|>',
      '<|end_of_turn|>'
    ]
  };

  if (enableThinking) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: 1024
    };
  }

  if (enableThinking && actualModelName.includes('claude')) {
    delete generationConfig.topP;
  }

  return {
    project: projectId,
    requestId: `agent-${randomUUID()}`,
    request: {
      contents: anthropicMessageToAntigravity(messages),
      systemInstruction: {
        role: 'user',
        parts: [{ text: systemText }]
      },
      tools: convertAnthropicToolsToAntigravity(tools),
      toolConfig: {
        functionCallingConfig: {
          mode: 'VALIDATED'
        }
      },
      generationConfig,
      sessionId
    },
    model: actualModelName,
    userAgent: 'antigravity'
  };
}

function generateProjectId() {
  const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
  const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
  const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomNum = Math.random().toString(36).substring(2, 7);
  return `${randomAdj}-${randomNoun}-${randomNum}`;
}

function generateSessionId() {
  return String(-Math.floor(Math.random() * 9e18));
}

export {
  generateMessageId,
  extractSystemMessage,
  anthropicMessageToAntigravity,
  convertAnthropicToolsToAntigravity,
  generateAnthropicRequestBody
};
