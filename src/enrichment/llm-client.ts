import { z } from 'zod';
import { createLogger } from '../shared/logger.js';
import { ExtractionError, TransientLLMError } from '../shared/errors.js';

const log = createLogger('llm');

const TRANSIENT_STATUS_CODES = new Set([401, 403, 429, 500, 502, 503, 504]);

/**
 * Runs `fetch`, classifying failures so callers can decide retry behavior:
 * network-level failures and the status codes in TRANSIENT_STATUS_CODES
 * throw TransientLLMError (safe to retry indefinitely); everything else
 * throws a plain Error (bad request/model — retrying won't help).
 */
export async function fetchWithClassification(url: string, init: RequestInit, label: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new TransientLLMError(`${label} network error calling ${url}: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    const message = `${label} request failed (${res.status}): ${errText}`;
    if (TRANSIENT_STATUS_CODES.has(res.status)) {
      throw new TransientLLMError(message, res.status);
    }
    throw new Error(message);
  }

  return res;
}

export interface LLMClient {
  complete(prompt: string, options?: { maxTokens?: number; temperature?: number }): Promise<string>;
  extractStructured<T>(prompt: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T>;
}

/** Scan `raw` for a balanced value of the SAME bracket type as `raw[start]`
 * (which must be `{` or `[`), respecting string/escape state so embedded
 * brackets inside string values don't confuse depth counting. Returns the
 * substring up to the true matching closer, or null if never balanced. */
function scanBalanced(raw: string, start: number): string | null {
  const opener = raw[start];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === opener) {
      depth++;
    } else if (ch === closer) {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** Find the first balanced `{...}` or `[...]` value in `raw` that ALSO
 * parses as valid JSON, trying candidate start positions (any `{` or `[`)
 * in the order they appear — not just the first bracket character in the
 * text. This correctly skips over non-JSON bracket-like constructs in
 * surrounding prose (e.g. a markdown link `[text](url)` appearing before
 * the real JSON payload) instead of committing to whichever bracket type
 * happens to occur first, which could otherwise return the wrong value or
 * throw before ever reaching the real payload. */
function findBalancedJsonValue(raw: string): string | null {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{' && raw[i] !== '[') continue;
    const candidate = scanBalanced(raw, i);
    if (!candidate) continue;
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // Not valid JSON (e.g. a markdown link's [text] construct) — keep
      // scanning from the next candidate bracket position.
      continue;
    }
  }
  return null;
}

/**
 * Extract JSON from an LLM response with hardened parsing.
 * Prefers the last ```json code block (the actual output, not examples).
 * Falls back to the first balanced {...} or [...] value in the raw text
 * if no code block found.
 */
export function extractJSON(raw: string): unknown {
  // Collect all ```json code block matches; prefer the last one
  const codeBlockRegex = /```json\s*([\s\S]*?)```/g;
  const matches: string[] = [];
  let match;
  while ((match = codeBlockRegex.exec(raw)) !== null) {
    matches.push(match[1]);
  }

  // Try each code block from last to first (last is most likely the actual output)
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i].trim());
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      // Try next match
    }
  }

  // Fallback: find the true balanced { ... } or [ ... ] in the raw text,
  // respecting string boundaries so embedded braces/brackets and trailing
  // prose don't cause overshoot (see findBalancedJsonValue).
  const balanced = findBalancedJsonValue(raw);
  if (balanced) {
    return JSON.parse(balanced);
  }

  // Last resort: try parsing the entire raw text
  return JSON.parse(raw);
}

/**
 * Bedrock client using HTTP Bearer token auth (no IAM credentials needed).
 * Calls the REST API directly with Authorization: Bearer <token>.
 */
export function createBedrockBearerClient(config: {
  region: string;
  model: string;
  maxTokens: number;
  bearerToken: string;
}): LLMClient {
  const endpoint = `https://bedrock-runtime.${config.region}.amazonaws.com/model/${encodeURIComponent(config.model)}/invoke`;

  async function call(prompt: string, maxTokens: number, _temperature: number): Promise<string> {
    const res = await fetchWithClassification(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.bearerToken}`,
      },
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(120_000),
    }, 'Bedrock Bearer');

    const data = (await res.json()) as { content?: Array<{ text?: string }> };
    return data.content?.[0]?.text ?? '';
  }

  return {
    async complete(prompt, options) {
      const maxTokens = options?.maxTokens ?? config.maxTokens;
      const temperature = options?.temperature ?? 0.3;
      log.debug('Bedrock Bearer request', { model: config.model, maxTokens });
      const result = await call(prompt, maxTokens, temperature);
      log.debug('Bedrock Bearer response', { length: result.length });
      return result;
    },

    async extractStructured<T>(prompt: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
      const raw = await call(prompt, config.maxTokens, 0.1);
      try {
        const parsed = extractJSON(raw);
        return schema.parse(parsed);
      } catch (err) {
        throw new ExtractionError(
          `Failed to extract structured data: ${(err as Error).message}`,
          raw.slice(0, 200),
        );
      }
    },
  };
}

export function createBedrockClient(config: {
  region: string;
  model: string;
  maxTokens: number;
  bearerToken?: string;
}): LLMClient {
  // Bearer token: explicit config → env var — if present, use bearer client
  const token = config.bearerToken ?? process.env['BEDROCK_BEARER_TOKEN'];
  if (token) {
    return createBedrockBearerClient({ region: config.region, model: config.model, maxTokens: config.maxTokens, bearerToken: token });
  }

  // Lazy-load AWS SDK to avoid import cost when LLM is not needed
  let invokeModel: ((prompt: string, maxTokens: number, temperature: number) => Promise<string>) | null = null;

  async function getInvoker(): Promise<(prompt: string, maxTokens: number, temperature: number) => Promise<string>> {
    if (invokeModel) return invokeModel;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { BedrockRuntimeClient, InvokeModelCommand } = await import(
      /* @vite-ignore */ '@aws-sdk/client-bedrock-runtime'
    ) as any;

    const client = new BedrockRuntimeClient({ region: config.region });

    invokeModel = async (prompt: string, maxTokens: number, temperature: number) => {
      const body = JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: maxTokens,
        temperature,
        messages: [{ role: 'user', content: prompt }],
      });

      const command = new InvokeModelCommand({
        modelId: config.model,
        contentType: 'application/json',
        accept: 'application/json',
        body,
      });

      const response = await client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));
      return responseBody.content?.[0]?.text ?? '';
    };

    return invokeModel;
  }

  return {
    async complete(prompt, options) {
      const invoke = await getInvoker();
      const maxTokens = options?.maxTokens ?? config.maxTokens;
      const temperature = options?.temperature ?? 0.3;

      log.debug('LLM request', { model: config.model, maxTokens });
      const result = await invoke(prompt, maxTokens, temperature);
      log.debug('LLM response', { length: result.length });
      return result;
    },

    async extractStructured<T>(prompt: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
      const invoke = await getInvoker();
      const raw = await invoke(prompt, config.maxTokens, 0.1);

      try {
        const parsed = extractJSON(raw);
        return schema.parse(parsed);
      } catch (err) {
        throw new ExtractionError(
          `Failed to extract structured data: ${(err as Error).message}`,
          raw.slice(0, 200),
        );
      }
    },
  };
}

/**
 * OpenAI-compatible client for LiteLLM proxies.
 */
export function createLiteLLMClient(config: {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}): LLMClient {
  async function call(prompt: string, maxTokens: number, temperature: number): Promise<string> {
    const url = `${config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    const res = await fetchWithClassification(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
      }),
    }, 'LiteLLM');

    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content ?? '';
  }

  return {
    async complete(prompt, options) {
      const maxTokens = options?.maxTokens ?? config.maxTokens;
      const temperature = options?.temperature ?? 0.3;
      log.debug('LiteLLM request', { model: config.model, maxTokens });
      const result = await call(prompt, maxTokens, temperature);
      log.debug('LiteLLM response', { length: result.length });
      return result;
    },

    async extractStructured<T>(prompt: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
      const raw = await call(prompt, config.maxTokens, 0.1);
      try {
        const parsed = extractJSON(raw);
        return schema.parse(parsed);
      } catch (err) {
        throw new ExtractionError(
          `Failed to extract structured data: ${(err as Error).message}`,
          raw.slice(0, 200),
        );
      }
    },
  };
}

/**
 * A no-op LLM client for testing or when LLM is disabled.
 */
export function createNoopClient(): LLMClient {
  return {
    async complete() {
      return '';
    },
    async extractStructured<T>(_prompt: string, _schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
      throw new Error('LLM extraction not available (noop client)');
    },
  };
}
