#!/usr/bin/env bash
#
# Build the yeet guest image (macOS / Apple Silicon, no Docker).
#
#   Ubuntu 24.04 arm64 base (glibc — pi ships a Node binary that needs it)
#   + pi (the coding agent)
#   + git + ca-certificates   (installed in-guest via apt over TSI networking)
#   + bun + node              (fetched on the HOST and copied in; see "toolchain" below)
#   + /yeet mountpoint and the baked yeet-init
#
# Output: $YEET_HOME/images/base-<digest>/, then an atomic flip of the `current` symlink.
# Re-running with the same recipe is a no-op unless --force.
#
# Two things the spike got wrong that are fixed here:
#   * apt leaves 313 MB of lists/caches behind (187M /var/lib/apt + 126M /var/cache/apt).
#     Cleaning halves both image size and file count, which directly halves clonefile cost.
#   * The guest had NO node/bun/python/cargo/gcc/curl/ca-certificates, so any real project's
#     verify command exited 127. That made a verify loop impossible.
#
# Toolchain note: we deliberately fetch bun and node on the *host* rather than
# `curl | bash` in the guest. The bootstrap ordering there is a trap — installing bun that
# way needs ca-certificates AND curl, and the minimal rootfs has neither, so you would have
# to apt them first purely to install something we can just copy in. Host-side fetch also
# keeps the image build reproducible and offline-able.
set -euo pipefail
cd "$(dirname "$0")"

YEET_HOME="${YEET_HOME:-$HOME/.yeet}"
UBUNTU_URL="https://cdimage.ubuntu.com/ubuntu-base/releases/24.04/release/ubuntu-base-24.04.4-base-arm64.tar.gz"
PI_VER="v0.82.0"
PI_URL="https://github.com/badlogic/pi-mono/releases/download/${PI_VER}/pi-linux-arm64.tar.gz"
BUN_URL="https://github.com/oven-sh/bun/releases/latest/download/bun-linux-aarch64.zip"
NODE_VER="v22.17.0"
NODE_URL="https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-arm64.tar.xz"
GO_VER="1.23.4"
GO_URL="https://go.dev/dl/go${GO_VER}.linux-arm64.tar.gz"
RUST_VER="1.83.0"
RUST_URL="https://static.rust-lang.org/dist/rust-${RUST_VER}-aarch64-unknown-linux-gnu.tar.xz"
UV_URL="https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-unknown-linux-gnu.tar.gz"
# One list, referenced in the digest below, so editing it forces a rebuild. build-essential
# is not optional garnish: rust cannot LINK without a system cc, and cgo and node-gyp need it
# too — a toolchain that compiles but cannot link is worse than none, because the agent only
# finds out at the end of its first build.
APT_PKGS="git ca-certificates build-essential python3 python3-pip python3-venv"

LAUNCHER="$YEET_HOME/bin/yeet-vm"
STAGE="$YEET_HOME/images/.build-$$"
export DYLD_LIBRARY_PATH="$(brew --prefix)/lib"

log() { printf '\033[36m▪\033[0m %s\n' "$*"; }

# Report where we died before cleaning up — a bare `set -e` exit that silently removes the
# stage directory is indistinguishable from success if the caller pipes stdout somewhere.
fail() { echo "setup: FAILED at line $1" >&2; [ -d "$STAGE" ] && rm -rf "$STAGE"; exit 1; }
trap 'fail $LINENO' ERR
trap '[ -d "$STAGE" ] && rm -rf "$STAGE"' INT TERM

# ── launcher ────────────────────────────────────────────────────────────────────────────
log "building launcher"
make -C launcher >/dev/null
mkdir -p "$YEET_HOME/bin" "$YEET_HOME/images"
cp launcher/yeet-vm "$LAUNCHER"

# The image is only usable through a VM boot, so prove the launcher works before spending
# minutes on downloads.
codesign -d --entitlements - "$LAUNCHER" 2>&1 | grep -q hypervisor \
  || { echo "setup: launcher is missing the hypervisor entitlement" >&2; exit 1; }

# ── base rootfs ─────────────────────────────────────────────────────────────────────────
mkdir -p "$STAGE"
log "ubuntu 24.04 base rootfs"
curl -fsSL "$UBUNTU_URL" | tar -xz -C "$STAGE" 2>/dev/null

