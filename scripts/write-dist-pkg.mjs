// Marks each build output directory with its module system so Node and
// TypeScript interpret the .js and .d.ts files correctly.
import { chmodSync, writeFileSync } from "node:fs";

writeFileSync(new URL("../dist/esm/package.json", import.meta.url), JSON.stringify({ type: "module" }) + "\n");
writeFileSync(new URL("../dist/cjs/package.json", import.meta.url), JSON.stringify({ type: "commonjs" }) + "\n");
chmodSync(new URL("../dist/cjs/cli.js", import.meta.url), 0o755);
