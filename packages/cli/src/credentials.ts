import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { holdSecret } from "./redact";

/**
 * The machine's stored `uiverify login`s, one per API origin, in one `0600` JSON file under a `0700`
 * directory in the user's config dir. Never in the repo.
 *
 * Several `uiverify upload`s can run at once (a monorepo's packages), and each may need to renew the same
 * login, whose refresh token rotates on every use. So every read-modify-write runs under an exclusive
 * lockfile and re-reads the file inside it, and the file is always replaced whole by temp-file + rename,
 * so a crash mid-write never leaves it torn.
 *
 * Where the OS keeps a key for this user (the macOS keychain, a Linux desktop's keyring, Windows DPAPI), the
 * file is sealed (AES-256-GCM) under a key kept there, so the file at rest (a backup, a synced dotfiles folder)
 * is ciphertext. Code running as the same user can get that key just as it could read a plain file; this
 * guards the file at rest, not the account. Only a `login` that starts a store seals it; every other write
 * keeps the form it read, so an upload never creates a key or changes which sessions can read the file.
 */

// Every object is `passthrough`: a field a newer uiverify adds survives this one's read-modify-write.
const activeSchema = z.object({
  clientId: z.string(),
  tokenEndpoint: z.string(),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
  /** When the control plane confirmed the account (`POST /api/cli/session`); null until then. */
  confirmedAt: z.number().nullable(),
  /** When this approval was stored; a renewal keeps it, so it names the approval across token rotations. */
  storedAt: z.number(),
}).passthrough();

const pendingSchema = z.object({
  clientId: z.string(),
  tokenEndpoint: z.string(),
  deviceCode: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  expiresAt: z.number(),
  interval: z.number(),
}).passthrough();

const loginEntrySchema = z.object({ active: activeSchema.optional(), pending: pendingSchema.optional() }).passthrough();

// The plain and sealed formats share one `version` counter: a new key store name or envelope field is a bump,
// and anything above what this version knows reads as `newer` (touched by nothing), never `corrupt`.
const credentialsSchema = z.object({ version: z.literal(1), logins: z.record(z.string(), loginEntrySchema) }).passthrough();
const versionSchema = z.object({ version: z.number() });

const sealedSchema = z.object({ iv: z.string(), tag: z.string(), data: z.string() });
type Sealed = z.infer<typeof sealedSchema>;

/** The macOS envelope: no `key`, so the fixed keychain item. */
const sealedV1Schema = z.object({ version: z.literal(1), sealed: sealedSchema });

/** The envelope of a store with a key per file: names the store and which key. Strict, so a field this
 *  version doesn't know makes it `newer`. How each store finds its key (the ref's shape, the Secret Service
 *  item's attributes, the DPAPI entropy) is part of this version too: changing one is a bump. */
const sealedV2Schema = z
  .object({ version: z.literal(2), sealed: sealedSchema, key: z.object({ store: z.string(), ref: z.string().optional() }).strict() })
  .strict();

/** Which key a sealed file is sealed with. */
interface FileKey {
  store: KeyStoreId;
  ref?: string;
}

/** The macOS keychain's file keeps its original shape, so a pinned older uiverify on the same Mac still reads
 *  it; a store with a key per file needs `version: 2`, which older ones refuse as `newer` and leave alone. */
function envelope(sealed: Sealed, key: FileKey): z.infer<typeof sealedV1Schema> | z.infer<typeof sealedV2Schema> {
  return key.store === "keychain" && key.ref === undefined ? { version: 1, sealed } : { version: 2, sealed, key };
}

export type ActiveLogin = z.infer<typeof activeSchema>;
export type PendingLogin = z.infer<typeof pendingSchema>;
export type LoginEntry = z.infer<typeof loginEntrySchema>;
export type Credentials = z.infer<typeof credentialsSchema>;

const EMPTY: Credentials = { version: 1, logins: {} };

/** `file` with the entry under `key` replaced by `entry`, or removed when `entry` is empty. */
export function withEntry(file: Credentials, key: string, entry: LoginEntry): Credentials {
  const logins = { ...file.logins };
  if (entry.active || entry.pending) logins[key] = entry;
  else delete logins[key];
  return { ...file, logins };
}

