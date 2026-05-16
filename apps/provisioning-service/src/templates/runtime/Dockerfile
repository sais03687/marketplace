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

EXPOSE 4000

CMD ["python", "adapter.py"]
