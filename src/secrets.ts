import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export type LocalMode = "lab" | "operational";
export type KeychainCommand = (
  args: string[],
  stdin?: string,
) => Promise<{ code: number; stdout: string }>;

const securityCommand: KeychainCommand = (args, stdin) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("/usr/bin/security", args, {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: "/usr/bin:/bin" },
    });
    let output = "";
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 8192) child.kill("SIGKILL");
    });
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("macOS Keychain is unavailable."));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolvePromise({ code: code ?? 1, stdout: output });
    });
    child.stdin.on("error", () => {
      /* Early native failure is reported via exit status. */
    });
    child.stdin.end(stdin ?? "");
  });

/** Dedicated Keychain item per JARVIS checkout and mode. Secret never enters argv. */
export class KeychainSecrets {
  private readonly account: string;
  private readonly service = "com.dynaminds.jarvis.anthropic";
  private readonly run: KeychainCommand;
  private readonly platform: string;

  constructor(
    projectDir: string,
    mode: LocalMode,
    options: { platform?: string; run?: KeychainCommand } = {},
  ) {
    this.account = `jarvis-${createHash("sha256").update(resolve(projectDir)).digest("hex").slice(0, 20)}-${mode}`;
    this.run = options.run ?? securityCommand;
    this.platform = options.platform ?? process.platform;
  }

  async status(): Promise<{
    available: boolean;
    configured: boolean;
    provider: string;
    reason: string | null;
  }> {
    if (this.platform !== "darwin")
      return {
        available: false,
        configured: false,
        provider: "anthropic",
        reason: "macOS Keychain is available only on macOS.",
      };
    try {
      const result = await this.run([
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        this.account,
      ]);
      return {
        available: true,
        configured: result.code === 0,
        provider: "anthropic",
        reason: null,
      };
    } catch {
      return {
        available: false,
        configured: false,
        provider: "anthropic",
        reason: "macOS Keychain is unavailable or locked.",
      };
    }
  }

  async set(secret: string): Promise<void> {
    this.supported();
    this.validSecret(secret);
    // security -i parses this private stdin stream; -w value is absent from OS process argv.
    // Input alphabet excludes whitespace, quotes, backslashes and newlines, preventing commands.
    const command = `add-generic-password -U -s ${this.service} -a ${this.account} -w ${secret}\n`;
    try {
      const result = await this.run(["-i"], command);
      if (result.code !== 0) throw new Error();
      // Interactive security may exit zero after a failed inner command; read back privately.
      const stored = await this.read();
      if (stored !== secret) throw new Error();
    } catch {
      throw new Error(
        "Could not save the provider credential in macOS Keychain; no credential was logged.",
      );
    }
  }

  async read(): Promise<string> {
    this.supported();
    try {
      const result = await this.run([
        "find-generic-password",
        "-s",
        this.service,
        "-a",
        this.account,
        "-w",
      ]);
      const secret = result.stdout.trim();
      if (result.code !== 0) throw new Error();
      this.validSecret(secret);
      return secret;
    } catch {
      throw new Error(
        "Provider credential is missing, locked or invalid in macOS Keychain.",
      );
    }
  }

  private supported() {
    if (this.platform !== "darwin")
      throw new Error(
        "Provider secrets require macOS Keychain on this installation.",
      );
  }
  private validSecret(secret: string) {
    if (!/^[A-Za-z0-9_./+=-]{16,4096}$/.test(secret))
      throw new Error(
        "Invalid provider credential format; secret was not logged.",
      );
  }
}
