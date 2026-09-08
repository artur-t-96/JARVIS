import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
let gitSha = "development";
try {
  gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  if (
    execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim()
  )
    gitSha += "-dirty";
} catch {}
writeFileSync(
  "dist/build.json",
  JSON.stringify(
    { gitSha, builtAt: new Date().toISOString(), node: process.version },
    null,
    2,
  ) + "\n",
);
