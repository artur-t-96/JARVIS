import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Bounded local stdout/stderr capture, including native warnings outside Diagnostics. */
export function rotatingLogWriter(
  path: string,
  maxBytes = 5 * 1024 * 1024,
  retained = 2,
) {
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < 32 ||
    !Number.isInteger(retained) ||
    retained < 1 ||
    retained > 10
  )
    throw new Error("Invalid log retention limits.");
  return (chunk: Buffer | string) => {
    let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (bytes.length > maxBytes)
      bytes = bytes.subarray(bytes.length - maxBytes);
    const size = existsSync(path) ? statSync(path).size : 0;
    if (size + bytes.length > maxBytes) {
      rmSync(`${path}.${retained}`, { force: true });
      for (let index = retained - 1; index >= 1; index--)
        if (existsSync(`${path}.${index}`))
          renameSync(`${path}.${index}`, `${path}.${index + 1}`);
      if (existsSync(path)) renameSync(path, `${path}.1`);
    }
    appendFileSync(path, bytes, { mode: 0o600 });
  };
}

function supervise() {
  process.umask(0o077);
  const [server, log] = process.argv.slice(2);
  const root = resolve(process.cwd());
  if (
    !server ||
    !log ||
    !isAbsolute(server) ||
    server !== join(root, "dist", "server.js") ||
    ![
      join(root, ".data", "local-product", "lab.log"),
      join(root, ".data", "local-product", "operational.log"),
    ].includes(log)
  )
    throw new Error("Invalid local supervisor paths.");
  const write = rotatingLogWriter(log);
  const child = spawn(process.execPath, [server], {
    cwd: root,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let loggingFailed = false;
  const output = (chunk: Buffer) => {
    if (loggingFailed) return;
    try {
      write(chunk);
    } catch {
      loggingFailed = true;
      child.kill("SIGTERM");
    }
  };
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  child.on("error", () => {
    process.exitCode = 1;
  });
  child.on("close", (code) => {
    process.exitCode = loggingFailed ? 1 : (code ?? 1);
  });
  process.on("SIGTERM", () => {
    child.kill("SIGTERM");
  });
  process.on("SIGINT", () => {
    child.kill("SIGTERM");
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    supervise();
  } catch {
    process.stderr.write(
      "Local supervisor failed. No environment values were logged.\n",
    );
    process.exitCode = 1;
  }
}
