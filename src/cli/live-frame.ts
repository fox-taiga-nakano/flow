import stringWidth from "string-width";

type Writer = { raw(text: string): void; capture(into: (text: string) => void): () => void; signal: AbortSignal };
type Terminal = {
  columns?: number;
  rows?: number;
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
};

const CSI = "\x1b[";
// Terminals without synchronized output (DEC 2026) ignore these and still get the same bytes.
const BEGIN = `${CSI}?2026h`;
const END = `${CSI}?2026l`;
const CLEAR = `${CSI}H${CSI}2J${CSI}3J`;

/** What `flow run` needs from a terminal to keep one frame in place. */
export type LiveScreen = {
  render(text: string): void;
  /** Forget the drawn frame, so the next render repaints everything (after a resize). */
  invalidate(): void;
  /** Collect what a tick prints, for the next frame, until the returned function is called. */
  capture(into: (text: string) => void): () => void;
  onResize(listener: () => void): () => void;
  /** Leave the last frame on screen and give the cursor back below it. */
  close(): void;
};

/**
 * Redraws one frame in place: only lines that differ from the drawn frame are rewritten,
 * and the screen is erased only for the first frame or one taller than the terminal.
 */
export class LiveFrame implements LiveScreen {
  private drawn: string[] | null = null;
  private started = false;
  private closed = false;
  constructor(
    private readonly out: Writer,
    private readonly terminal: Terminal,
    private readonly captured: Writer[] = [out],
  ) {}
  render(text: string): void {
    if (this.closed || this.out.signal.aborted) return;
    const lines = text.split("\n");
    const columns = this.terminal.columns ?? 80;
    const height = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(stringWidth(line) / columns)), 0);
    // A wrapped line or a frame taller than the screen scrolls, so row positions stop matching.
    const fits = height === lines.length && height <= (this.terminal.rows ?? 24);
    let body: string;
    if (!this.drawn || !fits) {
      body = CLEAR + lines.join("\n");
    } else {
      const drawn = this.drawn;
      body = lines.map((line, i) => (line === drawn[i] ? "" : `${CSI}${i + 1};1H${CSI}2K${line}`)).join("");
      if (lines.length < drawn.length) body += `${CSI}${lines.length + 1};1H${CSI}J`;
      body += `${CSI}${lines.length};${stringWidth(lines.at(-1)!) + 1}H`;
    }
    this.drawn = fits ? lines : null;
    this.out.raw(`${BEGIN}${this.started ? "" : `${CSI}?25l`}${body}${END}`);
    this.started = true;
  }
  invalidate(): void {
    this.drawn = null;
  }
  capture(into: (text: string) => void): () => void {
    const releases = this.captured.map((writer) => writer.capture(into));
    return () => releases.forEach((release) => release());
  }
  onResize(listener: () => void): () => void {
    this.terminal.on("resize", listener);
    return () => void this.terminal.off("resize", listener);
  }
  close(): void {
    if (this.closed || !this.started) return;
    this.closed = true;
    this.out.raw(`\n${CSI}?25h`);
  }
}
