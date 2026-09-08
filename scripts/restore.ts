import { resolve } from "node:path";
import { restoreBackup, verifyBackup } from "../src/backup.js";

process.umask(0o077);
const [source, target] = process.argv.slice(2);
if (!source || !target || process.argv.length !== 4) {
  process.stderr.write(
    "Usage: npm run restore -- <backup-directory> <empty-data-directory|--verify>\n",
  );
  process.exitCode = 1;
} else {
  try {
    const result =
      target === "--verify"
        ? verifyBackup(resolve(source))
        : await restoreBackup({
            source: resolve(source),
            targetDir: resolve(target),
          });
    process.stdout.write(
      JSON.stringify({
        status: "verified",
        createdAt: result.manifest.createdAt,
        files: result.manifest.files.length,
        manifestHash: result.manifestHash,
        ...(target !== "--verify" ? { targetDir: resolve(target) } : {}),
      }) + "\n",
    );
  } catch (error) {
    process.stderr.write(
      `Restore failed: ${error instanceof Error ? error.message : "unknown failure"}\n`,
    );
    process.exitCode = 1;
  }
}
