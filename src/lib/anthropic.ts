// Thin fetch wrapper for Anthropic Messages API. No SDK dep - fetch() over
// the public endpoint with the API key from env. Server-only. Reads
// ANTHROPIC_API_KEY and (optionally) ANTHROPIC_MODEL; defaults to a stable
// Sonnet. Throws on missing key or non-2xx.

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const ANTHROPIC_VERSION = "2023-06-01";
const ENDPOINT = "https://api.anthropic.com/v1/messages";

export type AnthropicUsage = {
  input_tokens: number;
  output_tokens: number;
};

export type AnthropicResult<T> = {
  parsed: T;
  raw: string;
  model: string;
  usage: AnthropicUsage;
};

export async function callAnthropicJson<T>(args: {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<AnthropicResult<T>> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key.length === 0) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to Vercel + .env.local before running the matcher."
    );
  }
  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;

  const body = {
    model,
    max_tokens: args.maxTokens ?? 4096,
    temperature: args.temperature ?? 0,
    system: args.system,
    messages: [{ role: "user", content: args.user }],
  };

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 400)}`);
  }

  const json = (await res.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: AnthropicUsage;
    model?: string;
  };
  const text = (json.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
  if (!text) {
    throw new Error("Anthropic response had no text content");
  }

  // The prompt instructs the model to return raw JSON, but a well-behaved
  // model sometimes wraps it in a ```json fence. Peel one layer defensively.
  const trimmed = text.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
    : trimmed;

  let parsed: T;
  try {
    parsed = JSON.parse(unfenced) as T;
  } catch (e) {
    const sample = unfenced.slice(0, 240);
    throw new Error(
      `Anthropic returned non-JSON (first 240 chars): ${sample}; parse error: ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  return {
    parsed,
    raw: text,
    model: json.model ?? model,
    usage: json.usage ?? { input_tokens: 0, output_tokens: 0 },
  };
}
