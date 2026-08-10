export interface StreamEvent {
  type?: string;
  [key: string]: unknown;
}

export function summarizeEvent(e: StreamEvent): string {
  if (!e.type) return "unknown";
  return typeof e.subtype === "string" ? `${e.type}:${e.subtype}` : e.type;
}

interface CollectorOpts {
  onLine?: (line: string) => void;
  onEvent?: (e: StreamEvent) => void;
  // Counts UTF-16 code units (JS string length), NOT bytes: multi-byte UTF-8
  // input (e.g. non-ASCII text) can occupy roughly up to 2x the memory the
  // name implies before this cap trips. Kept internal/approximate on purpose.
  maxBufferChars?: number;
}

export class StreamCollector {
  assistantText = "";
  resultText: string | null = null;
  planText: string | null = null;
  toolCallCount = 0;
  #buffer = "";
  #opts: CollectorOpts;
  // See CollectorOpts.maxBufferChars: UTF-16 code units, not bytes.
  #maxBufferChars: number;

  constructor(opts: CollectorOpts = {}) {
    this.#opts = opts;
    this.#maxBufferChars = opts.maxBufferChars ?? 8 * 1024 * 1024;
  }

  feed(chunk: string): void {
    this.#buffer += chunk;
    let nl: number;
    while ((nl = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      this.#handleLine(line);
    }
    if (this.#buffer.length > this.#maxBufferChars) {
      // drop-with-flag: a corrupt/no-newline stream must not grow memory unboundedly
      this.#opts.onEvent?.({ type: "bridge_buffer_overflow", droppedBytes: this.#buffer.length });
      this.#buffer = "";
    }
  }

  end(): void {
    if (this.#buffer.trim()) this.#handleLine(this.#buffer);
    this.#buffer = "";
  }

  #handleLine(line: string): void {
    if (!line.trim()) return;
    this.#opts.onLine?.(line);
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      return; // tolerate non-JSON noise on stdout
    }
    if (typeof e !== "object" || e === null) return;
    const ev = e as StreamEvent;
    this.#opts.onEvent?.(ev);
    if (ev.type === "assistant") {
      const msg = ev.message as { content?: unknown } | undefined;
      if (Array.isArray(msg?.content)) {
        for (const part of msg.content) {
          if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
            this.assistantText += String((part as { text?: unknown }).text ?? "");
          }
        }
      }
    } else if (ev.type === "tool_call") {
      // real agent emits started+completed pairs; count invocations, not lifecycle lines
      if (ev.subtype !== "completed") this.toolCallCount += 1;
      const tc = ev.tool_call as { createPlanToolCall?: { args?: { plan?: unknown } } } | undefined;
      const plan = tc?.createPlanToolCall?.args?.plan;
      if (typeof plan === "string" && plan.trim() !== "") this.planText = plan;
    } else if (ev.type === "result") {
      this.resultText =
        typeof ev.result === "string"
          ? ev.result
          : ev.result === undefined
            ? null
            : JSON.stringify(ev.result);
    }
  }
}
