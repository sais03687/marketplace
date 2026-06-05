# Data Analyst — Tool Routing Guide

## Microsoft 365 tools (built-in)

These are available directly in your code via `microsoft_tools.py`:

### SharePoint / File Storage
- `drive_ensure_folder()` — Create your agent folder on SharePoint
- `drive_upload(filename, content)` — Upload files to your SharePoint folder
- `drive_list(subfolder)` — List files in your folder
- `drive_search(query)` — Search SharePoint for files
- `drive_get_file(item_id)` — Get file metadata
- `drive_read_text(item_id)` — Download and read a file's text content

### Excel
- `excel_read(item_id, sheet, range)` — Read data from an Excel workbook
- `excel_write(item_id, sheet, range, values)` — Write data to Excel
- `excel_append(item_id, sheet, values)` — Append rows to an Excel sheet

### Calendar
- `calendar_list(days_ahead)` — List upcoming calendar events
- `calendar_create(summary, start, end, ...)` — Create calendar events
- `calendar_update(event_id, ...)` — Update calendar events
- `calendar_delete(event_id)` — Delete calendar events

### Batch operations
- `execute_reads(requests)` — Execute multiple read operations at once
- `execute_writes(writes)` — Execute multiple write operations at once

## MCP tools (via mcp_fn)

These are available through `mcp_fn(server_type, tool_name, arguments)`:

### python-sandbox
- `execute_python` — Run Python code with pandas, matplotlib, numpy, seaborn, openpyxl
  - Write output files to `/tmp/output/` and they'll be returned as base64
  - Use `MPLBACKEND=Agg` (already set) for matplotlib
  - 30s timeout, print results to stdout
- `parse_pdf` — Extract text and tables from a PDF (pass base64-encoded content)
- `parse_docx` — Extract text from a Word document (pass base64-encoded content)
- `parse_xlsx` — Extract sheet data from Excel as JSON (pass base64-encoded content)

## Platform functions (injected by adapter)

- `approve_fn(...)` — Queue an action for manager approval
- `resolve_fn(approval_id)` — Wait for approval resolution
- `contribute_fn(type, title, content, tags)` — Share a learning with AgentMind
- `search_fn(query)` — Search AgentMind for relevant knowledge
- `use_fn(contribution_ids)` — Report which AgentMind contributions you used
- `request_decision_fn(question, context, options, urgency)` — Ask the manager a question and wait for their answer. Use this for:
  - High-level decisions: "Should I include revenue projections in the external report?"
  - Ambiguous instructions: "The data shows two possible interpretations — which should I use?"
  - Scope decisions: "This analysis could go deeper into regional breakdown — should I?"
  - Sensitive actions: "I'd like to email the external auditor — here's my draft. Proceed?"

## Tool selection guide

| Task | Tools to use |
|------|-------------|
| Analyze a CSV/Excel dataset | `drive_read_text` or `excel_read` → `mcp_fn("python-sandbox", "execute_python", ...)` |
| Create a chart | `mcp_fn("python-sandbox", "execute_python", ...)` → `drive_upload(...)` |
| Parse a PDF report | `mcp_fn("python-sandbox", "parse_pdf", ...)` |
| Build an Excel report | `mcp_fn("python-sandbox", "execute_python", ...)` → `drive_upload(...)` |
| Ask teammate for data | `send_email` (goes through approval queue if external) |
| Update task tracker | `excel_append(...)` or `excel_write(...)` |
| Schedule a meeting | `calendar_create(...)` |
| Ask manager for a decision | `request_decision` — question + context + options |
| Clarify ambiguous instructions | `request_decision` with urgency="normal" |
| Get approval for sensitive action | `request_decision` with urgency="high" |
