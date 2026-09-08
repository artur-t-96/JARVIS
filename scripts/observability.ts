import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ObservabilityRuntime } from "../src/observability/runtime.js";

process.umask(0o077);
try {
  const [command, mode, ...extra] = process.argv.slice(2);
  const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const runtime = new ObservabilityRuntime(projectDir);
  if (extra.length || !command)
    throw new Error(
      "Użyj: install | start MODE | stop MODE | status MODE | doctor MODE.",
    );
  if (command === "install") {
    if (mode)
      throw new Error(
        "Instalacja używa wspólnych, przypiętych binariów; nie podawaj trybu.",
      );
    const installed = await runtime.install();
    process.stdout.write(
      JSON.stringify({
        status: "installed",
        components: installed.map((item) => ({
          id: item.id,
          version: item.version,
        })),
      }) + "\n",
    );
  } else {
    if (mode !== "lab" && mode !== "operational")
      throw new Error("Wybierz jawnie tryb lab albo operational.");
    if (!["start", "stop", "status", "doctor"].includes(command))
      throw new Error(
        "Nieznane polecenie. Użyj install, start, stop, status albo doctor.",
      );
    const result =
      await runtime[command as "start" | "stop" | "status" | "doctor"](mode);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  }
} catch (error) {
  process.stderr.write(
    `JARVIS observability: ${error instanceof Error ? error.message : "Operacja nie powiodła się."}\n`,
  );
  process.exitCode = 1;
}
