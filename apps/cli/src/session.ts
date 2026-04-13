/**
 * Nexus CLI — Session persistence
 *
 * Sessions are stored as JSON files in <NEXUS_HOME>/sessions/.
 * Each session file: { id, name, createdAt, updatedAt, messages }
 */

import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Message } from "@nexus/core";

export interface SessionMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface SessionFile extends SessionMeta {
  messages: Message[];
}

function sessionsDir(nexusHome: string): string {
  const dir = join(nexusHome, "sessions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function saveSession(nexusHome: string, session: SessionFile): void {
  const dir = sessionsDir(nexusHome);
  const file = join(dir, `${session.id}.json`);
  writeFileSync(file, JSON.stringify(session, null, 2), "utf-8");
}

export function listSessions(nexusHome: string): SessionMeta[] {
  const dir = sessionsDir(nexusHome);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse(); // newest first

  const sessions: SessionMeta[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, f), "utf-8")) as SessionFile;
      sessions.push({
        id: raw.id,
        name: raw.name,
        createdAt: raw.createdAt,
        updatedAt: raw.updatedAt,
        messageCount: raw.messages.length,
      });
    } catch {
      // Skip malformed files
    }
  }
  return sessions;
}

export function loadSessionById(nexusHome: string, id: string): SessionFile | null {
  const dir = sessionsDir(nexusHome);
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as SessionFile;
  } catch {
    return null;
  }
}
