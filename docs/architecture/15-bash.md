# 15 — The `bash` tool: agents run code when the task needs it

The user is a CEO who does not code, but **agents may code** when that is the way to get the job done: summing revenue
in a 5,000-row Excel file, statistics, charts, file format conversion. Estimating by eye over CSV is
wrong. The old decision "no shell" (00/02) is replaced by this document. Code is in `src/tool/builtin/bash.ts`.

## Decisions

- **One `bash` tool** (`command`, `timeout?` up to 600 seconds). stdout and stderr are merged;
  long output keeps the end (`tail`) and the full output is saved to `tool-output/`. A non-zero exit code
  returns an error with `[exit code N]`.
- **Separate working directory** `<DB directory>/workspace` (configurable via `HAHANESS_WORKDIR`), not the
  source directory. `HOME` also points there, so `pip install --user` and caches stay inside this directory.
- **Files sent by the CEO have their originals in `workspace/uploads/`** (`attach(..., workdir)`). The `<attachments>` block
  says `original="uploads/x.xlsx"`, so the agent reads them with pandas or openpyxl to compute exactly instead of computing
  on the text version.
- **Company documents stay in the DB.** Files created in `workspace` are not documents: to give something to
  the CEO, `write` it into `deliverables/` or put the figures in the report. The tool prompt and the CTO prompt state
  this explicitly.
- **No secret leakage:** the child process only receives PATH, LANG, TZ and a few similar variables. API keys live in the DB and
  in the server's environment variables, so code written by the agent cannot read them via env.
- **On timeout or stop, the whole process group is killed** (`detached` + `kill(-pid)`), so a backgrounded `python`
  also stops.
- `concurrency: serial`: commands within the same turn run one after another.

## Who can use it

- **The CTO** has it by default (`bash * allow` in `cto.md`).
- **Employees** can only use it with the `bash` capability (the **Staff** (Nhân sự) page, or `hire` with
  `capabilities: [..., "bash"]`). Without it, `employeeRules` denies `bash`. No builtin role currently has
  `bash`; the CTO runs it itself or hires a data analysis role.

## Risks (accepted)

This is **not a sandbox**: commands run with the server process's permissions. Code written by the agent can read the DB
file, access the network, and delete any file the system user is allowed to delete. The main risk is prompt injection: a malicious web page or
file tricks the agent into running commands. Current mitigations:

- No env passed through (keys are not present in the command's environment variables).
- Working directory separate from the source code.
- Employees must be granted permission explicitly.

On a VPS, run the server as a separate low-privilege user, or in a container. The Docker image (`18-deployment.md`)
does the latter: it runs as the `node` user, ships `bash`, `python3`, `pandas` and `openpyxl`, and `pip install --user`
lands in `/data/workspace/.local` so it survives upgrades. Next step, if needed: run commands in a nested sandbox
(`--network none`, mount each `workspace`), keeping the tool's interface unchanged.
