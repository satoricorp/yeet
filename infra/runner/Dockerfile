# The yeet cloud runner — the guest image, re-expressed as a container.
#
# Full toolchain parity with guest/setup.sh, same versions, same reasoning: partial parity is
# the confusing kind of lie ("works locally, fails in cloud" with no error explaining why).
# The cost is a ~1.5 GB image and a slower cold pull; that is a documented trade, not an
# accident, and SOCI lazy-pull is the later fix if launch latency ever matters.
#
# Isolation comes from Fargate itself (every task is an AWS Firecracker microVM), which is
# why this needs no libkrun: the walls are Amazon's, the contract inside is unchanged.
#
# Build for linux/arm64 — pi, bun and the task definition are all ARM:
#   docker buildx build --platform linux/arm64 -t yeet-runner .
FROM ubuntu:24.04

ARG PI_VER=v0.82.0
ARG NODE_VER=v22.17.0
ARG GO_VER=1.23.4
ARG RUST_VER=1.83.0

# Same package list as guest/setup.sh's APT_PKGS, plus what a container needs that a VM got
# from the host side: curl/unzip/xz to fetch toolchains, awscli for `yeet sync`'s S3 half.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates build-essential python3 python3-pip python3-venv \
      curl unzip xz-utils awscli \
    && rm -rf /var/lib/apt/lists/*

# pi — the coding agent
RUN curl -fsSL "https://github.com/badlogic/pi-mono/releases/download/${PI_VER}/pi-linux-arm64.tar.gz" \
      | tar -xz -C /tmp \
    && cp -R /tmp/pi /opt/pi && ln -sf /opt/pi/pi /usr/local/bin/pi && rm -rf /tmp/pi

# bun + node
RUN curl -fsSL -o /tmp/bun.zip "https://github.com/oven-sh/bun/releases/latest/download/bun-linux-aarch64.zip" \
    && unzip -qo /tmp/bun.zip -d /tmp \
    && install -m 0755 /tmp/bun-linux-aarch64/bun /usr/local/bin/bun \
    && ln -sf /usr/local/bin/bun /usr/local/bin/bunx && rm -rf /tmp/bun*
RUN curl -fsSL "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-arm64.tar.xz" \
      | tar -xJ -C /opt \
    && mv "/opt/node-${NODE_VER}-linux-arm64" /opt/node \
    && ln -sf /opt/node/bin/node /usr/local/bin/node \
    && ln -sf /opt/node/bin/npm /usr/local/bin/npm \
    && ln -sf /opt/node/bin/npx /usr/local/bin/npx

# go + rust + uv — the toolchains added to the guest image in the same commit as this file
RUN curl -fsSL "https://go.dev/dl/go${GO_VER}.linux-arm64.tar.gz" | tar -xz -C /opt \
    && ln -sf /opt/go/bin/go /usr/local/bin/go && ln -sf /opt/go/bin/gofmt /usr/local/bin/gofmt
RUN curl -fsSL "https://static.rust-lang.org/dist/rust-${RUST_VER}-aarch64-unknown-linux-gnu.tar.xz" \
      | tar -xJ -C /tmp \
    && "/tmp/rust-${RUST_VER}-aarch64-unknown-linux-gnu/install.sh" \
         --prefix=/usr/local --disable-ldconfig --without=rust-docs >/dev/null \
    && rm -rf /tmp/rust-*
RUN curl -fsSL "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-unknown-linux-gnu.tar.gz" \
      | tar -xz -C /tmp --strip-components=1 \
    && install -m 0755 /tmp/uv /usr/local/bin/uv && rm -f /tmp/uv*

# git identity, matching guest/setup.sh: the runner is what commits, and commits need a name.
RUN git config --global safe.directory '*' \
    && git config --global user.name yeet \
    && git config --global user.email yeet@cloud \
    && git config --global init.defaultBranch main

# The SAME per-iteration runner the VM executes — the whole point of the file contract.
COPY yeet-run /usr/local/bin/yeet-run
COPY entry.sh /usr/local/bin/yeet-cloud-entry
RUN chmod +x /usr/local/bin/yeet-run /usr/local/bin/yeet-cloud-entry

ENTRYPOINT ["/usr/local/bin/yeet-cloud-entry"]
