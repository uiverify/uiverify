import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ActiveLogin, type CredentialStore, type LoginEntry, type PendingLogin, credentialStore, withEntry } from "./credentials";
import { fakeKeyStore } from "./fake-key-store";
import {
  type AuthDeps,
  type LoginDeps,
  NOT_FINISHED,
  NOT_SIGNED_IN,
  loginAccessToken,
  loginToken,
  runLogin,
  runLogout,
  runWhoami,
  shouldOpenBrowser,
} from "./login";
import { type LoginEnding, LoginGoneError } from "./login-errors";

const API = "http://localhost:3000";
const KEY = API;
const DEVICE_EP = "https://auth.example/oauth2/device_authorization";
const TOKEN_EP = "https://auth.example/oauth2/token";
const VERIFY_URL = "https://auth.example/device?user_code=ABCD-EFGH";
const SESSION = { user: { id: "user_1", email: "dev@acme.test", name: "Dev" }, teams: [{ slug: "acme", name: "Acme" }] };

type Reply = { status: number; body: unknown };
const ok = (body: unknown): Reply => ({ status: 200, body });
const oauthError = (error: string): Reply => ({ status: 400, body: { error } });
const notSetUp = (): Reply => ({ status: 403, body: { error: "Your UI Verify account is still being set up. Run `npx uiverify login` again in a minute." } });

/** AuthKit + the control plane's `/api/cli/*`, at the fetch boundary. Device-token polls and refreshes are
 *  answered from queues; every call is recorded. */
class FakeAuth {
  calls: Array<{ url: string; method: string; form: URLSearchParams; authorization?: string; headers: Headers }> = [];
  devicePolls: Array<Reply | (() => Promise<Reply>)> = [];
  refreshes: Array<Reply | (() => Promise<Reply>)> = [];
  session: (method: string, token: string | undefined) => Reply = () => ok(SESSION);
  deviceCodes = 0;

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    const headers = new Headers(init?.headers);
    this.calls.push({ url, method, form, authorization: headers.get("authorization") ?? undefined, headers });
    const reply = await this.route(url, method, form, headers.get("authorization")?.replace(/^Bearer /, ""));
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  };

  private async route(url: string, method: string, form: URLSearchParams, token: string | undefined): Promise<Reply> {
    if (url === `${API}/api/cli/login`) {
      return ok({ clientId: "client_cli", deviceAuthorizationEndpoint: DEVICE_EP, tokenEndpoint: TOKEN_EP, scopes: ["openid", "offline_access"] });
    }
    if (url === DEVICE_EP) {
      this.deviceCodes++;
      return ok({
        device_code: `device-code-secret-${this.deviceCodes}`,
        user_code: "ABCD-EFGH",
        verification_uri: "https://auth.example/device",
        verification_uri_complete: VERIFY_URL,
        expires_in: 600,
        interval: 5,
      });
    }
    if (url === TOKEN_EP && form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code") {
      const next = this.devicePolls.shift() ?? oauthError("authorization_pending");
      return typeof next === "function" ? next() : next;
    }
    if (url === TOKEN_EP && form.get("grant_type") === "refresh_token") {
      const next = this.refreshes.shift();
      if (!next) throw new Error("unexpected refresh");
      return typeof next === "function" ? next() : next;
    }
    if (url === `${API}/api/cli/session`) return this.session(method, token);
    throw new Error(`unexpected request ${method} ${url}`);
  }

  count(pred: (c: FakeAuth["calls"][number]) => boolean): number {
    return this.calls.filter(pred).length;
  }
  get refreshCalls(): number {
    return this.count((c) => c.form.get("grant_type") === "refresh_token");
  }
  get sessionPosts(): number {
    return this.count((c) => c.url === `${API}/api/cli/session` && c.method === "POST");
  }
  get devicePollCalls(): number {
    return this.count((c) => c.form.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code");
  }
}

const issued = (n: number): Reply => ok({ access_token: `access-token-${n}`, refresh_token: `refresh-token-${n}`, expires_in: 3_600 });

let home: string;
let store: CredentialStore;
let auth: FakeAuth;
let clock: { t: number };
let lines: string[];
let opened: string[];
let ended: LoginEnding[];

function authDeps(): AuthDeps {
  return {
    fetch: auth.fetch,
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
  };
}

function loginDeps(over: Partial<LoginDeps> = {}): LoginDeps {
  return {
    ...authDeps(),
    apiUrl: API,
    store,
    isTTY: false,
    canOpenBrowser: true,
    openBrowser: async (u) => {
      opened.push(u);
      return true;
    },
    log: (m) => lines.push(m),
    clientHeaders: {},
    reportEnded: (e) => ended.push(e),
    ...over,
  };
}

async function seed(entry: LoginEntry): Promise<void> {
  await store.withLock(async () => store.write(withEntry(store.read(), KEY, entry)));
}

const active = (over: Partial<ActiveLogin> = {}): ActiveLogin => ({
  clientId: "client_cli",
  tokenEndpoint: TOKEN_EP,
  accessToken: "access-token-0",
  refreshToken: "refresh-token-0",
  expiresAt: clock.t + 3_600_000,
  confirmedAt: clock.t - 1,
  storedAt: clock.t - 10,
  ...over,
});

const pendingCode = (over: Partial<PendingLogin> = {}): PendingLogin => ({
  clientId: "client_cli",
  tokenEndpoint: TOKEN_EP,
  deviceCode: "device-code-secret-0",
  userCode: "WXYZ-0000",
  verificationUri: "https://auth.example/device?user_code=WXYZ-0000",
  expiresAt: clock.t + 300_000,
  interval: 5,
  ...over,
});

