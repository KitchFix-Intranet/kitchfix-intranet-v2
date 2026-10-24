// Local intake runner. Reads env from .env.local via Node's --env-file flag,
// which `npm run intake` wires up for you. Falls back to whatever env is
// already in process.env, so Vercel / CI runs do not need .env.local.
// Usage:
//   npm run intake -- --mode full
//   npm run intake -- --mode incremental

import { serviceClient } from "../src/lib/supabase/service";
import { runIntake, IntakeMode } from "../src/lib/intake";

function parseMode(argv: string[]): IntakeMode {
  const i = argv.indexOf("--mode");
  if (i >= 0 && argv[i + 1]) {
    const v = argv[i + 1];
    if (v === "full" || v === "incremental") return v;
  }
  return "full";
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  console.log(`intake: mode=${mode}`);
  const start = Date.now();
  const client = serviceClient();
  const result = await runIntake(client, mode, (m) => console.log(m));
  const ms = Date.now() - start;
  console.log(`intake finished: status=${result.status} runId=${result.runId} elapsed_ms=${ms}`);
  console.log(JSON.stringify(result.counts, null, 2));
  if (result.status === "failed") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
