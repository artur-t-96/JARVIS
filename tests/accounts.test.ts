import { test } from "node:test";
import assert from "node:assert/strict";
import { Accounts } from "../src/accounts.js";

test("individual sessions expire and revocation removes execution identity", () => {
  let now = 0;
  const accounts = new Accounts(":memory:", () => now);
  const user = {
    id: "operator",
    tenantId: "a",
    username: "operator-a",
    password: "test-long-passphrase",
    roles: ["operator", "approver"],
    scopes: ["assets"],
  };
  accounts.provision(user);
  const login = accounts.login(user.username, user.password);
  const cookie = `jarvis_session=${login.token}`;
  assert.equal(accounts.authenticate(cookie).tenantId, "a");
  assert.deepEqual(accounts.authenticate(cookie).scopes, ["assets"]);
  now = 9 * 60 * 60_000;
  assert.throws(() => accounts.authenticate(cookie));
  const second = accounts.login(user.username, user.password);
  accounts.revoke("a", "operator");
  assert.throws(() => accounts.authenticate(`jarvis_session=${second.token}`));
  assert.deepEqual(accounts.principals(), []);
  accounts.close();
});
test("failed login is rate limited and does not create a session", () => {
  const accounts = new Accounts(":memory:");
  for (let n = 0; n < 5; n++)
    assert.throws(() => accounts.login("unknown", "wrong"));
  assert.throws(() => accounts.login("unknown", "wrong"), /Zbyt wiele/);
  accounts.close();
});
