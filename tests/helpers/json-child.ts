import { spawn } from "node:child_process";

/** Native child with a bounded JSON-line handshake; SIGKILL always targets our child. */
export function jsonChild(script: string, args: string[]) {
  const child = spawn(process.execPath, ["--import", "tsx", script, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let pending = "",
    stderr = "",
    ended = false;
  const messages: Record<string, unknown>[] = [];
  const waiters = new Set<() => void>();
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-20_000);
  });
  child.stdout.on("data", (chunk: string) => {
    pending += chunk;
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) messages.push(JSON.parse(line));
    }
    for (const wake of waiters) wake();
  });
  const exited = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", (error) => {
      ended = true;
      reject(error);
      for (const wake of waiters) wake();
    });
    child.once("close", (code, signal) => {
      ended = true;
      resolve({ code, signal });
      for (const wake of waiters) wake();
    });
  });
  return {
    exited,
    send(value: string) {
      child.stdin.write(value);
    },
    async waitFor(type: string): Promise<Record<string, unknown>> {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`Child timed out at ${type}: ${stderr}`));
        }, 15_000);
        const check = () => {
          const message = messages.find((entry) => entry.type === type);
          if (message || ended) {
            clearTimeout(timeout);
            waiters.delete(check);
            if (message) resolve(message);
            else reject(new Error(`Child exited before ${type}: ${stderr}`));
          }
        };
        waiters.add(check);
        check();
      });
    },
    async kill() {
      if (!ended) child.kill("SIGKILL");
      return exited;
    },
  };
}
