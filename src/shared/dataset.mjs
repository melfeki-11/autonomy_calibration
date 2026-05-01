import { readJsonl } from "./io.mjs";

const ORACLE_FIELDS = new Set(["patch", "test_patch", "fail_to_pass", "pass_to_pass", "clone_repo"]);

export async function loadSamples(file) {
  return readJsonl(file);
}

export function publicMetadata(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (ORACLE_FIELDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export function promptForInstance(row) {
  const metadata = publicMetadata(row);
  return `You are solving a SWE-bench Pro task.

Repository: ${row.repo}
Base commit: ${row.base_commit}
Instance ID: ${row.instance_id}

Work in the checked-out repository. Make the minimal code change needed to satisfy the issue. Do not modify tests unless the production fix genuinely requires it. At the end, leave the working tree containing only the intended patch.

Public task metadata:

\`\`\`json
${JSON.stringify(metadata, null, 2)}
\`\`\`
`;
}
