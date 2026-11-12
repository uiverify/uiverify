import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { credentialStore, withEntry } from "./credentials";

/**
 * The real CLI, run as a process against a local server standing in for UI Verify: the report has to arrive
 * from the detached sender, carry nothing it shouldn't, and never hold the command up.
 */

const BIN = path.resolve(__dirname, "../bin/uiverify.ts");
const KEY = "uv_proj_e2etestkey0000000000";

interface Received {
  url: string;
  authorization: string | undefined;
  body: string;
}

function recordingServer(opts: { answer: boolean }): Promise<{ url: string; received: Received[]; close: () => void }> {
  const received: Received[] = [];
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push({ url: req.url ?? "", authorization: req.headers.authorization, body });
      if (opts.answer) res.writeHead(202, { "content-type": "application/json" }).end("{}");
      else open.add(res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address !== null && typeof address === "object" ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        received,
        close: () => {
          for (const res of open) res.destroy();
          server.close();
        },
      });
    });
  });
}

// An empty config dir, so a login stored on the machine running the tests is never read.
const CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-e2e-config-"));

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; ms: number; stderr: string }> {
  const started = Date.now();
  const child = spawn(process.execPath, ["--import", "tsx", BIN, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: os.homedir(), XDG_CONFIG_HOME: CONFIG_HOME, ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, ms: Date.now() - started, stderr })));
}

async function waitFor(check: () => boolean, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
}