log "pi ${PI_VER}"
tmp=$(mktemp -d)
curl -fsSL "$PI_URL" | tar -xz -C "$tmp"
mkdir -p "$STAGE/opt" "$STAGE/usr/local/bin"
cp -R "$tmp/pi" "$STAGE/opt/pi"
ln -sf /opt/pi/pi "$STAGE/usr/local/bin/pi"
rm -rf "$tmp"

log "bun + node (host-fetched)"
tmp=$(mktemp -d)
curl -fsSL -o "$tmp/bun.zip" "$BUN_URL"
unzip -qo "$tmp/bun.zip" -d "$tmp"
install -m 0755 "$tmp"/bun-linux-aarch64/bun "$STAGE/usr/local/bin/bun"
ln -sf /usr/local/bin/bun "$STAGE/usr/local/bin/bunx"
curl -fsSL "$NODE_URL" | tar -xJ -C "$tmp"
cp -R "$tmp/node-${NODE_VER}-linux-arm64" "$STAGE/opt/node"
ln -sf /opt/node/bin/node "$STAGE/usr/local/bin/node"
ln -sf /opt/node/bin/npm "$STAGE/usr/local/bin/npm"
ln -sf /opt/node/bin/npx "$STAGE/usr/local/bin/npx"
rm -rf "$tmp"

# Go, Rust, uv — same host-fetch pattern as bun/node, same reasoning: no bootstrap ordering
# traps, reproducible, offline-able. Python itself comes from apt below (Ubuntu 24.04 ships
# 3.12); uv is the installer agents actually reach for now, and it is one static binary.
log "go ${GO_VER} (host-fetched)"
tmp=$(mktemp -d)
curl -fsSL "$GO_URL" | tar -xz -C "$tmp"
cp -R "$tmp/go" "$STAGE/opt/go"
ln -sf /opt/go/bin/go "$STAGE/usr/local/bin/go"
ln -sf /opt/go/bin/gofmt "$STAGE/usr/local/bin/gofmt"
rm -rf "$tmp"

log "rust ${RUST_VER} (host-fetched)"
tmp=$(mktemp -d)
curl -fsSL "$RUST_URL" | tar -xJ -C "$tmp"
# The standalone installer is pure file operations, so it runs fine on the macOS host
# against the stage dir. --without=rust-docs saves ~600 MB nobody in a VM will read.
"$tmp/rust-${RUST_VER}-aarch64-unknown-linux-gnu/install.sh"   --destdir="$STAGE" --prefix=/usr/local --disable-ldconfig --without=rust-docs >/dev/null
rm -rf "$tmp"

log "uv (host-fetched)"
tmp=$(mktemp -d)
curl -fsSL "$UV_URL" | tar -xz -C "$tmp" --strip-components=1
install -m 0755 "$tmp/uv" "$STAGE/usr/local/bin/uv"
install -m 0755 "$tmp/uvx" "$STAGE/usr/local/bin/uvx" 2>/dev/null || true
rm -rf "$tmp"

# ── guest config ────────────────────────────────────────────────────────────────────────
log "dns, git identity, mountpoints, init"
printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$STAGE/etc/resolv.conf"
mkdir -p "$STAGE/yeet"

# git runs as root in the guest against a virtiofs tree owned by the host user, so mark it
# safe; also give commits an identity, since the guest is what actually commits (only it
# sees correct file modes — see the override_stat xattr note in yeet-vm.c).
cat > "$STAGE/root/.gitconfig" <<'GIT'
[safe]
	directory = *
[user]
	name = yeet
	email = yeet@vm
[init]
	defaultBranch = main
GIT

# yeet-init is the ONLY thing baked into the image, because it has to exist before /yeet is
# mounted. The per-iteration runner is staged into run state instead, so iterating on it
# never requires rebuilding the image.
cat > "$STAGE/usr/local/bin/yeet-init" <<'INIT'
#!/bin/bash
# Mount what the launcher announced, then exec the payload.
# libkrun's own init mounts /dev /dev/pts /dev/shm /proc /sys /sys/fs/cgroup — but NOT /tmp,
# and it does not auto-mount extra virtiofs tags.
set -eu
mount -t tmpfs tmpfs /tmp 2>/dev/null || true
if [ -n "${YEET_MOUNTS:-}" ]; then
  IFS=,
  for m in $YEET_MOUNTS; do
    tag=${m%%=*}
    dir="/${tag}"
    mkdir -p "$dir"
    mount -t virtiofs "$tag" "$dir"
  done
  unset IFS
