import { once } from "node:events";
import { readFileSync } from "node:fs";
import { WorkspaceStore } from "../src/workspace.js";

const fixture = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const store = new WorkspaceStore(fixture.path, {
  clock: () => Date.parse("2026-09-08T10:00:00Z"),
});
store.setPrincipalProvider(() => fixture.principals);
store.setProfileProvider(() => fixture.profile);
const tool = store.tools().find((tool) => tool.id === fixture.toolId)!;
process.stdout.write(JSON.stringify({ type: "ready" }) + "\n");
await once(process.stdin, "data");
try {
  const ctx = { ...fixture.context, signal: new AbortController().signal };
  const result = await tool.execute(ctx, fixture.input);
  process.stdout.write(
    JSON.stringify({
      type: "finished",
      ok: true,
      verified: (await tool.verify(ctx, fixture.input, result)).ok,
    }) + "\n",
  );
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      type: "finished",
      ok: false,
      code: (error as { code?: string }).code,
    }) + "\n",
  );
} finally {
  store.close();
  process.stdin.destroy();
}