/** `%APPDATA%\uiverify` on Windows, else `$XDG_CONFIG_HOME/uiverify`, else `~/.config/uiverify`. */
export function credentialsPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homedir: string): string {
  const base =
    platform === "win32" && env.APPDATA
      ? env.APPDATA
      : env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
        ? env.XDG_CONFIG_HOME
        : path.join(homedir, ".config");
  return path.join(base, "uiverify", "credentials.json");
}

/** The key a login is stored under: the API URL's origin, so `https://uiverify.ai/` and
 *  `https://uiverify.ai` share one login. Throws on a URL that doesn't parse. */
export function loginKey(apiUrl: string): string {
  return new URL(apiUrl).origin;
}

/**
 * The stored logins can't be read. `corrupt` (not JSON, or a sealed file its key can't open) is proof the file
 * is dead. `keychain` (no key came back: locked, out of this shell's reach, deleted, or sealed by another
 * system's key store) may be a good file: `login` renames it aside to sign in afresh, and `logout` deletes it
 * like a `corrupt` one, since signing out must leave no renewable login behind. `timeout` (an unlock dialog
 * nobody answered) and `newer` (written by a newer uiverify) are never touched. Nothing ever overwrites any of
 * them.
 */
export class UnreadableStoreError extends Error {
  constructor(
    readonly kind: "keychain" | "timeout" | "newer" | "corrupt",
    message: string,
    /** Sealed by a key store this shell doesn't have: another system's (a synced config dir), or any at all here
     *  (a Linux shell with no session bus reading what its desktop sealed). */
    readonly sealedElsewhere = false,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The key stores

export interface CommandResult {
  /** The exit code; null when the process was killed for running past the timeout. */
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a process with `input` on stdin, killed after `timeoutMs`. Key stores reach their tool only through
 *  this, so tests fake it. */
export type CommandRunner = (command: string, args: string[], input: string | undefined, timeoutMs: number) => CommandResult;

export const runCommand: CommandRunner = (command, args, input, timeoutMs) => {
  // `windowsHide`: a GUI-hosted agent has no console, and each sealed read would flash a PowerShell window.
  // `LC_ALL=C`: the stores match the tools' messages (GDBus's "Timeout was reached"), which GLib translates.
  const r = spawnSync(command, args, { input, encoding: "utf8", timeout: timeoutMs, windowsHide: true, env: { ...process.env, LC_ALL: "C" } });
  // `null` only when our timeout killed it (an unlock dialog nobody answered); a crash, or any other failure
  // to run, is -1, so a tool that dies every time can't pass for a dialog forever.
  const timedOut = r.error !== undefined && "code" in r.error && r.error.code === "ETIMEDOUT";
  const status = timedOut ? null : r.error ? -1 : (r.status ?? -1);
  return { status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** `unrecognised`: the file names a key this store never writes (a ref of another shape: a newer uiverify's).
 *  `reseal`: what to do first, where a later fresh store would then be sealed (install a missing tool). */
export type KeyRead =
  | { kind: "found"; key: Buffer; ref?: string }
  | { kind: "absent" }
  | { kind: "unrecognised" }
  | { kind: "unavailable"; reason: string; timedOut?: boolean; reseal?: string };

const KEY_STORE_IDS = ["keychain", "secret-service", "dpapi"] as const;
export type KeyStoreId = (typeof KEY_STORE_IDS)[number];

function isKeyStoreId(id: string): id is KeyStoreId {
  return KEY_STORE_IDS.some((k) => k === id);
}

/** Where the store's sealing key lives. A sealed file names the store (`id`) and, where it needs one, which
 *  key (`ref`); a new key always gets a new ref, so `create` can never replace a key some file depends on. */
export interface KeyStore {
  readonly id: KeyStoreId;
  /** What a person calls it ("keychain", "keyring"), for messages. */
  readonly name: string;
  /** How a person unlocks it, for the "can't be read in this session" message. */
  readonly unlockHint: string;
  /** The key a file names, a clean "there is none", or why the store couldn't answer. */
  read(ref: string | undefined): KeyRead;
  /** The key for a store a `login` starts: a new one under a new ref where the store has refs, the one fixed
   *  item (made if missing) on macOS. */
  create(): KeyRead;
}

const KEY_SERVICE = "uiverify";
const KEY_ACCOUNT = "store-key";
const KEY_HEX = /^[0-9a-f]{64}$/;
const MAC_TIMEOUT_MS = 5_000;
// `security` exits 44 for "The specified item could not be found" and 45 for "already exists".
const SECURITY_NOT_FOUND = 44;

/**
 * The macOS login keychain through `/usr/bin/security`, by absolute path: `npx` and package scripts put the
 * repo's `node_modules/.bin` first on `PATH`, where a dependency's `security` bin would receive the key. The
 * key goes in on stdin (`security -i` reads commands from it), never in argv. One fixed item, so no `ref`.
 * `keychain` names a keychain file for the real-tool test; production passes none (the default keychain).
 */
export function macKeychain(run: CommandRunner = runCommand, keychain?: string): KeyStore {
  const target = keychain ? [keychain] : [];

  function readItem(): KeyRead {
    const r = run("/usr/bin/security", ["find-generic-password", "-s", KEY_SERVICE, "-a", KEY_ACCOUNT, "-w", ...target], undefined, MAC_TIMEOUT_MS);
    if (r.status === SECURITY_NOT_FOUND) return { kind: "absent" };
    const hex = r.stdout.trim();
    if (r.status !== 0 || !KEY_HEX.test(hex)) {
      if (r.status === null) return { kind: "unavailable", reason: "the keychain didn't answer in time", timedOut: true };
      return { kind: "unavailable", reason: r.stderr.trim() || `security exited ${r.status}` };
    }
    holdSecret(hex);
    return { kind: "found", key: Buffer.from(hex, "hex") };
  }

  function create(): KeyRead {
    const hex = randomBytes(32).toString("hex");
    holdSecret(hex);
    // No `-U`: an existing key is never replaced (another config dir's store may be sealed with it). When
    // one already exists the add fails and the read below returns it.
    const quoted = keychain ? ` "${keychain}"` : "";
    const added = run("/usr/bin/security", ["-i"], `add-generic-password -s ${KEY_SERVICE} -a ${KEY_ACCOUNT} -l "UI Verify CLI" -w ${hex}${quoted}\n`, MAC_TIMEOUT_MS);
    // An add cut off by the timeout (an unlock dialog nobody answered) leaves the read-back "absent" without a
    // prompt; report the timeout, so the first login fails instead of being stored unsealed for good.
    if (added.status === null) return { kind: "unavailable", reason: "the keychain didn't answer in time", timedOut: true };
    return readItem();
  }

  return {
    id: "keychain",
    name: "keychain",
    unlockHint: "Unlock your keychain (security unlock-keychain)",
    read: (ref) => (ref === undefined ? readItem() : { kind: "unrecognised" }),
    create,
  };
}

const SECRET_SERVICE_REF = /^[0-9a-f]{32}$/;
// Long enough for a person to type into the desktop's unlock dialog, short of GDBus's own 25 s method-call
// timeout (so the two don't race) and of the store lock's 30 s stale window.
const SECRET_SERVICE_TIMEOUT_MS = 20_000;
const SECRET_SERVICE_HINT = "Unlock your keyring (sign in to your desktop session, or open your keyring app)";
// Only a login into an empty store seals it, so the reseal step is to sign out of everything and back in.
const RESEAL_STEPS = "then run npx uiverify logout for every server you use and npx uiverify login to keep your login in your keyring";

/**
 * The Secret Service (gnome-keyring, KWallet) through `secret-tool`, at the absolute path `tool`. Each key is
 * its own item under a random `key-id`: `secret-tool store` silently replaces an item with the same
 * attributes, and a lookup can't tell a locked item from a missing one, so a fixed item could be replaced
 * under a file sealed with it. The key goes in on stdin, never in argv.
 */
export function secretService(run: CommandRunner, tool: string): KeyStore {
  function lookup(ref: string): KeyRead {
    const r = run(tool, ["lookup", "service", KEY_SERVICE, "key-id", ref], undefined, SECRET_SERVICE_TIMEOUT_MS);
    // GDBus's own timeout (a stalled provider, or an unlock dialog shown inside the call) is ours too.
    if (r.status === null || r.stderr.includes("Timeout was reached")) {
      return { kind: "unavailable", reason: "the keyring didn't answer in time", timedOut: true };
    }
    const hex = r.stdout.trim();
    if (r.status === 0 && KEY_HEX.test(hex)) {
      holdSecret(hex);
      return { kind: "found", key: Buffer.from(hex, "hex"), ref };
    }
    // No such item, or one in a collection locked with no way to prompt: never proof the file is dead.
    if (r.status === 1 && hex === "" && r.stderr.trim() === "") return { kind: "absent" };
    return { kind: "unavailable", reason: r.stderr.trim() || `secret-tool exited ${r.status}` };
  }

  function create(): KeyRead {
    const ref = randomBytes(16).toString("hex");
    const hex = randomBytes(32).toString("hex");
    holdSecret(hex);
    const stored = run(tool, ["store", "--label=UI Verify CLI", "service", KEY_SERVICE, "key-id", ref], hex, SECRET_SERVICE_TIMEOUT_MS);
    if (stored.status === null || stored.stderr.includes("Timeout was reached")) {
      return { kind: "unavailable", reason: "the keyring didn't answer in time", timedOut: true };
    }
    if (stored.status !== 0) {
      if (stored.stderr.includes("was not provided by any .service files")) {
        return { kind: "unavailable", reason: "no keyring app is running", reseal: `Start one, ${RESEAL_STEPS}.` };
      }
      return { kind: "unavailable", reason: stored.stderr.trim() || `secret-tool exited ${stored.status}` };
    }
    // No read-back: under a fresh random ref there is nothing a successful store could have collided with, and
    // a provider that confirms each read (KeePassXC) would prompt a second time inside the store lock.
    return { kind: "found", key: Buffer.from(hex, "hex"), ref };
  }

  return {
    id: "secret-service",
    name: "keyring",
    unlockHint: SECRET_SERVICE_HINT,
    read: (ref) => (ref !== undefined && SECRET_SERVICE_REF.test(ref) ? lookup(ref) : { kind: "unrecognised" }),
    create,
  };
}

/** A Linux shell with a session bus whose keyring this CLI won't use, saying why, so a login isn't stored
 *  plain without a word. */
function unusableSecretService(reason: string, unlockHint: string, reseal?: string): KeyStore {
  const answer: KeyRead = reseal === undefined ? { kind: "unavailable", reason } : { kind: "unavailable", reason, reseal };
  return { id: "secret-service", name: "keyring", unlockHint, read: () => answer, create: () => answer };
}

// A DPAPI blob of a 32-byte key is ~230 bytes; anything far outside that is not one of ours.
const DPAPI_REF = /^[A-Za-z0-9+/]{100,4000}={0,2}$/;
// No unlock dialog exists on Windows, but a cold Windows PowerShell start under antivirus can take seconds.
const DPAPI_TIMEOUT_MS = 20_000;

/**
 * The scripts read stdin into a variable, use it only in .NET calls and write with `[Console]::Out.Write`, so
 * no cmdlet ever receives the key or the blob: managed machines often log PowerShell's host output
 * (Transcription) and cmdlet parameter bindings (Module Logging). No double quotes, so Node's Windows argv
 * quoting passes each through unchanged.
 */
const DPAPI_PRELUDE =
  "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; " +
  "$e=[Text.Encoding]::UTF8.GetBytes('uiverify-store-key-v1'); $s=[Security.Cryptography.DataProtectionScope]::CurrentUser; " +
  "$in=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ";
export const DPAPI_PROTECT =
  DPAPI_PRELUDE +
  "$b=[Security.Cryptography.ProtectedData]::Protect($in,$e,$s); $c=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,$s); " +
  "if ([Convert]::ToBase64String($c) -ne [Convert]::ToBase64String($in)) { throw 'the protected key did not read back' }; " +
  "[Console]::Out.Write([Convert]::ToBase64String($b))";
export const DPAPI_UNPROTECT = DPAPI_PRELUDE + "[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($in,$e,$s)))";

/** Windows PowerShell by absolute path (never from `PATH`); a `SystemRoot` that isn't drive-absolute is ignored. */
export function powershellPath(env: NodeJS.ProcessEnv): string {
  const root = env.SystemRoot && /^[A-Za-z]:\\/.test(env.SystemRoot) ? env.SystemRoot : "C:\\Windows";
  return path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Windows DPAPI (CurrentUser) through Windows PowerShell. DPAPI protects bytes rather than storing them, so
 * the protected key itself is the `ref` the sealed file carries: there is no separate key file to lose,
 * overwrite or race on. The key and the blob go in on stdin, never in argv.
 */
export function windowsDpapi(run: CommandRunner, powershell: string): KeyStore {
  const ps = (script: string, input: string) => run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], input, DPAPI_TIMEOUT_MS);
  const failed = (r: CommandResult): KeyRead =>
    r.status === null
      ? { kind: "unavailable", reason: "Windows PowerShell didn't answer in time", timedOut: true }
      : { kind: "unavailable", reason: r.stderr.trim().split("\n")[0]?.trim() || `powershell exited ${r.status}` };

  function read(ref: string | undefined): KeyRead {
    if (ref === undefined || !DPAPI_REF.test(ref)) return { kind: "unrecognised" };
    const r = ps(DPAPI_UNPROTECT, ref);
    const key = Buffer.from(r.stdout.trim(), "base64");
    if (r.status !== 0 || key.length !== 32) return failed(r);
    holdSecret(r.stdout.trim());
    return { kind: "found", key, ref };
  }

  function create(): KeyRead {
    const key = randomBytes(32);
    holdSecret(key.toString("base64"));
    const r = ps(DPAPI_PROTECT, key.toString("base64"));
    const blob = r.stdout.trim();
    if (r.status !== 0 || !DPAPI_REF.test(blob)) return failed(r);
    return { kind: "found", key, ref: blob };
  }

  return {
    id: "dpapi",
    name: "Windows data protection",
    unlockHint: "Run it as the Windows user who signed in (if Windows PowerShell was only slow to start, once more is enough)",
    read,
    create,
  };
}

// Distro and Nix paths only: `/usr/local/bin` is `npm install -g`'s bin dir, often user-writable, and no
// distro package puts `secret-tool` there.
const SECRET_TOOL_DIRS = ["/usr/bin", "/bin", "/run/current-system/sw/bin"];

/**
 * Why a Linux shell with a session bus can't use the keyring, or null when it can: it must be inside a person's
 * graphical login (logind's session type x11 or wayland), and not SSH or WSL. Anywhere else an unlock dialog
 * would show on a screen nobody is at (the console, while signed in over SSH; an Xvfb display), the keyring call
 * would time out, and a timeout fails every login.
 */
export function linuxKeyringRefusal(env: NodeJS.ProcessEnv): string | null {
  if (env.SSH_CONNECTION || env.SSH_TTY) return "the keyring isn't used over SSH";
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return "the keyring isn't used in WSL";
  if (env.XDG_SESSION_TYPE !== "x11" && env.XDG_SESSION_TYPE !== "wayland") {
    return "the keyring is used only inside a graphical desktop login, not one started from a text console or a virtual display";
  }
  return null;
}

/** The key store for this machine, or null where logins are kept in a plain file without a word (a Linux shell
 *  with no session bus: a container, a plain SSH session, CI). */
export function platformKeyStore(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, exists: (file: string) => boolean = fs.existsSync): KeyStore | null {
  if (platform === "darwin") return macKeychain();
  if (platform === "win32") return windowsDpapi(runCommand, powershellPath(env));
  if (platform !== "linux") return null;
  // `path.posix`: Linux paths, whatever the host (the tests run on Windows too).
  const bus = Boolean(env.DBUS_SESSION_BUS_ADDRESS) || (Boolean(env.XDG_RUNTIME_DIR) && exists(path.posix.join(env.XDG_RUNTIME_DIR ?? "", "bus")));
  if (!bus) return null;
  const tool = SECRET_TOOL_DIRS.map((d) => path.posix.join(d, "secret-tool")).find(exists);
  // Without `secret-tool`, a desktop login is told how to get one; anywhere else the shell is most likely a
  // server's or a container's, so it says nothing.
  if (!tool) {
    return linuxKeyringRefusal(env) === null
      ? unusableSecretService(
          `secret-tool wasn't found in ${SECRET_TOOL_DIRS.join(", ")}`,
          "Install secret-tool (package libsecret-tools)",
          `Install it (package libsecret-tools), ${RESEAL_STEPS}.`,
        )
      : null;
  }
  const refusal = linuxKeyringRefusal(env);
  return refusal === null
    ? secretService(runCommand, tool)
    : unusableSecretService(refusal, "Run it from a terminal in your desktop session");
}

// ---------------------------------------------------------------------------------------------------------
// Sealing

const SEAL_AAD = Buffer.from("uiverify-credentials-v1");

function seal(plain: string, key: Buffer): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(SEAL_AAD);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/** The plaintext, or null when this key didn't seal it (or the file was altered). */
function unseal(sealed: Sealed, key: Buffer): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
    decipher.setAAD(SEAL_AAD);
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------
// The store

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 45_000;

export interface CredentialStore {
  readonly file: string;
  /** The stored logins. Throws `UnreadableStoreError` when this session can't read them. */
  read(): Credentials;
  /** Run `fn` holding the exclusive lock. `fn` re-reads (`read`) before deciding anything, and writes with
   *  `write`, which is only safe under the lock. */
  withLock<T>(fn: () => Promise<T>): Promise<T>;
  /** Replace the file, keeping the form of the last `read`. `seal: true` (a `login`) also seals a store that
   *  held no logins, when the key store can give a key; `unsealable` says why it couldn't. */
  write(next: Credentials, opts?: { seal?: boolean }): WriteResult;
  /** Rename an unreadable file aside (for `login`); returns the new path. */
  moveAside(): string;
  /** Delete the file (for `logout` of a store this session can't read). */
  remove(): void;
  /** The files `moveAside` left next to the store (for `logout`, which deletes them too). */
  setAside(): string[];
}

export type WriteResult = { form: "sealed" | "plain" } | { form: "unsealable"; reason: string; reseal?: string };

export interface StoreClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const realClock: StoreClock = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

function isErrnoException(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && "code" in e;
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (isErrnoException(e) && e.code === "ENOENT") return null;
    throw e;
  }
}

// Windows refuses a rename while antivirus or the indexer holds the new file; it lets go within milliseconds.
const RENAME_RETRIES = 5;
const RENAME_BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (attempt >= RENAME_RETRIES || !isErrnoException(e) || !RENAME_BUSY.has(e.code ?? "")) {
        fs.rmSync(from, { force: true });
        throw e;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function credentialStore(file: string, keys: KeyStore | null, clock: StoreClock = realClock): CredentialStore {
  const dir = path.dirname(file);
  const lockFile = `${file}.lock`;
  const stealMarker = `${lockFile}.steal`;
  // Keyed by store and ref, never one key for the store: a file another process re-created under a new key
  // since this one first looked must still open (and be renewed under its own key).
  const keyCache = new Map<string, Buffer>();
  /** The key of the file last read; null when it was plain (or absent). */
  let lastReadKey: FileKey | null = null;
  let lastReadEmpty = true;

  function ensureDir(): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `mkdirSync`'s mode is masked by the umask and ignored for a dir that already exists.
    fs.chmodSync(dir, 0o700);
  }

  function corrupt(why: string): UnreadableStoreError {
    return new UnreadableStoreError("corrupt", `Your stored UI Verify login (${file}) can't be read: ${why}.`);
  }

  function unreachable(): UnreadableStoreError {
    return new UnreadableStoreError(
      "keychain",
      `Your stored UI Verify login (${file}) was sealed with a key from an OS keychain this shell can't reach. ` +
        "Run npx uiverify login to sign in afresh from this shell, or set UIVERIFY_API_KEY.",
      true,
    );
  }

  /** The key that opens a sealed file. Only a found key is cached. */
  function sealingKey(fileKey: FileKey): Buffer {
    const cacheKey = `${fileKey.store}:${fileKey.ref ?? ""}`;
    const cached = keyCache.get(cacheKey);
    if (cached) return cached;
    if (!keys || keys.id !== fileKey.store) throw unreachable();
    const r = keys.read(fileKey.ref);
    if (r.kind === "found") {
      keyCache.set(cacheKey, r.key);
      return r.key;
    }
    if (r.kind === "unrecognised") throw newer();
    // A store answers "not found" both for a deleted key and when this shell can't reach it at all (a
    // sandboxed agent, a locked keyring with no way to prompt), so a missing key is never proof the file is dead.
    const why = r.kind === "absent" ? `the ${keys.name} gave no key for it` : `the ${keys.name} didn't answer (${r.reason})`;
    throw new UnreadableStoreError(
      r.kind === "unavailable" && r.timedOut ? "timeout" : "keychain",
      `Your stored UI Verify login (${file}) is sealed with a key in your ${keys.name}, and ${why}. ${keys.unlockHint} ` +
        "and try again, run npx uiverify login to sign in afresh from this shell, or set UIVERIFY_API_KEY.",
    );
  }

  function newer(): UnreadableStoreError {
    return new UnreadableStoreError("newer", `Your stored UI Verify login (${file}) was written by a newer uiverify. Run npx uiverify@latest.`);
  }

  /** The sealed envelope `json` is, or null for a plain document. Every shape a later uiverify could write is
   *  `newer`: anything above version 1 that isn't exactly this version's envelope with a store it knows. */
  function envelopeOf(json: unknown): { sealed: Sealed; key: FileKey } | null {
    const version = versionSchema.safeParse(json);
    if (!version.success || version.data.version === 1) {
      const v1 = sealedV1Schema.safeParse(json);
      return v1.success ? { sealed: v1.data.sealed, key: { store: "keychain" } } : null;
    }
    if (version.data.version < 1) return null;
    const v2 = sealedV2Schema.safeParse(json);
    if (!v2.success) throw newer();
    const { store, ref } = v2.data.key;
    if (!isKeyStoreId(store)) throw newer();
    return { sealed: v2.data.sealed, key: ref === undefined ? { store } : { store, ref } };
  }

  function read(): Credentials {
    let raw: string | null;
    try {
      raw = readOrNull(file);
    } catch (e) {
      throw corrupt(errorText(e));
    }
    if (raw === null) {
      lastReadKey = null;
      lastReadEmpty = true;
      return EMPTY;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw corrupt("it is not valid JSON");
    }
    const envelope = envelopeOf(json);
    if (envelope) {
      const plain = unseal(envelope.sealed, sealingKey(envelope.key));
      if (plain === null) throw corrupt("it was sealed with a different key");
      try {
        json = JSON.parse(plain);
      } catch {
        throw corrupt("its sealed contents are not valid JSON");
      }
      const inner = versionSchema.safeParse(json);
      if (inner.success && inner.data.version > 1) throw newer();
    }
    const parsed = credentialsSchema.safeParse(json);
    if (!parsed.success) throw corrupt("it is not a credentials file this uiverify can read");
    lastReadKey = envelope?.key ?? null;
    lastReadEmpty = Object.keys(parsed.data.logins).length === 0;
    for (const entry of Object.values(parsed.data.logins)) {
      holdSecret(entry.active?.accessToken);
      holdSecret(entry.active?.refreshToken);
      holdSecret(entry.pending?.deviceCode);
    }
    return parsed.data;
  }

  /** A new key for the store a `login` write starts, or why there is none (the login is written plain). A
   *  timeout the key store reports as one (an unlock dialog nobody answered) fails the write instead. */
  function keyForLogin(keys: KeyStore): { fileKey: FileKey; key: Buffer } | { reason: string; reseal?: string } {
    const got = keys.create();
    if (got.kind === "unavailable" && got.timedOut) {
      throw new UnreadableStoreError("timeout", `The ${keys.name} didn't answer in time. ${keys.unlockHint} and try again, or set UIVERIFY_API_KEY.`);
    }
    if (got.kind !== "found") {
      const why = got.kind === "unavailable" ? got.reason : `it didn't keep a key`;
      const reason = `this shell can't use your ${keys.name} (${why})`;
      return got.kind === "unavailable" && got.reseal !== undefined ? { reason, reseal: got.reseal } : { reason };
    }
    const fileKey: FileKey = got.ref === undefined ? { store: keys.id } : { store: keys.id, ref: got.ref };
    keyCache.set(`${fileKey.store}:${fileKey.ref ?? ""}`, got.key);
    return { fileKey, key: got.key };
  }

  function write(next: Credentials, opts: { seal?: boolean } = {}): WriteResult {
    ensureDir();
    const plain = JSON.stringify(next);
    // A `login` seals only a store it starts: an existing plain one stays plain, so a shell that can't reach
    // the key store (SSH, a sandboxed agent) keeps reading what it could read before.
    const wantsSeal = lastReadKey === null && opts.seal === true && lastReadEmpty;
    let sealWith: { fileKey: FileKey; key: Buffer } | null = null;
    let unsealable: { reason: string; reseal?: string } | null = null;
    if (lastReadKey) {
      sealWith = { fileKey: lastReadKey, key: sealingKey(lastReadKey) };
    } else if (wantsSeal && keys) {
      const got = keyForLogin(keys);
      if ("key" in got) sealWith = got;
      else unsealable = got;
    }
    const body = sealWith ? JSON.stringify(envelope(seal(plain, sealWith.key), sealWith.fileKey)) : plain;
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, `${body}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    renameWithRetry(tmp, file);
    lastReadKey = sealWith?.fileKey ?? null;
    if (sealWith) return { form: "sealed" };
    return unsealable === null ? { form: "plain" } : { form: "unsealable", ...unsealable };
  }

  /** The files `moveAside` left next to the store. */
  function setAside(): string[] {
    const base = path.basename(file);
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${base}.unreadable-`))
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  }

  function moveAside(): string {
    const aside = `${file}.unreadable-${clock.now()}`;
    fs.renameSync(file, aside);
    lastReadKey = null;
    return aside;
  }

  function remove(): void {
    fs.rmSync(file, { force: true });
    lastReadKey = null;
  }

  /** Try once to take the lock. A lock older than `LOCK_STALE_MS` (its holder crashed) is moved aside by
   *  `rename`, which only one waiter can win; the winner checks it moved the same stale lock it saw and
   *  puts back a live lock it raced onto instead. */
  function tryAcquire(token: string): boolean {
    try {
      const fd = fs.openSync(lockFile, "wx", 0o600);
      fs.writeFileSync(fd, token);
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (!isErrnoException(e) || e.code !== "EEXIST") throw e;
    }
    let seen: { content: string | null; mtimeMs: number };
    try {
      seen = { content: readOrNull(lockFile), mtimeMs: fs.statSync(lockFile).mtimeMs };
    } catch {
      return false;
    }
    if (clock.now() - seen.mtimeMs < LOCK_STALE_MS) return false;
    // One stealer at a time: whoever creates the marker removes the stale lock (if it is still the one it saw),
    // and everyone then races `open wx` again, which only one wins.
    try {
      fs.closeSync(fs.openSync(stealMarker, "wx", 0o600));
    } catch (e) {
      if (!isErrnoException(e) || e.code !== "EEXIST") throw e;
      try {
        if (clock.now() - fs.statSync(stealMarker).mtimeMs >= LOCK_STALE_MS) fs.rmSync(stealMarker, { force: true });
      } catch {
        // Gone already.
      }
      return false;
    }
    try {
      const still = { content: readOrNull(lockFile), mtimeMs: fs.statSync(lockFile).mtimeMs };
      if (still.content === seen.content && still.mtimeMs === seen.mtimeMs) fs.rmSync(lockFile, { force: true });
    } catch {
      // Released meanwhile.
    } finally {
      fs.rmSync(stealMarker, { force: true });
    }
    return false;
  }

  function release(token: string): void {
    if (readOrNull(lockFile) === token) fs.rmSync(lockFile, { force: true });
  }

  /** A shell that may not write the config dir (a sandboxed agent) can't renew a login: say so plainly, before
   *  a refresh spends a token whose replacement couldn't be stored. */
  function unwritable(e: unknown): Error | null {
    if (!isErrnoException(e) || !["EACCES", "EPERM", "EROFS"].includes(e.code ?? "")) return null;
    return new Error(
      `Can't write ${dir} from this shell (${e.code}), which keeping your UI Verify login needs. Allow writes to it ` +
        "(a sandboxed agent shell may block them), run outside the sandbox, or set UIVERIFY_API_KEY.",
    );
  }

  async function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
    const started = clock.now();
    for (;;) {
      let acquired: boolean;
      try {
        ensureDir();
        acquired = tryAcquire(token);
      } catch (e) {
        throw unwritable(e) ?? e;
      }
      if (acquired) break;
      if (clock.now() - started > LOCK_MAX_WAIT_MS) {
        throw new Error(`could not lock ${lockFile}: another uiverify process is holding it`);
      }
      await clock.sleep(LOCK_RETRY_MS);
    }
    // A process killed while holding the lock (an agent's timeout, Ctrl-C) releases it on the way out, so the
    // next run doesn't wait out the 30 s stale window.
    const onSignal = (signal: NodeJS.Signals): void => {
      release(token);
      process.kill(process.pid, signal);
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      return await fn();
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      release(token);
    }
  }

  return { file, read, write, withLock, moveAside, remove, setAside };
}
