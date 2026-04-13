FROM python:3.12-slim

WORKDIR /agent

# Platform deps (fixed, always present)
COPY platform-requirements.txt .
RUN pip install --no-cache-dir -r platform-requirements.txt

# Creator deps (from their package)
COPY creator/requirements.txt ./creator-requirements.txt
RUN pip install --no-cache-dir -r creator-requirements.txt || true

# Copy platform adapter to WORKDIR root (NOT inside creator/)
COPY adapter.py .
COPY platform-requirements.txt .

# Copy creator code into subdirectory
COPY creator/ ./creator/

RUN mkdir -p /data

EXPOSE 4000

CMD ["python", "adapter.py"]
