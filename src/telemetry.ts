import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

const ACTIVE = "telemetry.jsonl";
export const SEGMENT_RE = /^telemetry-\d+(-\d+)?\.jsonl$/;
const WATERMARK = "analyzed-watermark";

/**
 * Timestamp (ms since epoch) of the last record in an append-ordered NDJSON telemetry
 * file, or null if the file is missing, empty, or its last line is unparseable.
 * Unparseable/empty → null (callers must treat null as "unknown, don't skip/delete").
 */
export async function lastRecordTs(file: string): Promise<number | null> {
  try {
    const body = await readFile(file, "utf8");
    const ls = body.split("\n").filter((l) => l.trim());
    if (ls.length === 0) return null;
    const ts = Date.parse((JSON.parse(ls[ls.length - 1]!) as { ts?: string }).ts ?? "");
    return Number.isNaN(ts) ? null : ts;
  } catch {
    return null; // unparseable → refuse to delete (safe)
  }
}

export interface TelemetryOpts {
  logsDir: string;
  jobsDir: string;
  enabled?: boolean;
  rotateBytes?: number;
  maxFieldChars?: number;
  activeJobIds?: () => string[];
}

export class Telemetry {
  readonly enabled: boolean;
  readonly logsDir: string;
  #jobsDir: string;
  #rotateBytes: number;
  #maxFieldChars: number;
  #activeJobIds: () => string[];
  #chain: Promise<void> = Promise.resolve();
  #activeBytes = 0;
  #rotateSeq = 0;

  constructor(o: TelemetryOpts) {
    this.enabled = o.enabled ?? process.env.CURSOR_BRIDGE_TELEMETRY !== "off";
    this.logsDir = o.logsDir;
    this.#jobsDir = o.jobsDir;
    this.#rotateBytes = o.rotateBytes ?? 10_485_760;
    this.#maxFieldChars = o.maxFieldChars ?? 32_768;
    this.#activeJobIds = o.activeJobIds ?? (() => []);
  }

  record(kind: string, payload: Record<string, unknown>): void {
    if (!this.enabled) return;
    // the sync part (truncate + stringify) must also never throw into a working call
    // (circular refs / BigInt in payloads would otherwise escape the write-chain catch)
    let line: string;
    try {
      const { value, truncated } = this.#truncate(payload);
      const rec: Record<string, unknown> = { ts: new Date().toISOString(), kind, ...(value as Record<string, unknown>) };
      if (truncated) rec.truncated = true;
      line = JSON.stringify(rec) + "\n";
    } catch {
      line = JSON.stringify({ ts: new Date().toISOString(), kind, unserializable: true }) + "\n";
    }
    // write-chain: one append completes before the next starts (no partial-write interleave)
    this.#chain = this.#chain
      .then(async () => {
        await mkdir(this.logsDir, { recursive: true });
        await appendFile(this.#active(), line);
        this.#activeBytes += Buffer.byteLength(line);
        if (this.#activeBytes > this.#rotateBytes) await this.#rotate();
      })
      .catch(() => {}); // telemetry must never break a working call
  }

  async flush(timeoutMs = 300): Promise<void> {
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.#chain, new Promise((r) => { t = setTimeout(r, timeoutMs); })]);
    } finally {
      clearTimeout(t);
    }
  }

  async startup(): Promise<void> {
    if (!this.enabled) return;
    // serialize housekeeping on the write-chain so a concurrent record() can never
    // interleave an append with the rotate/janitor file operations
    this.#chain = this.#chain
      .then(async () => {
        await mkdir(this.logsDir, { recursive: true });
        try {
          this.#activeBytes = (await stat(this.#active())).size;
        } catch {
          this.#activeBytes = 0;
        }
        if (this.#activeBytes > this.#rotateBytes) await this.#rotate();
        await this.#janitor();
      })
      .catch(() => {}); // startup housekeeping is best-effort
    await this.#chain;
  }

  async watermark(): Promise<string | null> {
    try {
      const s = (await readFile(path.join(this.logsDir, WATERMARK), "utf8")).trim();
      return Number.isNaN(Date.parse(s)) ? null : s;
    } catch {
      return null;
    }
  }

  async markAnalyzed(): Promise<string> {
    if (!this.enabled) throw new Error("telemetry is disabled");
    const ts = new Date().toISOString();
    // serialized on the write-chain, but write failures MUST propagate to the caller —
    // returning ts after a swallowed failure would be a false success on a destructive gate
    const p = this.#chain.then(async () => {
      await mkdir(this.logsDir, { recursive: true });
      await writeFile(path.join(this.logsDir, WATERMARK), ts + "\n");
    });
    this.#chain = p.catch(() => {}); // keep the chain alive regardless
    await p; // throws to the caller on failure
    return ts;
  }

