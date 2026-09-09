import test from "node:test";
import assert from "node:assert/strict";
import { pcmWav } from "../web/src/audio.js";
import { referenceOptions } from "../web/src/references.js";
import { dateLabel } from "../web/src/types.js";

test("report timestamps use the company timezone while date-only filters keep their calendar day", () => {
  const capturedAt = "2026-09-09T00:30:00.000Z";
  assert.match(dateLabel(capturedAt, true, "Europe/Warsaw"), /9 wrz.*02:30/);
  assert.match(dateLabel(capturedAt, true, "America/New_York"), /8 wrz.*20:30/);
  assert.equal(dateLabel("2026-09-01", false, "UTC"), "1 wrz 2026");
});

test("browser voice encoder produces mono PCM16 16kHz WAV and mixes stereo", () => {
  const wav = pcmWav(
    [new Float32Array(48000).fill(0.5), new Float32Array(48000).fill(-0.5)],
    48000,
  );
  const view = new DataView(wav);
  assert.equal(wav.byteLength, 32044);
  assert.equal(new TextDecoder().decode(wav.slice(0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(wav.slice(8, 12)), "WAVE");
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 32000);
  for (let offset = 44; offset < wav.byteLength; offset += 2)
    assert.equal(view.getInt16(offset, true), 0);
});

test("browser voice encoder clips peaks and rejects empty or overlong recordings", () => {
  const view = new DataView(pcmWav([new Float32Array([2, -2, 0])], 16000));
  assert.equal(view.getInt16(44, true), 32767);
  assert.equal(view.getInt16(46, true), -32768);
  assert.throws(() => pcmWav([], 16000), /puste/);
  assert.throws(() => pcmWav([new Float32Array(480001)], 16000), /30 sekund/);
});

test("form references select human titles, limit relation kind and current case tasks", () => {
  const entity = (
    id: string,
    module: string,
    data: Record<string, unknown>,
  ) => ({
    id,
    module,
    title: `Nazwa ${id}`,
    data,
    status: "open",
    version: 1,
    createdAt: "2026-09-08",
    updatedAt: "2026-09-08",
  });
  const records = {
    purchases: [
      entity("supplier", "purchases", { kind: "supplier" }),
      entity("order", "purchases", { kind: "order" }),
    ],
    sales: [
      entity("client", "sales", { kind: "client" }),
      entity("deal", "sales", { kind: "deal" }),
    ],
  };
  assert.deepEqual(referenceOptions("supplierId", records, {}), [
    { id: "supplier", label: "Nazwa supplier" },
  ]);
  assert.deepEqual(referenceOptions("parentId", records, { kind: "offer" }), [
    { id: "deal", label: "Nazwa deal" },
  ]);
  const item = entity("case", "cases", {
    tasks: [
      { id: "a", title: "Dokumenty", status: "open" },
      { id: "b", title: "Sprzęt", status: "completed" },
    ],
  });
  assert.deepEqual(referenceOptions("taskId", {}, {}, item), [
    { id: "a", label: "Dokumenty" },
  ]);
  assert.equal(referenceOptions("dependsOn", {}, {}, item)?.length, 2);
  assert.equal(referenceOptions("title", {}, {}), null);
});
