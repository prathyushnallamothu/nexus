/**
 * Nexus Code Execution Tool
 *
 * Run arbitrary code in an isolated environment.
 */

import type { Tool } from "../types.js";

export const runCodeTool: Tool = {
  schema: {
    name: "run_code",
    description:
      "Execute code in an isolated sandbox. Supports Python, JavaScript/Node.js, TypeScript (via tsx), Bash, and Ruby. " +
      "Returns stdout, stderr, and exit code. Use for testing algorithms, running calculations, or validating code snippets.",
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description:
            "Language: 'python', 'javascript', 'typescript', 'bash', 'ruby'",
          enum: ["python", "javascript", "typescript", "bash", "ruby"],
        },
        code: { type: "string", description: "Code to execute" },
        timeout_ms: {
          type: "number",
          description:
            "Max execution time in milliseconds (default 15000, max 60000)",
          default: 15000,
        },
      },
      required: ["language", "code"],
    },
  },
  async execute(args) {
    const { exec: execCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const execAsync = promisify(execCb);
    const lang = String(args.language).toLowerCase();
    const code = String(args.code);
    const timeoutMs = Math.min(Number(args.timeout_ms ?? 15_000), 60_000);

    const ext: Record<string, string> = {
      python: "py",
      javascript: "js",
      typescript: "ts",
      bash: "sh",
      ruby: "rb",
    };
    const fileExt = ext[lang] ?? "txt";
    let workDir: string | null = null;

    try {
      workDir = mkdtempSync(join(tmpdir(), "nexus-run-"));
      const filePath = join(workDir, `code.${fileExt}`);
      writeFileSync(filePath, code, "utf-8");

      const runners: Record<string, string> = {
        python: `python3 "${filePath}"`,
        javascript: `node "${filePath}"`,
        typescript: `npx tsx "${filePath}"`,
        bash: `bash "${filePath}"`,
        ruby: `ruby "${filePath}"`,
      };
      const command = runners[lang];
      if (!command) throw new Error(`Unsupported language: ${lang}`);

      let stdout = "";
      let stderr = "";
      let exitCode = 0;

      try {
        const result = await execAsync(command, {
          timeout: timeoutMs,
          maxBuffer: 1024 * 1024,
        });
        stdout = result.stdout;
        stderr = result.stderr;
      } catch (err: any) {
        stdout = err.stdout ?? "";
        stderr = err.stderr ?? err.message;
        exitCode = typeof err.code === "number" ? err.code : 1;
      }

      const parts: string[] = [];
      if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`);
      if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`);
      parts.push(`exit code: ${exitCode}`);
      return parts.join("\n\n");
    } finally {
      if (workDir) {
        try {
          rmSync(workDir, { recursive: true });
        } catch {}
      }
    }
  },
};

/** All code execution tools */
export const codeTools: Tool[] = [runCodeTool];