  async listDeletable(): Promise<{ segments: string[]; jobs: string[] }> {
    if (!this.enabled) return { segments: [], jobs: [] };
    const wm = await this.watermark();
    if (!wm) return { segments: [], jobs: [] };
    const wmMs = Date.parse(wm);
    const segments: string[] = [];
    for (const f of await this.#segments()) {
      const last = await lastRecordTs(path.join(this.logsDir, f));
      if (last !== null && last < wmMs) segments.push(f);
    }
    const jobs: string[] = [];
    const active = new Set(this.#activeJobIds());
    for (const id of await this.#jobDirs()) {
      if (active.has(id)) continue;
      const meta = await this.#readMeta(id);
      if (meta && TERMINAL_STATUSES.has(meta.status) && typeof meta.endedAt === "number" && meta.endedAt < wmMs) {
        jobs.push(id);
      }
    }
    return { segments, jobs };
  }

  async storageInfo(): Promise<{ active_bytes: number; segments: number; segments_bytes: number; job_dirs: number; watermark: string | null }> {
    let activeBytes = 0;
    try {
      activeBytes = (await stat(this.#active())).size;
    } catch {}
    let segBytes = 0;
    const segs = await this.#segments();
    for (const f of segs) {
      try {
        segBytes += (await stat(path.join(this.logsDir, f))).size;
      } catch {}
    }
    return {
      active_bytes: activeBytes,
      segments: segs.length,
      segments_bytes: segBytes,
      job_dirs: (await this.#jobDirs()).length,
      watermark: await this.watermark(),
    };
  }

  #active(): string {
    return path.join(this.logsDir, ACTIVE);
  }

  async #rotate(): Promise<void> {
    // rename is atomic on the same filesystem; recreate the active file immediately.
    // monotonic seq suffix prevents same-millisecond rotations from overwriting a segment
    try {
      await rename(this.#active(), path.join(this.logsDir, `telemetry-${Date.now()}-${++this.#rotateSeq}.jsonl`));
    } catch {
      // active file vanished or rename failed: resync the counter instead of
      // silently retrying a doomed rotation on every subsequent append
      try {
        this.#activeBytes = (await stat(this.#active())).size;
      } catch {
        this.#activeBytes = 0;
      }
      return;
    }
    await writeFile(this.#active(), "");
    this.#activeBytes = 0;
  }

  async #janitor(): Promise<void> {
    const { segments, jobs } = await this.listDeletable();
    for (const f of segments) await rm(path.join(this.logsDir, f), { force: true });
    for (const id of jobs) await rm(path.join(this.#jobsDir, id), { recursive: true, force: true });
  }

  async #segments(): Promise<string[]> {
    try {
      return (await readdir(this.logsDir)).filter((f) => SEGMENT_RE.test(f));
    } catch {
      return [];
    }
  }

  async #jobDirs(): Promise<string[]> {
    try {
      return await readdir(this.#jobsDir);
    } catch {
      return [];
    }
  }

  async #readMeta(id: string): Promise<{ status: string; endedAt: number | null } | null> {
    try {
      const m = JSON.parse(await readFile(path.join(this.#jobsDir, id, "meta.json"), "utf8"));
      return typeof m === "object" && m !== null ? (m as { status: string; endedAt: number | null }) : null;
    } catch {
      return null;
    }
  }

  #truncate(v: unknown, depth = 0): { value: unknown; truncated: boolean } {
    if (typeof v === "string") {
      if (v.length > this.#maxFieldChars) {
        return { value: v.slice(0, this.#maxFieldChars) + "…[truncated]", truncated: true };
      }
      return { value: v, truncated: false };
    }
    if (Array.isArray(v)) {
      let t = false;
      const out = v.map((x) => {
        const r = this.#truncate(x, depth + 1);
        t = t || r.truncated;
        return r.value;
      });
      return { value: out, truncated: t };
    }
    if (typeof v === "object" && v !== null) {
      if (depth >= 8) {
        // depth cap must not become a truncation bypass: stringify the subtree and cap it
        const s = JSON.stringify(v) ?? "";
        return s.length > this.#maxFieldChars
          ? { value: s.slice(0, this.#maxFieldChars) + "…[truncated]", truncated: true }
          : { value: v, truncated: false };
      }
      let t = false;
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const r = this.#truncate(x, depth + 1);
        t = t || r.truncated;
        out[k] = r.value;
      }
      return { value: out, truncated: t };
    }
    return { value: v, truncated: false };
  }
}