describe("failure report, end to end", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  /** A git checkout with one commit and no capture output, so the run gets past git and fails at capture. */
  function repo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiv-e2e-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("commit", "-q", "--allow-empty", "-m", "init");
    return dir;
  }

  it("sends one report for a missing capture dir: key in the header only, no path outside the repo", async () => {
    const server = await recordingServer({ answer: true });
    cleanups.push(server.close);
    const cwd = repo();
    const res = await runCli(["upload", "--static-dir", "storybook-static", "--working-directory", cwd], {
      UIVERIFY_API_KEY: KEY,
      UIVERIFY_API_URL: server.url,
      COMMIT_SHA: "a".repeat(40),
      BRANCH: "main",
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("Reporting this failure to UI Verify");

    await waitFor(() => server.received.length > 0, 10_000);
    expect(server.received).toHaveLength(1);
    const [got] = server.received;
    expect(got?.url).toBe("/api/ingest/failure-report");
    expect(got?.authorization).toBe(`Bearer ${KEY}`);
    expect(got?.body).not.toContain(KEY);
    expect(got?.body).not.toContain(cwd);
    expect(got?.body).not.toContain(os.homedir());
    const keyed = JSON.parse(got?.body ?? "{}");
    for (const field of ["project", "repoFullName", "upstreamRepoFullName"]) expect(keyed).not.toHaveProperty(field);
    expect(keyed).toMatchObject({
      command: "upload",
      credential: "key",
      stage: "capture",
      errorClass: "missing_dir",
      framework: "unknown",
      os: process.platform,
      arch: process.arch,
      ci: false,
    });
  });

  /** Catches the report holding the command up (or changing its exit code) when our endpoint hangs. */
  it("exits as fast and with the same code when the endpoint never answers", async () => {
    const server = await recordingServer({ answer: false });
    cleanups.push(server.close);
    const args = ["upload", "--static-dir", "storybook-static", "--working-directory", repo()];
    const base = { UIVERIFY_API_KEY: KEY, UIVERIFY_API_URL: server.url, COMMIT_SHA: "a".repeat(40), BRANCH: "main" };
    const off = await runCli(args, { ...base, UIVERIFY_TELEMETRY: "0" });
    const on = await runCli(args, base);
    expect(on.code).toBe(off.code);
    expect(on.ms - off.ms).toBeLessThan(1500);
    await waitFor(() => server.received.length > 0, 10_000);
    expect(server.received).toHaveLength(1);
  });

  it("sends nothing with UIVERIFY_TELEMETRY=0", async () => {
    const server = await recordingServer({ answer: true });
    cleanups.push(server.close);
    const res = await runCli(["upload", "--static-dir", "storybook-static", "--working-directory", repo()], {
      UIVERIFY_API_KEY: KEY,
      UIVERIFY_API_URL: server.url,
      UIVERIFY_TELEMETRY: "0",
      COMMIT_SHA: "a".repeat(40),
      BRANCH: "main",
    });
    expect(res.code).toBe(1);
    expect(res.stderr).not.toContain("Reporting this failure");
    await new Promise((r) => setTimeout(r, 1500));
    expect(server.received).toHaveLength(0);
  });

  it("reports a missing key under auth, without an Authorization header", async () => {
    const server = await recordingServer({ answer: true });
    cleanups.push(server.close);
    const res = await runCli(["upload", "--static-dir", "storybook-static", "--working-directory", repo()], { UIVERIFY_API_URL: server.url });
    expect(res.code).toBe(1);
    await waitFor(() => server.received.length > 0, 10_000);
    expect(server.received[0]?.authorization).toBeUndefined();
    const anonymous = JSON.parse(server.received[0]?.body ?? "{}");
    expect(anonymous).toMatchObject({ stage: "auth", errorClass: "missing_key", credential: "none" });
    for (const field of ["project", "repoFullName", "upstreamRepoFullName"]) expect(anonymous).not.toHaveProperty(field);
  });

  /** Catches reporting changing an exit code: 2 for a malformed command line, 0 under --no-strict. */
  it("keeps exit 2 for a bad option and exit 0 under --no-strict, reporting each once", async () => {
    const server = await recordingServer({ answer: true });
    cleanups.push(server.close);
    const env = { UIVERIFY_API_KEY: KEY, UIVERIFY_API_URL: server.url, COMMIT_SHA: "a".repeat(40), BRANCH: "main" };
    const bad = await runCli(["upload", "--static-dir", "sb", "--colour", "--working-directory", repo()], env);
    expect(bad.code).toBe(2);
    await waitFor(() => server.received.length > 0, 10_000);
    const lenient = await runCli(["upload", "--static-dir", "storybook-static", "--no-strict", "--working-directory", repo()], env);
    expect(lenient.code).toBe(0);
    await waitFor(() => server.received.length > 1, 10_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(server.received[0]?.authorization).toBe(`Bearer ${KEY}`);
    expect(server.received.map((r) => JSON.parse(r.body))).toMatchObject([
      { stage: "invocation", errorClass: "invalid_args", credential: "key" },
      { stage: "capture", errorClass: "missing_dir" },
    ]);
  });

  /** Catches the report's git lookup printing git's own error into the user's output. */
  it("adds no git error to the output outside a git checkout", async () => {
    const server = await recordingServer({ answer: true });
    cleanups.push(server.close);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiv-nogit-"));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const res = await runCli(["upload", "--static-dir", "sb", "--working-directory", dir], { UIVERIFY_API_URL: server.url });
    expect(res.stderr).toContain("Not signed in. Run npx uiverify login, or set UIVERIFY_API_KEY.");
    expect(res.stderr).not.toContain("fatal:");
  });

  it("doesn't report a bare `uiverify` or a version check", async () => {
    const server = await recordingServer({ answer: true });
    cleanups.push(server.close);
    for (const args of [[], ["--version"]]) {
      const res = await runCli(args, { UIVERIFY_API_KEY: KEY, UIVERIFY_API_URL: server.url });
      expect(res.code).toBe(2);
    }
    await new Promise((r) => setTimeout(r, 1500));
    expect(server.received).toHaveLength(0);
  });
});

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}

interface FakeOptions {
  token?: "ok" | "unavailable";
  register?: "ok" | "unauthorized";
  markUploaded?: "ok" | "bad_request";
}

