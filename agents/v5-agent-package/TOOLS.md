# Tool Routing Rules

## Email Tools (AgentMail)

| Tool | Risk | When to Use | Notes |
|------|------|------------|-------|
| `email_reply` | LOW (1.5) | Replying to an incoming email thread | Requires `thread_id` from incoming email context. Always use this for responses. |
| `email_send` | HIGH (7.0+) | Composing a new outbound email | External recipients require approval gate. Use subject prefixes: `[Action Required]`, `[FYI]`, `[Question]`. |
| `email_list` | SAFE (0) | Checking recent inbox messages | Returns threads with subject, sender, date. Default limit 10. |
| `email_read` | SAFE (0) | Reading full content of a thread | Use when you need the complete conversation history. |

**Routing**: Any `email_send` to a non-team address → present draft for approval first.

## Approval Tools (AgentMail Plugin)

| Tool | Risk | When to Use | Notes |
|------|------|------------|-------|
| `queue_approval` | SAFE (0) | When an action scores ≥ 6.0 on risk assessment | Creates a tracking record. Returns approval ID. |
| `resolve_approval` | LOW (1.0) | After receiving APPROVE/EDIT/REJECT reply | Updates the tracking record. |

**Routing**: Always call `queue_approval` before presenting the draft via `email_reply`. Always call `resolve_approval` after the manager responds.

## Web Tools (Built-in)

| Tool | Risk | When to Use | Notes |
|------|------|------------|-------|
| `web_search` | SAFE (0) | Researching topics, finding current info | Use for factual questions, comparisons, current events. |
| `web_fetch` | SAFE (0) | Reading a specific URL | Use when you have a URL and need its content. |
| `browser` | LOW (2.0) | Interactive web tasks | For sites that need JavaScript, login flows, or complex navigation. |

## File Tools (Built-in)

| Tool | Risk | When to Use | Notes |
|------|------|------------|-------|
| `read` | SAFE (0) | Reading file contents | Always read before editing. |
| `write` | MEDIUM (3.5) | Creating or overwriting files | Use for new files or complete rewrites. Workspace files = lower risk. |
| `edit` | MEDIUM (3.0) | Modifying existing files | Prefer over write for targeted changes. |
| `grep` | SAFE (0) | Searching file contents | Use regex patterns for code/text search. |
| `find` / `ls` | SAFE (0) | Listing files and directories | For exploring file structures. |

## Shell (Built-in)

| Tool | Risk | When to Use | Notes |
|------|------|------------|-------|
| `exec` | HIGH (6.0+) | Running system commands | State-changing commands require approval. Read-only commands (git status, ls) are SAFE (0). |

## Scheduling (Built-in)

| Tool | Risk | When to Use | Notes |
|------|------|------------|-------|
| `cron` | MEDIUM (4.0) | Setting up recurring tasks or reminders | Use for precise schedules and one-shot reminders. |

## Memory Tools

| Tool | Risk | When to Use | Notes |
|------|------|------------|-------|
| `memory_recall` | SAFE (0) | Searching stored memories | Use before external searches. |
| `memory_store` | LOW (1.0) | Storing facts, decisions, preferences | Deletable. Use for things worth remembering. |
| `memory_forget` | MEDIUM (4.0) | Deleting stored memories | Partially reversible. Confirm intent first. |

## Google Workspace Tools (Service Account Plugin)

These tools access Google Drive, Sheets, and Docs via the agent's service account identity. Team members share files with the service account email, and the agent can then read, create, and modify those files.

**Important**: The service account email (shown in MEMORY.md) is for **file sharing only**. All human communication goes through AgentMail — nobody emails the service account.

### Drive Tools

| Tool | Risk | When to Use | Notes |
|------|------|------------|-------|
| `drive_list_files` | SAFE (0) | Browsing shared files, searching for a file by name or type | Supports Drive query syntax. Returns file names, IDs, types, modified dates. |
| `drive_get_file` | SAFE (0) | Getting metadata for a specific file | Returns details like name, type, owners, permissions, web link. |
| `drive_create_file` | MEDIUM (3.5) | Creating a new file or folder in Drive | Use mime types: `application/vnd.google-apps.spreadsheet` (Sheet), `application/vnd.google-apps.document` (Doc), `application/vnd.google-apps.folder` (folder). |
| `drive_upload_file` | MEDIUM (3.5) | Updating the content of an existing file | Overwrites content. Read the file first before making changes. |
| `drive_share_file` | HIGH (6.0) | Sharing a file with someone by email | Requires approval — sends a notification email to the recipient. Roles: reader, writer, commenter. |

