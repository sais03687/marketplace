FROM python:3.12-slim

WORKDIR /agent

# Platform deps (fixed, always present)
COPY platform-requirements.txt .
RUN pip install --no-cache-dir -r platform-requirements.txt

# Creator deps — fail loudly if requirements.txt is present but broken
# (if requirements.txt is absent the layer is skipped gracefully)
COPY creator/ ./creator/
RUN if [ -f creator/requirements.txt ]; then \
      pip install --no-cache-dir -r creator/requirements.txt; \
    fi

# Copy platform adapter to WORKDIR root (NOT inside creator/)
COPY adapter.py .
COPY platform-requirements.txt .

# Copy creator code into subdirectory (already copied above for deps — idempotent)

RUN mkdir -p /data

# Run creator code as an unprivileged user, never root. Capabilities are already
# dropped (CapDrop: ALL) and egress is proxied; this closes the last easy win by
# ensuring a bug or a hostile dependency in creator code is a non-root process,
# not root inside the container. The agent binds 4000 (above the privileged
# range) and writes only /data and /agent/creator, both owned by this user below.
#
# pip install ran above as root, before this switch, so build-time dependency
# installation is unaffected. NOTE: a FRESH named volume for /data inherits this
# ownership on first mount; an EXISTING root-owned volume (e.g. reprovisioning a
# deployment created before this change) must be chowned once —
#   docker run --rm -v <vol>:/data busybox chown -R 10001:10001 /data
RUN useradd --uid 10001 --create-home --shell /usr/sbin/nologin agent \
    && chown -R agent:agent /agent /data
USER agent

EXPOSE 4000

CMD ["python", "adapter.py"]
