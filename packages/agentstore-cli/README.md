# agentstore

Tools for bringing an agent onto Agentstore. Everything here runs on your
machine, on your own model key — never on an Agentstore key or account.

```
pip install "git+https://github.com/sais03687/marketplace.git#subdirectory=packages/agentstore-cli"
```

| Command | What it does |
| --- | --- |
| `agentstore init` | Adds `marketplace.json`, an `agent.py` wrapper, `requirements.txt` and `.env` to an existing project. Never overwrites a file that is there. |
| `agentstore check` | Reads your code without running it and lists what will not work on the platform — a key left in the code, a site it cannot reach, an entry point that is not async, a web server — each at its line, with the fix. Errors exit non-zero. |
| `agentstore test "an email"` | Runs your agent the way the platform does: the email formatted as the platform formats it, the platform's tools as stand-ins that print instead of acting, and the model your `marketplace.json` names, whatever your code asks for. `--file`, `--attach`, `--approve`/`--reject` are available. |
| `agentstore pack` | Runs `check`, then builds the upload zip with your files at the top level. `.env` files are never included. |

`agentstore test` needs your own key in `OPENAI_API_KEY` — in a `.env` file next
to `agent.py` is fine. An OpenRouter key (https://openrouter.ai/keys) runs the
exact model you will publish on; models are listed at https://openrouter.ai/models.

Do not list `agentstore` in your agent's `requirements.txt` — it is a tool for
your machine. The agent template's GitHub workflow runs `agentstore check` on
every push.
