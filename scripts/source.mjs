import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// An explicit source allowlist keeps private data and build caches out of the offer.
const files = [
  "AGENTS.md",
  "LICENSE",
  "README.md",
  "VALIDATION.md",
  "Makefile",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.server.json",
  "vite.config.ts",
  "server",
  "web",
  "scripts",
  "deploy",
  "gateway/Cargo.toml",
  "gateway/Cargo.lock",
  "gateway/PROTOCOL.md",
  "gateway/src",
].filter(existsSync);
execFileSync("tar", ["-czf", "dist/source.tar.gz", ...files]);
