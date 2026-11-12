import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaptureOutputError, createBundle, createScreenshotBundle } from "./bundle";
import { LoginGoneError } from "./login-errors";
import {
  type FailureReport,
  classifyFailure,
  detectFramework,
  reportCredential,
  reportsEnabled,
  sanitizeReportMessage,
  FAILURE_REPORT_PATH,
  LOGIN_ENDED_NOTICE,
  LOGIN_EXPIRED_UNUSED_NOTICE,
  loginClientHeaders,
  loginEndingReporter,
  sendReport,
} from "./failure-report";
import { HttpStatusError } from "./retry";

const posix = { repoRoot: "/work/app", home: "/Users/jane" };

describe("sanitizeReportMessage", () => {
  it("keeps a path inside the repo, made relative", () => {
    expect(sanitizeReportMessage("--static-dir /work/app/storybook-static does not exist", posix)).toBe(
      "--static-dir ./storybook-static does not exist",
    );
  });

  it("doesn't mistake a sibling of the repo for a path inside it", () => {
    expect(sanitizeReportMessage("cannot read /work/app-secret/x.json", posix)).toBe("cannot read <path>");
    expect(sanitizeReportMessage("cannot read /work/app+acme/x", posix)).toBe("cannot read <path>");
    expect(sanitizeReportMessage("nothing to upload in /work/app: no captures", posix)).toBe("nothing to upload in .: no captures");
  });

  it("removes every path outside the repo: absolute, home-relative, climbing out, UNC", () => {
    const text = "a /etc/ssl/certs b ~/clients/acme/x c ../other-repo/dist d \\\\server\\share\\x e";
    expect(sanitizeReportMessage(text, posix)).toBe("a <path> b <path> c <path> d <path> e");
  });

  it("removes a home path with spaces as a whole", () => {
    const ctx = { repoRoot: "/work/app", home: "/Users/Jane Smith" };
    expect(sanitizeReportMessage("open /Users/Jane Smith/Library/Caches/x.tgz", ctx)).toBe("open <path>");
  });

  it("removes a quoted path with spaces as a whole", () => {
    expect(sanitizeReportMessage("EACCES: open '/var/folders/a b/x.tgz' failed", posix)).toBe(
      "EACCES: open '<path>' failed",
    );
  });

  it("handles Windows paths whatever their slashes and drive case", () => {
    const ctx = { repoRoot: "C:/work/app", home: "C:\\Users\\John Doe" };
    const text = "--static-dir c:\\work\\app\\storybook-static is empty; tmp 'C:\\Users\\John Doe\\AppData\\x.tgz'; D:\\data\\y";
    expect(sanitizeReportMessage(text, ctx)).toBe("--static-dir ./storybook-static is empty; tmp '<path>'; <path>");
  });

  /** Catches an agent shell in the home directory turning `~/clients/acme/…` into an in-repo-looking path. */
  it("treats nothing as inside the repo when the repo root is the home directory or above it", () => {
    expect(sanitizeReportMessage("missing /Users/jane/clients/acme/dist", { repoRoot: "/Users/jane", home: "/Users/jane" })).toBe(
      "missing <path>",
    );
    expect(sanitizeReportMessage("missing /Users/jane/clients/acme/dist", { repoRoot: "/", home: "/Users/jane" })).toBe("missing <path>");
  });

  it("masks keys, the exact one and anything shaped like one", () => {
    const out = sanitizeReportMessage("key uv_proj_abcdef123456 and vt_live_zzzzzzzzzz", { ...posix, apiKey: "uv_proj_abcdef123456" });
    expect(out).not.toContain("abcdef123456");
    expect(out).not.toContain("zzzzzzzzzz");
  });

  it("removes any path that climbs with `..`, wherever the climb starts", () => {
    expect(sanitizeReportMessage("open /work/app/../secret-client/x.json", posix)).toBe("open <path>");
    expect(sanitizeReportMessage("open /work/app/sub/../../secret-client/x.json", posix)).toBe("open <path>");
    expect(sanitizeReportMessage("open sub/../../secret-client/x.json", posix)).toBe("open <path>");
  });

  /** Catches the tail of an unquoted path with a space (the CLI prints its capture dir unquoted) leaking. */
  it("removes a capture dir outside the repo whole, spaces and all, when the CLI names it", () => {
    const ctx = { ...posix, knownPaths: ["/Volumes/Work Drive/acme-corp/storybook-static"] };
    expect(sanitizeReportMessage("--static-dir /Volumes/Work Drive/acme-corp/storybook-static does not exist", ctx)).toBe(
      "--static-dir <path> does not exist",
    );
    expect(sanitizeReportMessage("nothing to upload in /Volumes/Work Drive/acme-corp/storybook-static: no captures", ctx)).toBe(
      "nothing to upload in <path>: no captures",
    );
    const windows = { repoRoot: "C:/work/app", home: "C:/Users/jane", knownPaths: ["D:\\Client Work\\acme-corp\\out"] };
    expect(sanitizeReportMessage("nothing to upload in D:\\Client Work\\acme-corp\\out: no captures", windows)).toBe(
      "nothing to upload in <path>: no captures",
    );
    const inside = { ...posix, knownPaths: ["/work/app/storybook-static"] };
    expect(sanitizeReportMessage("--static-dir /work/app/storybook-static does not exist", inside)).toBe(
      "--static-dir ./storybook-static does not exist",
    );
  });

  it("leaves ordinary words with slashes alone and caps the length at 500", () => {
    expect(sanitizeReportMessage("and/or the build", posix)).toBe("and/or the build");
    expect(sanitizeReportMessage("x".repeat(900), posix)).toHaveLength(500);
  });
});

