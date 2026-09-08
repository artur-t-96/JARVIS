import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VoiceService } from "../src/voice.js";

process.umask(0o077);
const expected = "Sprawdź zadania wymagające zgody.";
const temporary = mkdtempSync(join(tmpdir(), "jarvis-voice-smoke-"));
try {
  const input = join(temporary, "polish.wav");
  execFileSync(
    "/usr/bin/say",
    [
      "-v",
      "Zosia",
      "-r",
      "145",
      "--file-format=WAVE",
      "--data-format=LEI16@16000",
      "-o",
      input,
      expected,
    ],
    { timeout: 30_000, stdio: ["ignore", "ignore", "pipe"] },
  );
  // Apple's writer includes extended fmt chunks; rewrite to canonical PCM with stdlib only.
  const canonical = join(temporary, "canonical.wav");
  execFileSync(
    "/usr/bin/python3",
    [
      "-c",
      "import wave,sys\nwith wave.open(sys.argv[1], 'rb') as source:\n params=source.getparams(); data=source.readframes(source.getnframes())\nwith wave.open(sys.argv[2], 'wb') as target:\n target.setparams(params); target.writeframes(data)",
      input,
      canonical,
    ],
    { timeout: 10_000 },
  );
  const runtimeDir = resolve(
    process.argv[2] ?? process.env.JARVIS_VOICE_DIR ?? ".data/voice",
  );
  const voice = new VoiceService(temporary, { runtimeDir });
  const startedAt = Date.now();
  const result = await voice.transcribe({
    audio: readFileSync(canonical).toString("base64"),
    mimeType: "audio/wav",
  });
  const normalized = result.text.toLowerCase().replace(/[.!?,]/g, "");
  const verified =
    normalized.includes("zadania") && normalized.includes("zgody");
  const cleaned = readdirSync(join(temporary, "voice-jobs")).length === 0;
  const report = {
    verified,
    verifiedAt: new Date().toISOString(),
    engine: "whisper.cpp",
    language: "pl",
    sample: "local-macos-Zosia-synthetic",
    expected,
    recognized: result.text,
    elapsedMs: Date.now() - startedAt,
    audioCleaned: cleaned,
    cloudAudio: false,
  };
  writeFileSync(
    join(runtimeDir, "verification.json"),
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 },
  );
  process.stdout.write(JSON.stringify(report) + "\n");
  if (!verified || !cleaned) process.exitCode = 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
