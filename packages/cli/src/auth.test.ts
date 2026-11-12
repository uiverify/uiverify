import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCredential } from "./auth";
import { type ActiveLogin, type CredentialStore, credentialStore, withEntry } from "./credentials";
import { type AuthDeps, NOT_FINISHED, NOT_SIGNED_IN } from "./login";

const API = "https://uiverify.ai";
const deps: AuthDeps = { fetch: async () => new Response("{}"), now: () => 1_000, sleep: async () => {} };
const login = (over: Partial<ActiveLogin> = {}): ActiveLogin => ({
  clientId: "client_cli",
  tokenEndpoint: "https://auth.example/token",
  accessToken: "access-token-1",
  refreshToken: "refresh-token-1",
  expiresAt: 10_000_000,
  confirmedAt: 500,
  storedAt: 400,
  ...over,
});

let home: string;
let store: CredentialStore;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-auth-"));
  store = credentialStore(path.join(home, "uiverify", "credentials.json"), null);
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

async function seed(active: ActiveLogin, origin = API): Promise<void> {
  await store.withLock(async () => store.write(withEntry(store.read(), origin, { active })));
}

describe("resolveCredential", () => {
  it("uses the API key when set, even when signed in", async () => {
    await seed(login());
    const r = resolveCredential({ UIVERIFY_API_KEY: "uv_proj_key123456" }, API, store, deps);
    expect(r.ok && r.credential.signedIn).toBe(false);
    expect(r.ok && (await r.credential.token())).toBe("uv_proj_key123456");
  });

  /** Would catch: an upload with no key ignoring the stored login, or using another server's. */
  it("uses the login stored for this API URL when there is no key, in CI too", async () => {
    await seed(login());
    const r = resolveCredential({ CI: "true" }, `${API}/`, store, deps);
    expect(r.ok && r.credential.signedIn).toBe(true);
    expect(r.ok && (await r.credential.token())).toBe("access-token-1");
    expect(resolveCredential({}, "http://localhost:3000", store, deps)).toEqual({
      ok: false,
      error: `${NOT_SIGNED_IN}\nTo sign in to http://localhost:3000, run: UIVERIFY_API_URL=http://localhost:3000 npx uiverify login`,
      errorClass: "missing_key",
    });
  });

  /** Would catch: an approval the control plane hasn't confirmed (the account doesn't exist yet) used to
   *  upload. */
  it("refuses a login whose sign-in isn't finished", async () => {
    await seed(login({ confirmedAt: null }));
    expect(resolveCredential({}, API, store, deps)).toEqual({ ok: false, error: NOT_FINISHED, errorClass: "login_unconfirmed" });
  });

  /** Would catch: an upload that started under one login carrying on under another approval stored mid-run
   *  (another `login`, maybe another account, maybe unconfirmed). */
  it("pins the approval it resolved, failing rather than switching mid-run", async () => {
    await seed(login());
    const r = resolveCredential({}, API, store, deps);
    await seed(login({ accessToken: "access-token-2", refreshToken: "refresh-token-2", storedAt: 900, confirmedAt: null }));
    await expect(r.ok && r.credential.token()).rejects.toThrow(NOT_SIGNED_IN);
  });

  it("says how to fix a store it can't read", () => {
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    fs.writeFileSync(store.file, "{broken");
    const r = resolveCredential({}, API, store, deps);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("Run npx uiverify login to replace it, or set UIVERIFY_API_KEY.");
    expect(!r.ok && r.errorClass).toBe("login_unreadable");
  });

  /** Catches a malformed API URL reading as a missing key in the setup funnel. */
  it("calls an API URL that isn't a URL an invalid argument", () => {
    expect(resolveCredential({}, "not a url", store, deps)).toMatchObject({ ok: false, errorClass: "invalid_args" });
  });

  /** Catches an upload made while `login` still waits for approval reading as one that never tried to sign in. */
  it("tells a waiting or recently expired login code apart from never signing in, keeping the message", async () => {
    const code = (expiresAt: number) =>
      store.withLock(async () =>
        store.write(
          withEntry(store.read(), API, {
            pending: {
              clientId: "client_cli",
              tokenEndpoint: "https://auth.example/token",
              deviceCode: "device-code-1",
              userCode: "ABCD-EFGH",
              verificationUri: "https://auth.example/device",
              expiresAt,
              interval: 5,
            },
          }),
        ),
      );
    await code(5_000);
    expect(resolveCredential({}, API, store, deps)).toEqual({ ok: false, error: NOT_SIGNED_IN, errorClass: "login_pending" });
    await code(1_000 - 59 * 60_000);
    expect(resolveCredential({}, API, store, deps)).toMatchObject({ errorClass: "login_pending" });
    await code(1_000 - 61 * 60_000);
    expect(resolveCredential({}, API, store, deps)).toMatchObject({ errorClass: "missing_key" });
  });
});

