// Local matcher runner. Reads env from .env.local via node --env-file.
// Usage:
//   npm run match -- --limit 500      # dry-run the top 500 dollar-ordered items
//   npm run match                     # full pass over every unlinked food item
// Env required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// ANTHROPIC_API_KEY.

import { serviceClient } from "../src/lib/supabase/service";
import { runMatcher } from "../src/lib/matcher";

function parseArg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const limit = parseArg(argv, "limit");
  const batch = parseArg(argv, "batch");
  const parsedLimit = limit ? Math.max(1, parseInt(limit, 10)) : undefined;
  const parsedBatch = batch ? Math.max(5, Math.min(60, parseInt(batch, 10))) : undefined;

  console.log(`match: limit=${parsedLimit ?? "all"} batch=${parsedBatch ?? 35}`);
  const start = Date.now();
  const client = serviceClient();
  const result = await runMatcher(client, {
    mode: parsedLimit ? "slice" : "full",
    limit: parsedLimit,
    batchSize: parsedBatch,
    logger: (m) => console.log(m),
  });
  const ms = Date.now() - start;
  console.log(`match finished: status=${result.status} elapsed_ms=${ms}`);
  console.log(JSON.stringify(result.counts, null, 2));
  if (result.note) console.log(`note: ${result.note}`);
  if (result.status === "failed") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
