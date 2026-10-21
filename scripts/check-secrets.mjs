#!/usr/bin/env node
// Fails if any tracked file looks like it contains an API key or other secret.
// Runs in CI on every pull request (`pnpm check:secrets`).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS = [
  { name: "Travila secret key", re: /\bsk_(live|test)?_?[A-Za-z0-9]{20,}\b/ },
  { name: "Travila publishable key", re: /\bpk_(live|test)?_?[A-Za-z0-9]{20,}\b/ },
  { name: "DeepSeek / OpenAI style key", re: /\bsk-[A-Za-z0-9]{24,}\b/ },
  { name: "Browser Use key", re: /\bbu_[A-Za-z0-9_-]{20,}\b/ },
  { name: "Anthropic key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "Bearer token literal", re: /Bearer\s+[A-Za-z0-9._-]{32,}/ },
  {
    name: "Postgres URL with password",
    re: /postgres(ql)?:\/\/[^:\s"'`]+:(?!postgres@)[^@\s"'`]{6,}@(?!localhost|127\.0\.0\.1)/,
  },
];

// Files that are allowed to mention patterns (this scanner and its tests).
const ALLOW = new Set(["scripts/check-secrets.mjs"]);

const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
  .toString()
  .split("\0")
  .filter((f) => f && !ALLOW.has(f) && !f.endsWith("pnpm-lock.yaml"));

const findings = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue; // binary
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) findings.push(`${file}:${i + 1}  ${name}`);
    }
  });
}

if (findings.length) {
  console.error("Possible secrets found. Move them to environment variables:\n");
  for (const f of findings) console.error("  " + f);
  process.exit(1);
}
console.log(`No secrets found in ${files.length} files.`);
