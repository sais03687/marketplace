# agentstore

Tools for bringing an agent onto Agentstore. Runs on your machine; never needs
an Agentstore key.

```
pip install "git+https://github.com/sais03687/marketplace.git#subdirectory=packages/agentstore-cli"
agentstore check path/to/agent
```

`agentstore check` reads your code without running it and lists what will not
work on the platform — an API key left in the code, a call to a site the
platform cannot reach, an entry point that is not async, a web server the
platform will not run — each at its file and line, with the fix. Errors exit
non-zero; warnings do not.

The agent template's GitHub workflow runs it on every push. Do not list
`agentstore` in your agent's `requirements.txt`; it is a tool for your machine.
