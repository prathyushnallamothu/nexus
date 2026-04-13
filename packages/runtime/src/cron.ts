/**
 * Nexus Cron Scheduler
 *
 * File-backed job store + background runner.
 * Jobs are persisted to .nexus/cron/jobs.json and survive restarts.
 * The runner checks every 30s and executes due jobs via the agent.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

// ── Types ─────────────────────────────────────────────────

export interface CronJob {
  id: string;
  name: string;
  /** Cron expression (5-part) OR natural language stored as-is */
  schedule: string;
  /** Parsed 5-part cron expression */
  cronExpr: string;
  /** Task description sent to the agent */
  task: string;
  /** Whether the job is enabled */
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt: number;
  lastOutput?: string;
  runCount: number;
}

export interface CronRunResult {
  jobId: string;
  startedAt: number;
  finishedAt: number;
  output: string;
  success: boolean;
}

// ── Natural language → cron parser ────────────────────────

export function parseCronSchedule(input: string): string {
  const s = input.trim().toLowerCase();

  // Already a cron expression (5 fields)
  if (/^[\d\*\/,\-]+ [\d\*\/,\-]+ [\d\*\/,\-]+ [\d\*\/,\-]+ [\d\*\/,\-]+$/.test(s)) {
    return s;
  }

  // Natural language patterns
  if (s === "every minute")           return "* * * * *";
  if (s === "every hour")             return "0 * * * *";
  if (s === "every day" || s === "daily") return "0 9 * * *";
  if (s === "every week" || s === "weekly") return "0 9 * * 1";
  if (s === "every month" || s === "monthly") return "0 9 1 * *";
  if (s === "every night" || s === "nightly") return "0 23 * * *";
  if (s === "every morning")          return "0 8 * * *";
  if (s === "every weekday")          return "0 9 * * 1-5";
  if (s === "every weekend")          return "0 9 * * 6,0";

  // "every N minutes/hours/days"
  const everyMatch = s.match(/^every (\d+) (minute|hour|day)s?$/);
  if (everyMatch) {
    const n = everyMatch[1];
    const unit = everyMatch[2];
    if (unit === "minute") return `*/${n} * * * *`;
    if (unit === "hour")   return `0 */${n} * * *`;
    if (unit === "day")    return `0 9 */${n} * *`;
  }

  // "every day at HH:MM" or "every day at H am/pm"
  const atMatch = s.match(/(?:every day |daily )?at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (atMatch) {
    let hour = parseInt(atMatch[1]);
    const min = parseInt(atMatch[2] ?? "0");
    const ampm = atMatch[3];
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    return `${min} ${hour} * * *`;
  }

  // "every monday/tuesday/..."
  const days: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  for (const [name, num] of Object.entries(days)) {
    if (s.includes(name)) {
      const timeMatch = s.match(/at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
      if (timeMatch) {
        let hour = parseInt(timeMatch[1]);
        const min = parseInt(timeMatch[2] ?? "0");
        if (timeMatch[3] === "pm" && hour < 12) hour += 12;
        return `${min} ${hour} * * ${num}`;
      }
      return `0 9 * * ${num}`;
    }
  }

  // Default: every day at 9am
  return "0 9 * * *";
}

// ── Next run time ─────────────────────────────────────────

export function getNextRun(cronExpr: string, from = Date.now()): number {
  const [minE, hourE, domE, monE, dowE] = cronExpr.split(" ");
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // start from next minute

  // Simple next-run: iterate minute-by-minute for up to 1 year
  const limit = from + 365 * 24 * 60 * 60 * 1000;
  while (d.getTime() < limit) {
    if (
      matches(d.getMinutes(), minE) &&
      matches(d.getHours(), hourE) &&
      matches(d.getDate(), domE) &&
      matches(d.getMonth() + 1, monE) &&
      matches(d.getDay(), dowE)
    ) {
      return d.getTime();
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return from + 24 * 60 * 60 * 1000; // fallback: tomorrow
}

function matches(value: number, expr: string): boolean {
  if (expr === "*") return true;
  if (expr.includes("/")) {
    const [, step] = expr.split("/");
    return value % parseInt(step) === 0;
  }
  if (expr.includes(",")) {
    return expr.split(",").some((v) => parseInt(v) === value);
  }
  if (expr.includes("-")) {
    const [lo, hi] = expr.split("-").map(Number);
    return value >= lo && value <= hi;
  }
  return parseInt(expr) === value;
}

// ── CronStore ─────────────────────────────────────────────

export class CronStore {
  private jobsFile: string;
  private jobs: Map<string, CronJob> = new Map();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.jobsFile = join(dir, "jobs.json");
    this._load();
  }

  add(opts: { name: string; schedule: string; task: string }): CronJob {
    const cronExpr = parseCronSchedule(opts.schedule);
    const id = createHash("sha256")
      .update(`${opts.name}${Date.now()}`)
      .digest("hex")
      .slice(0, 8);
    const job: CronJob = {
      id,
      name: opts.name,
      schedule: opts.schedule,
      cronExpr,
      task: opts.task,
      enabled: true,
      createdAt: Date.now(),
      nextRunAt: getNextRun(cronExpr),
      runCount: 0,
    };
    this.jobs.set(id, job);
    this._save();
    return job;
  }

  remove(id: string): boolean {
    const existed = this.jobs.has(id);
    this.jobs.delete(id);
    if (existed) this._save();
    return existed;
  }

  toggle(id: string, enabled: boolean): CronJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    job.enabled = enabled;
    this._save();
    return job;
  }

  list(): CronJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  get(id: string): CronJob | null {
    return this.jobs.get(id) ?? null;
  }

  markRan(id: string, output: string, success: boolean): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.lastRunAt = Date.now();
    job.nextRunAt = getNextRun(job.cronExpr);
    job.lastOutput = output.slice(0, 500);
    job.runCount++;
    this._save();
  }

  getDue(): CronJob[] {
    const now = Date.now();
    return Array.from(this.jobs.values()).filter(
      (j) => j.enabled && j.nextRunAt <= now,
    );
  }

  private _load(): void {
    try {
      if (!existsSync(this.jobsFile)) return;
      const data = JSON.parse(readFileSync(this.jobsFile, "utf-8")) as CronJob[];
      for (const job of data) this.jobs.set(job.id, job);
    } catch {}
  }

  private _save(): void {
    try {
      writeFileSync(this.jobsFile, JSON.stringify(Array.from(this.jobs.values()), null, 2));
    } catch {}
  }
}

// ── CronRunner ────────────────────────────────────────────

type TaskRunner = (task: string) => Promise<string>;

export class CronRunner {
  private store: CronStore;
  private runner: TaskRunner;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onJobRan?: (job: CronJob, result: CronRunResult) => void;

  constructor(store: CronStore, runner: TaskRunner, onJobRan?: (job: CronJob, result: CronRunResult) => void) {
    this.store = store;
    this.runner = runner;
    this.onJobRan = onJobRan;
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    // Check immediately on start, then on interval
    this._tick();
    this.timer = setInterval(() => this._tick(), intervalMs);
    // Don't keep the process alive just for cron
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async _tick(): Promise<void> {
    const due = this.store.getDue();
    for (const job of due) {
      const startedAt = Date.now();
      let output = "";
      let success = false;
      try {
        output = await this.runner(job.task);
        success = true;
      } catch (err: any) {
        output = `Error: ${err.message}`;
      }
      this.store.markRan(job.id, output, success);
      this.onJobRan?.(job, { jobId: job.id, startedAt, finishedAt: Date.now(), output, success });
    }
  }
}