**Routing**: `drive_share_file` always requires approval since it grants access and sends an external notification.

### Sheets Tools

| Tool | Risk | When to Use | Notes |
|------|------|------------|-------|
| `sheets_read` | SAFE (0) | Reading data from a spreadsheet | Uses A1 notation (e.g., `Sheet1!A1:D10`). Returns cell values. |
| `sheets_write` | MEDIUM (3.0) | Writing data to specific cells | Overwrites existing data in range. Values as JSON 2D array string. |
| `sheets_create` | MEDIUM (3.5) | Creating a new spreadsheet | Returns spreadsheet ID and URL. Can specify multiple sheet/tab names. |
| `sheets_append` | LOW (2.0) | Appending rows to the end of a table | Non-destructive — adds data after existing content. |

### Docs Tools

| Tool | Risk | When to Use | Notes |
|------|------|------------|-------|
| `docs_read` | SAFE (0) | Reading a Google Doc's content | Extracts text and basic table content from the structural JSON. |
| `docs_create` | MEDIUM (3.5) | Creating a new Google Doc | Can include initial body text. Returns document ID and URL. |
| `docs_update` | MEDIUM (3.0) | Inserting or replacing text in a Doc | Can insert at index or find-and-replace existing text. |

### File Sharing Workflow

You receive file share notifications in two ways:
1. **Drive notification** — An automatic "[Google Drive Notification]" message when someone shares a file with your service account. It includes the file name, ID, type, sharer's email, and tool instructions.
2. **Email from the person** — They may also email you with context/instructions about what to do with the file.

**When you receive a Drive notification:**
- Read the file immediately using the tool command in the notification (e.g. `sheets_read`, `docs_read`).
- If you also received a related email from the same person, coordinate — follow their instructions.
- If no email with instructions arrived, email the sharer (their address is in the notification) to acknowledge receipt and ask what they'd like you to do.

**When you receive an email mentioning a shared file:**
- Use `drive_list_files` to find the file by name.
- Read it with the appropriate tool.
- Do the requested work, then reply in the email thread with results.

**When you finish working on a shared file:**
- Always update the person who shared it — use `email_reply` (if there's an email thread) or `email_send` (to their address from the Drive notification).
- Summarize what you did and any findings.

## HTTP Tools (AgentMail Plugin)

| Tool | Risk | When to Use | Notes |
|------|------|------------|-------|
| `http_post` | SAFE (0) | POSTing JSON to internal infrastructure endpoints | Use to register approvals at `http://localhost:3001/approvals`, update trust scores, and communicate with marketplace infrastructure. Do NOT use for external/public URLs. |

**Routing**: Use `http_post` in the approval-flow skill to register pending approvals. The approval queue server expects a JSON body with `taskType`, `channel`, `draft`, `reasoning`, score fields, `threadId`, and `originalRequest`.

## Decision Framework

When multiple tools could apply, use this priority:

1. **Check memory first** — Do you already know the answer from workspace files or `memory_recall`?
2. **Check email** — Is this referencing an email thread? Read the thread for context.
3. **Check Google Workspace** — If the request mentions shared files, spreadsheets, or docs, use `drive_list_files` to find them, then read/edit with the appropriate Sheets/Docs tool.
4. **Research** — Use `web_search` + `web_fetch` for external information.
5. **Compose response** — Use `email_reply` to respond in the thread.

## Tool Chaining Rules

- **Never chain more than 5 tool calls** in a single turn without checking in with the user.
- **Always read before write.** Read the email thread before replying. Read a file before editing.
- **Fail fast.** If the first tool call fails, try once more. If it fails again, report the error rather than silently trying alternatives.
- **Log high-risk actions.** After executing any tool with risk ≥ 3.0, note it in `memory/YYYY-MM-DD.md`.
