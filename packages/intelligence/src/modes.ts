/**
 * Nexus Mode System
 *
 * Modes are markdown files that define domain-specific agent behavior.
 * Drop a .md file in the modes/ directory and Nexus learns a new specialty.
 *
 * No code required — anyone can create a mode.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";

export interface Mode {
  /** Filename-derived identifier */
  id: string;
  /** Display name (from # heading or filename) */
  name: string;
  /** When to activate this mode (from ## Trigger section) */
  trigger: string;
  /** Full content to inject into system prompt */
  content: string;
  /** Extracted sections */
  sections: Record<string, string>;
  /** Source file path */
  filePath: string;
}

export class ModeManager {
  private modes: Map<string, Mode> = new Map();
  private modesDir: string;

  constructor(modesDir: string) {
    this.modesDir = resolve(modesDir);
    this.loadModes();
  }

  /** Find the best mode for a user message */
  detect(userMessage: string): Mode | null {
    const messageLower = userMessage.toLowerCase();
    let bestMatch: Mode | null = null;
    let bestScore = 0;

    for (const mode of this.modes.values()) {
      const score = this.scoreTrigger(mode, messageLower);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = mode;
      }
    }

    // Only activate if confidence is reasonable
    return bestScore > 0.3 ? bestMatch : null;
  }

  /** Get all available modes */
  getAll(): Mode[] {
    return Array.from(this.modes.values());
  }

  /** Get a specific mode by ID */
  get(id: string): Mode | null {
    return this.modes.get(id) ?? null;
  }

  /** Reload modes from disk */
  reload(): void {
    this.modes.clear();
    this.loadModes();
  }

  private loadModes(): void {
    if (!existsSync(this.modesDir)) return;

    const files = readdirSync(this.modesDir).filter(
      (f) => f.endsWith(".md") && !f.startsWith("_"),
    );

    for (const file of files) {
      try {
        const filePath = join(this.modesDir, file);
        const content = readFileSync(filePath, "utf-8");
        const mode = this.parseMode(file, content, filePath);
        this.modes.set(mode.id, mode);
      } catch {
        // Skip unparseable files
      }
    }
  }

  private parseMode(filename: string, content: string, filePath: string): Mode {
    const id = basename(filename, ".md");

    // Extract name from first # heading
    const nameMatch = content.match(/^#\s+(.+)$/m);
    const name = nameMatch?.[1] ?? id;

    // Extract sections by ## headings
    const sections: Record<string, string> = {};
    const sectionRegex = /^##\s+(.+)$/gm;
    let lastSection: string | null = null;
    let lastIndex = 0;

    let match;
    while ((match = sectionRegex.exec(content)) !== null) {
      if (lastSection) {
        sections[lastSection] = content.slice(lastIndex, match.index).trim();
      }
      lastSection = match[1].toLowerCase().trim();
      lastIndex = match.index + match[0].length;
    }
    if (lastSection) {
      sections[lastSection] = content.slice(lastIndex).trim();
    }

    const trigger = sections["trigger"] ?? "";

    return { id, name, trigger, content, sections, filePath };
  }

  private scoreTrigger(mode: Mode, message: string): number {
    if (!mode.trigger) return 0;

    const triggerLines = mode.trigger
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim().toLowerCase())
      .filter((l) => l.length > 0);

    let maxScore = 0;

    for (const trigger of triggerLines) {
      // Direct keyword match
      const keywords = trigger.split(/\s+/).filter((w) => w.length > 3);
      let matchedKeywords = 0;
      for (const kw of keywords) {
        if (message.includes(kw)) matchedKeywords++;
      }

      if (keywords.length > 0) {
        const score = matchedKeywords / keywords.length;
        maxScore = Math.max(maxScore, score);
      }
    }

    return maxScore;
  }
}
