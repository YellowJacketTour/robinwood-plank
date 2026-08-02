"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs");
const path = require("node:path");
const process = require("node:process");

const appRoot = __dirname;
const releaseRoot = fs.realpathSync(path.join(appRoot, "current"));
const envFile =
  process.env.PLANK_ENV_FILE ||
  path.join(appRoot, "shared", ".env.production");

if (fs.existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

// GitHub Actions installs this server-only credential separately from the
// release artifact and .env.production. A cPanel-provided environment value
// still wins when present.
if (!process.env.UNISWAP_API_KEY?.trim()) {
  const uniswapKeyFile = path.join(
    appRoot,
    "shared",
    "runtime-secrets",
    "uniswap-api-key"
  );
  if (fs.existsSync(uniswapKeyFile)) {
    const mode = fs.statSync(uniswapKeyFile).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      throw new Error("Uniswap runtime secret must not be group/world accessible.");
    }
    const key = fs.readFileSync(uniswapKeyFile, "utf8").trim();
    if (key.length < 16) {
      throw new Error("Uniswap runtime secret is empty or invalid.");
    }
    process.env.UNISWAP_API_KEY = key;
  }
}

process.env.NODE_ENV = "production";
process.env.DEPLOYMENT_VERSION ||= path.basename(releaseRoot);
process.chdir(releaseRoot);

// This is Next.js' generated standalone server, not a custom Next server.
// Passenger supplies PORT and manages the process lifecycle.
require(path.join(releaseRoot, "server.js"));
