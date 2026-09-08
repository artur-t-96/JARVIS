import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itCaseFixture } from "./helpers/it-case-fixture.js";
import { laboratoryTlsTarget } from "../src/laboratory-contract.js";
import { createBackup, restoreBackup } from "../src/backup.js";

test("certificate backup retains encrypted material; restore needs its separately recovered installation key", async () => {
  const root = mkdtempSync(join(tmpdir(), "jarvis-cert-backup-")),
    source = join(root, "source"),
    target = join(root, "restored"),
    destination = join(root, "backup");
  let f = await itCaseFixture(source, { target: laboratoryTlsTarget });
  try {
    const id = await f.open();
    await f.complete("lab.renewCertificate", f.view(id).repairInput);
    await f.bind(id);
    const before = f.get("cases", id),
      fingerprint = f.view(id).repairInput.expectedFingerprint;
    await f.close();
    const backup = await createBackup({
      dataDir: source,
      destination,
      buildVersion: "synthetic-certificate-test",
    });
    assert.ok(!backup.manifest.files.some((x) => x.path.endsWith(".key")));
    await restoreBackup({ source: destination, targetDir: target });
    assert.equal(existsSync(join(target, "laboratory-wrapping.key")), false);
    f = await itCaseFixture(target, { target: laboratoryTlsTarget });
    assert.deepEqual(f.get("cases", id), before);
    assert.equal(f.view(id).readiness.ready, false);
    assert.equal(f.view(id).repairInput.expectedFingerprint, fingerprint);
    copyFileSync(
      join(source, "laboratory-wrapping.key"),
      join(target, "laboratory-wrapping.key"),
    );
    assert.equal((await f.inspect()).healthy, true);
    assert.equal(f.view(id).readiness.ready, true);
    assert.equal(f.view(id).repairInput.expectedFingerprint, fingerprint);
  } finally {
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
