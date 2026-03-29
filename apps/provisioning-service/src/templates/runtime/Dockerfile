FROM python:3.12-slim

WORKDIR /agent

# Platform deps (fixed, always present)
COPY platform-requirements.txt .
RUN pip install --no-cache-dir -r platform-requirements.txt

# Creator deps (from their package)
COPY requirements.txt ./creator-requirements.txt
RUN pip install --no-cache-dir -r creator-requirements.txt

# Copy all code (adapter + creator files)
COPY . .

RUN mkdir -p /data

EXPOSE 4000

CMD ["python", "adapter.py"]
