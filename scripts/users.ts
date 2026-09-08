import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Accounts } from "../src/accounts.js";

process.umask(0o077);
const accounts = new Accounts(
  resolve(process.env.JARVIS_DATA_DIR ?? ".data", "accounts.sqlite"),
);
try {
  const command = process.argv[2];
  if (command === "create") {
    // JSON is supplied on stdin, never through shell arguments or repository files.
    const principal = accounts.provision(JSON.parse(readFileSync(0, "utf8")));
    process.stdout.write(
      JSON.stringify({ created: principal.id, tenantId: principal.tenantId }) +
        "\n",
    );
  } else if (command === "revoke" && process.argv[3] && process.argv[4]) {
    accounts.revoke(process.argv[3], process.argv[4]);
    process.stdout.write("Dostęp i sesje odwołane.\n");
  } else
    throw new Error(
      "Use: users create < private-user.json OR users revoke TENANT USER",
    );
} catch {
  process.stderr.write(
    "Nie udało się zarządzić kontem. Sprawdź polecenie i dane; sekret nie jest logowany.\n",
  );
  process.exitCode = 1;
} finally {
  accounts.close();
}
