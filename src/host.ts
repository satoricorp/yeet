/**
 * host.ts — the platform seam: the syscalls yeet needs that Bun doesn't expose, plus paths.
 *
 * Two platforms, one doctrine: a copy-on-write clone or a loud failure, never a silent byte
 * copy.
 *
 * macOS — clonefile(2), called directly rather than shelling to `cp -c`, because `cp -c`
 * "will fallback to using copyfile(2) instead to ensure the copy still succeeds" — i.e. it
 * silently degrades a 1.3s metadata-only clone into a 563 MB byte copy, and you cannot tell
 * from the outside which one you got.
 *
 * Linux — `cp -a --reflink=always`. `always`, not `auto`, for the same reason: auto degrades
 * to a full copy on ext4 without telling anyone. If the clone fails, the fix is to put
 * $YEET_HOME on a CoW filesystem (XFS with reflink=1, or Btrfs — Fedora's default), and the
 * error says so rather than quietly making every iteration pay for 563 MB.
 *
 * Clone-vs-copy is CORRECTNESS, not just speed: virtiofs stores the guest's uid/gid/mode in
 * a `user.containers.override_stat` xattr, so the host-visible mode is a lie (git is 0600 on
 * the host, 0755 in the guest). cp -R, rsync without -X, and tar without --xattrs all
 * destroy that, leaving a guest whose git is not executable. clonefile preserves xattrs by
 * construction; on Linux, -a (--preserve=all) carries them.
 *
 * flock(2): liveness. Same symbol and same constants in libSystem and glibc (LOCK_EX=2,
 * LOCK_NB=4, LOCK_UN=8). The kernel releases the lock on crash, kill -9, or reboot, which a
 * pid check cannot match (pids roll over; a reboot invalidates them all).
 */
import { dlopen, FFIType } from "bun:ffi";
import { openSync, closeSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const IS_MAC = process.platform === "darwin";

// clonefile exists only in libSystem — asking glibc for it would throw at module load, which
// is why the symbol table itself is platform-conditional rather than the call sites alone.
const { symbols } = dlopen(IS_MAC ? "libSystem.B.dylib" : "libc.so.6", {
  ...(IS_MAC ? { clonefile: { args: [FFIType.ptr, FFIType.ptr, FFIType.i32], returns: FFIType.i32 } } : {}),
  flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
}) as { symbols: { clonefile?: CFunc; flock: (fd: number, op: number) => number } };
type CFunc = (src: Buffer, dst: Buffer, flags: number) => number;

const cstr = (s: string) => Buffer.from(s + "\0", "utf8");

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** Copy-on-write clone. `dst` must NOT already exist. Throws on failure — never falls back
 *  to a byte copy, because a silent 563 MB copy per iteration is worth failing over. */
export function cloneTree(src: string, dst: string): void {
  if (IS_MAC) {
    const rc = symbols.clonefile!(cstr(src), cstr(dst), 0);
    if (rc !== 0) {
      throw new Error(
        `clonefile("${src}" -> "${dst}") failed (rc=${rc}). ` +
          `Both paths must be on the same APFS volume and dst must not exist.`,
      );
    }
    return;
  }
  const r = Bun.spawnSync(["cp", "-a", "--reflink=always", src, dst]);
  if (r.exitCode !== 0) {
    throw new Error(
      `cp --reflink=always "${src}" -> "${dst}" failed: ${r.stderr.toString().trim()}. ` +
        `$YEET_HOME must live on a CoW filesystem (XFS with reflink=1, or Btrfs) — ` +
        `a plain copy here would silently cost 563 MB per iteration.`,
    );
  }
}

export type Lock = { release(): void };

/** Take an exclusive non-blocking lock. Returns null if another process holds it — which is
 *  exactly the liveness signal GC needs: lock acquirable ⇒ the owner is gone, whatever the
 *  metadata claims. */
/**
 * Get rid of a cloned rootfs without making anyone wait for it.
 *
 * Deleting one is expensive and wildly asymmetric: measured 1754/1830/1914 ms to remove a tree
 * that took 96/239/359 ms to clone, against a ~623 ms boot. Doing it synchronously after the VM
 * exits put roughly two seconds of pure teardown on the critical path of EVERY vm — the build,
 * the confirm run, coverage, test, run, and the merge check — where the user is sitting watching
 * a finished agent.
 *
 * A rename is effectively free, so move it aside and let a detached process do the slow part.
 * Deliberately not queueMicrotask: microtasks drain BEFORE the awaiting continuation resumes, so
 * that would keep the whole cost on the critical path while looking like it had moved.
 */
export function discardTree(dir: string): void {
  if (!existsSync(dir)) return;
  try {
    mkdirSync(TRASH_DIR, { recursive: true });
    const doomed = join(TRASH_DIR, `${Date.now().toString(36)}-${Math.floor(performance.now() * 1000) % 1e6}`);
    renameSync(dir, doomed);
    // Detached and unref'd: yeet may exit long before rm finishes, and that is fine — anything
    // left behind is swept by sweepTrash() on the next run.
    Bun.spawn(["rm", "-rf", doomed], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  } catch {
    // A rename across devices, or a trash dir we cannot make: fall back to paying the cost.
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* nothing left to try */ }
  }
}

/** Clear anything a killed process left in the trash. Cheap, and bounded by how often yeet runs. */
export function sweepTrash(): void {
  if (!existsSync(TRASH_DIR)) return;
  try {
    for (const e of readdirSync(TRASH_DIR)) {
      Bun.spawn(["rm", "-rf", join(TRASH_DIR, e)], { stdio: ["ignore", "ignore", "ignore"] }).unref();
    }
  } catch { /* best effort */ }
}

export function tryLock(path: string): Lock | null {
  const fd = openSync(path, "w");
  if (symbols.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd);
    return null;
  }
  return {
    release() {
      symbols.flock(fd, LOCK_UN);
      closeSync(fd);
    },
  };
}

export const YEET_HOME = process.env.YEET_HOME ?? join(homedir(), ".yeet");
export const AGENTS_DIR = join(YEET_HOME, "agents");
export const LAUNCHER = join(YEET_HOME, "bin", "yeet-vm");
export const CURRENT_IMAGE = join(YEET_HOME, "images", "current");
/** Where cloned rootfs trees go to die. Beside the agent dirs, never inside one — the agent dir
 *  is mounted into the guest, so a doomed 563 MB tree in there would be visible to the agent. */
export const TRASH_DIR = join(YEET_HOME, "trash");

/** macOS: libkrun dlopen()s libkrunfw by leaf name at runtime, so it is invisible to
 *  otool -L and unreachable via -rpath (libkrunfw's install name is absolute) — every spawn
 *  of the launcher must carry DYLD_LIBRARY_PATH or it dies with "Couldn't find or load
 *  libkrunfw.5.dylib". Linux: the same dlopen is resolved by ldconfig, since distro packages
 *  and `make install` both land in the ld.so search path, so no override is needed. */
export function launcherEnv(): Record<string, string> {
  if (!IS_MAC) return {};
  const prefix = Bun.spawnSync(["brew", "--prefix"]).stdout.toString().trim() || "/opt/homebrew";
  return { DYLD_LIBRARY_PATH: `${prefix}/lib` };
}