const entry = (): LoginEntry | undefined => store.read().logins[KEY];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-login-"));
  store = credentialStore(path.join(home, "uiverify", "credentials.json"), null);
  auth = new FakeAuth();
  clock = { t: 1_000_000_000 };
  lines = [];
  opened = [];
  ended = [];
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("runLogin", () => {
  /** Would catch: a login that never confirms with the control plane (no `cli_login`), or stores tokens a
   *  later upload can't tell were confirmed. */
  it("signs in: prints the server, link and code, opens the browser, stores and confirms the login", async () => {
    auth.devicePolls.push(issued(1));
    expect(await runLogin(loginDeps({ isTTY: true }))).toBe("signed-in");
    expect(lines[0]).toBe(`Signing in to UI Verify at ${KEY}`);
    expect(lines).toContain(`  ${VERIFY_URL}`);
    expect(lines).toContain("  Code: ABCD-EFGH");
    expect(lines).toContain("Signed in as dev@acme.test (Dev).");
    expect(opened).toEqual([VERIFY_URL]);
    expect(auth.sessionPosts).toBe(1);
    expect(entry()).toEqual({
      active: { clientId: "client_cli", tokenEndpoint: TOKEN_EP, accessToken: "access-token-1", refreshToken: "refresh-token-1", expiresAt: expect.any(Number), confirmedAt: expect.any(Number), storedAt: expect.any(Number) },
    });
    expect(auth.count((c) => c.url === DEVICE_EP && c.form.get("scope") === "openid offline_access" && c.form.get("client_id") === "client_cli")).toBe(1);
  });

  it("with no team, says the first upload explains how to set up a project", async () => {
    auth.devicePolls.push(issued(1));
    auth.session = () => ok({ ...SESSION, teams: [] });
    expect(await runLogin(loginDeps({ isTTY: true }))).toBe("signed-in");
    expect(lines).toContain("You're not in a UI Verify team yet: your first `uiverify upload` creates your team and the project for its repository.");
    expect(entry()?.active?.confirmedAt).not.toBeNull();
  });

  /** Would catch: an agent shell that shows output only at exit waiting a minute before the person can even
   *  see the link (no browser opened, so nobody can approve yet). */
  it("without a terminal or a browser, prints the code and exits at once, keeping it for the rerun", async () => {
    expect(await runLogin(loginDeps({ canOpenBrowser: false }))).toBe("waiting");
    expect(lines.at(-1)).toMatch(/^Show this link and code to the person signing in; the code must be picked up within 10 minutes\. If they see your messages while you work, .* If they only see them when you stop, stop here /);
    expect(auth.devicePollCalls).toBe(0);
    expect(opened).toEqual([]);
    expect(entry()?.pending).toMatchObject({ deviceCode: "device-code-secret-1", userCode: "ABCD-EFGH" });
  });

  it("counts a browser that failed to start as no browser", async () => {
    expect(await runLogin(loginDeps({ openBrowser: async () => false }))).toBe("waiting");
    expect(lines.at(-1)).toMatch(/^Show this link and code to the person signing in; the code must be picked up within 10 minutes\. If they see your messages while you work, .* If they only see them when you stop, stop here /);
  });

  /** Would catch: an agent's shell blocking past its tool timeout, so the link is never shown. */
  it("without a terminal waits at most a minute, keeping the same code for the rerun", async () => {
    const started = clock.t;
    expect(await runLogin(loginDeps())).toBe("waiting");
    expect(clock.t - started).toBeLessThanOrEqual(60_000);
    expect(lines.at(-1)).toBe("Still waiting for approval. Run npx uiverify login again to keep waiting (same code).");
    expect(entry()?.pending?.deviceCode).toBe("device-code-secret-1");
  });

  /** Would catch: a rerun printing a new code (invalidating the one the person is looking at), or making a
   *  network call before it shows the code. */
  it("resumes the stored code: prints it before any request, and finishes once approved", async () => {
    await seed({ pending: pendingCode() });
    auth.devicePolls.push(issued(1));
    let callsWhenPrinted = -1;
    const deps = loginDeps({
      log: (m) => {
        lines.push(m);
        if (m === "  Code: WXYZ-0000" && callsWhenPrinted < 0) callsWhenPrinted = auth.calls.length;
      },
    });
    expect(await runLogin(deps)).toBe("signed-in");
    expect(callsWhenPrinted).toBe(0);
    expect(auth.deviceCodes).toBe(0);
    expect(opened).toEqual([]);
    expect(entry()?.pending).toBeUndefined();
  });

  it("prints a stored code first even when a dead login sits beside it", async () => {
    await seed({ active: active({ expiresAt: clock.t - 1 }), pending: pendingCode() });
    auth.refreshes.push(oauthError("invalid_grant"));
    auth.devicePolls.push(issued(1));
    expect(await runLogin(loginDeps())).toBe("signed-in");
    expect(lines.indexOf("  Code: WXYZ-0000")).toBe(3);
    expect(entry()?.active?.refreshToken).toBe("refresh-token-1");
  });

  it("slows down when asked, and persists the new interval", async () => {
    auth.devicePolls.push(oauthError("slow_down"));
    expect(await runLogin(loginDeps())).toBe("waiting");
    expect(entry()?.pending?.interval).toBe(10);
  });

  it.each([
    ["access_denied", "The login was denied in the browser. Run npx uiverify login to try again."],
    ["expired_token", "The login code expired before it was approved. Run npx uiverify login again."],
    ["invalid_grant", "This login code is no longer valid (already used, or expired). Run npx uiverify login again."],
  ])("fails on %s and forgets the code", async (error, message) => {
    auth.devicePolls.push(oauthError(error));
    await expect(runLogin(loginDeps({ isTTY: true }))).rejects.toThrow(message);
    expect(entry()).toBeUndefined();
  });

  it("with a terminal gives up when the code expires unapproved", async () => {
    await expect(runLogin(loginDeps({ isTTY: true }))).rejects.toThrow("The login code expired before it was approved.");
    expect(entry()).toBeUndefined();
    expect(ended).toEqual(["expired"]);
  });

  /** Would catch: a losing concurrent `login` clearing the approval the winner stored (or reporting
   *  "already used") while the winner is still confirming. */
  it("when another login redeemed the same code, finishes that login instead of failing", async () => {
    await seed({ pending: pendingCode() });
    auth.devicePolls.push(async () => {
      // The other process redeemed the code and stored the approval; it hasn't confirmed it yet.
      store.write(withEntry(store.read(), KEY, { active: active({ accessToken: "access-token-9", refreshToken: "refresh-token-9", confirmedAt: null, storedAt: clock.t }) }));
      return oauthError("invalid_grant");
    });
    expect(await runLogin(loginDeps())).toBe("signed-in");
    expect(entry()?.active).toMatchObject({ refreshToken: "refresh-token-9", confirmedAt: expect.any(Number) });
    expect(ended).toEqual([]);
  });

  /** Would catch: a losing run calling the code "already used" while the winner's write is still queued
   *  behind the lock, though the sign-in succeeded. */
  it("waits briefly for a winner whose write is still on its way", async () => {
    await seed({ pending: pendingCode() });
    auth.devicePolls.push(oauthError("invalid_grant"));
    const deps = loginDeps({
      sleep: async (ms) => {
        clock.t += ms;
        if (ms === 2_000) store.write(withEntry(store.read(), KEY, { active: active({ refreshToken: "refresh-token-w", storedAt: clock.t }) }));
      },
    });
    expect(await runLogin(deps)).toBe("signed-in");
    expect(entry()?.active?.refreshToken).toBe("refresh-token-w");
    expect(ended).toEqual([]);
  });

  /** Would catch: this run's own renewal (a rotated refresh token) mistaken for another process's approval,
   *  which loops the run on a code that was denied. */
  it("doesn't count its own renewal of a login the server dropped as another process's approval", async () => {
    await seed({ active: active({ expiresAt: clock.t - 1 }) });
    auth.refreshes.push(issued(5));
    auth.session = () => notSetUp();
    auth.devicePolls.push(oauthError("access_denied"));
    await expect(runLogin(loginDeps({ isTTY: true }))).rejects.toThrow("The login was denied in the browser.");
    expect(auth.devicePollCalls).toBe(1);
  });

  /** Would catch: two runs starting at once each storing their own code, so the person approves one and
   *  every rerun waits on the other. */
  it("adopts a code another run stored while this one asked for its own", async () => {
    const other = pendingCode({ deviceCode: "device-code-secret-other", userCode: "OTHR-CODE" });
    const fetch = auth.fetch;
    const deps = loginDeps({
      canOpenBrowser: false,
      fetch: async (input, init) => {
        const res = await fetch(input, init);
        if (String(input) === DEVICE_EP) store.write(withEntry(store.read(), KEY, { pending: other }));
        return res;
      },
    });
    expect(await runLogin(deps)).toBe("waiting");
    expect(lines).toContain("  Code: OTHR-CODE");
    expect(lines).not.toContain("  Code: ABCD-EFGH");
    expect(entry()?.pending?.deviceCode).toBe("device-code-secret-other");
  });

  /** Would catch: a terminal run whose code ran out locally saying "expired" after another run signed in with it. */
  it("on local expiry, reports a login another run stored with the code", async () => {
    await seed({ pending: pendingCode({ expiresAt: clock.t + 4_000 }) });
    auth.devicePolls.push(async () => {
      store.write(withEntry(store.read(), KEY, { active: active({ refreshToken: "refresh-token-w", storedAt: clock.t }), pending: pendingCode({ expiresAt: clock.t + 4_000 }) }));
      return oauthError("authorization_pending");
    });
    expect(await runLogin(loginDeps({ isTTY: true }))).toBe("signed-in");
    expect(entry()?.active?.refreshToken).toBe("refresh-token-w");
  });

  /** Would catch: a confirmation sent with another run's newer approval while recording this run's (or
   *  printing "Signed in as" for one approval and leaving the other unconfirmed). */
  it("never mixes two approvals in one confirmation", async () => {
    await seed({ active: active({ confirmedAt: null, storedAt: clock.t - 10 }) });
    const sent: Array<string | undefined> = [];
    auth.session = (_m, token) => {
      sent.push(token);
      if (sent.length === 1) {
        store.write(withEntry(store.read(), KEY, { active: active({ accessToken: "access-token-other", refreshToken: "refresh-token-other", confirmedAt: null, storedAt: clock.t }) }));
        return notSetUp();
      }
      return token === "access-token-other" ? ok({ ...SESSION, user: { ...SESSION.user, email: "other@acme.test", name: null } }) : ok(SESSION);
    };
    expect(await runLogin(loginDeps())).toBe("signed-in");
    // The approval it reports is the one it confirmed and recorded.
    expect(lines).toContain("Signed in as other@acme.test.");
    expect(entry()?.active).toMatchObject({ refreshToken: "refresh-token-other", confirmedAt: expect.any(Number) });
    expect(sent).toEqual(["access-token-0", "access-token-other"]);
  });

  /** Would catch: a confirmation renewing onto another run's newer approval (the 401 retry), or failing with
   *  "did not accept" when that newer approval is waiting to be confirmed. */
  it("re-reads and confirms a newer approval that appears while renewing for the confirmation", async () => {
    await seed({ active: active({ confirmedAt: null, storedAt: clock.t - 10 }) });
    const sent: Array<string | undefined> = [];
    auth.session = (_m, token) => {
      sent.push(token);
      return token === "access-token-0" ? { status: 401, body: { error: "expired" } } : ok({ ...SESSION, user: { ...SESSION.user, email: "other@acme.test", name: null } });
    };
    auth.refreshes.push(async () => {
      // Another run stores its own approval while this run renews for the 401.
      store.write(withEntry(store.read(), KEY, { active: active({ accessToken: "access-token-other", refreshToken: "refresh-token-other", confirmedAt: null, storedAt: clock.t }) }));
      return issued(7);
    });
    expect(await runLogin(loginDeps())).toBe("signed-in");
    expect(sent).toEqual(["access-token-0", "access-token-other"]);
    expect(entry()?.active).toMatchObject({ refreshToken: "refresh-token-other", confirmedAt: expect.any(Number) });
  });

  /** Would catch: "Signed in as" printed for an approval whose confirmation didn't land because a newer one
   *  replaced it while the request was out, leaving the stored login unconfirmed. */
  it("confirms the newer approval when this one was replaced during a successful confirmation", async () => {
    await seed({ active: active({ confirmedAt: null, storedAt: clock.t - 10 }) });
    const sent: Array<string | undefined> = [];
    auth.session = (_m, token) => {
      sent.push(token);
      if (sent.length === 1) {
        store.write(withEntry(store.read(), KEY, { active: active({ accessToken: "access-token-other", refreshToken: "refresh-token-other", confirmedAt: null, storedAt: clock.t }) }));
        return ok(SESSION);
      }
      return ok({ ...SESSION, user: { ...SESSION.user, email: "other@acme.test", name: null } });
    };
    expect(await runLogin(loginDeps())).toBe("signed-in");
    expect(lines).toContain("Signed in as other@acme.test.");
    expect(lines).not.toContain("Signed in as dev@acme.test (Dev).");
    expect(entry()?.active).toMatchObject({ refreshToken: "refresh-token-other", confirmedAt: expect.any(Number) });
  });

  /** Would catch: a real bug in the poll swallowed as a "blip" and retried until the code expires. */
  it("ends the login on a poll error that isn't the network", async () => {
    const fetch = auth.fetch;
    const deps = loginDeps({
      isTTY: true,
      fetch: async (input, init) => {
        if (String(input) === TOKEN_EP) throw new TypeError("Cannot read properties of undefined");
        return fetch(input, init);
      },
    });
    await expect(runLogin(deps)).rejects.toThrow("Cannot read properties of undefined");
  });

  /** Would catch: one network blip while polling ending a login the person was approving right then. */
  it("keeps polling through a network blip, a 5xx or a 429 from the sign-in server", async () => {
    let calls = 0;
    const fetch = auth.fetch;
    auth.devicePolls.push({ status: 503, body: "down" }, { status: 429, body: "slow" }, issued(1));
    const deps = loginDeps({
      isTTY: true,
      fetch: async (input, init) => {
        if (String(input) === TOKEN_EP) {
          const n = calls++;
          if (n === 0) throw new TypeError("fetch failed", { cause: new Error("ECONNRESET") });
          // undici's error for a connection dropped while the response body was read.
          if (n === 1) throw new TypeError("terminated");
          // A request that ran past its timeout.
          if (n === 2) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        return fetch(input, init);
      },
    });
    expect(await runLogin(deps)).toBe("signed-in");
    expect(lines.filter((l) => l.startsWith("Couldn't get a usable answer from the sign-in server"))).toHaveLength(1);
  });

  /** Would catch: a login whose renewal died counting as "another process won", reporting signed in. */
  it("doesn't count a dead login from before as a winner", async () => {
    await seed({ active: active({ expiresAt: clock.t - 1 }), pending: pendingCode() });
    auth.refreshes.push(oauthError("invalid_grant"));
    auth.devicePolls.push(oauthError("expired_token"));
    await expect(runLogin(loginDeps())).rejects.toThrow("The login code expired before it was approved.");
  });

  it("already signed in: says who, starts nothing, and clears a leftover code", async () => {
    await seed({ active: active(), pending: pendingCode() });
    expect(await runLogin(loginDeps())).toBe("signed-in");
    expect(lines).toContain("Signed in as dev@acme.test (Dev).");
    expect(auth.deviceCodes).toBe(0);
    expect(entry()).toEqual({ active: active() });
  });

  it("replaces a login the server no longer knows (403) with a new approval", async () => {
    await seed({ active: active() });
    let posts = 0;
    auth.session = (method) => (method === "GET" ? notSetUp() : (posts++, ok(SESSION)));
    auth.devicePolls.push(issued(1));
    expect(await runLogin(loginDeps({ isTTY: true }))).toBe("signed-in");
    expect(posts).toBe(1);
    expect(entry()?.active?.refreshToken).toBe("refresh-token-1");
  });

  /** Would catch: a new sign-up whose account the webhook hasn't created yet having to approve twice. */
  it("waits out a late sign-up webhook, then confirms", async () => {
    auth.devicePolls.push(issued(1));
    const replies = [notSetUp(), notSetUp(), ok(SESSION)];
    auth.session = () => replies.shift() ?? ok(SESSION);
    expect(await runLogin(loginDeps({ isTTY: true }))).toBe("signed-in");
    expect(lines.filter((l) => l === "Finishing setting up your account...")).toHaveLength(1);
  });

  /** Would catch: an approval lost to the cap (or a kill) mid-confirmation, costing a second approval; or
   *  an unconfirmed login used by an upload meanwhile. */
  it("keeps an approval it couldn't confirm in time, and the rerun confirms it, refreshing first", async () => {
    auth.devicePolls.push(issued(1));
    auth.session = () => notSetUp();
    expect(await runLogin(loginDeps())).toBe("waiting");
    expect(lines.at(-1)).toBe("Still finishing your sign-in. Run npx uiverify login again to finish.");
    expect(entry()?.active).toMatchObject({ refreshToken: "refresh-token-1", confirmedAt: null });
    expect(auth.deviceCodes).toBe(1);

    clock.t += 3_600_000; // the approved access token expired meanwhile
    auth.session = () => ok(SESSION);
    auth.refreshes.push(issued(2));
    lines = [];
    expect(await runLogin(loginDeps())).toBe("signed-in");
    expect(auth.deviceCodes).toBe(1);
    expect(entry()?.active).toMatchObject({ refreshToken: "refresh-token-2", confirmedAt: expect.any(Number) });
  });

  /** Would catch: an account that will never appear sending the person round "try again in a minute". */
  it("gives up on an account that hasn't appeared in ten minutes, with its own final message", async () => {
    await seed({ active: active({ confirmedAt: null, storedAt: clock.t - 11 * 60_000 }) });
    auth.session = () => notSetUp();
    await expect(runLogin(loginDeps())).rejects.toThrow("Sign in once at the website to finish it");
    expect(entry()).toBeUndefined();
    expect(ended).toEqual(["account_not_ready"]);
  });

  /** Would catch: a confirmation write keyed on a token that rotates, so a renewal in between leaves the
   *  login unconfirmed after "Signed in as". */
  it("records the confirmation even when the login was renewed meanwhile", async () => {
    await seed({ active: active({ confirmedAt: null }) });
    auth.session = () => {
      store.write(withEntry(store.read(), KEY, { active: { ...active({ confirmedAt: null }), refreshToken: "refresh-token-r" } }));
      return ok(SESSION);
    };
    expect(await runLogin(loginDeps())).toBe("signed-in");
    expect(entry()?.active).toMatchObject({ refreshToken: "refresh-token-r", confirmedAt: expect.any(Number) });
  });

  it("drops an approval the server refuses outright (401)", async () => {
    auth.devicePolls.push(issued(1));
    auth.session = () => ({ status: 401, body: { error: "invalid" } });
    auth.refreshes.push(issued(2));
    await expect(runLogin(loginDeps({ isTTY: true }))).rejects.toThrow("UI Verify did not accept the new login.");
    expect(entry()).toBeUndefined();
    expect(ended).toEqual(["rejected"]);
  });

  /** Catches a renewal that UI Verify's 401 forced being blamed on AuthKit, which would hide a server-side
   *  mismatch behind a refresh failure. */
  it("still calls it rejected when the renewal the 401 forced is refused too", async () => {
    auth.devicePolls.push(issued(1));
    auth.session = () => ({ status: 401, body: { error: "invalid" } });
    auth.refreshes.push(oauthError("invalid_grant"));
    await expect(runLogin(loginDeps({ isTTY: true }))).rejects.toThrow("UI Verify did not accept the new login.");
    expect(ended).toEqual(["rejected"]);
  });

  /** Catches AuthKit refusing an approved login's renewal being reported as UI Verify's refusal. */
  it("reports refresh_refused when AuthKit refuses the renewal before UI Verify was asked", async () => {
    await seed({ active: active({ confirmedAt: null, expiresAt: clock.t - 1 }) });
    auth.refreshes.push(oauthError("invalid_grant"));
    await expect(runLogin(loginDeps())).rejects.toThrow("UI Verify did not accept the new login.");
    expect(auth.sessionPosts).toBe(0);
    expect(ended).toEqual(["refresh_refused"]);
  });

  /** Catches the funnel's endings going unreported: each is sent once, by the run that ended it. */
  it("reports a denied code, and a code already used that no other run signed in with", async () => {
    auth.devicePolls.push(oauthError("access_denied"));
    await expect(runLogin(loginDeps({ isTTY: true }))).rejects.toThrow("denied in the browser");
    auth.devicePolls.push(oauthError("invalid_grant"));
    await expect(runLogin(loginDeps({ isTTY: true }))).rejects.toThrow("no longer valid");
    expect(ended).toEqual(["denied", "code_used"]);
  });

  /** Catches two runs on one code counting its ending twice: only the run whose write cleared it reports. */
  it("doesn't report a code another run already cleared", async () => {
    await seed({ pending: pendingCode() });
    auth.devicePolls.push(async () => {
      store.write(withEntry(store.read(), KEY, {}));
      return oauthError("access_denied");
    });
    await expect(runLogin(loginDeps({ isTTY: true }))).rejects.toThrow("denied in the browser");
    expect(ended).toEqual([]);
  });

  /** Catches the agent's most common ending (it came back after the code died) going unreported, or a run
   *  reporting its own wait. */
  it("reports a stored code that died unwatched once, then waits on a new code without reporting it", async () => {
    await seed({ pending: pendingCode({ expiresAt: clock.t - 1 }) });
    expect(await runLogin(loginDeps({ canOpenBrowser: false }))).toBe("waiting");
    expect(entry()?.pending?.deviceCode).toBe("device-code-secret-1");
    expect(await runLogin(loginDeps({ canOpenBrowser: false }))).toBe("waiting");
    expect(ended).toEqual(["expired_unwatched"]);
  });

  /** Catches two reruns that both found the dead code each reporting it: the one whose write found it already
   *  replaced by a peer's live code adopts that code and reports nothing. */
  it("reports nothing for a dead code a peer already replaced while this run asked for its own", async () => {
    await seed({ pending: pendingCode({ expiresAt: clock.t - 1 }) });
    const fetch = auth.fetch;
    const deps = loginDeps({
      canOpenBrowser: false,
      fetch: async (input, init) => {
        if (String(input) === DEVICE_EP) store.write(withEntry(store.read(), KEY, { pending: pendingCode({ deviceCode: "device-code-peer" }) }));
        return fetch(input, init);
      },
    });
    expect(await runLogin(deps)).toBe("waiting");
    expect(entry()?.pending?.deviceCode).toBe("device-code-peer");
    expect(ended).toEqual([]);
  });

  /** Catches a confirmation's loser reporting an ending it didn't cause: another run removed the approval while
   *  this one was being refused, so this run's drop wrote nothing. */
  it("reports nothing when the approval it was confirming is gone before it could drop it", async () => {
    await seed({ active: active({ confirmedAt: null }) });
    auth.session = () => {
      store.write(withEntry(store.read(), KEY, {}));
      return { status: 401, body: { error: "invalid" } };
    };
    await expect(runLogin(loginDeps())).rejects.toThrow();
    expect(ended).toEqual([]);
  });

  /** Catches a report for a stored code the run failed to remove, which the next run would report again. */
  it("reports nothing when the write that would remove the dead code fails", async () => {
    await seed({ pending: pendingCode({ expiresAt: clock.t - 1 }) });
    const failing: CredentialStore = {
      ...store,
      write: () => {
        throw new Error("keychain write failed");
      },
    };
    await expect(runLogin(loginDeps({ store: failing, canOpenBrowser: false }))).rejects.toThrow("keychain write failed");
    expect(ended).toEqual([]);
  });

  /** Catches a start the server counted ending with no outcome when AuthKit won't create a code. */
  it("reports start_failed when AuthKit refuses to create a code after the config arrived", async () => {
    const fetch = auth.fetch;
    const deps = loginDeps({
      fetch: async (input, init) =>
        String(input) === DEVICE_EP ? new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 }) : fetch(input, init),
    });
    await expect(runLogin(deps)).rejects.toThrow("device authorization -> 400");
    expect(ended).toEqual(["start_failed"]);
  });

  /** Catches the login funnel losing its per-CLI split: the config fetch and the confirmation carry the headers. */
  it("sends the client headers on the login config and the confirming POST only", async () => {
    auth.devicePolls.push(issued(1));
    const clientHeaders = { "x-uiverify-cli-version": "1.9.0", "x-uiverify-ci": "0", "x-uiverify-tty": "1" };
    expect(await runLogin(loginDeps({ isTTY: true, clientHeaders }))).toBe("signed-in");
    const versionOn = auth.calls.filter((c) => c.headers.get("x-uiverify-cli-version") === "1.9.0").map((c) => `${c.method} ${c.url}`);
    expect(versionOn).toEqual([`GET ${API}/api/cli/login`, `POST ${API}/api/cli/session`]);
    expect(ended).toEqual([]);
  });

  /** Would catch: a dead credentials file blocking login forever, or being overwritten instead of kept. */
  it("moves a credentials file it can never read aside and signs in afresh", async () => {
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    fs.writeFileSync(store.file, "{broken");
    auth.devicePolls.push(issued(1));
    expect(await runLogin(loginDeps({ isTTY: true }))).toBe("signed-in");
    const aside = fs.readdirSync(path.dirname(store.file)).find((f) => f.startsWith("credentials.json.unreadable-"));
    expect(aside && fs.readFileSync(path.join(path.dirname(store.file), aside), "utf8")).toBe("{broken");
  });

  /** Would catch: a shell that can't get the keychain key (a sandboxed agent, after a login at the person's
   *  own terminal) left with no way to sign in except an API key; or that store deleted. */
  it("moves a store sealed with a key this shell can't get aside, keeping it, and signs in afresh", async () => {
    const keys = fakeKeyStore();
    const sealed = credentialStore(store.file, keys);
    await sealed.withLock(async () => sealed.write(withEntry(sealed.read(), KEY, { active: active() }), { seal: true }));
    const before = fs.readFileSync(store.file, "utf8");
    keys.held.clear();
    auth.devicePolls.push(issued(1));
    expect(await runLogin(loginDeps({ store: credentialStore(store.file, keys), isTTY: true }))).toBe("signed-in");
    const aside = fs.readdirSync(path.dirname(store.file)).find((f) => f.startsWith("credentials.json.unreadable-"));
    expect(aside && fs.readFileSync(path.join(path.dirname(store.file), aside), "utf8")).toBe(before);
    expect(lines.some((l) => l.includes("rename it back to use it again"))).toBe(true);
  });

  /** Would catch: a notice that promises a fix will seal later logins when only a login into an empty store
   *  seals, or reseal steps whose `logout` would delete a sealed store set aside (by this run or an earlier one). */
  it("gives the reseal steps for a fixable key store, except while a sealed store is set aside", async () => {
    const missingTool = () =>
      Object.assign(fakeKeyStore(), { create: () => ({ kind: "unavailable" as const, reason: "secret-tool wasn't found", reseal: "Install it, then log out and in." }) });
    auth.devicePolls.push(issued(1));
    expect(await runLogin(loginDeps({ store: credentialStore(store.file, missingTool()), isTTY: true }))).toBe("signed-in");
    expect(lines.filter((l) => l.startsWith("Storing this login unencrypted"))).toEqual([
      "Storing this login unencrypted, readable only by you: this shell can't use your keyring (secret-tool wasn't found). Install it, then log out and in.",
    ]);

    fs.rmSync(store.file);
    lines.length = 0;
    const keys = fakeKeyStore();
    const sealed = credentialStore(store.file, keys);
    await sealed.withLock(async () => sealed.write(withEntry(sealed.read(), KEY, { active: active() }), { seal: true }));
    const unreadable = Object.assign(missingTool(), { read: () => ({ kind: "unavailable" as const, reason: "secret-tool wasn't found" }) });
    auth.devicePolls.push(issued(1));
    expect(await runLogin(loginDeps({ store: credentialStore(store.file, unreadable), isTTY: true }))).toBe("signed-in");
    expect(lines.some((l) => l.includes("rename it back to use it again"))).toBe(true);
    expect(lines.filter((l) => l.startsWith("Storing this login unencrypted"))).toEqual([
      "Storing this login unencrypted, readable only by you: this shell can't use your keyring (secret-tool wasn't found).",
    ]);

    // A later run into an empty store, with that file still set aside, gives no steps either.
    fs.rmSync(store.file);
    lines.length = 0;
    auth.devicePolls.push(issued(1));
    expect(await runLogin(loginDeps({ store: credentialStore(store.file, missingTool()), isTTY: true }))).toBe("signed-in");
    expect(lines.filter((l) => l.startsWith("Storing this login unencrypted"))).toEqual([
      "Storing this login unencrypted, readable only by you: this shell can't use your keyring (secret-tool wasn't found).",
    ]);
  });

  /** Would catch: a config dir synced between two systems that both seal (a Mac and a Linux desktop) never
   *  settling: each `login` sealing the shared file under its own key store, signing the other machine out. */
  it("replaces a store sealed by another system's key store with a plain one", async () => {
    const mac = fakeKeyStore("keychain");
    const sealed = credentialStore(store.file, mac);
    await sealed.withLock(async () => sealed.write(withEntry(sealed.read(), KEY, { active: active() }), { seal: true }));
    const linux = fakeKeyStore();
    auth.devicePolls.push(issued(1));
    expect(await runLogin(loginDeps({ store: credentialStore(store.file, linux), isTTY: true }))).toBe("signed-in");
    expect(fs.readFileSync(store.file, "utf8")).toContain("refresh-token-1");
    expect(linux.creates).toBe(0);
    expect(lines.some((l) => l.startsWith("Storing this login unencrypted"))).toBe(false);
    expect(lines.some((l) => l.includes("The new login is stored unencrypted, readable by any shell or machine that shares this folder."))).toBe(true);
    expect(credentialStore(store.file, mac).read().logins[KEY]?.active).toBeDefined();
  });

  /** Would catch: an unlock dialog the person missed letting `login` set a good sealed store aside. */
  it("leaves a sealed store alone when the keychain only timed out", async () => {
    const keys = fakeKeyStore();
    const sealed = credentialStore(store.file, keys);
    await sealed.withLock(async () => sealed.write(withEntry(sealed.read(), KEY, { active: active() }), { seal: true }));
    const before = fs.readFileSync(store.file, "utf8");
    const timedOut = Object.assign(fakeKeyStore(), { timedOut: true });
    await expect(runLogin(loginDeps({ store: credentialStore(store.file, timedOut) }))).rejects.toThrow("no answer");
    expect(fs.readFileSync(store.file, "utf8")).toBe(before);
    expect(fs.readdirSync(path.dirname(store.file)).some((f) => f.includes("unreadable"))).toBe(false);
  });

  /** Would catch: a login silently stored unencrypted for good where the OS keeps a key, or the notice not
   *  saying why (the reason is what tells a Linux user to install secret-tool). */
  it("says when a login has to be stored unencrypted, and why", async () => {
    const noKeychain = Object.assign(fakeKeyStore(), { locked: true });
    auth.devicePolls.push(issued(1));
    expect(await runLogin(loginDeps({ store: credentialStore(store.file, noKeychain), isTTY: true }))).toBe("signed-in");
    expect(lines.filter((l) => l.startsWith("Storing this login unencrypted"))).toEqual([
      "Storing this login unencrypted, readable only by you: this shell can't use your keyring (User interaction is not allowed.).",
    ]);
  });

  /** Would catch: an unlock dialog nobody answered turning the first login into a plain store for good, where
   *  the key store reports the timeout as one (macOS, Windows). */
  it("fails a first login whose keychain timed out, storing nothing", async () => {
    const timedOut = Object.assign(fakeKeyStore(), { timedOut: true });
    await expect(runLogin(loginDeps({ store: credentialStore(store.file, timedOut) }))).rejects.toThrow("didn't answer in time");
    expect(fs.existsSync(store.file)).toBe(false);
  });

  /** Would catch: the "unencrypted" notice shown for a store kept plain on purpose (it already held a login). */
  it("doesn't call a store kept plain on purpose unencrypted-by-failure", async () => {
    const keys = fakeKeyStore();
    await seed({ active: active({ expiresAt: clock.t - 1 }) });
    auth.refreshes.push(oauthError("invalid_grant"));
    auth.devicePolls.push(issued(1));
    expect(await runLogin(loginDeps({ store: credentialStore(store.file, keys), isTTY: true }))).toBe("signed-in");
    expect(lines.some((l) => l.startsWith("Storing this login unencrypted"))).toBe(false);
  });

  it("leaves a newer uiverify's store alone", async () => {
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    fs.writeFileSync(store.file, JSON.stringify({ version: 2 }));
    await expect(runLogin(loginDeps())).rejects.toThrow("written by a newer uiverify");
    expect(fs.readFileSync(store.file, "utf8")).toBe(JSON.stringify({ version: 2 }));
  });

  it("names the server it couldn't reach, and one that has no login route", async () => {
    // `withRetry` backs off on real timers between its attempts.
    vi.useFakeTimers();
    try {
      const failing = runLogin(loginDeps({ fetch: async () => { throw new TypeError("fetch failed"); } }));
      const settled = expect(failing).rejects.toThrow(`could not reach UI Verify at ${API}`);
      await vi.runAllTimersAsync();
      await settled;
    } finally {
      vi.useRealTimers();
    }
    await expect(runLogin(loginDeps({ fetch: async () => new Response("", { status: 404 }) }))).rejects.toThrow(
      "doesn't support `uiverify login`; set UIVERIFY_API_KEY instead.",
    );
    // No config, so UI Verify counted no start: reporting an ending here would outnumber the starts.
    expect(ended).toEqual([]);
  });
});

