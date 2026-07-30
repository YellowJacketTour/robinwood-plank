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

process.env.NODE_ENV = "production";
process.env.DEPLOYMENT_VERSION ||= path.basename(releaseRoot);
process.chdir(releaseRoot);

// This is Next.js' generated standalone server, not a custom Next server.
// Passenger supplies PORT and manages the process lifecycle.
require(path.join(releaseRoot, "server.js"));
