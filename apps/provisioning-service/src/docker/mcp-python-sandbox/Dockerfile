FROM python:3.12-slim

# Install Python data science + document parsing packages
RUN pip install --no-cache-dir \
    fastapi \
    uvicorn \
    pandas \
    matplotlib \
    numpy \
    seaborn \
    openpyxl \
    pdfplumber \
    python-docx

COPY server.py /app/server.py

WORKDIR /app

# Create output directory for code execution
RUN mkdir -p /tmp/output

EXPOSE 8080

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