describe("loginAccessToken", () => {
  it("uses the stored token while it has more than a minute left", async () => {
    await seed({ active: active({ expiresAt: clock.t + 61_000 }) });
    expect(await loginAccessToken(store, KEY, authDeps())).toBe("access-token-0");
    expect(auth.refreshCalls).toBe(0);
  });

  /** Would catch: keeping the old refresh token, which AuthKit invalidated by rotating it, or a renewal
   *  that loses the login's approval stamp. */
  it("renews inside the last minute and stores the rotated refresh token, keeping the approval", async () => {
    await seed({ active: active({ expiresAt: clock.t + 59_000 }) });
    auth.refreshes.push(issued(1));
    expect(await loginAccessToken(store, KEY, authDeps())).toBe("access-token-1");
    const refresh = auth.calls.find((c) => c.form.get("grant_type") === "refresh_token");
    expect(refresh?.form.get("refresh_token")).toBe("refresh-token-0");
    expect(refresh?.form.get("client_id")).toBe("client_cli");
    expect(entry()?.active).toMatchObject({ accessToken: "access-token-1", refreshToken: "refresh-token-1", storedAt: active().storedAt, confirmedAt: active().confirmedAt });
  });

  /** Would catch: parallel uploads each spending the same rotating refresh token (all but one then die). */
  it("renews once when two processes race, and both get the new token", async () => {
    await seed({ active: active({ expiresAt: clock.t - 1 }) });
    auth.refreshes.push(async () => {
      await new Promise((r) => setTimeout(r, 100));
      return issued(1);
    });
    const other = credentialStore(store.file, null);
    const [a, b] = await Promise.all([loginAccessToken(store, KEY, authDeps()), loginAccessToken(other, KEY, authDeps())]);
    expect([a, b]).toEqual(["access-token-1", "access-token-1"]);
    expect(auth.refreshCalls).toBe(1);
  });

  /** Would catch: a renewal resurrecting a login that `logout` removed while it waited for the lock. */
  it("writes nothing back when the login was removed while it waited for the lock", async () => {
    await seed({ active: active({ expiresAt: clock.t - 1 }) });
    let release = (): void => {};
    const logout = store.withLock(async () => {
      await new Promise<void>((r) => (release = r));
      store.write(withEntry(store.read(), KEY, {}));
    });
    const renewing = loginAccessToken(credentialStore(store.file, null), KEY, authDeps());
    await new Promise((r) => setTimeout(r, 100));
    release();
    await logout;
    await expect(renewing).rejects.toBeInstanceOf(LoginGoneError);
    expect(auth.refreshCalls).toBe(0);
    expect(entry()).toBeUndefined();
  });

  /** Would catch: a holder suspended past the 30s stale-lock window writing its older tokens over the ones
   *  the process that stole the lock stored meanwhile. */
  it("keeps tokens another process stored while this one's refresh was in flight", async () => {
    await seed({ active: active({ expiresAt: clock.t - 1 }) });
    auth.refreshes.push(async () => {
      store.write(withEntry(store.read(), KEY, { active: active({ accessToken: "access-token-other", refreshToken: "refresh-token-other" }) }));
      return issued(1);
    });
    expect(await loginAccessToken(store, KEY, authDeps())).toBe("access-token-other");
    expect(entry()?.active).toMatchObject({ accessToken: "access-token-other", refreshToken: "refresh-token-other" });
  });

  it("writes nothing back when the login was removed during a successful refresh", async () => {
    await seed({ active: active({ expiresAt: clock.t - 1 }) });
    auth.refreshes.push(async () => {
      store.write(withEntry(store.read(), KEY, {}));
      return issued(1);
    });
    await expect(loginAccessToken(store, KEY, authDeps())).rejects.toBeInstanceOf(LoginGoneError);
    expect(entry()).toBeUndefined();
  });

  it("says to sign in again when the refresh token is refused, leaving the entry for the next login", async () => {
    await seed({ active: active({ expiresAt: clock.t - 1 }) });
    auth.refreshes.push(oauthError("invalid_grant"));
    await expect(loginAccessToken(store, KEY, authDeps())).rejects.toThrow(NOT_SIGNED_IN);
    expect(entry()?.active?.refreshToken).toBe("refresh-token-0");
  });

  /** Holds the lock through the refresh until `release`, aging the lock file past the 30s stale window
   *  meanwhile, as when the holder is suspended: the next process steals it. */
  function suspendedRefresh(reply: Reply) {
    let release = (): void => {};
    auth.refreshes.push(async () => {
      const old = new Date(Date.now() - 31_000);
      fs.utimesSync(`${store.file}.lock`, old, old);
      await new Promise<void>((r) => (release = r));
      return reply;
    });
    return () => release();
  }

  /** Would catch: a holder whose refresh lost the race to the process that stole its lock reporting
   *  "not signed in" while a valid login is stored. */
  it("adopts the stored login when its own refresh lost to a process that stole the lock", async () => {
    await seed({ active: active({ expiresAt: clock.t - 1 }) });
    const resume = suspendedRefresh(oauthError("invalid_grant"));
    auth.refreshes.push(issued(1));
    const suspended = loginAccessToken(store, KEY, authDeps());
    await new Promise((r) => setTimeout(r, 50));
    expect(await loginAccessToken(credentialStore(store.file, null), KEY, authDeps())).toBe("access-token-1");
    resume();
    expect(await suspended).toBe("access-token-1");
  });

  /** Would catch: an adopted login handed out with the expiry of the login it replaced, so the failure report
   *  would treat the adopted token as expired and go without it. */
  it("hands out the adopted login's own expiry", async () => {
    await seed({ active: active({ expiresAt: clock.t - 1 }) });
    const resume = suspendedRefresh(oauthError("invalid_grant"));
    auth.refreshes.push(issued(1));
    const suspended = loginToken(store, KEY, authDeps());
    await new Promise((r) => setTimeout(r, 50));
    const adopted = await loginToken(credentialStore(store.file, null), KEY, authDeps());
    resume();
    expect(await suspended).toEqual(adopted);
    expect(adopted.expiresAt).toBe(store.read().logins[KEY]?.active?.expiresAt);
    expect(adopted.expiresAt).toBeGreaterThan(clock.t);
  });

  /** Would catch: the process that stole the lock deleting the entry on its invalid_grant, so the holder
   *  that won the refresh finds nothing and throws away the only valid rotated tokens. */
  it("keeps the renewal of a suspended holder that won, when the lock-stealer's refresh was refused", async () => {
    await seed({ active: active({ expiresAt: clock.t - 1 }) });
    const resume = suspendedRefresh(issued(1));
    auth.refreshes.push(oauthError("invalid_grant"));
    const suspended = loginAccessToken(store, KEY, authDeps());
    await new Promise((r) => setTimeout(r, 50));
    await expect(loginAccessToken(credentialStore(store.file, null), KEY, authDeps())).rejects.toThrow(NOT_SIGNED_IN);
    resume();
    expect(await suspended).toBe("access-token-1");
    expect(entry()?.active).toMatchObject({ accessToken: "access-token-1", refreshToken: "refresh-token-1" });
  });

  it("keeps using a still-valid token when renewal fails for another reason, and fails an expired one", async () => {
    await seed({ active: active({ expiresAt: clock.t + 30_000 }) });
    auth.refreshes.push({ status: 500, body: "down" });
    expect(await loginAccessToken(store, KEY, authDeps())).toBe("access-token-0");
    await seed({ active: active({ expiresAt: clock.t - 1 }) });
    auth.refreshes.push(async () => {
      throw new Error("socket hang up");
    });
    await expect(loginAccessToken(store, KEY, authDeps())).rejects.toThrow("could not renew your UI Verify login (socket hang up)");
  });

  /** Would catch: a 401 (clock behind the server) never renewing because the token "isn't expired yet". */
  it("renews past a rejected token even when it hasn't expired, unless another process already did", async () => {
    await seed({ active: active() });
    auth.refreshes.push(issued(1));
    expect(await loginAccessToken(store, KEY, authDeps(), "access-token-0")).toBe("access-token-1");
    expect(await loginAccessToken(store, KEY, authDeps(), "access-token-0")).toBe("access-token-1");
    expect(auth.refreshCalls).toBe(1);
  });

  it("treats a pending-only entry as signed out", async () => {
    await seed({ pending: pendingCode() });
    await expect(loginAccessToken(store, KEY, authDeps())).rejects.toThrow(NOT_SIGNED_IN);
  });
});

