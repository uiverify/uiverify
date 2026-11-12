import { execFileSync, spawn } from "node:child_process";
import { createCipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ActiveLogin,
  type CommandRunner,
  DPAPI_PROTECT,
  DPAPI_UNPROTECT,
  type KeyStore,
  UnreadableStoreError,
  credentialStore,
  credentialsPath,
  linuxKeyringRefusal,
  loginKey,
  macKeychain,
  platformKeyStore,
  powershellPath,
  runCommand,
  secretService,
  windowsDpapi,
  withEntry,
} from "./credentials";
import { type FakeKeyStore, fakeKeyStore } from "./fake-key-store";

const ORIGIN = "https://uiverify.ai";
const ACTIVE: ActiveLogin = {
  clientId: "client_cli",
  tokenEndpoint: "https://auth.example/token",
  accessToken: "access-token-1",
  refreshToken: "refresh-token-1",
  expiresAt: 1,
  confirmedAt: null,
  storedAt: 0,
};

describe("credentialsPath", () => {
  it("prefers XDG_CONFIG_HOME, else ~/.config, and %APPDATA% on Windows", () => {
    // `path.join` so the expectations hold where the separator is a backslash (the Windows CI job).
    expect(credentialsPath({ XDG_CONFIG_HOME: "/x" }, "linux", "/home/me")).toBe(path.join("/x", "uiverify", "credentials.json"));
    expect(credentialsPath({}, "darwin", "/Users/me")).toBe(path.join("/Users/me", ".config", "uiverify", "credentials.json"));
    // A relative XDG_CONFIG_HOME is invalid per the spec and ignored.
    expect(credentialsPath({ XDG_CONFIG_HOME: "rel" }, "linux", "/home/me")).toBe(path.join("/home/me", ".config", "uiverify", "credentials.json"));
    expect(credentialsPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming", XDG_CONFIG_HOME: "/x" }, "win32", "C:\\Users\\me")).toBe(
      path.join("C:\\Users\\me\\AppData\\Roaming", "uiverify", "credentials.json"),
    );
  });

  it("keys a login by the API URL's origin", () => {
    expect(loginKey("https://uiverify.ai/")).toBe("https://uiverify.ai");
    expect(loginKey("http://localhost:3000/some/path")).toBe("http://localhost:3000");
  });
});

