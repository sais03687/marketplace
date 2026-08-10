FROM python:3.12-slim

# Install Python data science + document parsing packages.
#
# Everything must be baked in: the sandbox sits on the agent's Internal network
# and has no route out, so `pip install` at runtime hangs until the 30s timeout
# rather than failing usefully.
#
# Kept deliberately light. The sandbox runs under a 256 MB hard limit, and
# scipy or statsmodels import at roughly 80 MB of RSS before doing any work —
# alongside pandas and matplotlib that is close enough to the ceiling to turn a
# normal analysis into an OOM kill, which surfaces as an unexplained restart
# rather than a traceback. Revisit together with the memory limit, not alone.
RUN pip install --no-cache-dir \
    fastapi \
    uvicorn \
    pandas \
    matplotlib \
    numpy \
    seaborn \
    openpyxl \
    xlsxwriter \
    xlrd \
    tabulate \
    charset-normalizer \
    pdfplumber \
    python-docx

COPY server.py /app/server.py

WORKDIR /app

# Create output directory for code execution
RUN mkdir -p /tmp/output

EXPOSE 8080

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
