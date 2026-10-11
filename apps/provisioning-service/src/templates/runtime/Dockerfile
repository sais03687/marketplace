# Agent image, built in two stages.
#
# BUILD stage: has git, curl/wget, a C/C++/Fortran toolchain and CMake, so a
# creator can depend on packages that are only on GitHub or have to be
# compiled — many build scripts fetch their own sources with curl or wget
# (Ipopt's MUMPS does, and fails without one) — and can
# ship an optional build.sh for anything pip cannot do (a C++ library with
# Python bindings, say). This stage has the internet and runs creator-supplied
# code — pip's setup.py and build.sh — so it holds no secrets: keys only ever
# reach the running container, at start-up, from the platform.
#
# RUNTIME stage: the slim image the agent actually runs in. It receives the
# installed packages and the creator's folder (including anything build.sh
# produced) and nothing else — no compilers, no git, no apt cache. A toolchain
# left at runtime would hand every agent the means to build whatever it liked
# inside a buyer's deployment; leaving it behind costs nothing.
FROM python:3.12-slim AS build

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         git build-essential gfortran cmake pkg-config curl wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Platform deps, then the creator's, into a prefix copied whole into the runtime
# stage. Sequential installs keep pip's normal meaning: the creator's
# requirements are resolved against what the platform already installed.
COPY platform-requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r platform-requirements.txt

COPY creator/ ./creator/
RUN if [ -f creator/requirements.txt ]; then \
      PYTHONPATH=/install/lib/python3.12/site-packages \
      pip install --no-cache-dir --prefix=/install -r creator/requirements.txt; \
    fi

# The optional build step runs as an unprivileged user, in the creator's own
# folder, and can only leave its results there.
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin builder \
    && chown -R builder:builder /build/creator
USER builder
RUN if [ -f creator/build.sh ]; then \
      cd creator && PYTHONPATH=/install/lib/python3.12/site-packages sh ./build.sh; \
    fi
USER root


FROM python:3.12-slim

# Shared libraries that compiled code commonly links against at runtime
# (OpenMP, the Fortran runtime). Libraries only — no compilers.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgomp1 libgfortran5 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /agent

COPY --from=build /install /usr/local
COPY --from=build /build/creator/ ./creator/

# System libraries the creator's packages load at runtime, from the manifest's
# systemPackages (e.g. SUMO's Python bindings link X11 and OpenGL). Debian
# packages only, validated again here — names, at most 25 — and installed as
# root before the switch to the agent's user below. A list that fails the check
# fails the build rather than being skipped.
RUN pkgs="$(python -c 'import json,re,sys; p=json.load(open("creator/marketplace.json")).get("systemPackages") or []; ok=isinstance(p,list) and len(p)<=25 and all(isinstance(x,str) and re.fullmatch(r"[a-z0-9][a-z0-9+.-]{1,62}",x) for x in p); print(" ".join(p)) if ok else sys.exit("systemPackages must be a list of at most 25 Debian package names")')" \
    && if [ -n "$pkgs" ]; then \
         apt-get update \
         && apt-get install -y --no-install-recommends $pkgs \
         && rm -rf /var/lib/apt/lists/*; \
       fi

# Platform adapter at WORKDIR root (NOT inside creator/)
COPY adapter.py .
COPY platform_llm.py .
COPY platform-requirements.txt .

RUN mkdir -p /data

# Run creator code as an unprivileged user, never root. Capabilities are already
# dropped (CapDrop: ALL) and egress is proxied; this closes the last easy win by
# ensuring a bug or a hostile dependency in creator code is a non-root process,
# not root inside the container. The agent binds 4000 (above the privileged
# range) and writes only /data and /agent/creator, both owned by this user below.
#
# NOTE: a FRESH named volume for /data inherits this ownership on first mount; an
# EXISTING root-owned volume (e.g. reprovisioning a deployment created before the
# non-root change) must be chowned once —
#   docker run --rm -v <vol>:/data busybox chown -R 10001:10001 /data
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin agent \
    && chown -R agent:agent /agent /data
USER agent

EXPOSE 4000

CMD ["python", "adapter.py"]
