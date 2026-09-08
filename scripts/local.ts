import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LocalRuntime } from "../src/local-runtime.js";
import { KeychainSecrets, type LocalMode } from "../src/secrets.js";

process.umask(0o077);
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      port: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      observability: { type: "boolean" },
    },
  });
  const [command, selectedMode] = positionals;
  if (positionals.length > 2)
    throw new Error("Unexpected positional arguments.");
  const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const runtime = new LocalRuntime(projectDir);
  if (command === "install" || command === "update") {
    const result = await runtime[command]();
    process.stdout.write(
      JSON.stringify({
        status: "installed",
        gitSha: result.gitSha,
        installedAt: result.installedAt,
        node: result.node,
      }) + "\n",
    );
  } else {
    if (selectedMode !== "lab" && selectedMode !== "operational")
      throw new Error("Choose the explicit lab or operational mode.");
    const mode: LocalMode = selectedMode;
    if (command === "start") {
      if (values.provider && values.provider !== "anthropic")
        throw new Error("Supported optional provider: anthropic.");
      process.stdout.write(
        JSON.stringify(
          await runtime.start({
            mode,
            observability: values.observability,
            ...(values.port ? { port: Number(values.port) } : {}),
            ...(values.provider
              ? { provider: "anthropic", model: values.model }
              : {}),
          }),
        ) + "\n",
      );
    } else if (command === "stop" || command === "status")
      process.stdout.write(JSON.stringify(await runtime[command](mode)) + "\n");
    else if (command === "secret-set") {
      if (process.stdin.isTTY)
        throw new Error(
          "Provide the credential through private stdin; never as a shell argument.",
        );
      await new KeychainSecrets(projectDir, mode).set(
        readFileSync(0, "utf8").trim(),
      );
      process.stdout.write(
        JSON.stringify({
          stored: true,
          provider: "anthropic",
          mode,
          location: "macOS Keychain",
        }) + "\n",
      );
    } else if (command === "secret-status")
      process.stdout.write(
        JSON.stringify(await new KeychainSecrets(projectDir, mode).status()) +
          "\n",
      );
    else
      throw new Error(
        "Use install, update, start MODE, stop MODE, status MODE, secret-set MODE or secret-status MODE.",
      );
  }
} catch (error) {
  process.stderr.write(
    `JARVIS local: ${error instanceof Error ? error.message : "Operation failed."}\n`,
  );
  process.exitCode = 1;
}