describe("credentialStore", () => {
  let home: string;
  let file: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-creds-"));
    file = credentialsPath({ XDG_CONFIG_HOME: home }, "linux", home);
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  async function store(keys: KeyStore | null, entry: Parameters<typeof withEntry>[2], seal = false) {
    const s = credentialStore(file, keys);
    await s.withLock(async () => s.write(withEntry(s.read(), ORIGIN, entry), { seal }));
    return s;
  }

  it("reads a missing file as no logins", () => {
    expect(credentialStore(file, null).read()).toEqual({ version: 1, logins: {} });
  });

  /** Would catch: a damaged file read as empty, so the next write erases every login in it. */
  it.each([
    ["not JSON", "{not json", "it is not valid JSON"],
    ["not a credentials file", JSON.stringify({ version: 1, logins: [] }), "it is not a credentials file this uiverify can read"],
  ])("refuses a file that is %s, naming it", (_label, content, why) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    expect(() => credentialStore(file, null).read()).toThrow(`(${file}) can't be read: ${why}.`);
  });

  /** Would catch: an older pinned uiverify treating a newer one's store as dead, so its `login` moves the
   *  newer logins aside and its `logout` deletes them. */
  it("refuses a file a newer uiverify wrote without calling it dead", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 2, logins: {} }));
    let thrown: unknown;
    try {
      credentialStore(file, null).read();
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof UnreadableStoreError && thrown.kind).toBe("newer");
    expect(String(thrown)).toContain("written by a newer uiverify");
  });

  /** Would catch: a field a newer uiverify adds dropped by this one's renewal write. */
  it("keeps fields it doesn't know through a read-modify-write", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, extra: 1, logins: { [ORIGIN]: { active: { ...ACTIVE, scope: "x" }, note: "n" } } }));
    const s = credentialStore(file, null);
    await s.withLock(async () => {
      const f = s.read();
      const entry = f.logins[ORIGIN] ?? {};
      s.write(withEntry(f, ORIGIN, { ...entry, active: entry.active && { ...entry.active, refreshToken: "refresh-token-2" } }));
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      version: 1,
      extra: 1,
      logins: { [ORIGIN]: { active: { ...ACTIVE, scope: "x", refreshToken: "refresh-token-2" }, note: "n" } },
    });
  });

  /** Would catch: tokens landing in a world-readable file or directory. */
  it.skipIf(process.platform === "win32")("writes the file 0600 in a 0700 directory, leaving no temp file behind", async () => {
    const s = await store(null, { active: ACTIVE });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(["credentials.json"]);
    expect(s.read().logins[ORIGIN]).toEqual({ active: ACTIVE });
  });

  it.skipIf(process.platform === "win32")("tightens a config dir that already exists with a looser mode", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.chmodSync(path.dirname(file), 0o755);
    await store(null, { active: ACTIVE });
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  /** Would catch: a login's tokens left readable in the file on a machine with a key store, or an envelope
   *  that doesn't name the key that opens it. */
  it.each([
    ["the macOS keychain, in its original shape (one fixed key)", "keychain", {}],
    ["a key store with a key per file, naming it", "secret-service", { version: 2, key: { store: "secret-service", ref: "ref-1" } }],
  ] as const)("seals a login write under %s, and reads it back", async (_label, id, shape) => {
    const keys = fakeKeyStore(id);
    await store(keys, { active: ACTIVE }, true);
    const raw = fs.readFileSync(file, "utf8");
    expect(raw).not.toContain("refresh-token-1");
    expect(JSON.parse(raw)).toEqual({ version: 1, sealed: { iv: expect.any(String), tag: expect.any(String), data: expect.any(String) }, ...shape });
    expect(credentialStore(file, keys).read().logins[ORIGIN]).toEqual({ active: ACTIVE });
    expect(keys.creates).toBe(1);
  });

  /** Would catch: a store that seals a renewal with a new key (or under another ref) instead of the one the
   *  file names, so the next reader can't open it. */
  it("seals every later write of a file with the key it names", async () => {
    const keys = fakeKeyStore();
    const s = await store(keys, { active: ACTIVE }, true);
    await s.withLock(async () => s.write(withEntry(s.read(), ORIGIN, { active: { ...ACTIVE, refreshToken: "refresh-token-2" } }), { seal: true }));
    expect(JSON.parse(fs.readFileSync(file, "utf8")).key).toEqual({ store: "secret-service", ref: "ref-1" });
    expect(keys.creates).toBe(1);
    expect(credentialStore(file, keys).read().logins[ORIGIN]?.active?.refreshToken).toBe("refresh-token-2");
  });

  /** Would catch: a store instance that cached one key reading (or renewing) a file another process re-created
   *  under a new key with the cached one, calling it corrupt or sealing it so nothing can open it. */
  it("opens and renews a file re-created under a new key since it cached the old one", async () => {
    const keys = fakeKeyStore();
    const first = await store(keys, { active: ACTIVE }, true);
    expect(first.read().logins[ORIGIN]?.active).toEqual(ACTIVE);
    const other = credentialStore(file, keys);
    other.remove();
    await other.withLock(async () => other.write(withEntry(other.read(), ORIGIN, { active: { ...ACTIVE, refreshToken: "refresh-token-b" } }), { seal: true }));
    expect(JSON.parse(fs.readFileSync(file, "utf8")).key.ref).toBe("ref-2");
    await first.withLock(async () => {
      const f = first.read();
      expect(f.logins[ORIGIN]?.active?.refreshToken).toBe("refresh-token-b");
      first.write(withEntry(f, ORIGIN, { active: { ...ACTIVE, refreshToken: "refresh-token-c" } }));
    });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).key.ref).toBe("ref-2");
    expect(credentialStore(file, keys).read().logins[ORIGIN]?.active?.refreshToken).toBe("refresh-token-c");
  });

  /** Would catch: a fresh login after `moveAside` replacing the key the set-aside file needs, so renaming it
   *  back no longer opens it. */
  it("keeps a set-aside file openable after a fresh login creates a new key", async () => {
    const keys = fakeKeyStore();
    const s = await store(keys, { active: ACTIVE }, true);
    const aside = s.moveAside();
    await s.withLock(async () => s.write(withEntry(s.read(), ORIGIN, { active: { ...ACTIVE, refreshToken: "refresh-token-2" } }), { seal: true }));
    expect(JSON.parse(fs.readFileSync(file, "utf8")).key.ref).toBe("ref-2");
    fs.renameSync(aside, file);
    expect(credentialStore(file, keys).read().logins[ORIGIN]).toEqual({ active: ACTIVE });
  });

  /** Would catch: a renewal, or a `login` over an existing plain store, sealing it and stranding the shells
   *  (SSH, a sandboxed agent) that could read it before. */
  it("keeps the form it read; a login seals only a store it starts", async () => {
    const keys = fakeKeyStore();
    const s = await store(keys, { active: ACTIVE });
    await s.withLock(async () => s.write(withEntry(s.read(), ORIGIN, { active: { ...ACTIVE, refreshToken: "refresh-token-2" } })));
    await s.withLock(async () => s.write(withEntry(s.read(), "https://staging.example", { active: ACTIVE }), { seal: true }));
    expect(fs.readFileSync(file, "utf8")).toContain("refresh-token-2");
    expect(keys.creates).toBe(0);

    fs.rmSync(file);
    const sealed = await store(keys, { active: ACTIVE }, true);
    await sealed.withLock(async () => sealed.write(withEntry(sealed.read(), ORIGIN, { active: { ...ACTIVE, refreshToken: "refresh-token-3" } })));
    expect(fs.readFileSync(file, "utf8")).not.toContain("refresh-token-3");
    expect(credentialStore(file, keys).read().logins[ORIGIN]?.active?.refreshToken).toBe("refresh-token-3");
  });

  /** Would catch: a sandboxed shell that may not write the config dir failing with a raw errno (or after a
   *  refresh spent the token) instead of saying what to do. */
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("says plainly when this shell can't write the config dir", async () => {
    // A read-only parent stands in for a sandbox that denies writes outside the workspace.
    const parent = path.join(home, "read-only");
    fs.mkdirSync(parent, { mode: 0o500 });
    try {
      let ran = false;
      const inSandbox = credentialStore(path.join(parent, "uiverify", "credentials.json"), null);
      await expect(inSandbox.withLock(async () => void (ran = true))).rejects.toThrow("Can't write");
      expect(ran).toBe(false);
    } finally {
      fs.chmodSync(parent, 0o700);
    }
  });

  /** Would catch: two waiters both stealing one stale lock (each removing the other's fresh lock), so two
   *  processes spend the same rotating refresh token. */
  it("lets only one waiter steal a stale lock", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, "999999:crashed");
    const old = new Date(Date.now() - 31_000);
    fs.utimesSync(`${file}.lock`, old, old);
    fs.writeFileSync(`${file}.lock.steal`, "");
    const s = credentialStore(file, null);
    let entered = false;
    const p = s.withLock(async () => {
      entered = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(entered).toBe(false);
    fs.rmSync(`${file}.lock.steal`);
    await p;
    expect(entered).toBe(true);
  });

  /** Would catch: a login failing outright, or sealing under a key nobody can read back, on a machine whose
   *  keychain is locked. */
  it("writes a login plain when the key store can't keep a key, saying why", async () => {
    const keys = fakeKeyStore();
    keys.locked = true;
    const s = credentialStore(file, keys);
    const written = await s.withLock(async () => s.write(withEntry(s.read(), ORIGIN, { active: ACTIVE }), { seal: true }));
    expect(written).toEqual({ form: "unsealable", reason: "this shell can't use your keyring (User interaction is not allowed.)" });
    expect(fs.readFileSync(file, "utf8")).toContain("refresh-token-1");
  });

  it("writes plain, and doesn't call it a failure, where there is no key store", async () => {
    const s = credentialStore(file, null);
    expect(await s.withLock(async () => s.write(withEntry(s.read(), ORIGIN, { active: ACTIVE }), { seal: true }))).toEqual({ form: "plain" });
  });

  /** Would catch: a process that first saw a plain file treating a file another process sealed since as
   *  empty (absence cached), and overwriting a live login. */
  it("opens a file another process sealed after this one first read it", async () => {
    const keys = fakeKeyStore();
    const reader = await store(keys, { active: ACTIVE });
    expect(reader.read().logins[ORIGIN]?.active).toEqual(ACTIVE);
    await store(keys, { active: { ...ACTIVE, refreshToken: "refresh-token-9" } }, true);
    expect(reader.read().logins[ORIGIN]?.active?.refreshToken).toBe("refresh-token-9");
  });

  /** Would catch: an unlock dialog nobody answered while creating the key storing the first login plain for good. */
  it("fails a first login write when creating the key timed out, writing nothing", async () => {
    const keys = fakeKeyStore();
    keys.timedOut = true;
    const s = credentialStore(file, keys);
    await expect(s.withLock(async () => s.write(withEntry(s.read(), ORIGIN, { active: ACTIVE }), { seal: true }))).rejects.toThrow("didn't answer in time");
    expect(fs.existsSync(file)).toBe(false);
  });

  /** Would catch: a process killed while holding the lock (an agent's timeout) leaving it for 30 s. */
  it.skipIf(process.platform === "win32")("releases its lock when killed while holding it", async () => {
    const credentials = path.resolve(__dirname, "credentials.ts");
    const script = `import { credentialStore } from ${JSON.stringify(credentials)};
await credentialStore(${JSON.stringify(file)}, null).withLock(async () => { console.log("held"); await new Promise(() => setInterval(() => {}, 1000)); });`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve) => child.stdout.on("data", (c: Buffer) => c.toString().includes("held") && resolve()));
    expect(fs.existsSync(`${file}.lock`)).toBe(true);
    child.kill("SIGTERM");
    await new Promise((r) => child.on("close", r));
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  }, 30_000);

  /** Would catch: a sealed file read as empty (and later overwritten) when its key can't be had, or a
   *  keychain that merely didn't answer treated as a dead file (which `login` would move aside). */
  it.each([
    ["the key store is locked", (k: FakeKeyStore) => void (k.locked = true), "keychain", "didn't answer (User interaction is not allowed.). Unlock it"],
    ["the key store timed out", (k: FakeKeyStore) => void (k.timedOut = true), "timeout", "didn't answer (no answer)"],
    // A store says "not found" also when a sandboxed shell can't reach it: never proof the file is dead.
    ["the key store gives no key", (k: FakeKeyStore) => void k.held.clear(), "keychain", "the keyring gave no key for it"],
    ["the key is another one", (k: FakeKeyStore) => void k.held.set("ref-1", Buffer.alloc(32, 7)), "corrupt", "it was sealed with a different key"],
  ])("refuses a sealed file when %s, and leaves it untouched", async (_label, breakIt, kind, why) => {
    const keys = fakeKeyStore();
    await store(keys, { active: ACTIVE }, true);
    const before = fs.readFileSync(file, "utf8");
    breakIt(keys);
    const fresh = credentialStore(file, keys);
    expect(() => fresh.read()).toThrow(why);
    let thrown: unknown;
    try {
      fresh.read();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnreadableStoreError);
    expect(thrown instanceof UnreadableStoreError && thrown.kind).toBe(kind);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  /** Would catch: a file sealed by another system's key store (a synced dotfiles folder) sent down the
   *  "unlock your keychain" path, which can never help, or called dead. */
  it.each([
    ["no key store", () => null],
    ["another system's key store", () => fakeKeyStore("dpapi")],
  ])("refuses a file sealed elsewhere, on a machine with %s, as out of reach", async (_label, here) => {
    await store(fakeKeyStore(), { active: ACTIVE }, true);
    let thrown: unknown;
    try {
      credentialStore(file, here()).read();
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof UnreadableStoreError && thrown.kind).toBe("keychain");
    expect(String(thrown)).toContain("was sealed with a key from an OS keychain this shell can't reach");
  });

  /** Would catch: a later uiverify's key under this machine's own store (a new ref format) read as sealed
   *  elsewhere, which `logout` deletes and `login` replaces with a plain store, instead of left alone. */
  it("reads a key this machine's store doesn't recognise as written by a newer uiverify", async () => {
    const keys = fakeKeyStore();
    await store(keys, { active: ACTIVE }, true);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"ref":"ref-1"', '"ref":"a-newer-format"'));
    const unrecognising = Object.assign(fakeKeyStore(), { read: () => ({ kind: "unrecognised" as const }) });
    let thrown: unknown;
    try {
      credentialStore(file, unrecognising).read();
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof UnreadableStoreError && thrown.kind).toBe("newer");
  });

  /** Would catch: a shape a later uiverify could write read as `corrupt`, which `logout` deletes and `login`
   *  sets aside, instead of `newer`, which nothing touches. */
  it.each([
    ["a version 3 envelope", () => ({ version: 3, sealed: { iv: "a", tag: "b", data: "c" }, key: { store: "secret-service", ref: "r" } })],
    ["a version 2 plain store", () => ({ version: 2, logins: {} })],
    ["a version 2 envelope from a key store this version doesn't know", () => ({ version: 2, sealed: { iv: "a", tag: "b", data: "c" }, key: { store: "kwallet" } })],
    ["a version 2 envelope with a field this version doesn't know", () => ({ version: 2, sealed: { iv: "a", tag: "b", data: "c" }, key: { store: "dpapi", ref: "r" }, cipher: "x" })],
  ])("reads %s as written by a newer uiverify", (_label, doc) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc()));
    let thrown: unknown;
    try {
      credentialStore(file, fakeKeyStore()).read();
    } catch (e) {
      thrown = e;
    }
    expect(thrown instanceof UnreadableStoreError && thrown.kind).toBe("newer");
  });

  it("reads a sealed file whose contents a newer uiverify wrote as newer", async () => {
    const keys = fakeKeyStore();
    await store(keys, { active: ACTIVE }, true);
    const key = keys.held.get("ref-1") ?? Buffer.alloc(0);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("uiverify-credentials-v1"));
    const data = Buffer.concat([cipher.update(JSON.stringify({ version: 2, logins: {} }), "utf8"), cipher.final()]);
    const sealed = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    fs.writeFileSync(file, JSON.stringify({ version: 2, sealed, key: { store: "secret-service", ref: "ref-1" } }));
    expect(() => credentialStore(file, keys).read()).toThrow("written by a newer uiverify");
  });

  it("moves an unreadable file aside, or removes it", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{not json");
    const s = credentialStore(file, null, { now: () => 1234, sleep: async () => {} });
    expect(s.moveAside()).toBe(`${file}.unreadable-1234`);
    expect(fs.readFileSync(`${file}.unreadable-1234`, "utf8")).toBe("{not json");
    expect(s.read()).toEqual({ version: 1, logins: {} });
    fs.writeFileSync(file, "{not json");
    s.remove();
    expect(fs.existsSync(file)).toBe(false);
  });

  /** Would catch: two processes inside the lock at once (the parallel-refresh race's precondition). */
  it("lets only one holder in at a time, across store instances on the same file", async () => {
    const a = credentialStore(file, null);
    const b = credentialStore(file, null);
    const order: string[] = [];
    let releaseA = (): void => {};
    const heldA = a.withLock(async () => {
      order.push("a in");
      await new Promise<void>((r) => (releaseA = r));
      order.push("a out");
    });
    const heldB = b.withLock(async () => {
      order.push("b in");
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(order).toEqual(["a in"]);
    releaseA();
    await Promise.all([heldA, heldB]);
    expect(order).toEqual(["a in", "a out", "b in"]);
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  /** Would catch: a crashed holder's lock blocking every later upload. */
  it("steals a lock older than 30s", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, "999999:crashed");
    const old = new Date(Date.now() - 31_000);
    fs.utimesSync(`${file}.lock`, old, old);
    const s = credentialStore(file, null);
    const ran = await s.withLock(async () => fs.readFileSync(`${file}.lock`, "utf8"));
    expect(ran).not.toBe("999999:crashed");
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
    expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith(".stale"))).toEqual([]);
  });

  it("does not steal a live lock", async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.lock`, "123:live");
    const s = credentialStore(file, null);
    let entered = false;
    const p = s.withLock(async () => {
      entered = true;
    });
    await new Promise((r) => setTimeout(r, 200));
    expect(entered).toBe(false);
    fs.rmSync(`${file}.lock`);
    await p;
    expect(entered).toBe(true);
  });
});

/** A fake process runner answering from a queue, recording every call. */
function recorder(answers: Array<Partial<{ status: number | null; stdout: string; stderr: string }>>) {
  const calls: Array<{ command: string; args: string[]; input: string | undefined; timeoutMs: number }> = [];
  const run: CommandRunner = (command, args, input, timeoutMs) => {
    calls.push({ command, args, input, timeoutMs });
    const a = answers.shift() ?? {};
    return { status: a.status === undefined ? 0 : a.status, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { run, calls };
}
const HEX = "ab".repeat(32);

describe("runCommand", () => {
  /** Would catch: a key-store tool that crashes reported as a timeout, which `login` and `logout` never touch,
   *  so a store it guards could never be recovered from the CLI. */
  it("reports only its own timeout as one; a crash is a plain failure", () => {
    expect(runCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], undefined, 200).status).toBeNull();
    // A failure, not a timeout: -1 on POSIX (killed by a signal), 1 on Windows (TerminateProcess).
    const crashed = runCommand(process.execPath, ["-e", "process.kill(process.pid, 'SIGKILL')"], undefined, 5_000).status;
    expect(crashed).not.toBeNull();
    expect(crashed).not.toBe(0);
    expect(runCommand(process.execPath, ["-e", "process.stdout.write(require('fs').readFileSync(0, 'utf8'))"], "in", 5_000)).toEqual({ status: 0, stdout: "in", stderr: "" });
  });

  /** Would catch: a tool's messages arriving translated (GLib follows the locale), so GDBus's "Timeout was
   *  reached" is missed and a good sealed store is set aside. */
  it("runs the tool in the C locale", () => {
    expect(runCommand(process.execPath, ["-e", "process.stdout.write(process.env.LC_ALL ?? '')"], undefined, 5_000).stdout).toBe("C");
  });
});

describe("macKeychain", () => {

  it("doesn't recognise a file naming a ref, which this store never writes", () => {
    const { run, calls } = recorder([]);
    expect(macKeychain(run).read("ref")).toEqual({ kind: "unrecognised" });
    expect(calls).toEqual([]);
  });

  it("reads the key, tells a missing key from a keychain that can't answer", () => {
    expect(macKeychain(recorder([{ stdout: `${HEX}\n` }]).run).read(undefined)).toEqual({ kind: "found", key: Buffer.from(HEX, "hex") });
    expect(macKeychain(recorder([{ status: 44 }]).run).read(undefined)).toEqual({ kind: "absent" });
    expect(macKeychain(recorder([{ status: 36, stderr: "User interaction is not allowed." }]).run).read(undefined)).toEqual({
      kind: "unavailable",
      reason: "User interaction is not allowed.",
    });
    expect(macKeychain(recorder([{ status: null }]).run).read(undefined)).toMatchObject({ kind: "unavailable" });
  });

  /** Would catch: the key passed in argv (visible to `ps`), `-U` replacing a key another store is sealed
   *  with, or `security` looked up on PATH (where a dependency's bin could answer). */
  it("creates the key over stdin without replacing one, then reads it back", () => {
    const { run, calls } = recorder([{}, { stdout: HEX }]);
    expect(macKeychain(run).create()).toEqual({ kind: "found", key: Buffer.from(HEX, "hex") });
    expect(calls.every((c) => c.command === "/usr/bin/security")).toBe(true);
    expect(calls[0]?.args).toEqual(["-i"]);
    expect(calls[0]?.input).toMatch(/^add-generic-password -s uiverify -a store-key -l "UI Verify CLI" -w [0-9a-f]{64}\n$/);
    expect(calls[0]?.input).not.toContain(" -U");
    expect(calls.some((c) => c.args.some((a) => /^[0-9a-f]{64}$/.test(a)))).toBe(false);
  });

  it("reports a key that doesn't read back as unavailable, and an add that timed out as a timeout", () => {
    expect(macKeychain(recorder([{ status: null }, { status: 44 }]).run).create()).toMatchObject({ kind: "unavailable", timedOut: true });
    expect(macKeychain(recorder([{}, { status: 36 }]).run).create()).toMatchObject({ kind: "unavailable" });
  });

  /** Checks the commands against the real `security` tool, in a throwaway keychain file. Runs on macOS: a
   *  developer's Mac and the `login-store-macos` CI job. */
  it.skipIf(process.platform !== "darwin")("round-trips a key through the real security tool", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-kc-"));
    const keychain = path.join(dir, "test.keychain-db");
    try {
      execFileSync("/usr/bin/security", ["create-keychain", "-p", "pw", keychain]);
      execFileSync("/usr/bin/security", ["unlock-keychain", "-p", "pw", keychain]);
      const kc = macKeychain(undefined, keychain);
      expect(kc.read(undefined)).toEqual({ kind: "absent" });
      const created = kc.create();
      expect(created.kind === "found" && created.key).toHaveLength(32);
      expect(kc.read(undefined)).toEqual(created);
      // A second create keeps the first key.
      expect(macKeychain(undefined, keychain).create()).toEqual(created);
    } finally {
      execFileSync("/usr/bin/security", ["delete-keychain", keychain]);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("secretService", () => {
  const TOOL = "/usr/bin/secret-tool";
  const REF = "0123456789abcdef0123456789abcdef";

  it("reads the key a file names, telling a missing key from a keyring that can't answer", () => {
    expect(secretService(recorder([{ stdout: HEX }]).run, TOOL).read(REF)).toEqual({ kind: "found", key: Buffer.from(HEX, "hex"), ref: REF });
    // No such item, and also an item in a locked collection with no way to prompt.
    expect(secretService(recorder([{ status: 1 }]).run, TOOL).read(REF)).toEqual({ kind: "absent" });
    expect(secretService(recorder([{ status: 1, stderr: "secret-tool: Cannot get secret of a locked object" }]).run, TOOL).read(REF)).toEqual({
      kind: "unavailable",
      reason: "secret-tool: Cannot get secret of a locked object",
    });
  });

  /** Would catch: GDBus's own timeout (its 25 s default, or a shorter one a provider sets) read as a lasting
   *  failure, so `login` sets a good sealed store aside after an unlock dialog nobody answered. */
  it("treats our timeout and GDBus's own as a timeout", () => {
    expect(secretService(recorder([{ status: null }]).run, TOOL).read(REF)).toMatchObject({ kind: "unavailable", timedOut: true });
    expect(secretService(recorder([{ status: 1, stderr: "secret-tool: Timeout was reached" }]).run, TOOL).read(REF)).toMatchObject({ kind: "unavailable", timedOut: true });
  });

  /** Would catch: a ref from the (unauthenticated) file reaching `secret-tool`'s argv unchecked. */
  it("doesn't recognise a missing or malformed ref, running nothing", () => {
    const { run, calls } = recorder([]);
    expect(secretService(run, TOOL).read(undefined)).toEqual({ kind: "unrecognised" });
    expect(secretService(run, TOOL).read("--all")).toEqual({ kind: "unrecognised" });
    expect(calls).toEqual([]);
  });

  /** Would catch: the key in argv (visible to `ps`), a fixed item `store` would silently replace under a file
   *  sealed with it, or a tool found on PATH. */
  it("creates each key as a new item under a fresh ref, the key on stdin", () => {
    const { run, calls } = recorder([{}, {}]);
    const a = secretService(run, TOOL).create();
    const b = secretService(run, TOOL).create();
    if (a.kind !== "found" || b.kind !== "found") throw new Error("create failed");
    expect(a.ref).toMatch(/^[0-9a-f]{32}$/);
    expect(a.ref).not.toBe(b.ref);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({ command: TOOL, args: ["store", "--label=UI Verify CLI", "service", "uiverify", "key-id", a.ref], input: a.key.toString("hex"), timeoutMs: 20_000 });
    expect(calls.some((c) => c.args.includes(a.key.toString("hex")))).toBe(false);
  });

  /** Would catch: a store that didn't answer (an unlock dialog nobody answered) storing the first login plain
   *  for good instead of failing it, or a refused store read as a key. */
  it("reports a store that timed out as a timeout, and a refused one as unavailable", () => {
    expect(secretService(recorder([{ status: null }]).run, TOOL).create()).toMatchObject({ kind: "unavailable", timedOut: true });
    expect(secretService(recorder([{ status: 1, stderr: "secret-tool: Timeout was reached" }]).run, TOOL).create()).toMatchObject({ kind: "unavailable", timedOut: true });
    expect(secretService(recorder([{ status: 1, stderr: "secret-tool: Cannot create an item in a locked collection" }]).run, TOOL).create()).toEqual({
      kind: "unavailable",
      reason: "secret-tool: Cannot create an item in a locked collection",
    });
    // A fresh login with no keyring app running is stored plain rather than failed, saying what would seal it.
    expect(
      secretService(recorder([{ status: 1, stderr: "secret-tool: The name org.freedesktop.secrets was not provided by any .service files" }]).run, TOOL).create(),
    ).toEqual({
      kind: "unavailable",
      reason: "no keyring app is running",
      reseal: "Start one, then run npx uiverify logout for every server you use and npx uiverify login to keep your login in your keyring.",
    });
  });

  /** Checks the commands against the real `secret-tool` and gnome-keyring. Runs in the `login-store-linux` CI
   *  job, which sets the variable (so it can't skip there) inside a `dbus-run-session` with an unlocked
   *  throwaway keyring. The locked case runs last: `secret-tool` can lock a collection but not unlock it. */
  describe.runIf(process.env.UIVERIFY_TEST_SECRET_SERVICE === "1")("against the real secret-tool", () => {
    const real = secretService(runCommand, TOOL);
    const made: string[] = [];

    it("round-trips keys, each under its own item", () => {
      const a = real.create();
      const b = real.create();
      if (a.kind !== "found" || b.kind !== "found") throw new Error(`create failed: ${JSON.stringify([a, b])}`);
      made.push(a.ref ?? "", b.ref ?? "");
      expect(a.ref).not.toBe(b.ref);
      expect(real.read(a.ref)).toEqual(a);
      expect(real.read(b.ref)).toEqual(b);
      expect(real.read("f".repeat(32))).toEqual({ kind: "absent" });
    });

    it("seals a login with it, and reads it back", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-ss-"));
      try {
        const file = path.join(home, "uiverify", "credentials.json");
        const s = credentialStore(file, real);
        await s.withLock(async () => s.write(withEntry(s.read(), ORIGIN, { active: ACTIVE }), { seal: true }));
        const raw = fs.readFileSync(file, "utf8");
        expect(raw).not.toContain("refresh-token-1");
        const doc: unknown = JSON.parse(raw);
        expect(doc).toMatchObject({ version: 2, key: { store: "secret-service", ref: expect.stringMatching(/^[0-9a-f]{32}$/) } });
        expect(credentialStore(file, real).read().logins[ORIGIN]).toEqual({ active: ACTIVE });
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("is the key store a desktop login picks", () => {
      const picked = platformKeyStore("linux", { ...process.env, XDG_SESSION_TYPE: "x11" });
      const got = picked?.create();
      expect(got).toMatchObject({ kind: "found" });
      if (got?.kind === "found") {
        expect(picked?.read(got.ref)).toEqual(got);
        if (got.ref) made.push(got.ref);
      }
    });

    it("answers absent, and refuses to create, promptly when the keyring is locked with no way to prompt", () => {
      for (const ref of made) runCommand(TOOL, ["clear", "service", "uiverify", "key-id", ref], undefined, 5_000);
      const kept = real.create();
      if (kept.kind !== "found") throw new Error(`create failed: ${JSON.stringify(kept)}`);
      execFileSync(TOOL, ["lock", "--collection=login"]);
      const started = Date.now();
      expect(real.read(kept.ref)).toEqual({ kind: "absent" });
      expect(real.create()).toEqual({ kind: "unavailable", reason: "secret-tool: Cannot create an item in a locked collection" });
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  });
});

describe("windowsDpapi", () => {
  const PS = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const KEY_B64 = Buffer.alloc(32, 9).toString("base64");
  const BLOB = "A".repeat(230);

  it("runs Windows PowerShell by absolute path, ignoring a SystemRoot that isn't drive-absolute", () => {
    expect(powershellPath({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath({ SystemRoot: "Windows" })).toBe(PS);
    expect(powershellPath({})).toBe(PS);
  });

  /** Would catch: the key or the blob in argv, `-EncodedCommand` (flagged by EDR products), or a script that
   *  hands the secret to a cmdlet, whose bindings Module Logging records. */
  it("protects a new key with the key on stdin, keeping the blob as the ref", () => {
    const { run, calls } = recorder([{ stdout: BLOB }]);
    const created = windowsDpapi(run, PS).create();
    expect(created).toMatchObject({ kind: "found", ref: BLOB });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: PS, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_PROTECT], timeoutMs: 20_000 });
    const sent = calls[0]?.input ?? "";
    expect(created.kind === "found" && created.key.toString("base64")).toBe(sent);
    expect(calls[0]?.args.some((a) => a.includes(sent))).toBe(false);
  });

  it("unprotects the key a file names, the blob on stdin", () => {
    const { run, calls } = recorder([{ stdout: KEY_B64 }]);
    expect(windowsDpapi(run, PS).read(BLOB)).toEqual({ kind: "found", key: Buffer.alloc(32, 9), ref: BLOB });
    expect(calls[0]).toMatchObject({ args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", DPAPI_UNPROTECT], input: BLOB });
  });

  it("keeps the secret out of every cmdlet and the scripts free of double quotes", () => {
    for (const script of [DPAPI_PROTECT, DPAPI_UNPROTECT]) {
      expect(script).not.toContain('"');
      expect(script).not.toMatch(/Write-Output|Write-Host|Out-|\| /);
      expect(script).toContain("[Console]::Out.Write(");
    }
  });

  /** Would catch: a refused or failed DPAPI call (another user, Constrained Language Mode, AMSI) read as a
   *  key, or a slow PowerShell start not reported as a timeout. */
  it("maps failures, refusals and timeouts", () => {
    const refused = "Cannot add type. Definition of new types is not supported in this language mode.";
    expect(windowsDpapi(recorder([{ status: 1, stderr: `${refused}\nAt line:1 char:1` }]).run, PS).read(BLOB)).toEqual({ kind: "unavailable", reason: refused });
    expect(windowsDpapi(recorder([{ status: 1, stderr: refused }]).run, PS).create()).toEqual({ kind: "unavailable", reason: refused });
    expect(windowsDpapi(recorder([{ stdout: "c2hvcnQ=" }]).run, PS).read(BLOB)).toMatchObject({ kind: "unavailable" });
    expect(windowsDpapi(recorder([{ status: null }]).run, PS).read(BLOB)).toMatchObject({ kind: "unavailable", timedOut: true });
    expect(windowsDpapi(recorder([{ status: null }]).run, PS).create()).toMatchObject({ kind: "unavailable", timedOut: true });
  });

  it("doesn't recognise a missing or malformed ref, running nothing", () => {
    const { run, calls } = recorder([]);
    expect(windowsDpapi(run, PS).read(undefined)).toEqual({ kind: "unrecognised" });
    expect(windowsDpapi(run, PS).read("not base64!")).toEqual({ kind: "unrecognised" });
    expect(calls).toEqual([]);
  });

  /** Checks the scripts against real DPAPI. Runs on Windows: the `login-store-windows` CI job. */
  describe.runIf(process.platform === "win32")("against real DPAPI", () => {
    const real = windowsDpapi(runCommand, powershellPath(process.env));

    it("round-trips a key", () => {
      const created = real.create();
      if (created.kind !== "found") throw new Error(`create failed: ${JSON.stringify(created)}`);
      expect(real.read(created.ref)).toEqual(created);
      expect(real.create()).not.toEqual(created);
    });

    it("seals a login with it, and reads it back", async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "uiverify-dpapi-"));
      try {
        const file = path.join(home, "uiverify", "credentials.json");
        const s = credentialStore(file, real);
        await s.withLock(async () => s.write(withEntry(s.read(), ORIGIN, { active: ACTIVE }), { seal: true }));
        const raw = fs.readFileSync(file, "utf8");
        expect(raw).not.toContain("refresh-token-1");
        const doc: unknown = JSON.parse(raw);
        expect(doc).toMatchObject({ version: 2, key: { store: "dpapi", ref: expect.any(String) } });
        expect(credentialStore(file, real).read().logins[ORIGIN]).toEqual({ active: ACTIVE });
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
  });
});

describe("platformKeyStore", () => {
  const DESKTOP = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus", XDG_SESSION_TYPE: "wayland" };
  const has = (...files: string[]) => (f: string) => files.includes(f);
  const TOOLS = has("/run/user/1000/bus", "/usr/bin/secret-tool");

  /** Would catch: the keyring used from a shell whose unlock dialog would show on a screen nobody is at (SSH,
   *  WSL, an Xvfb display, a text console), where every login would time out; or skipped on a real desktop. */
  it.each([
    ["a Wayland desktop login", DESKTOP],
    ["an X11 login whose bus is only the runtime-dir socket", { XDG_RUNTIME_DIR: "/run/user/1000", XDG_SESSION_TYPE: "x11" }],
  ])("uses the keyring in %s", (_label, env) => {
    expect(linuxKeyringRefusal(env)).toBeNull();
    expect(platformKeyStore("linux", env, TOOLS)?.read(undefined)).toEqual({ kind: "unrecognised" });
  });

  /** Would catch: a shell that has a keyring but may not use it storing the login plain without a word. */
  it.each([
    ["an SSH shell", { ...DESKTOP, SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, "the keyring isn't used over SSH"],
    ["an SSH shell with a tty", { ...DESKTOP, SSH_TTY: "/dev/pts/1" }, "the keyring isn't used over SSH"],
    ["WSL", { ...DESKTOP, WSL_DISTRO_NAME: "Ubuntu" }, "the keyring isn't used in WSL"],
    ["WSL with only its interop variable left", { ...DESKTOP, WSL_INTEROP: "/run/WSL/1_interop" }, "the keyring isn't used in WSL"],
    ["a session started from a text console", { ...DESKTOP, XDG_SESSION_TYPE: "tty" }, "only inside a graphical desktop login"],
    ["a virtual display", { DBUS_SESSION_BUS_ADDRESS: "unix:path=/x", DISPLAY: ":99" }, "only inside a graphical desktop login"],
  ])("explains why it won't use the keyring in %s", (_label, env, why) => {
    const keys = platformKeyStore("linux", env, TOOLS);
    expect(keys?.create()).toEqual({ kind: "unavailable", reason: expect.stringContaining(why) });
    expect(keys?.unlockHint).toBe("Run it from a terminal in your desktop session");
  });

  it("stores plain without a word where there is no session bus, or no secret-tool outside a desktop login", () => {
    expect(platformKeyStore("linux", { XDG_SESSION_TYPE: "wayland" }, TOOLS)).toBeNull();
    expect(platformKeyStore("linux", { ...DESKTOP, SSH_CONNECTION: "x" }, has())).toBeNull();
  });

  /** Would catch: `secret-tool` taken from PATH or the npm global bin, where a package's bin would get the key. */
  it("finds secret-tool only in system dirs, and says so when a desktop login lacks it", () => {
    const missing = platformKeyStore("linux", DESKTOP, has("/usr/local/bin/secret-tool"));
    expect(missing?.create()).toEqual({
      kind: "unavailable",
      reason: "secret-tool wasn't found in /usr/bin, /bin, /run/current-system/sw/bin",
      reseal: "Install it (package libsecret-tools), then run npx uiverify logout for every server you use and npx uiverify login to keep your login in your keyring.",
    });
    expect(missing?.unlockHint).toBe("Install secret-tool (package libsecret-tools)");
    expect(platformKeyStore("linux", DESKTOP, has("/run/current-system/sw/bin/secret-tool"))?.read(undefined)).toEqual({ kind: "unrecognised" });
  });

  it("uses the keychain on macOS, DPAPI on Windows, and nothing elsewhere", () => {
    expect(platformKeyStore("darwin", {})?.id).toBe("keychain");
    expect(platformKeyStore("win32", {})?.id).toBe("dpapi");
    expect(platformKeyStore("freebsd", DESKTOP)).toBeNull();
  });
});