fi
exec "$@"
INIT
chmod +x "$STAGE/usr/local/bin/yeet-init"

# ── in-guest provisioning ───────────────────────────────────────────────────────────────
# apt needs its sandbox user disabled on a minimal rootfs, and the base image ships no
# signed lists, hence AllowUnauthenticated. ca-certificates matters beyond apt: without it
# node/bun cannot make HTTPS calls, so `npm install` during a project's tests would fail.
log "installing ${APT_PKGS} inside the VM"
"$LAUNCHER" --root "$STAGE" -- /usr/bin/apt-get \
  -o APT::Sandbox::User=root -o Acquire::AllowInsecureRepositories=true update >/dev/null 2>&1
# shellcheck disable=SC2086 — the list is deliberately word-split
"$LAUNCHER" --root "$STAGE" -- /usr/bin/apt-get \
  -o APT::Sandbox::User=root -o APT::Get::AllowUnauthenticated=true \
  install -y --no-install-recommends $APT_PKGS >/dev/null 2>&1

log "warming pi's model catalog inside the VM"
"$LAUNCHER" --root "$STAGE" -- /usr/local/bin/pi update --models >/dev/null 2>&1 || true

# ── shrink ──────────────────────────────────────────────────────────────────────────────
# Do this last: apt must be usable up to this point. Halves clonefile cost per iteration.
log "cleaning apt caches"
before=$(du -sm "$STAGE" | cut -f1)
rm -rf "$STAGE/var/lib/apt/lists"/* "$STAGE/var/cache/apt/archives"/*.deb \
       "$STAGE/var/cache/apt"/*.bin "$STAGE/usr/share/doc" "$STAGE/usr/share/man" 2>/dev/null || true
after=$(du -sm "$STAGE" | cut -f1)
log "image ${before}MB → ${after}MB"

# ── verify before publishing ────────────────────────────────────────────────────────────
# The probe is a FILE, never inline shell. libkrun's argv transport corrupts any argument
# containing both '"' and '$' (it re-splits on internal spaces) — see the note in yeet-vm.c.
# An inline probe here is what silently failed the first build.
log "verifying toolchain in-guest"
cat > "$STAGE/usr/local/bin/yeet-probe" <<'PROBE'
#!/bin/bash
for b in git bun node npm pi python3 pip3 uv go gofmt cargo rustc cc; do
  if command -v "$b" >/dev/null 2>&1; then echo "$b ok"; else echo "$b MISSING"; fi
done
PROBE
chmod +x "$STAGE/usr/local/bin/yeet-probe"

probe=$("$LAUNCHER" --root "$STAGE" -- /usr/local/bin/yeet-probe 2>/dev/null) || true
echo "$probe" | sed 's/^/    /'
if [ -z "$probe" ] || echo "$probe" | grep -q MISSING; then
  echo "setup: toolchain incomplete, not publishing image" >&2
  exit 1
fi

# ── publish ─────────────────────────────────────────────────────────────────────────────
digest=$(printf '%s' "$UBUNTU_URL$PI_URL$BUN_URL$NODE_URL$GO_URL$RUST_URL$UV_URL$APT_PKGS" | shasum -a 256 | cut -c1-12)
dest="$YEET_HOME/images/base-$digest"
rm -rf "$dest"
mv "$STAGE" "$dest"
cat > "$dest/.yeet-image.json" <<META
{"digest":"$digest","builtAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","ubuntu":"24.04","pi":"$PI_VER","node":"$NODE_VER","go":"$GO_VER","rust":"$RUST_VER","sizeMb":$after}
META

ln -sfn "$dest" "$YEET_HOME/images/current.tmp"
# -h is load-bearing: without it, BSD mv follows a symlink-to-directory DESTINATION and moves
# the tmp link INSIDE the old image instead of replacing the link. Latent on every fresh
# install (no `current` yet) and guaranteed on the first rebuild — which is exactly how it
# was found: a 2.4 GB image built, verified, published, and then never became current.
mv -fh "$YEET_HOME/images/current.tmp" "$YEET_HOME/images/current"
touch "$YEET_HOME/.metadata_never_index"   # keep Spotlight off a Linux rootfs

log "image ready: $dest"
log "current -> $(readlink "$YEET_HOME/images/current")"
