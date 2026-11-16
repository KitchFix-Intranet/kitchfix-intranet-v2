// Service Calendar lane · Supabase seam.
//
// v1's engine imports `getServiceClient` from `@/lib/supabase`. v2's
// service client is in `src/lib/supabase/service.ts` and is exported
// as `serviceClient`. Same shape (plain function, service role,
// session persistence off); v2 caches one client for the process,
// v1 returns a fresh one per call. Nothing runs at import time in
// either version, and no engine file sees more than one client at a
// time, so the shapes are interchangeable for the engine's needs.
//
// We re-export under v1's name so every engine file changes only
// its import path, not the call site.

export { serviceClient as getServiceClient } from "@/lib/supabase/service";
