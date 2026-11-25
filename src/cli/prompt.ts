// Questions at a terminal, for `vine setup` and `vine turn set`. Prompts go
// to stderr, so stdout stays clean for --json. A hidden answer is typed
// unseen and is never echoed, logged or put in a command line.
//
// Without a terminal, answers are read one per line from stdin.

import { createInterface } from "node:readline";

export interface Prompter {
  /** A free-text answer; empty takes the default. */
  ask(question: string, def?: string): Promise<string>;
  /** Typed unseen. */
  hidden(question: string): Promise<string>;
  /** One of the choices by number; empty takes the default (0-based). */
  choose(question: string, choices: string[], def?: number): Promise<number>;
  confirm(question: string, def?: boolean): Promise<boolean>;
  readonly interactive: boolean;
}

/** Lines of piped stdin, read as they're asked for. */
class Lines {
  private buf: string[] = [];
  private waiting: ((l: string) => void)[] = [];
  private ended = false;
  constructor(stream: NodeJS.ReadableStream) {
    const rl = createInterface({ input: stream });
    rl.on("line", (l) => (this.waiting.length ? this.waiting.shift()!(l) : this.buf.push(l)));
    rl.on("close", () => {
      this.ended = true;
      for (const w of this.waiting.splice(0)) w("");
    });
  }
  next(): Promise<string> {
    if (this.buf.length) return Promise.resolve(this.buf.shift()!);
    if (this.ended) return Promise.resolve("");
    return new Promise((r) => this.waiting.push(r));
  }
}

let piped: Lines | undefined;

function line(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    process.stderr.write(question);
    piped ??= new Lines(stdin);
    return piped.next().then((l) => {
      process.stderr.write("\n");
      return l;
    });
  }
  const rl = createInterface({ input: stdin, output: process.stderr });
  return new Promise((resolve, reject) => {
    let answered = false;
    rl.question(question, (a) => {
      answered = true;
      rl.close();
      resolve(a);
    });
    rl.on("close", () => {
      if (!answered) reject(new Error("Cancelled."));
    });
  });
}

/** Reads a secret: typed unseen at a terminal, or the next line of piped input. */
export function readHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    process.stderr.write(question);
    piped ??= new Lines(stdin);
    return piped.next().then((l) => {
      process.stderr.write("\n");
      return l.trim();
    });
  }
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let typed = "";
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(typed.trim()));
        if (ch === "\u0003") return done(() => reject(new Error("Cancelled.")));
        if (ch === "\u007f" || ch === "\b") typed = typed.slice(0, -1);
        else typed += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export function terminalPrompter(): Prompter {
  return {
    interactive: Boolean(process.stdin.isTTY),
    async ask(q, def) {
      const a = (await line(`${q}${def ? ` [${def}]` : ""}: `)).trim();
      return a || def || "";
    },
    hidden: (q) => readHidden(`${q}: `),
    async choose(q, choices, def = 0) {
      process.stderr.write(`${q}\n${choices.map((c, i) => `  ${i + 1}) ${c}${i === def ? "  (default)" : ""}`).join("\n")}\n`);
      for (;;) {
        const a = (await line(`Choose 1-${choices.length} [${def + 1}]: `)).trim();
        if (!a) return def;
        const n = Number(a);
        if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1;
        if (!process.stdin.isTTY) return def;
      }
    },
    async confirm(q, def = true) {
      const a = (await line(`${q} [${def ? "Y/n" : "y/N"}]: `)).trim().toLowerCase();
      return a ? a.startsWith("y") : def;
    },
  };
}

/** Answers every question with its default (for --yes), and refuses hidden ones without a terminal. */
export function defaultsPrompter(inner: Prompter): Prompter {
  return {
    interactive: inner.interactive,
    ask: async (_q, def) => def ?? "",
    choose: async (_q, _c, def = 0) => def,
    confirm: async (_q, def = true) => def,
    hidden: (q) => inner.hidden(q),
  };
}
