// Load .env.local / .env for CLI scripts with Next.js's own loader, so scripts
// and the app parse values identically (including `$` expansion — write a
// literal dollar sign as \$).
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd(), true, { info: () => {}, error: console.error });
