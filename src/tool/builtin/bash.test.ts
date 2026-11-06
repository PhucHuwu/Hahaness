import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bash, run } from "./bash.ts"
import { capabilityRules } from "../../agent/registry.ts"
import { denied, evaluate } from "../../permission/ruleset.ts"
import { Db } from "../../core/db.ts"
import { DocumentStore } from "../../context/documents.ts"
import { attach } from "../../upload/attachments.ts"

const never = new AbortController().signal

test("bash: runs in the company workdir, combined output, exit codes, secrets are not inherited", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hahaness-bash-"))
  process.env.OPENAI_API_KEY = "sk-secret-test"
  try {
    const tool = bash(join(dir, "workspace"))
    const ctx = { signal: never } as any
    let r = await tool.execute(tool.schema.parse({ command: "pwd; echo out; echo err >&2" }), ctx)
    assert.ok(!r.isError)
    assert.match(r.output, new RegExp(`${join(dir, "workspace").replace(/[/\\]/g, ".")}\\nout\\nerr`))
    r = await tool.execute(tool.schema.parse({ command: "echo \"key=$OPENAI_API_KEY\"" }), ctx)
    assert.equal(r.output, "key=")
    r = await tool.execute(tool.schema.parse({ command: "echo nope; exit 3" }), ctx)
    assert.ok(r.isError)
    assert.match(r.output, /nope\n\[exit code 3\]/)
    r = await tool.execute(tool.schema.parse({ command: "python3 -c 'print(sum([1,2,3]))'" }), ctx)
    assert.equal(r.output, "6")
  } finally {
    delete process.env.OPENAI_API_KEY
    await rm(dir, { recursive: true, force: true })
  }
})

test("bash: timeout and interrupt kill the whole process tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hahaness-bash-"))
  try {
    const t0 = Date.now()
    let r = await run(`(sleep 30; echo late > ${dir}/late.txt) & sleep 30`, dir, 300, never)
    assert.ok(r.isError && /timeout/.test(r.output))
    assert.ok(Date.now() - t0 < 5000)
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 200)
    r = await run("sleep 30", dir, 60_000, ctrl.signal)
    assert.equal(r.output, "interrupted")
    await new Promise((res) => setTimeout(res, 300))
    await assert.rejects(readFile(join(dir, "late.txt")), "child processes were killed too")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("bash: uploads keep the original file in the workdir for code to read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hahaness-bash-"))
  const db = new Db(":memory:")
  try {
    const docs = new DocumentStore(db)
    const parts = await attach(docs, [{ name: "dt.csv", data: Buffer.from("a,b\n1,2\n3,4") }], "ceo", dir)
    assert.match(parts[0]!.type === "text" ? parts[0]!.text : "", /original="uploads\/dt.csv"/)
    await attach(docs, [{ name: "dt.csv", data: Buffer.from("x") }], "ceo", dir)
    const r = await run(`python3 -c "import csv; print(sum(int(r['b']) for r in csv.DictReader(open('uploads/dt.csv'))))"; cat "uploads/dt (2).csv"`, dir, 30_000, never)
    assert.equal(r.output, "6\nx")
  } finally {
    db.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("bash: employees get it only with the bash capability", () => {
  const without = capabilityRules(["read", "write"])
  const withBash = capabilityRules(["read", "bash"])
  assert.ok(denied(without, "bash", "ls"))
  assert.equal(evaluate(withBash, "bash", "ls"), "allow")
  assert.ok(!denied(withBash, "bash", "ls"))
})
