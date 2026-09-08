import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { tsImport } from "tsx/esm/api";
import { itCaseFixture } from "./helpers/it-case-fixture.js";
import { custodyNow } from "./helpers/custody-fixture.js";
import {
  laboratoryFreshnessMs,
  laboratoryTlsTarget,
} from "../src/laboratory-contract.js";
const { ItCaseCard } = await tsImport("../web/src/ItCase.tsx", {
  parentURL: import.meta.url,
  tsconfig: fileURLToPath(new URL("../tsconfig.web.json", import.meta.url)),
});
test("IT UI distinguishes diagnosis, approved procedure, test and receipt without rendering stale health as success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-it-ui-"));
  let now = custodyNow;
  const f = await itCaseFixture(dir, { clock: () => now });
  try {
    const caseId = await f.open(),
      html = () =>
        renderToStaticMarkup(
          createElement(ItCaseCard, {
            item: f.get("cases", caseId),
            view: f.view(caseId),
            onRepair() {},
            onBind() {},
          }),
        );
    assert.match(html(), /Diagnoza operatora/);
    assert.match(html(), /Brak zakończonej/);
    assert.doesNotMatch(html(), /Powiąż test z odbiorem/);
    await f.complete("lab.repairCase", f.view(caseId).repairInput);
    assert.match(html(), /Pozytywny i aktualny test HTTP/);
    assert.match(html(), /Powiąż test z odbiorem/);
    now += laboratoryFreshnessMs + 1;
    assert.match(html(), /Stan nieaktualny/);
    assert.match(html(), /Historyczny wynik/);
    assert.doesNotMatch(
      html(),
      /Pozytywny i aktualny test HTTP|Powiąż test z odbiorem/,
    );
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("certificate UI separates configured metadata from a verified TLS peer", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-cert-ui-")),
    f = await itCaseFixture(dir, { target: laboratoryTlsTarget });
  try {
    const id = await f.open(),
      html = () =>
        renderToStaticMarkup(
          createElement(ItCaseCard, {
            item: f.get("cases", id),
            view: f.view(id),
            onRepair() {},
            onBind() {},
            onInspect() {},
          }),
        );
    assert.match(html(), /Certyfikat wygasł/);
    assert.match(html(), /Odcisk serwera nie został potwierdzony/);
    assert.doesNotMatch(html(), /Pozytywny i aktualny test/);
    await f.complete("lab.renewCertificate", f.view(id).repairInput);
    assert.match(html(), /Nazwa, daty i łańcuch zweryfikowane przez TLS/);
    assert.match(html(), /Odcisk potwierdzony w połączeniu/);
    assert.match(html(), /Pozytywny i aktualny test certyfikatu oraz HTTPS/);
    assert.doesNotMatch(html(), /PRIVATE KEY|encryptedKey|encrypted_key/);
  } finally {
    await f.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
