/**
 * Official-API transport.
 *
 * The only mode that is actually authorized: your own API keys, direct to each
 * provider's documented endpoint. No terms-of-service violation, no bot
 * detection, no DOM selectors to repair — and real token-by-token streaming
 * instead of scraping rendered HTML.
 *
 * Keys live in chrome.storage.local and are sent only to their own provider.
 * The service worker's fetch is exempt from CORS for hosts covered by
 * host_permissions, which is what makes calling these endpoints from an
 * extension possible at all.
 */

export const API_PROVIDERS = {
  openai: {
    id: 'openai',
    name: 'ChatGPT',
    short: 'GPT',
    color: '#10a37f',
    keyName: 'openai',
    keyLabel: 'OpenAI API key',
    keyHint: 'platform.openai.com/api-keys — starts with sk-',
    defaultModel: 'gpt-5',
    docs: 'https://platform.openai.com/api-keys'
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    short: 'GEM',
    color: '#4285f4',
    keyName: 'google',
    keyLabel: 'Google AI Studio key',
    keyHint: 'aistudio.google.com/apikey — has a free tier',
    defaultModel: 'gemini-2.5-flash',
    docs: 'https://aistudio.google.com/apikey'
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    short: 'CL',
    color: '#d97757',
    keyName: 'anthropic',
    keyLabel: 'Anthropic API key',
    keyHint: 'console.anthropic.com — starts with sk-ant-',
    defaultModel: 'claude-opus-5',
    docs: 'https://console.anthropic.com/settings/keys'
  },
  llama: {
    id: 'llama',
    name: 'Llama',
    short: 'LL',
    color: '#0064e0',
    keyName: 'openrouter',
    keyLabel: 'OpenRouter key',
    keyHint: 'openrouter.ai/keys — Meta has no first-party consumer API',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    docs: 'https://openrouter.ai/keys'
  }
};

export const API_PROVIDER_ORDER = ['openai', 'gemini', 'claude', 'llama'];

/**
 * Read a fetch response body as Server-Sent Events, yielding each `data:`
 * payload. Chunks split mid-line, so the tail is carried into the next read.
 */
async function* sseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Turn a non-2xx response into a message worth showing the user. */
async function describeFailure(response, providerName) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.error?.type || body?.message || '';
  } catch {
    detail = await response.text().catch(() => '');
  }

  if (response.status === 401 || response.status === 403) {
    return `${providerName} rejected the API key (${response.status}). Check it in Settings.`;
  }
  if (response.status === 429) {
    return `${providerName} rate limit or quota exceeded (429). ${detail}`.trim();
  }
  if (response.status >= 500) {
    return `${providerName} server error (${response.status}). Try again shortly.`;
  }
  return `${providerName} error ${response.status}: ${detail || 'no detail returned'}`;
}

// -------------------------------------------------------------- providers ---

/** OpenAI and OpenRouter share the chat-completions wire format. */
async function streamOpenAICompatible({ url, key, extraHeaders, model, system, messages, maxTokens, onDelta, signal, providerName }) {
  const body = {
    model,
    stream: true,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages
    ]
  };

  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) throw new Error(await describeFailure(response, providerName));

  for await (const data of sseLines(response)) {
    if (data === '[DONE]') break;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    // OpenRouter forwards upstream errors inside the stream.
    if (parsed.error) throw new Error(parsed.error.message || 'Upstream error');
    const delta = parsed.choices?.[0]?.delta?.content;
    if (delta) onDelta(delta);
  }
}

async function streamAnthropic({ key, model, system, messages, maxTokens, effort, onDelta, signal }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // Required for calls that originate from a browser context.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      // Thinking is on by default on Opus 5 and shares the max_tokens budget
      // with the reply. Low effort keeps a sidebar answer prompt without
      // disabling thinking, which has its own failure modes.
      output_config: { effort: effort || 'low' },
      ...(system ? { system } : {}),
      messages
    })
  });

  if (!response.ok) throw new Error(await describeFailure(response, 'Anthropic'));

  for await (const data of sseLines(response)) {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }

    if (parsed.type === 'error') {
      throw new Error(parsed.error?.message || 'Anthropic stream error');
    }
    if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
      onDelta(parsed.delta.text);
    }
    if (parsed.type === 'message_stop') break;
  }
}

async function streamGemini({ key, model, system, messages, maxTokens, onDelta, signal }) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    ':streamGenerateContent?alt=sse';

  const response = await fetch(url, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      // Gemini calls the assistant role "model".
      contents: messages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      generationConfig: { maxOutputTokens: maxTokens }
    })
  });

  if (!response.ok) throw new Error(await describeFailure(response, 'Gemini'));

  for await (const data of sseLines(response)) {
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (parsed.error) throw new Error(parsed.error.message || 'Gemini stream error');
    for (const part of parsed.candidates?.[0]?.content?.parts || []) {
      if (part.text) onDelta(part.text);
    }
  }
}

// ----------------------------------------------------------------- facade ---

/**
 * Stream one completion. `onDelta` receives incremental text; the resolved
 * value is the full reply.
 */
export async function streamCompletion({
  providerId,
  apiKeys,
  models,
  system,
  messages,
  maxTokens = 16000,
  effort = 'low',
  onDelta,
  signal
}) {
  const provider = API_PROVIDERS[providerId];
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);

  const key = (apiKeys?.[provider.keyName] || '').trim();
  if (!key) {
    throw new Error(
      `No ${provider.keyLabel} saved. Add one in Settings — ${provider.keyHint}`
    );
  }

  const model = (models?.[providerId] || provider.defaultModel).trim();

  let full = '';
  const collect = (text) => {
    full += text;
    onDelta?.(full);
  };

  const common = { key, model, system, messages, maxTokens, onDelta: collect, signal };

  switch (providerId) {
    case 'openai':
      await streamOpenAICompatible({
        ...common,
        url: 'https://api.openai.com/v1/chat/completions',
        providerName: 'OpenAI'
      });
      break;

    case 'llama':
      await streamOpenAICompatible({
        ...common,
        url: 'https://openrouter.ai/api/v1/chat/completions',
        providerName: 'OpenRouter',
        extraHeaders: {
          'HTTP-Referer': 'https://github.com/local/sidebar-ai',
          'X-Title': 'Sidebar AI'
        }
      });
      break;

    case 'claude':
      await streamAnthropic({ ...common, effort });
      break;

    case 'gemini':
      await streamGemini(common);
      break;

    default:
      throw new Error(`No transport for ${providerId}`);
  }

  return full;
}
