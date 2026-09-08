import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DomainError } from "./contracts.js";

export interface VoiceOptions {
  runtimeDir?: string;
  binaryPath?: string;
  modelPath?: string;
  timeoutMs?: number;
  maxAudioBytes?: number;
  maxDurationMs?: number;
}

/** Accept only bounded PCM WAV and strip ancillary chunks before the native parser. */
export function validateVoiceAudio(
  input: { audio: string; mimeType: string },
  options: Pick<VoiceOptions, "maxAudioBytes" | "maxDurationMs"> = {},
) {
  const maxAudioBytes = options.maxAudioBytes ?? 2 * 1024 * 1024;
  const maxDurationMs = options.maxDurationMs ?? 30_000;
  if (
    !input ||
    !["audio/wav", "audio/x-wav", "audio/wave"].includes(input.mimeType)
  )
    throw new DomainError(
      "voice_format",
      "Nagraj dźwięk w formacie PCM WAV.",
      400,
    );
  if (
    typeof input.audio !== "string" ||
    input.audio.length > Math.ceil(maxAudioBytes / 3) * 4
  )
    throw new DomainError(
      "voice_size",
      "Nagranie przekracza dozwolony rozmiar.",
      413,
    );
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      input.audio,
    )
  )
    throw new DomainError(
      "voice_base64",
      "Nagranie ma nieprawidłowe kodowanie.",
      400,
    );
  const wav = Buffer.from(input.audio, "base64");
  const invalid = () =>
    new DomainError(
      "voice_format",
      "Wymagany PCM WAV: mono, 16 kHz, 16 bitów.",
      400,
    );
  if (
    wav.length < 44 ||
    wav.length > maxAudioBytes ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 8, 12) !== "WAVE" ||
    wav.readUInt32LE(4) !== wav.length - 8
  )
    throw invalid();
  let pcm: Buffer | undefined;
  let formatFound = false;
  let offset = 12;
  while (offset + 8 <= wav.length) {
    const type = wav.toString("ascii", offset, offset + 4);
    const length = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + length > wav.length) throw invalid();
    if (type === "fmt ") {
      if (
        formatFound ||
        length !== 16 ||
        wav.readUInt16LE(start) !== 1 ||
        wav.readUInt16LE(start + 2) !== 1 ||
        wav.readUInt32LE(start + 4) !== 16_000 ||
        wav.readUInt32LE(start + 8) !== 32_000 ||
        wav.readUInt16LE(start + 12) !== 2 ||
        wav.readUInt16LE(start + 14) !== 16
      )
        throw invalid();
      formatFound = true;
    } else if (type === "data") {
      if (pcm || length < 8000 || length % 2 !== 0) throw invalid();
      pcm = wav.subarray(start, start + length);
    }
    offset = start + length + (length % 2);
  }
  if (!formatFound || !pcm || offset !== wav.length) throw invalid();
  const durationMs = pcm.length / 32;
  if (durationMs > maxDurationMs)
    throw new DomainError(
      "voice_duration",
      "Nagranie może trwać najwyżej 30 sekund.",
      413,
    );
  const canonical = Buffer.alloc(44 + pcm.length);
  canonical.write("RIFF", 0);
  canonical.writeUInt32LE(canonical.length - 8, 4);
  canonical.write("WAVEfmt ", 8);
  canonical.writeUInt32LE(16, 16);
  canonical.writeUInt16LE(1, 20);
  canonical.writeUInt16LE(1, 22);
  canonical.writeUInt32LE(16_000, 24);
  canonical.writeUInt32LE(32_000, 28);
  canonical.writeUInt16LE(2, 32);
  canonical.writeUInt16LE(16, 34);
  canonical.write("data", 36);
  canonical.writeUInt32LE(pcm.length, 40);
  pcm.copy(canonical, 44);
  return { wav: canonical, durationMs };
}

/** One local child process at a time. Audio and transcript files are always ephemeral. */
export class VoiceService {
  private busy = false;
  private readonly runtimeDir: string;
  private readonly binaryPath: string;
  private readonly modelPath: string;
  private readonly jobsDir: string;