describe("runWhoami / runLogout", () => {
  const whoami = () => runWhoami({ ...authDeps(), apiUrl: API, store, log: (m) => lines.push(m) });

  it("whoami prints the confirmed session, renewing once on a 401", async () => {
    await seed({ active: active() });
    const replies: Reply[] = [{ status: 401, body: { error: "expired" } }, ok(SESSION)];
    auth.session = () => replies.shift() ?? ok(SESSION);
    auth.refreshes.push(issued(1));
    await whoami();
    expect(lines).toEqual(["Signed in as dev@acme.test (Dev).", "Teams: acme."]);
  });

  /** Would catch: someone with a key exported reading "Signed in as" and assuming uploads go out as them. */
  it("whoami says when a key in the shell takes precedence over the login", async () => {
    await seed({ active: active() });
    vi.stubEnv("UIVERIFY_API_KEY", "uv_proj_key123456");
    try {
      await whoami();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(lines.at(-1)).toBe("UIVERIFY_API_KEY is set in this shell, so uploads from it use the key, not this login.");
  });

  /** Would catch: an approved-but-unconfirmed login reported as signed in. */
  it("whoami fails when not signed in, or when the sign-in isn't finished", async () => {
    await expect(whoami()).rejects.toThrow("Not signed in. Run npx uiverify login.");
    await seed({ active: active({ confirmedAt: null }) });
    await expect(whoami()).rejects.toThrow(NOT_FINISHED);
  });

  it("whoami passes on the server's 403 message", async () => {
    await seed({ active: active() });
    auth.session = () => notSetUp();
    await expect(whoami()).rejects.toThrow("still being set up");
  });

  it("logout removes only this API URL's login, including a pending code", async () => {
    await seed({ active: active(), pending: pendingCode() });
    await store.withLock(async () => store.write(withEntry(store.read(), "https://uiverify.ai", { active: active() })));
    await runLogout({ apiUrl: API, store, log: (m) => lines.push(m) });
    expect(entry()).toBeUndefined();
    expect(store.read().logins["https://uiverify.ai"]).toBeDefined();
    await runLogout({ apiUrl: API, store, log: (m) => lines.push(m) });
    expect(lines).toEqual([`Signed out of ${KEY}.`, `Not signed in to ${KEY}.`]);
  });

  /** Would catch: `logout` over SSH (keychain gives no key) leaving a renewable sealed login on disk. */
  it("logout deletes a sealed store this shell gets no key for, saying so", async () => {
    const keys = fakeKeyStore();
    const sealed = credentialStore(store.file, keys);
    await sealed.withLock(async () => sealed.write(withEntry(sealed.read(), KEY, { active: active() }), { seal: true }));
    keys.held.clear();
    await runLogout({ apiUrl: API, store: credentialStore(store.file, keys), log: (m) => lines.push(m) });
    expect(fs.existsSync(store.file)).toBe(false);
    expect(lines[0]).toContain("It held every UI Verify login on this machine");
  });

  /** Would catch: "Signed out" while a login `login` set aside still sits on disk, one rename from use. */
  it("logout deletes the login files set aside earlier, saying so", async () => {
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    fs.writeFileSync(`${store.file}.unreadable-123`, "{}");
    await runLogout({ apiUrl: API, store, log: (m) => lines.push(m) });
    expect(fs.existsSync(`${store.file}.unreadable-123`)).toBe(false);
    expect(lines.at(-1)).toContain("Also deleted 1 login file(s) set aside earlier");
  });

  /** Would catch: `logout` keeping a renewable login on disk (moved aside) when the file can't be read. */
  it("logout deletes a credentials file it can never read, saying so", async () => {
    fs.mkdirSync(path.dirname(store.file), { recursive: true });
    fs.writeFileSync(store.file, "{broken");
    await runLogout({ apiUrl: API, store, log: (m) => lines.push(m) });
    expect(fs.readdirSync(path.dirname(store.file)).filter((f) => f.startsWith("credentials.json"))).toEqual([]);
    expect(lines[0]).toContain("It held every UI Verify login on this machine");
  });
});

describe("shouldOpenBrowser", () => {
  it("opens one locally, never in CI or over SSH, and on Linux only with a display", () => {
    expect(shouldOpenBrowser({}, "darwin", false)).toBe(true);
    expect(shouldOpenBrowser({}, "darwin", true)).toBe(false);
    expect(shouldOpenBrowser({ SSH_CONNECTION: "1.2.3.4 1 5.6.7.8 22" }, "darwin", false)).toBe(false);
    expect(shouldOpenBrowser({}, "linux", false)).toBe(false);
    expect(shouldOpenBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux", false)).toBe(true);
  });
});
