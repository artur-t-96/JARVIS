import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DomainError, type Principal } from "./contracts.js";
import { z } from "zod";
import { migrateDatabase } from "./migrations.js";

const userSchema = z
  .object({
    id: z.string().min(1).max(100),
    tenantId: z.string().min(1).max(100),
    username: z.string().trim().min(3).max(100),
    password: z.string().min(12).max(256),
    roles: z.array(z.enum(["operator", "approver", "viewer"])).min(1),
    scopes: z.array(z.string().min(1)).default([]),
  })
  .strict();
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
type Row = Record<string, unknown>;
const toPrincipal = (r: Row): Principal => ({
  id: String(r.id),
  tenantId: String(r.tenant_id),
  roles: JSON.parse(String(r.roles)),
  scopes: JSON.parse(String(r.scopes)),
});

/** Local user accounts. Enrollment and revocation are explicit administrator CLI actions. */
export class Accounts {
  private db: DatabaseSync;
  constructor(
    path: string,
    private clock = Date.now,
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    migrateDatabase(this.db, {
      namespace: "accounts",
      migrations: [
        {
          version: 1,
          name: "accounts and revocable sessions",
          up: (db) =>
            db.exec(`
      CREATE TABLE IF NOT EXISTS account_schema(version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS users(id TEXT NOT NULL,tenant_id TEXT NOT NULL,username TEXT NOT NULL UNIQUE,salt TEXT NOT NULL,password_hash TEXT NOT NULL,roles TEXT NOT NULL,scopes TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,id));
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,user_id TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts(username TEXT PRIMARY KEY,attempts INTEGER NOT NULL,window_start INTEGER NOT NULL);
      INSERT OR IGNORE INTO account_schema VALUES(1);`),
        },
      ],
    });
    if (
      Number(
        (
          this.db
            .prepare("SELECT MAX(version) AS v FROM account_schema")
            .get() as Row
        ).v,
      ) !== 1
    )
      throw new Error("Unsupported account schema");
  }
  provision(value: unknown) {
    const user = userSchema.parse(value);
    const salt = randomBytes(32).toString("hex");
    const passwordHash = scryptSync(user.password, salt, 64).toString("hex");
    this.db
      .prepare(
        "INSERT INTO users(id,tenant_id,username,salt,password_hash,roles,scopes) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        user.id,
        user.tenantId,
        user.username,
        salt,
        passwordHash,
        JSON.stringify(user.roles),
        JSON.stringify(user.scopes),
      );
    return {
      id: user.id,
      tenantId: user.tenantId,
      roles: user.roles,
      scopes: user.scopes,
    };
  }
  principals(): Principal[] {
    return (
      this.db.prepare("SELECT * FROM users WHERE disabled=0").all() as Row[]
    ).map(toPrincipal);
  }
  count() {
    return Number(
      (this.db.prepare("SELECT COUNT(*) AS n FROM users").get() as Row).n,
    );
  }
  login(username: string, password: string) {
    const now = this.clock();
    const attempt = this.db
      .prepare("SELECT * FROM login_attempts WHERE username=?")
      .get(username) as Row | undefined;
    if (
      attempt &&
      now - Number(attempt.window_start) < 60_000 &&
      Number(attempt.attempts) >= 5
    )
      throw new DomainError(
        "RATE_LIMIT",
        "Zbyt wiele prób. Spróbuj ponownie za minutę.",
        429,
      );
    this.db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now);
    this.db
      .prepare("DELETE FROM login_attempts WHERE window_start<?")
      .run(now - 60_000);
    this.db
      .prepare(
        "INSERT INTO login_attempts(username,attempts,window_start) VALUES(?,1,?) ON CONFLICT(username) DO UPDATE SET attempts=attempts+1",
      )
      .run(username, now);
    const user = this.db
      .prepare("SELECT * FROM users WHERE username=? AND disabled=0")
      .get(username) as Row | undefined;
    const supplied = scryptSync(
      password,
      user ? String(user.salt) : "invalid-user",
      64,
    );
    const expected = user
      ? Buffer.from(String(user.password_hash), "hex")
      : Buffer.alloc(64);
    if (!timingSafeEqual(supplied, expected) || !user)
      throw new DomainError("UNAUTHORIZED", "Niepoprawne dane logowania.", 401);
    this.db
      .prepare("DELETE FROM login_attempts WHERE username=?")
      .run(username);
    const token = randomBytes(32).toString("base64url");
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?,?)")
      .run(
        digest(token),
        String(user.tenant_id),
        String(user.id),
        now + 8 * 60 * 60_000,
      );
    return { token, principal: toPrincipal(user) };
  }
  authenticate(cookie?: string): Principal {
    const token = cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("jarvis_session="))
      ?.slice(15);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new DomainError("UNAUTHORIZED", "Zaloguj się do JARVIS.", 401);
    const row = this.db
      .prepare(
        "SELECT u.* FROM users u JOIN sessions s ON s.tenant_id=u.tenant_id AND s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0",
      )
      .get(digest(token), this.clock()) as Row | undefined;
    if (!row)
      throw new DomainError(
        "UNAUTHORIZED",
        "Sesja wygasła lub dostęp został odebrany.",
        401,
      );
    return toPrincipal(row);
  }
  logout(cookie?: string) {
    const token = cookie
      ?.split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith("jarvis_session="))
      ?.slice(15);
    if (token)
      this.db
        .prepare("DELETE FROM sessions WHERE token_hash=?")
        .run(digest(token));
  }
  revoke(tenantId: string, id: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE users SET disabled=1 WHERE tenant_id=? AND id=?")
        .run(tenantId, id);
      this.db
        .prepare("DELETE FROM sessions WHERE tenant_id=? AND user_id=?")
        .run(tenantId, id);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
