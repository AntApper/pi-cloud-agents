import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

/**
 * Returns the parameter names declared under `Parameters:` in an `infra/*.yaml` template.
 * Tests use it to assert that a deployer passes exactly the parameters a template declares,
 * because CloudFormation rejects change sets with unknown or missing parameters.
 */
export function declaredTemplateParameters(templateFile: string): string[] {
  const text = fs.readFileSync(path.join(REPO_ROOT, "infra", templateFile), "utf8");
  const names: string[] = [];
  let inParameters = false;
  for (const line of text.split("\n")) {
    if (/^Parameters:\s*$/.test(line)) {
      inParameters = true;
      continue;
    }
    if (/^[A-Za-z]/.test(line)) {
      inParameters = false;
    }
    const match = inParameters ? line.match(/^ {2}([A-Za-z0-9]+):\s*$/) : null;
    if (match?.[1]) names.push(match[1]);
  }
  return names.sort();
}
