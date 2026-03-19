import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Logger } from "./types";

type NamespaceFormat = "json";

export interface PersistenceScope {
  accountId?: string;
  agentId?: string;
  conversationId?: string;
  groupId?: string;
  targetId?: string;
}

export interface ResolveNamespacePathOptions {
  storePath: string;
  scope?: PersistenceScope;
  format?: NamespaceFormat;
}

export interface ReadNamespaceJsonOptions<T> extends ResolveNamespacePathOptions {
  fallback: T;
  log?: Logger;
}

export interface WriteNamespaceJsonOptions<T> extends ResolveNamespacePathOptions {
  data: T;
  log?: Logger;
}

const NAMESPACE_ROOT_DIR = "dingtalk-state";
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_TTL_MS = 30_000;
const LOCK_METADATA_FILE = "holder.json";
const LOCK_MAX_BACKOFF_MS = 200;

interface PersistenceLockMetadata {
  pid: number;
  hostname: string;
  createdAt: number;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function encodeScopeValue(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function buildScopeSuffix(scope?: PersistenceScope): string {
  if (!scope) {
    return "";
  }
  const ordered: Array<[keyof PersistenceScope, string | undefined]> = [
    ["accountId", scope.accountId],
    ["agentId", scope.agentId],
    ["conversationId", scope.conversationId],
    ["groupId", scope.groupId],
    ["targetId", scope.targetId],
  ];

  const segments = ordered
    .filter(([, value]) => Boolean(value && value.trim()))
    .map(([key, value]) => `${key.replace(/Id$/, "")}-${encodeScopeValue((value || "").trim())}`);

  if (segments.length === 0) {
    return "";
  }
  return `.${segments.join(".")}`;
}

export function resolveNamespacePath(namespace: string, options: ResolveNamespacePathOptions): string {
  const format = options.format || "json";
  const baseDir = path.join(path.dirname(options.storePath), NAMESPACE_ROOT_DIR);
  const safeNamespace = sanitizeSegment(namespace.trim());
  const suffix = buildScopeSuffix(options.scope);
  return path.join(baseDir, `${safeNamespace}${suffix}.${format}`);
}

export function readNamespaceJson<T>(
  namespace: string,
  options: ReadNamespaceJsonOptions<T>,
): T {
  const filePath = resolveNamespacePath(namespace, options);
  try {
    if (!fs.existsSync(filePath)) {
      return options.fallback;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
      return options.fallback;
    }
    return JSON.parse(raw) as T;
  } catch (err: unknown) {
    options.log?.warn?.(
      `[DingTalk][Persistence] Failed to read namespace=${namespace} path=${filePath}: ${toErrorMessage(err)}`,
    );
    return options.fallback;
  }
}

export function writeNamespaceJsonAtomic<T>(
  namespace: string,
  options: WriteNamespaceJsonOptions<T>,
): void {
  const filePath = resolveNamespacePath(namespace, options);
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(options.data, null, 2));
    try {
      fs.renameSync(tempPath, filePath);
    } catch (err: unknown) {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true });
        fs.renameSync(tempPath, filePath);
      } else {
        throw err;
      }
    }
  } catch (err: unknown) {
    options.log?.warn?.(
      `[DingTalk][Persistence] Failed to write namespace=${namespace} path=${filePath}: ${toErrorMessage(err)}`,
    );
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function computeLockRetryDelay(attempt: number): number {
  return Math.min(LOCK_WAIT_MS * (2 ** Math.max(0, attempt)), LOCK_MAX_BACKOFF_MS);
}

async function writeLockMetadata(lockPath: string): Promise<void> {
  const metadata: PersistenceLockMetadata = {
    pid: process.pid,
    hostname: os.hostname(),
    createdAt: Date.now(),
  };
  await fs.promises.writeFile(path.join(lockPath, LOCK_METADATA_FILE), JSON.stringify(metadata));
}

async function readLockMetadata(lockPath: string): Promise<PersistenceLockMetadata | null> {
  try {
    const raw = await fs.promises.readFile(path.join(lockPath, LOCK_METADATA_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistenceLockMetadata>;
    if (
      typeof parsed.pid === "number"
      && Number.isFinite(parsed.pid)
      && typeof parsed.hostname === "string"
      && parsed.hostname.trim()
      && typeof parsed.createdAt === "number"
      && Number.isFinite(parsed.createdAt)
    ) {
      return {
        pid: parsed.pid,
        hostname: parsed.hostname,
        createdAt: parsed.createdAt,
      };
    }
  } catch {}
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "EPERM";
  }
}

async function shouldBreakStaleLock(lockPath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(lockPath);
    if (Date.now() - stat.mtimeMs >= STALE_LOCK_TTL_MS) {
      return true;
    }
  } catch {
    return false;
  }

  const metadata = await readLockMetadata(lockPath);
  if (!metadata) {
    return false;
  }
  return metadata.hostname === os.hostname() && !isProcessAlive(metadata.pid);
}

export async function withNamespaceFileLock<T>(
  namespace: string,
  options: ResolveNamespacePathOptions,
  fn: () => Promise<T> | T,
): Promise<T> {
  const filePath = resolveNamespacePath(namespace, options);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let waitAttempt = 0;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      await fs.promises.mkdir(lockPath, { recursive: false });
      await writeLockMetadata(lockPath);
      break;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") {
        throw err;
      }
      if (await shouldBreakStaleLock(lockPath)) {
        await fs.promises.rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for persistence lock: ${lockPath}`, { cause: err });
      }
      await sleep(computeLockRetryDelay(waitAttempt));
      waitAttempt += 1;
    }
  }

  try {
    return await fn();
  } finally {
    await fs.promises.rm(lockPath, { recursive: true, force: true });
  }
}
