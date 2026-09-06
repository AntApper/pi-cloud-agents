import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  ErrorResponseSchema,
  LaunchPayloadSchema,
  RunManifestSchema,
  RunnerStatusSchema,
} from "../shared/protocol.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMAS_DIR = join(__dirname, "../docs/schemas");

interface SchemaTarget {
  name: string;
  filename: string;
  schema: Parameters<typeof zodToJsonSchema>[0];
}

const targets: SchemaTarget[] = [
  {
    name: "LaunchPayload",
    filename: "launch-payload.v1.json",
    schema: LaunchPayloadSchema,
  },
  {
    name: "RunManifest",
    filename: "run-manifest.v1.json",
    schema: RunManifestSchema,
  },
  {
    name: "RunnerStatus",
    filename: "runner-status.v1.json",
    schema: RunnerStatusSchema,
  },
  {
    name: "ErrorResponse",
    filename: "error-response.v1.json",
    schema: ErrorResponseSchema,
  },
];

export function generateSchemas(outDir = SCHEMAS_DIR): string[] {
  mkdirSync(outDir, { recursive: true });
  const writtenFiles: string[] = [];

  for (const target of targets) {
    const jsonSchema = zodToJsonSchema(target.schema, {
      name: target.name,
      target: "jsonSchema7",
      $refStrategy: "none",
    });

    const filePath = join(outDir, target.filename);
    const content = `${JSON.stringify(jsonSchema, null, 2)}\n`;
    writeFileSync(filePath, content, "utf8");
    writtenFiles.push(filePath);
  }

  return writtenFiles;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const generated = generateSchemas();
  console.log(`Generated ${generated.length} JSON Schema definitions:`);
  for (const file of generated) {
    console.log(`  - ${file}`);
  }
}