/** UI Verify and AuthKit in one local server, for a signed-in run. */
function fakeUiVerify(opts: FakeOptions = {}): Promise<{ url: string; seen: Seen[]; reports: () => Seen[]; tokenHits: () => number; close: () => void }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const url = req.url ?? "";
      seen.push({ method: req.method ?? "", url, authorization: req.headers.authorization, body });
      const json = (status: number, value: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
      const base = `http://127.0.0.1:${port()}`;
      if (url === "/oauth2/token") {
        if (opts.token === "unavailable") return json(503, {});
        return json(200, { access_token: "access-token-e2e-2", refresh_token: "refresh-token-e2e-2", expires_in: 3600 });
      }
      if (url === "/api/ingest/build") {
        if (opts.register === "unauthorized") return json(401, { error: "invalid token" });
        return json(200, { buildId: "b1", uploadUrl: `${base}/upload/b1`, project: { id: "proj_1", team: "acme", slug: "web", created: false } });
      }
      if (url === "/upload/b1") return res.writeHead(200).end();
      if (url === "/api/ingest/build/b1/uploaded") {
        if (opts.markUploaded === "bad_request") return json(400, { error: "no project acme/web; your teams: acme (web, docs), beta (app)" });
        return json(200, {});
      }
      if (url === "/api/ingest/build/b1") return json(200, { status: "passed", processed: 1, total: 1, changed: 0, failed: 0 });
      if (url === "/api/ingest/failure-report") return json(202, {});
      return json(404, { error: `unexpected ${req.method} ${url}` });
    });
  });
  const port = (): number => {
    const a = server.address();
    return a !== null && typeof a === "object" ? a.port : 0;
  };
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${port()}`,
        seen,
        reports: () => seen.filter((s) => s.url === "/api/ingest/failure-report"),
        tokenHits: () => seen.filter((s) => s.url === "/oauth2/token").length,
        close: () => server.close(),
      }),
    ),
  );
}

describe("failure report from a signed-in run, end to end", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function tmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  /** A checkout of acme/web (forked from upstream/web) whose package names `dependencies`, with one screenshot. */
  function repo(devDependencies: Record<string, string> = { storybook: "8" }): string {
    const dir = tmp("uiv-e2e-login-");
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("remote", "add", "origin", "git@github.com:acme/web.git");
    git("remote", "add", "upstream", "https://github.com/upstream/web.git");
    git("commit", "-q", "--allow-empty", "-m", "init");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ devDependencies }));
    fs.mkdirSync(path.join(dir, "shots"));
    fs.writeFileSync(path.join(dir, "shots", "home.png"), Buffer.from("89504e470d0a1a0a", "hex"));
    return dir;
  }

  /** A config dir holding a confirmed login whose access token expires in `expiresIn` ms (negative: expired). */
  async function signedIn(apiUrl: string, expiresIn: number): Promise<string> {
    const config = tmp("uiv-e2e-login-config-");
    const store = credentialStore(path.join(config, "uiverify", "credentials.json"), null);
    const now = Date.now();
    const login = {
      clientId: "client_cli",
      tokenEndpoint: `${apiUrl}/oauth2/token`,
      accessToken: "access-token-e2e-1",
      refreshToken: "refresh-token-e2e-1",
      expiresAt: now + expiresIn,
      confirmedAt: now,
      storedAt: now,
    };
    await store.withLock(async () => store.write(withEntry(store.read(), apiUrl, { active: login })));
    return config;
  }

  async function run(server: { url: string }, args: string[], config: string, extra: Record<string, string> = {}) {
    return runCli(args, { UIVERIFY_API_URL: server.url, XDG_CONFIG_HOME: config, COMMIT_SHA: "a".repeat(40), BRANCH: "main", ...extra });
  }

  async function onlyReport(server: { reports: () => Seen[] }): Promise<{ authorization: string | undefined; body: Record<string, unknown> }> {
    await waitFor(() => server.reports().length > 0, 10_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(server.reports()).toHaveLength(1);
    const [got] = server.reports();
    return { authorization: got?.authorization, body: JSON.parse(got?.body ?? "{}") };
  }

  /** Catches a signed-in report arriving anonymous, or without what the server needs to find the project. */
  it("sends the login's token, the repository and how the framework was found, renewing nothing", async () => {
    const server = await fakeUiVerify();
    cleanups.push(server.close);
    const cwd = repo();
    const res = await run(server, ["upload", "--static-dir", "storybook-static", "--working-directory", cwd], await signedIn(server.url, 3_600_000));
    expect(res.code).toBe(1);
    const { authorization, body } = await onlyReport(server);
    expect(authorization).toBe("Bearer access-token-e2e-1");
    expect(body).toMatchObject({
      stage: "capture",
      errorClass: "missing_dir",
      credential: "login",
      repoFullName: "acme/web",
      upstreamRepoFullName: "upstream/web",
      framework: "storybook",
      frameworkSource: "package",
    });
    expect(body).not.toHaveProperty("project");
    expect(JSON.stringify(body)).not.toContain("access-token");
    expect(server.tokenHits()).toBe(0);
  }, 60_000);

  it("carries the token on a first-run invocation mistake too, with --project", async () => {
    const server = await fakeUiVerify();
    cleanups.push(server.close);
    const res = await run(server, ["upload", "--project", "acme/web", "--working-directory", repo()], await signedIn(server.url, 3_600_000));
    expect(res.code).toBe(1);
    const { authorization, body } = await onlyReport(server);
    expect(authorization).toBe("Bearer access-token-e2e-1");
    expect(body).toMatchObject({ stage: "invocation", errorClass: "invalid_args", credential: "login", project: "acme/web", repoFullName: "acme/web" });
  }, 60_000);

  /** Catches the start renewal missing (an expired stored token would leave the report anonymous) or running twice. */
  it("renews an expired token once, at the start, and sends the renewed one", async () => {
    const server = await fakeUiVerify();
    cleanups.push(server.close);
    const res = await run(server, ["upload", "--static-dir", "storybook-static", "--working-directory", repo()], await signedIn(server.url, -1000));
    expect(res.code).toBe(1);
    const { authorization } = await onlyReport(server);
    expect(authorization).toBe("Bearer access-token-e2e-2");
    expect(server.tokenHits()).toBe(1);
  }, 60_000);

  /** Catches a failed start renewal failing the run itself, or changing the step the person has to fix. */
  it("reports the run's own step with no bearer when the start renewal fails", async () => {
    const server = await fakeUiVerify({ token: "unavailable" });
    cleanups.push(server.close);
    const res = await run(server, ["upload", "--static-dir", "storybook-static", "--working-directory", repo()], await signedIn(server.url, -1000));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("storybook-static");
    const { authorization, body } = await onlyReport(server);
    expect(authorization).toBeUndefined();
    expect(body).toMatchObject({ stage: "capture", errorClass: "missing_dir", credential: "login" });
    for (const field of ["project", "repoFullName", "upstreamRepoFullName"]) expect(body).not.toHaveProperty(field);
    expect(server.tokenHits()).toBe(1);
  }, 60_000);

  it("renews nothing with reports off", async () => {
    const server = await fakeUiVerify();
    cleanups.push(server.close);
    const config = await signedIn(server.url, -1000);
    const res = await run(server, ["upload", "--static-dir", "storybook-static", "--working-directory", repo()], config, { UIVERIFY_TELEMETRY: "0" });
    expect(res.code).toBe(1);
    await new Promise((r) => setTimeout(r, 500));
    expect(server.tokenHits()).toBe(0);
    expect(server.reports()).toHaveLength(0);
  }, 60_000);

  /** Catches a malformed command line waiting on the keychain or a renewal, or claiming a credential it never
   *  looked up. */
  it("exits 2 on a malformed command line before any renewal, claiming no credential", async () => {
    const server = await fakeUiVerify({ token: "unavailable" });
    cleanups.push(server.close);
    const res = await run(server, ["upload", "--static-dir", "sb", "--colour", "--working-directory", repo()], await signedIn(server.url, -1000));
    expect(res.code).toBe(2);
    const { authorization, body } = await onlyReport(server);
    expect(authorization).toBeUndefined();
    expect(body).toMatchObject({ stage: "invocation", errorClass: "invalid_args" });
    expect(body).not.toHaveProperty("credential");
    expect(server.tokenHits()).toBe(0);
  }, 60_000);

  /** Catches register's `team/slug` not reaching a report from a later step, or a refusal's text (which names
   *  other teams' projects) leaving the machine. */
  it("names the project register picked after a later step fails, without the server's text", async () => {
    const server = await fakeUiVerify({ markUploaded: "bad_request" });
    cleanups.push(server.close);
    const res = await run(server, ["upload", "--screenshots", "shots", "--working-directory", repo()], await signedIn(server.url, 3_600_000));
    expect(res.code).toBe(1);
    const { body } = await onlyReport(server);
    expect(body).toMatchObject({ stage: "upload", errorClass: "http_4xx", credential: "login", project: "acme/web", frameworkSource: "capture" });
    expect(String(body.message)).not.toContain("beta");
  }, 60_000);

  /** Catches a token the server refused (twice: the renewed one too) going on the report. */
  it("sends no bearer after register refused the login", async () => {
    const server = await fakeUiVerify({ register: "unauthorized" });
    cleanups.push(server.close);
    const res = await run(server, ["upload", "--screenshots", "shots", "--working-directory", repo()], await signedIn(server.url, 3_600_000));
    expect(res.code).toBe(1);
    const { authorization, body } = await onlyReport(server);
    expect(authorization).toBeUndefined();
    expect(body).toMatchObject({ errorClass: "http_401", credential: "login" });
    for (const field of ["project", "repoFullName", "upstreamRepoFullName"]) expect(body).not.toHaveProperty(field);
    expect(server.tokenHits()).toBe(1);
  }, 60_000);

  /** Catches the start renewal costing a passing run a second refresh-token rotation at register. */
  it("spends one renewal in all on a run that passes", async () => {
    const server = await fakeUiVerify();
    cleanups.push(server.close);
    const res = await run(server, ["upload", "--screenshots", "shots", "--working-directory", repo()], await signedIn(server.url, -1000));
    expect(res.code).toBe(0);
    expect(server.tokenHits()).toBe(1);
    expect(server.seen.find((s) => s.url === "/api/ingest/build")?.authorization).toBe("Bearer access-token-e2e-2");
  }, 60_000);

  /** Catches the signed-in report holding the exit up when its endpoint never answers (a hung git is
   *  git.test.ts's "gives up on a hung git"). */
  it("exits as fast signed in when the endpoint never answers", async () => {
    const server = await recordingServer({ answer: false });
    cleanups.push(server.close);
    const config = await signedIn(server.url, 3_600_000);
    const args = ["upload", "--static-dir", "storybook-static", "--working-directory", repo()];
    const off = await run(server, args, config, { UIVERIFY_TELEMETRY: "0" });
    const on = await run(server, args, config);
    expect(on.code).toBe(off.code);
    expect(on.ms - off.ms).toBeLessThan(1500);
    await waitFor(() => server.received.length > 0, 10_000);
    expect(server.received[0]?.authorization).toBe("Bearer access-token-e2e-1");
    expect(JSON.parse(server.received[0]?.body ?? "{}")).toMatchObject({ repoFullName: "acme/web" });
  }, 60_000);

  it("sends no frameworkSource for a package naming two capture frameworks", async () => {
    const server = await fakeUiVerify();
    cleanups.push(server.close);
    const cwd = repo({ "@storybook/react": "8", "@uiverify/vitest": "1" });
    const res = await run(server, ["upload", "--static-dir", "storybook-static", "--working-directory", cwd], await signedIn(server.url, 3_600_000));
    expect(res.code).toBe(1);
    const { body } = await onlyReport(server);
    expect(body).not.toHaveProperty("frameworkSource");
  }, 60_000);
});