describe("heldToken", () => {
  let now = 1_000_000;
  let refreshes = 0;
  let refreshReply: { status: number; body: unknown } = { status: 200, body: { access_token: "access-token-2", refresh_token: "refresh-token-2", expires_in: 300 } };
  const clocked: AuthDeps = {
    fetch: async () => {
      refreshes++;
      return new Response(JSON.stringify(refreshReply.body), { status: refreshReply.status });
    },
    now: () => now,
    sleep: async () => {},
  };
  beforeEach(() => {
    now = 1_000_000;
    refreshes = 0;
    refreshReply = { status: 200, body: { access_token: "access-token-2", refresh_token: "refresh-token-2", expires_in: 300 } };
  });

  function signedIn(expiresIn: number) {
    return seed(login({ expiresAt: now + expiresIn })).then(() => {
      const r = resolveCredential({}, API, store, clocked);
      if (!r.ok || !r.credential.heldToken) throw new Error("expected a login credential");
      return { credential: r.credential, heldToken: r.credential.heldToken };
    });
  }

  /** Would catch: a failure before the run's first request (a missing --static-dir, an empty capture dir)
   *  going out with no bearer although the run already read a valid token. */
  it("holds the stored token from the moment the credential resolves, without reading the store again", async () => {
    const { heldToken } = await signedIn(600_000);
    fs.rmSync(store.file);
    expect(heldToken()).toBe("access-token-1");
    expect(refreshes).toBe(0);
  });

  it("follows a renewal and drops a token once it is within 30 s of expiry", async () => {
    const { credential, heldToken } = await signedIn(50_000);
    expect(await credential.token()).toBe("access-token-2");
    expect(heldToken()).toBe("access-token-2");
    now += 300_000 - 29_000;
    expect(heldToken()).toBeNull();
  });

  /** Would catch: AuthKit being briefly unreachable at start hiding the stored token, which is still valid and
   *  is the login this run used. */
  it("keeps the stored token when the start renewal can't reach AuthKit, until it is within 30 s of expiry", async () => {
    refreshReply = { status: 503, body: {} };
    const { credential, heldToken } = await signedIn(45_000);
    expect(await credential.token()).toBe("access-token-1");
    expect(heldToken()).toBe("access-token-1");
    now += 25_000;
    expect(heldToken()).toBeNull();
  });

  /** Would catch: a report authenticating as a login the run already learned is gone (AuthKit refused it for
   *  good, or the person signed out or in as someone else mid-run). */
  it("drops the token once the run learns the login is gone", async () => {
    refreshReply = { status: 400, body: { error: "invalid_grant" } };
    const dead = await signedIn(45_000);
    await expect(dead.credential.token()).rejects.toThrow(NOT_SIGNED_IN);
    expect(dead.heldToken()).toBeNull();

    const replaced = await signedIn(600_000);
    await seed(login({ accessToken: "access-token-other", storedAt: 900 }));
    await expect(replaced.credential.token()).rejects.toThrow(NOT_SIGNED_IN);
    expect(replaced.heldToken()).toBeNull();
  });

  /** Would catch: a token the server just answered 401 to staying on the report when its renewal fails. */
  it("drops a token the server refused, even when the renewal then fails", async () => {
    refreshReply = { status: 500, body: {} };
    const { credential, heldToken } = await signedIn(600_000);
    await expect(credential.renew?.("access-token-1")).rejects.toThrow("could not renew");
    expect(heldToken()).toBeNull();
  });
});
