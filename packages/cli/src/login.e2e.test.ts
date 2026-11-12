import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { credentialStore, withEntry } from "./credentials";

/**
 * The real CLI, run as a process, signed in instead of keyed: `login` → `whoami` → `upload` with no key →
 * `logout`, against one local server standing in for both UI Verify and AuthKit. On macOS and Windows the
 * spawned `login` would seal the store with the developer's real keychain or DPAPI, so there the test seeds
 * the login and skips that step; on Linux the spawned CLI gets no desktop session variables, so it never
 * seals, and vt-cli CI (Ubuntu) runs it whole.
 */

const BIN = path.resolve(__dirname, "../bin/uiverify.ts");
const SESSION = { user: { id: "user_1", email: "dev@acme.test", name: null }, teams: [{ slug: "acme", name: "Acme" }] };
const PROJECT = { id: "proj_1", team: "acme", slug: "web", created: false };

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function fakeUiVerify(
  token: () => { status: number; body: unknown } = () => ({
    status: 200,
    body: { access_token: "access-token-e2e-1", refresh_token: "refresh-token-e2e-1", expires_in: 3600 },
  }),
): Promise<{ url: string; seen: Seen[]; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, authorization: req.headers.authorization, headers: req.headers, body });
      const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const base = `http://127.0.0.1:${port()}`;
      if (url === "/api/cli/login") {
        return json(200, { clientId: "client_cli", deviceAuthorizationEndpoint: `${base}/oauth2/device_authorization`, tokenEndpoint: `${base}/oauth2/token`, scopes: ["openid", "offline_access"] });
      }
      if (url === "/oauth2/device_authorization") {
        return json(200, { device_code: "device-code-e2e-secret", user_code: "ABCD-EFGH", verification_uri: "https://auth.example/device", expires_in: 300, interval: 1 });
      }
      if (url === "/oauth2/token") {
        const reply = token();
        return json(reply.status, reply.body);
      }
      if (url === "/api/cli/session") return json(200, SESSION);
      if (url === "/api/ingest/build") return json(200, { buildId: "b1", uploadUrl: `${base}/upload/b1`, project: PROJECT });
      if (url === "/upload/b1") return res.writeHead(200).end();
      if (url === "/api/ingest/build/b1/uploaded") return json(200, {});
      if (url === "/api/ingest/build/b1") return json(200, { status: "passed", processed: 1, total: 1, changed: 0, failed: 0 });
      if (url === "/api/ingest/failure-report" || url === "/api/cli/login/failure") return json(202, {});
      return json(404, { error: `unexpected ${req.method} ${url}` });
    });
  });
  const port = (): number => {
    const a = server.address();
    return a !== null && typeof a === "object" ? a.port : 0;
  };
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${port()}`, seen, close: () => server.close() })));
}

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", BIN, ...args], {
    // No SSH or display variables: on Linux this makes `login` find no browser to open.
    // `SystemRoot`: a Windows child process without it can't start Node's crypto or sockets.
    env: { PATH: process.env.PATH ?? "", HOME: os.homedir(), ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
}

describe("signed-in CLI, end to end", () => {
  let server: Awaited<ReturnType<typeof fakeUiVerify>>;
  let config: string;
  let repo: string;
  let env: Record<string, string>;

  beforeAll(async () => {
    server = await fakeUiVerify();
    config = fs.mkdtempSync(path.join(os.tmpdir(), "uiv-login-config-"));
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "uiv-login-repo-"));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git("remote", "add", "origin", "git@github.com:acme/web.git");
    git("commit", "-q", "--allow-empty", "-m", "init");
    fs.mkdirSync(path.join(repo, "shots"));
    fs.writeFileSync(path.join(repo, "shots", "home.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    env = { UIVERIFY_API_URL: server.url, XDG_CONFIG_HOME: config, UIVERIFY_TELEMETRY: "0" };
  });
  afterAll(() => {
    server.close();
    fs.rmSync(config, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("signs in, uploads with no key into the project the server picked, and signs out", async () => {
    if (process.platform === "darwin" || process.platform === "win32") {
      const store = credentialStore(path.join(config, "uiverify", "credentials.json"), null);
      const login = { clientId: "client_cli", tokenEndpoint: `${server.url}/oauth2/token`, accessToken: "access-token-e2e-1", refreshToken: "refresh-token-e2e-1", expiresAt: Date.now() + 3_600_000, confirmedAt: Date.now(), storedAt: Date.now() };
      await store.withLock(async () => store.write(withEntry(store.read(), server.url, { active: login })));
    } else {
      // No terminal and no browser: the first run prints the code and exits 1; the rerun waits and finishes.
      const first = await runCli(["login"], env);
      expect(first.code).toBe(1);
      expect(first.stdout).toContain("Code: ABCD-EFGH");
      const second = await runCli(["login"], env);
      expect(second.code).toBe(0);
      expect(second.stdout).toContain("Signed in as dev@acme.test.");
      expect(server.seen.filter((s) => s.url === "/api/cli/session" && s.method === "POST")).toHaveLength(1);
      const stored = fs.readFileSync(path.join(config, "uiverify", "credentials.json"), "utf8");
      expect(fs.statSync(path.join(config, "uiverify", "credentials.json")).mode & 0o777).toBe(0o600);
      expect(stored).toContain("refresh-token-e2e-1");
    }

    const who = await runCli(["whoami"], env);
    expect(who.code).toBe(0);
    expect(who.stdout).toContain("Signed in as dev@acme.test.");

    const upload = await runCli(["upload", "--screenshots", "shots", "--project", "acme/web", "--working-directory", repo], {
      ...env,
      COMMIT_SHA: "a".repeat(40),
      BRANCH: "main",
    });
    expect(upload.stderr).toBe("");
    expect(upload.code).toBe(0);
    expect(upload.stdout).toContain("Project acme/web");
    const register = server.seen.find((s) => s.url === "/api/ingest/build");
    expect(register?.authorization).toBe("Bearer access-token-e2e-1");
    expect(JSON.parse(register?.body ?? "{}")).toMatchObject({ project: "acme/web", captureShape: "screenshots", repoFullName: "acme/web" });
    expect(upload.stdout).not.toContain("access-token-e2e-1");

    const out = await runCli(["logout"], env);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`Signed out of ${server.url}.`);
    expect((await runCli(["whoami"], env)).code).toBe(1);
    const noLogin = await runCli(["upload", "--screenshots", "shots", "--working-directory", repo], { ...env, COMMIT_SHA: "a".repeat(40), BRANCH: "main" });
    expect(noLogin.code).toBe(1);
    expect(noLogin.stderr).toContain("Not signed in. Run npx uiverify login, or set UIVERIFY_API_KEY.");
  }, 120_000);

  it("rejects options on the account commands with exit 2", async () => {
    const res = await runCli(["login", "--api-url", "http://x"], env);
    expect(res.code).toBe(2);
  }, 60_000);
});

/** Polls until `found` holds or `ms` pass: the report goes from a detached child that outlives the CLI. */
async function eventually(found: () => boolean, ms: number): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end && !found(); ) await new Promise((r) => setTimeout(r, 50));
}

describe("a login that ends without signing in, end to end", () => {
  let server: Awaited<ReturnType<typeof fakeUiVerify>>;
  let config: string;

  beforeAll(async () => {
    server = await fakeUiVerify(() => ({ status: 400, body: { error: "access_denied" } }));
  });
  afterAll(() => server.close());

  /** A code this run resumes. Seeded as a plain file, which `login` keeps plain, so no run here touches a real
   *  keychain on macOS. */
  async function seedCode(): Promise<void> {
    config = fs.mkdtempSync(path.join(os.tmpdir(), "uiv-login-ended-"));
    const store = credentialStore(path.join(config, "uiverify", "credentials.json"), null);
    const pending = {
      clientId: "client_cli",
      tokenEndpoint: `${server.url}/oauth2/token`,
      deviceCode: "device-code-e2e-secret",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.example/device",
      expiresAt: Date.now() + 300_000,
      interval: 1,
    };
    await store.withLock(async () => store.write(withEntry(store.read(), server.url, { pending })));
  }
  const failureReports = () => server.seen.filter((s) => s.url === "/api/cli/login/failure");

  /** Catches a denied login going unreported, reported twice (by `runLogin` and again by the command's catch),
   *  carrying a credential, or printing its notice where an agent relays stdout. */
  it("sends exactly one anonymous report for a denied code, with its notice on stderr", async () => {
    await seedCode();
    const res = await runCli(["login"], { UIVERIFY_API_URL: server.url, XDG_CONFIG_HOME: config });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("The login was denied in the browser.");
    expect(res.stderr).toContain("Telling UI Verify how this sign-in ended");
    expect(res.stdout).not.toContain("Telling UI Verify");
    await eventually(() => failureReports().length > 0, 5_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(failureReports()).toHaveLength(1);
    expect(failureReports()[0]?.authorization).toBeUndefined();
    expect(JSON.parse(failureReports()[0]?.body ?? "{}")).toMatchObject({ reason: "denied", tty: false });
    fs.rmSync(config, { recursive: true, force: true });
  }, 60_000);

  /** Catches the real CLI not identifying itself on a new sign-in (the server then counts no start), sending it
   *  with UIVERIFY_TELEMETRY=0, or reporting a run that only ends "still waiting". The store is seeded with another
   *  server's entry so it stays a plain file and no run touches a real keychain on macOS. */
  it.each([
    ["sends", {}],
    ["sends no", { UIVERIFY_TELEMETRY: "0" }],
  ])("%s client headers on a new sign-in, and never reports a still-waiting run", async (_label, extra) => {
    server.seen.length = 0;
    config = fs.mkdtempSync(path.join(os.tmpdir(), "uiv-login-headers-"));
    const store = credentialStore(path.join(config, "uiverify", "credentials.json"), null);
    await store.withLock(async () => store.write(withEntry(store.read(), "https://other.example", {})));
    // An SSH session: no browser opens on any platform, so the run prints the code and exits "still waiting".
    const res = await runCli(["login"], { UIVERIFY_API_URL: server.url, XDG_CONFIG_HOME: config, SSH_TTY: "/dev/ttys000", ...extra });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("Code: ABCD-EFGH");
    expect(res.stdout).toContain("Show this link and code to the person signing in");
    const config_ = server.seen.find((s) => s.url === "/api/cli/login");
    const telemetryOff = "UIVERIFY_TELEMETRY" in extra;
    expect(config_?.headers["x-uiverify-cli-version"]).toEqual(telemetryOff ? undefined : expect.stringMatching(/^\d+\.\d+\.\d+/));
    expect(config_?.headers["x-uiverify-ci"]).toBe(telemetryOff ? undefined : "0");
    expect(config_?.headers["x-uiverify-tty"]).toBe(telemetryOff ? undefined : "0");
    await new Promise((r) => setTimeout(r, 1_500));
    expect(failureReports()).toEqual([]);
    fs.rmSync(config, { recursive: true, force: true });
  }, 60_000);

  /** Catches the real `upload` reporting a sign-in that's still waiting as a missing key: the class resolveCredential
   *  picks has to reach the report. */
  it("reports an upload made while a sign-in code is waiting as login_pending", async () => {
    server.seen.length = 0;
    await seedCode();
    const res = await runCli(["upload", "--screenshots", "shots"], { UIVERIFY_API_URL: server.url, XDG_CONFIG_HOME: config });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Not signed in.");
    const reports = () => server.seen.filter((s) => s.url === "/api/ingest/failure-report");
    await eventually(() => reports().length > 0, 5_000);
    expect(JSON.parse(reports()[0]?.body ?? "{}")).toMatchObject({ stage: "auth", errorClass: "login_pending" });
    fs.rmSync(config, { recursive: true, force: true });
  }, 60_000);

  /** Catches UIVERIFY_TELEMETRY=0 still sending a login report. */
  it("sends no report and prints no notice with UIVERIFY_TELEMETRY=0", async () => {
    server.seen.length = 0;
    await seedCode();
    const res = await runCli(["login"], { UIVERIFY_API_URL: server.url, XDG_CONFIG_HOME: config, UIVERIFY_TELEMETRY: "0" });
    expect(res.code).toBe(1);
    await new Promise((r) => setTimeout(r, 1_500));
    expect(failureReports()).toEqual([]);
    expect(res.stderr).not.toContain("Telling UI Verify");
    fs.rmSync(config, { recursive: true, force: true });
  }, 60_000);
});
