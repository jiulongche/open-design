import { build } from "esbuild";

await build({
  bundle: true,
  entryPoints: ["./src/server.ts"],
  format: "esm",
  outdir: "./dist/mcp",
  outExtension: { ".js": ".mjs" },
  platform: "node",
  target: "node24",
});
