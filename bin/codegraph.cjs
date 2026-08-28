#!/usr/bin/env node

const path = require("node:path");
const { spawnSync } = require("node:child_process");

const packageRoot = path.resolve(__dirname, "..");
const tsxPath = path.join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
const cliPath = path.join(packageRoot, "src", "cli.ts");
const result = spawnSync(process.execPath, [tsxPath, cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
