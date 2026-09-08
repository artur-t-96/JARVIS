# JARVIS working agreement

- Change only JARVIS. Do not modify other applications, databases, credentials or deployments as part of this project without explicit instruction.
- Use Node 22.23.0 (`.nvmrc`) and npm. No local Docker.
- Main source is `src/`; the Polish operations console is `public/`.
- Relevant gates: `npm run format:check`, `npm run check`, `npm run demo`.
- Keep SQLite state, access tokens and provider secrets outside Git. `.data/` and `.env*` are ignored.
- Core owns executions, not domain data or commercial acceptance. Tools are a closed registry; the planner never grants authority.
- Every write needs explicit approval bound to plan, concrete arguments, tenant, policy and tool version. Recheck authority before every actual execution, including recovery.
- Unknown side effects require reconciliation. Never silently re-execute an ambiguous write or claim exactly-once for arbitrary external tools.
- Tests must exercise restart and separate durable side-effect storage. Preserve the real child-process SIGKILL test.
- Follow normal bot branch/PR/CI delivery. Production hosting is not configured; do not invent or reuse another application's deployment.
- Local mode binds loopback only and is intended for synthetic data. Network operation requires authenticated mode and a private auth file; hosting, TLS, backup/restore and real connectors require their own rollout.