describe("classifyFailure", () => {
  const same = (t: string): string => `clean(${t})`;
  const key = { signedIn: false };

  /** Catches a stored login that died mid-run (refused refresh, replaced approval) reporting as `unexpected`. */
  it("reports a login that can no longer be used as login_invalid at the auth step, wherever it was found", () => {
    const err = new LoginGoneError("Not signed in. Run npx uiverify login, or set UIVERIFY_API_KEY.");
    expect(classifyFailure("register", err, same, key)).toEqual({
      stage: "auth",
      errorClass: "login_invalid",
      message: "clean(Not signed in. Run npx uiverify login, or set UIVERIFY_API_KEY.)",
    });
  });

  it("reports a 401 at register as an auth failure with only the label, status and our own error", () => {
    const err = new HttpStatusError(401, "invalid or missing api key", "POST /api/ingest/build", "invalid or missing api key");
    expect(classifyFailure("register", err, same, key)).toEqual({
      stage: "auth",
      errorClass: "http_401",
      message: "POST /api/ingest/build -> 401: clean(invalid or missing api key)",
    });
  });

  /** Catches a proxy's block page or a storage host's XML error body reaching the report. */
  it("never sends a response body that isn't our own error", () => {
    const body = "<html>Blocked by Corp Proxy for jane.doe@acme.com from 10.1.2.3</html>";
    const err = new HttpStatusError(403, `bundle upload -> 403: ${body}`, "bundle upload", null);
    expect(classifyFailure("upload", err, same, key)).toEqual({ stage: "upload", errorClass: "http_403", message: "bundle upload -> 403" });
  });

  /** Catches a gateway in front of us (which answers with a status our ingest never uses) passing its JSON
   *  text off as ours. */
  it("keeps a 403 at register as a register failure, without the gateway's text", () => {
    const err = new HttpStatusError(403, "Blocked for jane@acme.com", "POST /api/ingest/build", "Blocked for jane@acme.com");
    expect(classifyFailure("register", err, same, key)).toEqual({ stage: "register", errorClass: "http_403", message: "POST /api/ingest/build -> 403" });
  });

  it("sends only the error's type for a response that couldn't be read, at register or upload", () => {
    const err = new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`);
    expect(classifyFailure("register", err, same, key)).toEqual({ stage: "register", errorClass: "unexpected", message: "SyntaxError" });
    expect(classifyFailure("upload", err, same, key)).toEqual({ stage: "upload", errorClass: "unexpected", message: "SyntaxError" });
  });

  /** Catches a signed-in register refusal (which lists repositories and projects across all the person's
   *  teams) leaving the machine in `message`. */
  it("sends no server text for a signed-in run, at any status", () => {
    const signedIn = { signedIn: true };
    for (const status of [400, 401, 404, 409]) {
      const err = new HttpStatusError(status, "no project for acme/web; your teams: acme (web, docs), beta (app)", "POST /api/ingest/build", "no project for acme/web; your teams: acme (web, docs), beta (app)");
      expect(classifyFailure("register", err, same, signedIn).message).toBe(`POST /api/ingest/build -> ${status}`);
    }
    const missing = new HttpStatusError(404, "project not found", "POST /api/ingest/build", "project not found");
    expect(classifyFailure("register", missing, same, key).message).toBe("POST /api/ingest/build -> 404: clean(project not found)");
  });

  it("classifies 409 and 5xx", () => {
    const conflict = new HttpStatusError(409, "wrong type", "POST /api/ingest/build", "wrong type");
    expect(classifyFailure("register", conflict, same, key).errorClass).toBe("http_409");
    expect(classifyFailure("register", new HttpStatusError(502, "x", "status", null), same, key).errorClass).toBe("http_5xx");
  });

  it("reports fetch's own network failure with its cause code", () => {
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }) });
    expect(classifyFailure("register", err, same, key)).toEqual({ stage: "register", errorClass: "network", message: "fetch failed (ENOTFOUND)" });
  });

  it("doesn't call any other TypeError a network failure", () => {
    const err = new TypeError("Cannot read properties of undefined (reading 'buildId')");
    expect(classifyFailure("register", err, same, key).errorClass).toBe("unexpected");
  });

  it("reports a capture error under the capture step with its report message, not the local one", () => {
    const err = new CaptureOutputError("unreadable_capture", "could not read x.json: Unexpected token 's', \"secret\"", "a capture file could not be read");
    expect(classifyFailure("archive", err, same, key)).toEqual({
      stage: "capture",
      errorClass: "unreadable_capture",
      message: "clean(a capture file could not be read)",
    });
  });

  it("falls back to the step's own class", () => {
    expect(classifyFailure("git", new Error("fatal: not a git repository"), same, key).errorClass).toBe("git_failed");
    expect(classifyFailure("archive", new Error("tar exploded"), same, key).errorClass).toBe("archive_failed");
    expect(classifyFailure("register", Object.assign(new Error("aborted at /etc/x"), { name: "TimeoutError" }), same, key)).toEqual({
      stage: "register",
      errorClass: "timeout",
      message: "TimeoutError",
    });
  });
});

describe("createBundle capture errors", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "uiv-report-"));
    dirs.push(d);
    return d;
  };

  it("throws missing_dir for a dir that doesn't exist and nothing_captured for an empty one", async () => {
    const root = tmp();
    await expect(createBundle(path.join(root, "nope"), path.join(root, "o.tgz"))).rejects.toMatchObject({ errorClass: "missing_dir" });
    await expect(createBundle(root, path.join(root, "o.tgz"))).rejects.toMatchObject({ errorClass: "nothing_captured" });
  });

  /** Catches a malformed snapshot's content (Node's JSON error quotes it) reaching the report. */
  it("keeps the parse detail for the user but reports a fixed sentence for an unreadable snapshot", async () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "snapshots"));
    fs.writeFileSync(path.join(root, "snapshots", "a.json"), '{"id": "a", secret-token-here');
    const err: unknown = await createBundle(root, path.join(root, "o.tgz")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureOutputError);
    if (!(err instanceof CaptureOutputError)) return;
    expect(err.message).toContain("a.json");
    expect(err.reportMessage).toBe("a capture file could not be read");
  });
});

describe("screenshot capture errors", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("classifies a missing dir, an empty one, and two images with one id", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiv-shots-"));
    dirs.push(root);
    const out = path.join(root, "o.tgz");
    await expect(createScreenshotBundle(path.join(root, "nope"), out)).rejects.toMatchObject({ errorClass: "missing_dir" });
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    await expect(createScreenshotBundle(empty, out)).rejects.toMatchObject({ errorClass: "nothing_captured" });
    const twins = path.join(root, "twins");
    fs.mkdirSync(twins);
    fs.writeFileSync(path.join(twins, "a.png"), "x");
    fs.writeFileSync(path.join(twins, "a.jpg"), "x");
    await expect(createScreenshotBundle(twins, out)).rejects.toMatchObject({
      errorClass: "unreadable_capture",
      reportMessage: "two screenshots map to the same id (differ only by extension)",
    });
  });
});

describe("detectFramework", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  /** The case that matters most: nothing was captured, so only the repo's dependencies say what it uses. */
  it("finds the SDK from the nearest package.json when the capture output is missing, in a monorepo", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiv-fw-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies: { turbo: "1" } }));
    const app = path.join(root, "apps", "web");
    fs.mkdirSync(path.join(app, "node_modules", "@uiverify", "vitest"), { recursive: true });
    fs.writeFileSync(path.join(app, "package.json"), JSON.stringify({ devDependencies: { "@uiverify/vitest": "^1.6.0" } }));
    fs.writeFileSync(path.join(app, "node_modules", "@uiverify", "vitest", "package.json"), JSON.stringify({ version: "1.6.2" }));

    expect(detectFramework({ staticDir: path.join(app, ".uiverify"), cwd: root, screenshots: false, producer: null })).toEqual({
      framework: "vitest",
      frameworkSource: "package",
      sdkName: "@uiverify/vitest",
      sdkVersion: "1.6.2",
    });
  });

  it("prefers the capture output, and says screenshots for a screenshot upload", () => {
    const producer = { name: "@uiverify/playwright", version: "1.5.0" };
    expect(detectFramework({ staticDir: "/nope", cwd: "/nope", screenshots: false, producer })).toEqual({
      framework: "playwright",
      frameworkSource: "capture",
      sdkName: "@uiverify/playwright",
      sdkVersion: "1.5.0",
    });
    expect(detectFramework({ staticDir: "/nope", cwd: "/nope", screenshots: true, producer: null })).toEqual({
      framework: "screenshots",
      frameworkSource: "capture",
    });
  });

  it("says a built Storybook came from the capture output", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiv-fw-"));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, "iframe.html"), "<html></html>");
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify({ v: 5, entries: {} }));
    expect(detectFramework({ staticDir: dir, cwd: dir, screenshots: false, producer: null })).toMatchObject({ frameworkSource: "capture" });
  });

  /** Catches a package naming two capture frameworks being reported as if it named one: the server would then
   *  place a Storybook failure on the repo's Vitest project. */
  it.each([
    ["Storybook alone", { storybook: "8" }, { framework: "storybook", frameworkSource: "package" }],
    ["one SDK", { "@uiverify/playwright": "1" }, { framework: "playwright", frameworkSource: "package", sdkName: "@uiverify/playwright" }],
    ["Storybook and an SDK", { "@storybook/react": "8", "@uiverify/vitest": "1" }, { framework: "vitest", sdkName: "@uiverify/vitest" }],
    ["two SDKs", { "@uiverify/vitest": "1", "@uiverify/playwright": "1" }, { framework: "vitest", sdkName: "@uiverify/vitest" }],
    ["no capture framework", { react: "19" }, { framework: "unknown" }],
  ])("from a package.json with %s", (_name, devDependencies, expected) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "uiv-fw-"));
    dirs.push(root);
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies }));
    expect(detectFramework({ staticDir: path.join(root, "out"), cwd: root, screenshots: false, producer: null })).toEqual(expected);
  });
});

describe("reportCredential", () => {
  const repos = { repoFullName: "acme/web", upstreamRepoFullName: "upstream/web" };
  const base = { apiKey: undefined, heldToken: () => "access-token-1", errorClass: "nothing_captured" as const, project: "acme/web" };

  /** Catches the upload target (repository names, `--project`) leaving the machine on a report the server can't
   *  tie to a person: keyed and anonymous reports never name a repository. */
  it("attaches the target only to a report carrying a login token", () => {
    let gitReads = 0;
    const counted = () => {
      gitReads++;
      return repos;
    };
    expect(reportCredential({ ...base, kind: "login", repos: counted })).toEqual({
      bearer: "access-token-1",
      fields: { credential: "login", project: "acme/web", repoFullName: "acme/web", upstreamRepoFullName: "upstream/web" },
    });
    expect(reportCredential({ ...base, kind: "key", apiKey: "uv_proj_abc", heldToken: undefined, repos: counted })).toEqual({
      bearer: "uv_proj_abc",
      fields: { credential: "key" },
    });
    expect(reportCredential({ ...base, kind: "none", heldToken: undefined, repos: counted })).toEqual({ bearer: undefined, fields: { credential: "none" } });
    expect(gitReads).toBe(1);
  });

  it("sends a login with no usable token as the claim alone", () => {
    const repos = () => {
      throw new Error("git must not run");
    };
    expect(reportCredential({ ...base, kind: "login", heldToken: () => null, repos })).toEqual({ bearer: undefined, fields: { credential: "login" } });
  });

  /** Catches a token the server just refused (register's renewed token answered 401 too) going on the report. */
  it("drops a login token for a 401 but keeps a key", () => {
    expect(reportCredential({ ...base, kind: "login", errorClass: "http_401", repos: () => repos })).toEqual({
      bearer: undefined,
      fields: { credential: "login" },
    });
    expect(reportCredential({ ...base, kind: "key", apiKey: "uv_proj_abc", errorClass: "http_401", repos: () => repos }).bearer).toBe("uv_proj_abc");
  });

  /** Catches a token `sendReport` would strip as unusable in a header leaving the report anonymous but still
   *  carrying the repository names the login was meant to vouch for. */
  it("treats a token that can't go in a header as no token, with no target", () => {
    const repos = () => {
      throw new Error("git must not run");
    };
    expect(reportCredential({ ...base, kind: "login", heldToken: () => "access\u200btoken", repos })).toEqual({ bearer: undefined, fields: { credential: "login" } });
  });

  it("leaves out the target fields it doesn't know", () => {
    expect(reportCredential({ ...base, kind: "login", project: undefined, repos: () => ({ repoFullName: "" }) }).fields).toEqual({ credential: "login" });
  });
});

describe("sendReport", () => {
  const report: FailureReport = {
    command: "upload",
    stage: "auth",
    errorClass: "missing_key",
    message: "UIVERIFY_API_KEY is required",
    framework: "unknown",
    cliVersion: "1.9.0",
    os: "linux",
    arch: "x64",
    nodeVersion: "22.12.0",
    ci: false,
  };

  /** Catches the child inheriting the parent's whole environment (CI secrets) or NODE_OPTIONS. */
  it("passes the child only the network settings, the URL, the body and the key", () => {
    let seen: Record<string, string> = {};
    sendReport({
      apiUrl: "https://uiverify.ai/",
      path: FAILURE_REPORT_PATH,
      bearer: "uv_proj_abc",
      body: report,
      env: { PATH: "/bin", HTTPS_PROXY: "http://proxy:3128", GITHUB_TOKEN: "ghs_secret", NODE_OPTIONS: "--require evil.js" },
      spawnSender: (env) => {
        seen = env;
      },
    });
    expect(seen).toEqual({
      PATH: "/bin",
      HTTPS_PROXY: "http://proxy:3128",
      UIVERIFY_REPORT_URL: "https://uiverify.ai/api/ingest/failure-report",
      UIVERIFY_REPORT_BODY: JSON.stringify(report),
      UIVERIFY_REPORT_AUTH: "uv_proj_abc",
    });
  });

  it("sends a key that isn't a valid header value without auth, so the report still goes", () => {
    let seen: Record<string, string> = {};
    sendReport({ apiUrl: "https://uiverify.ai", path: FAILURE_REPORT_PATH, bearer: "uv_proj_abc\u200b", body: report, env: {}, spawnSender: (env) => (seen = env) });
    expect(seen).not.toHaveProperty("UIVERIFY_REPORT_AUTH");
    expect(seen.UIVERIFY_REPORT_BODY).toBeDefined();
  });

  it("never throws when the sender can't start", () => {
    expect(() =>
      sendReport({ apiUrl: "https://uiverify.ai", path: FAILURE_REPORT_PATH, bearer: undefined, body: report, env: {}, spawnSender: () => {
        throw new Error("EPERM");
      } }),
    ).not.toThrow();
  });

  it("is off only for UIVERIFY_TELEMETRY=0", () => {
    expect(reportsEnabled({})).toBe(true);
    expect(reportsEnabled({ UIVERIFY_TELEMETRY: "1" })).toBe(true);
    expect(reportsEnabled({ UIVERIFY_TELEMETRY: "0" })).toBe(false);
  });
});

describe("login reports", () => {
  /** Catches an opted-out login still identifying its CLI to the login funnel, or a header the server can't read. */
  it("sends the CLI's version, CI and terminal on login requests, and nothing with UIVERIFY_TELEMETRY=0", () => {
    expect(loginClientHeaders({ CI: "true" }, false, "1.9.0")).toEqual({
      "x-uiverify-cli-version": "1.9.0",
      "x-uiverify-ci": "1",
      "x-uiverify-tty": "0",
    });
    expect(loginClientHeaders({}, true, "1.9.0")).toMatchObject({ "x-uiverify-ci": "0", "x-uiverify-tty": "1" });
    expect(loginClientHeaders({ UIVERIFY_TELEMETRY: "0" }, true, "1.9.0")).toEqual({});
  });

  /** Catches a login ending carrying text or a credential, or going to the setup-failure route. */
  it("reports an ending to the login route, anonymously, with only fixed fields, and says so on the notice line", () => {
    const sent: Array<Record<string, string>> = [];
    const notices: string[] = [];
    const reportEnded = loginEndingReporter({
      apiUrl: "https://uiverify.ai",
      env: { UIVERIFY_API_KEY: "uv_proj_abc" },
      isTTY: false,
      cliVersion: "1.9.0",
      notice: (l) => notices.push(l),
      spawnSender: (env) => sent.push(env),
    });
    reportEnded("denied");
    reportEnded("expired_unwatched");
    expect(sent.map((e) => e.UIVERIFY_REPORT_URL)).toEqual([
      "https://uiverify.ai/api/cli/login/failure",
      "https://uiverify.ai/api/cli/login/failure",
    ]);
    expect(sent[0]).not.toHaveProperty("UIVERIFY_REPORT_AUTH");
    expect(JSON.parse(sent[0]?.UIVERIFY_REPORT_BODY ?? "{}")).toEqual({
      reason: "denied",
      cliVersion: "1.9.0",
      nodeVersion: process.versions.node,
      os: process.platform,
      arch: process.arch,
      ci: false,
      tty: false,
    });
    expect(notices).toEqual([`[uiverify] ${LOGIN_ENDED_NOTICE}`, `[uiverify] ${LOGIN_EXPIRED_UNUSED_NOTICE}`]);
  });

  it("sends nothing and prints nothing with UIVERIFY_TELEMETRY=0", () => {
    const sent: unknown[] = [];
    const notices: string[] = [];
    loginEndingReporter({
      apiUrl: "https://uiverify.ai",
      env: { UIVERIFY_TELEMETRY: "0" },
      isTTY: true,
      cliVersion: "1.9.0",
      notice: (l) => notices.push(l),
      spawnSender: (env) => sent.push(env),
    })("denied");
    expect([sent, notices]).toEqual([[], []]);
  });
});
