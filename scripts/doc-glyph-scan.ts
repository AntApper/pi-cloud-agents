import fs from "node:fs";
import path from "node:path";

const FORBIDDEN_RANGES: Array<[number, number]> = [
  [0x1f000, 0x1faff], // emojis / pictographs
  [0x2600, 0x26ff], // miscellaneous symbols
  [0x2700, 0x27bf], // dingbats (except 0x2713 and 0x2717)
  [0x2b00, 0x2bff], // misc symbols and arrows
  [0xfe0f, 0xfe0f], // emoji variation selector
  [0x200d, 0x200d], // zero width joiner
  [0x1f1e6, 0x1f1ff], // regional indicators
];

const ALLOWED_EXCEPTIONS = new Set<number>([
  0x2713, // ✓
  0x2717, // ✗
]);

export interface ForbiddenGlyphMatch {
  char: string;
  codePoint: string;
  line: number;
  col: number;
}

export function findForbiddenGlyphs(content: string): ForbiddenGlyphMatch[] {
  const forbidden: ForbiddenGlyphMatch[] = [];
  let line = 1;
  let col = 1;

  for (let i = 0; i < content.length; ) {
    const codePoint = content.codePointAt(i);
    if (codePoint === undefined) break;
    const char = String.fromCodePoint(codePoint);

    if (char === "\n") {
      line++;
      col = 1;
      i += char.length;
      continue;
    }

    if (!ALLOWED_EXCEPTIONS.has(codePoint)) {
      for (const [start, end] of FORBIDDEN_RANGES) {
        if (codePoint >= start && codePoint <= end) {
          forbidden.push({
            char,
            codePoint: `U+${codePoint.toString(16).toUpperCase()}`,
            line,
            col,
          });
          break;
        }
      }
    }

    col += char.length;
    i += char.length;
  }

  return forbidden;
}

function scanDir(dir: string, fileList: string[] = []): string[] {
  if (!fs.existsSync(dir)) return fileList;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name !== "node_modules" &&
        entry.name !== ".git" &&
        entry.name !== "dist" &&
        entry.name !== ".tmp"
      ) {
        scanDir(fullPath, fileList);
      }
    } else if (entry.isFile()) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

export function runScan(): number {
  const root = process.cwd();
  const candidateFiles: string[] = [
    path.join(root, "README.md"),
    path.join(root, "AGENTS.md"),
    path.join(root, "CLAUDE.md"),
    ...scanDir(path.join(root, "docs")),
    ...scanDir(path.join(root, "extension")),
    ...scanDir(path.join(root, "core")),
    ...scanDir(path.join(root, "cli")),
    ...scanDir(path.join(root, "shared")),
    ...scanDir(path.join(root, "runner")),
  ];

  let totalViolations = 0;

  for (const file of candidateFiles) {
    if (!fs.existsSync(file)) continue;
    const ext = path.extname(file);
    if (![".md", ".ts", ".js", ".json", ".yaml", ".yml", ""].includes(ext)) continue;

    const content = fs.readFileSync(file, "utf8");
    const violations = findForbiddenGlyphs(content);

    if (violations.length > 0) {
      console.error(`Forbidden glyphs in ${path.relative(root, file)}:`);
      for (const v of violations) {
        console.error(`  Line ${v.line}, Col ${v.col}: ${v.char} (${v.codePoint})`);
      }
      totalViolations += violations.length;
    }
  }

  return totalViolations;
}

if (
  process.argv[1] &&
  (process.argv[1].endsWith("doc-glyph-scan.ts") || process.argv[1].endsWith("doc-glyph-scan.js"))
) {
  const violations = runScan();
  if (violations > 0) {
    console.error(`Glyph scan failed with ${violations} forbidden character(s).`);
    process.exit(1);
  }
  console.log("Glyph scan passed: no forbidden emojis or symbols found.");
}
