import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DomainError } from "../src/contracts.js";
import { validateVoiceAudio, VoiceService } from "../src/voice.js";

function audio(durationMs = 500) {
  const pcmLength = durationMs * 32;
  const wav = Buffer.alloc(44 + pcmLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcmLength, 40);
  return { audio: wav.toString("base64"), mimeType: "audio/wav" };
}

function setup(
  body = "writeFileSync(prefix + '.txt', 'Sprawdź zadania wymagające zgody.');",
  timeoutMs = 2000,
) {
  const root = mkdtempSync(join(tmpdir(), "jarvis-voice-test-"));
  const runtime = join(root, "voice");
  mkdirSync(runtime);
  const binaryPath = join(runtime, "fake-whisper.mjs");
  const marker = join(root, "invocation.json");
  writeFileSync(
    binaryPath,
    `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nconst prefix = args[args.indexOf('--output-file')+1];\nwriteFileSync(${JSON.stringify(marker)}, JSON.stringify({args,env:process.env}));\n${body}\n`,
  );
  chmodSync(binaryPath, 0o700);
  const modelPath = join(runtime, "fake-model.bin");
  writeFileSync(modelPath, "fixture-model");
  return {
    root,
    marker,
    service: new VoiceService(root, { binaryPath, modelPath, timeoutMs }),
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function expected(code: string) {
  return (error: unknown) =>
    error instanceof DomainError && error.code === code;
}

test("voice stays explicitly unavailable without installed local engine", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-voice-absent-"));
  try {
    const voice = new VoiceService(dir, { runtimeDir: join(dir, "absent") });
    assert.equal(voice.status().available, false);
    assert.equal(voice.status().localOnly, true);
    await assert.rejects(
      voice.transcribe(audio()),
      expected("voice_unavailable"),
    );
    assert.equal(existsSync(join(dir, "voice-jobs")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PCM validator rejects malformed, oversized, long and unsupported audio before a subprocess", async () => {
  const ctx = setup();
  try {
    assert.equal(validateVoiceAudio(audio()).durationMs, 500);
    for (const input of [
      { audio: "%%%%", mimeType: "audio/wav" },
      { audio: "", mimeType: "audio/wav" },
      { ...audio(), mimeType: "audio/webm" },
      audio(31_000),
      { audio: "AAAA".repeat(800_000), mimeType: "audio/wav" },
    ])
      await assert.rejects(
        ctx.service.transcribe(input),
        (error: unknown) =>
          error instanceof DomainError && [400, 413].includes(error.statusCode),
      );
    const changedRate = Buffer.from(audio().audio, "base64");
    changedRate.writeUInt32LE(44_100, 24);
    await assert.rejects(
      ctx.service.transcribe({
        audio: changedRate.toString("base64"),
        mimeType: "audio/wav",
      }),
      expected("voice_format"),
    );
    const brokenChunk = Buffer.from(audio().audio, "base64");
    brokenChunk.writeUInt32LE(0xffffffff, 40);
    await assert.rejects(
      ctx.service.transcribe({
        audio: brokenChunk.toString("base64"),
        mimeType: "audio/wav",
      }),
      expected("voice_format"),
    );
    assert.equal(existsSync(ctx.marker), false);
  } finally {
    ctx.close();
  }
});

test("local subprocess receives only fixed arguments and minimal env, and leaves no audio or transcript", async () => {
  const ctx = setup();
  try {
    assert.equal(ctx.service.status().available, true);
    assert.deepEqual(await ctx.service.transcribe(audio()), {
      text: "Sprawdź zadania wymagające zgody.",
    });
    const call = JSON.parse(readFileSync(ctx.marker, "utf8"));
    assert.equal(call.args[call.args.indexOf("--language") + 1], "pl");
    assert.ok(call.args.includes("--no-gpu"));
    assert.deepEqual(
      Object.keys(call.env)
        .filter((key) => key !== "__CF_USER_TEXT_ENCODING")
        .sort(),
      ["HOME", "LANG", "PATH", "TMPDIR"],
    );
    assert.deepEqual(readdirSync(join(ctx.root, "voice-jobs")), []);
    assert.equal(ctx.service.status().busy, false);
  } finally {
    ctx.close();
  }
});

test("overlapping calls are rejected while the accepted transcript completes", async () => {
  const ctx = setup(
    "await new Promise(resolve => setTimeout(resolve, 100)); writeFileSync(prefix + '.txt', 'Gotowe.');",
  );
  try {
    const first = ctx.service.transcribe(audio());
    assert.equal(ctx.service.status().busy, true);
    await assert.rejects(
      ctx.service.transcribe(audio()),
      expected("voice_busy"),
    );
    assert.equal((await first).text, "Gotowe.");
    assert.deepEqual(readdirSync(join(ctx.root, "voice-jobs")), []);
  } finally {
    ctx.close();
  }
});

test("timeout kills native work and clears private files; native errors never expose stderr", async () => {
  const slow = setup(
    "await new Promise(resolve => setTimeout(resolve, 10_000));",
    50,
  );
  try {
    await assert.rejects(
      slow.service.transcribe(audio()),
      expected("voice_timeout"),
    );
    assert.equal(slow.service.status().busy, false);
    assert.deepEqual(readdirSync(join(slow.root, "voice-jobs")), []);
  } finally {
    slow.close();
  }
  const failed = setup(
    "process.stderr.write('private-transcript-and-token'); process.exit(2);",
  );
  try {
    await assert.rejects(
      failed.service.transcribe(audio()),
      (error: unknown) =>
        error instanceof DomainError &&
        error.code === "voice_failed" &&
        !error.message.includes("private"),
    );
    assert.deepEqual(readdirSync(join(failed.root, "voice-jobs")), []);
  } finally {
    failed.close();
  }
});

test("empty and excessive native output are rejected and deleted", async () => {
  for (const body of [
    "writeFileSync(prefix + '.txt', '   ');",
    "writeFileSync(prefix + '.txt', 'a'.repeat(17_000));",
  ]) {
    const ctx = setup(body);
    try {
      await assert.rejects(
        ctx.service.transcribe(audio()),
        (error: unknown) =>
          error instanceof DomainError &&
          ["voice_empty", "voice_output"].includes(error.code),
      );
      assert.deepEqual(readdirSync(join(ctx.root, "voice-jobs")), []);
    } finally {
      ctx.close();
    }
  }
});