  constructor(
    dataDir: string,
    private readonly options: VoiceOptions = {},
  ) {
    this.runtimeDir = resolve(
      options.runtimeDir ??
        process.env.JARVIS_VOICE_DIR ??
        join(dataDir, "voice"),
    );
    this.binaryPath =
      options.binaryPath ?? join(this.runtimeDir, "bin", "whisper-cli");
    this.modelPath =
      options.modelPath ?? join(this.runtimeDir, "ggml-base.bin");
    this.jobsDir = join(dataDir, "voice-jobs");
  }

  status() {
    let available = false;
    let reason: string | null =
      "Brak lokalnego silnika mowy. Uruchom konfigurację voice:setup.";
    try {
      const executable = lstatSync(this.binaryPath);
      const model = lstatSync(this.modelPath);
      if (
        executable.isFile() &&
        !executable.isSymbolicLink() &&
        model.isFile() &&
        !model.isSymbolicLink() &&
        model.size > 0
      ) {
        accessSync(this.binaryPath, constants.X_OK);
        accessSync(this.modelPath, constants.R_OK);
        available = true;
        reason = null;
      }
    } catch {
      /* Missing or inaccessible runtime is an explicit unavailable state. */
    }
    return {
      available,
      reason,
      busy: this.busy,
      engine: "whisper.cpp",
      language: "pl",
      localOnly: true,
      maxDurationMs: this.options.maxDurationMs ?? 30_000,
      maxAudioBytes: this.options.maxAudioBytes ?? 2 * 1024 * 1024,
    };
  }

  async transcribe(input: {
    audio: string;
    mimeType: string;
  }): Promise<{ text: string }> {
    if (this.busy)
      throw new DomainError(
        "voice_busy",
        "Trwa transkrypcja poprzedniego nagrania.",
        409,
      );
    if (!this.status().available)
      throw new DomainError(
        "voice_unavailable",
        "Lokalny silnik mowy jest niedostępny.",
        503,
      );
    const validated = validateVoiceAudio(input, this.options);
    this.busy = true;
    let jobDir: string | undefined;
    try {
      mkdirSync(this.jobsDir, { recursive: true, mode: 0o700 });
      if (lstatSync(this.jobsDir).isSymbolicLink())
        throw new DomainError(
          "voice_storage",
          "Nieprawidłowy katalog roboczy audio.",
          503,
        );
      jobDir = mkdtempSync(join(this.jobsDir, "job-"));
      const audioPath = join(jobDir, "audio.wav");
      const outputPrefix = join(jobDir, "transcript");
      writeFileSync(audioPath, validated.wav, { mode: 0o600, flag: "wx" });
      await new Promise<void>((resolvePromise, reject) => {
        execFile(
          this.binaryPath,
          [
            "--model",
            this.modelPath,
            "--file",
            audioPath,
            "--language",
            "pl",
            "--threads",
            "2",
            "--no-gpu",
            "--no-prints",
            "--no-timestamps",
            "--output-txt",
            "--output-file",
            outputPrefix,
          ],
          {
            cwd: jobDir,
            timeout: this.options.timeoutMs ?? 60_000,
            killSignal: "SIGKILL",
            maxBuffer: 128 * 1024,
            encoding: "utf8",
            windowsHide: true,
            // Do not pass provider credentials or ambient proxy settings to the audio process.
            env: {
              PATH: "/usr/bin:/bin",
              HOME: jobDir,
              TMPDIR: jobDir,
              LANG: "C.UTF-8",
            },
          },
          (error) => {
            if (error)
              reject(
                new DomainError(
                  error.killed ? "voice_timeout" : "voice_failed",
                  error.killed
                    ? "Lokalna transkrypcja przekroczyła limit czasu."
                    : "Lokalna transkrypcja nie powiodła się.",
                  503,
                ),
              );
            else resolvePromise();
          },
        );
      });
      const output = join(jobDir, "transcript.txt");
      const stat = lstatSync(output);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_000)
        throw new DomainError(
          "voice_output",
          "Nieprawidłowy wynik lokalnej transkrypcji.",
          503,
        );
      const text = readFileSync(output, "utf8").trim().replace(/\s+/g, " ");
      if (!text || text.length > 8_000)
        throw new DomainError(
          "voice_empty",
          "Nie rozpoznano mowy. Spróbuj nagrać ponownie.",
          422,
        );
      return { text };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        "voice_failed",
        "Lokalna transkrypcja nie powiodła się.",
        503,
      );
    } finally {
      if (jobDir) rmSync(jobDir, { recursive: true, force: true });
      validated.wav.fill(0);
      this.busy = false;
    }
  }
}
