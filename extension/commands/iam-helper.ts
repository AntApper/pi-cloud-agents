/**
 * Extension command handler for `/cloud iam-policy` (T4.15).
 */

import {
  generateOperatorPolicyCfnYaml,
  generateOperatorPolicyJson,
} from "../../core/iam-helper.js";
import type { RouteContext, RouteResult } from "../router.js";

export async function handleCloudIamPolicyCommand(
  subArgs: string[],
  ctx?: RouteContext,
): Promise<RouteResult> {
  const yamlMode = subArgs.includes("--yaml") || subArgs.includes("--cfn");

  const output = yamlMode ? generateOperatorPolicyCfnYaml() : generateOperatorPolicyJson();

  if (ctx?.hasUI && ctx.ui?.notify) {
    ctx.ui.notify(output, "info");
  }

  return {
    subcommand: "iam-policy",
    args: subArgs,
    output,
    handled: true,
  };
}
