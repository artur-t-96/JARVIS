import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createBackup } from "../src/backup.js";

process.umask(0o077);
const [dataDir, destination] = process.argv.slice(2);
if (!dataDir || !destination || process.argv.length !== 4) {
  process.stderr.write(
    "Usage: npm run backup -- <stopped-data-directory> <new-backup-directory>\n",
  );
  process.exitCode = 1;
} else {
  try {
    let buildVersion = process.env.GIT_SHA;
    if (!buildVersion) {
      try {
        buildVersion = execFileSync("git", ["rev-parse", "HEAD"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        buildVersion = "local";
      }
    }
    const result = await createBackup({
      dataDir: resolve(dataDir),
      destination: resolve(destination),
      buildVersion,
    });
    process.stdout.write(
      JSON.stringify({
        status: "verified",
        destination: result.destination,
        createdAt: result.manifest.createdAt,
        files: result.manifest.files.length,
        manifestHash: result.manifestHash,
      }) + "\n",
    );
  } catch (error) {
    process.stderr.write(
      `Backup failed: ${error instanceof Error ? error.message : "unknown failure"}\n`,
    );
    process.exitCode = 1;
  }
}
