// The pair model picker overlay: one model row and one thinking row per role, a rounds row, and Start.
// Enter on a model row opens a searchable list; left/right change thinking and rounds; Enter on Start (the initial
// row) checks the picks and closes, or shows why not and stays open; Esc cancels.

import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { MAX_ROUNDS, sameModelWarning, thinkingChoices, WORKFLOWS, type Selection, type Source } from "./lib.ts";

export interface PickerTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface PickerOptions {
  selection: Selection;
  sources?: Record<string, Source>;
  models: readonly string[];
  task?: string;
  /** Thinking levels the model supports; undefined when unknown. */
  levelsFor?: (model: string) => readonly string[] | undefined;
  /** Resolves to null when the picks are ready, or the reason they are not. */
  check?: (selection: Selection) => Promise<string | null>;
  done: (selection: Selection | null) => void;
  requestRender?: () => void;
}

type Row = { kind: "model" | "thinking"; role: string } | { kind: "rounds" } | { kind: "start" };

const MAX_LIST = 10;

export class PairPicker {
  private selection: Selection;
  private rows: Row[];
  private cursor: number;
  private search: { role: string; query: string; index: number } | null = null;
  private status: { text: string; color: string } | null = null;
  private checking = false;
  private closed = false;
  private sources: Record<string, Source>;

  constructor(private readonly theme: PickerTheme, private readonly options: PickerOptions) {
    this.selection = structuredClone(options.selection);
    this.sources = { ...(options.sources ?? {}) };
    const roles = WORKFLOWS[this.selection.workflow].roles;
    this.rows = [
      ...roles.flatMap(({ id }) => [{ kind: "model", role: id } as Row, { kind: "thinking", role: id } as Row]),
      { kind: "rounds" },
      { kind: "start" },
    ];
    this.cursor = this.rows.length - 1;
  }

  /** The current picks (for tests). */
  current(): Selection {
    return structuredClone(this.selection);
  }

  invalidate(): void {}

  private matches(): string[] {
    const query = this.search?.query.trim().toLowerCase() ?? "";
    if (!query) return [...this.options.models];
    const words = query.split(/\s+/);
    return this.options.models.filter((model) => words.every((word) => model.toLowerCase().includes(word)));
  }

  private levels(role: string): string[] {
    return thinkingChoices(this.options.levelsFor?.(this.selection.roles[role].model));
  }

  private setModel(role: string, model: string): void {
    const pick = this.selection.roles[role];
    pick.model = model;
    if (!this.levels(role).includes(pick.thinking)) pick.thinking = "default";
    delete this.sources[role];
    this.status = null;
  }

  private cycle(direction: 1 | -1): void {
    const row = this.rows[this.cursor];
    if (row.kind === "thinking") {
      const levels = this.levels(row.role);
      const pick = this.selection.roles[row.role];
      const at = Math.max(0, levels.indexOf(pick.thinking));
      pick.thinking = levels[(at + direction + levels.length) % levels.length];
    } else if (row.kind === "rounds") {
      this.selection.rounds = Math.min(MAX_ROUNDS, Math.max(1, this.selection.rounds + direction));
      delete this.sources.rounds;
    } else return;
    this.status = null;
  }

  private async start(): Promise<void> {
    if (this.checking) return;
    if (!this.options.check) return this.finish(this.selection);
    this.checking = true;
    this.status = { text: "Checking that the models are ready in a worker's environment…", color: "muted" };
    this.options.requestRender?.();
    let problem: string | null;
    try {
      problem = await this.options.check(structuredClone(this.selection));
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    this.checking = false;
    if (this.closed) return;
    if (problem) this.status = { text: problem, color: "error" };
    else return this.finish(this.selection);
    this.options.requestRender?.();
  }

  private finish(selection: Selection | null): void {
    if (this.closed) return;
    this.closed = true;
    this.options.done(selection ? structuredClone(selection) : null);
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.search) this.searchInput(data);
    else if (matchesKey(data, "escape")) this.finish(null);
    else if (this.checking) return;
    else if (matchesKey(data, "up")) this.cursor = (this.cursor - 1 + this.rows.length) % this.rows.length;
    else if (matchesKey(data, "down") || matchesKey(data, "tab")) this.cursor = (this.cursor + 1) % this.rows.length;
    else if (matchesKey(data, "left")) this.cycle(-1);
    else if (matchesKey(data, "right") || data === " ") this.cycle(1);
    else if (matchesKey(data, "enter")) {
      const row = this.rows[this.cursor];
      if (row.kind === "model") {
        const index = Math.max(0, this.options.models.indexOf(this.selection.roles[row.role].model));
        this.search = { role: row.role, query: "", index };
      } else if (row.kind === "start") void this.start();
      else this.cycle(1);
    }
    this.options.requestRender?.();
  }

  private searchInput(data: string): void {
    const search = this.search!;
    const found = this.matches();
    if (matchesKey(data, "escape")) this.search = null;
    else if (matchesKey(data, "up")) search.index = found.length ? (search.index - 1 + found.length) % found.length : 0;
    else if (matchesKey(data, "down")) search.index = found.length ? (search.index + 1) % found.length : 0;
    else if (matchesKey(data, "enter")) {
      // Nothing listed matches: the typed text is used as given, and the readiness check judges it.
      const chosen = found[search.index] ?? search.query.trim();
      if (chosen) this.setModel(search.role, chosen);
      this.search = null;
    } else if (matchesKey(data, "backspace")) {
      search.query = search.query.slice(0, -1);
      search.index = 0;
    } else if (data.length === 1 && data >= " " && data !== "\x7f") {
      search.query += data;
      search.index = 0;
    } else if (data.length > 1 && !data.startsWith("\x1b") && [...data].every((ch) => ch >= " ")) {
      search.query += data; // paste
      search.index = 0;
    }
  }

  render(width: number): string[] {
    const t = this.theme;
    const info = WORKFLOWS[this.selection.workflow];
    const inner = Math.max(20, width - 4);
    const lines: string[] = [];
    const line = (text = "") => lines.push(text);
    line(t.bold(t.fg("accent", `${info.title}: choose models`)));
    if (this.options.task) line(t.fg("muted", this.options.task.replace(/\s+/g, " ")));
    line();
    if (this.search) this.renderSearch(line, inner);
    else this.renderRows(line);
    line();
    const warning = sameModelWarning(this.selection);
    if (warning && !this.search) line(t.fg("warning", `⚠ ${warning}`));
    if (this.status) line(t.fg(this.status.color, this.status.text));
    line(
      t.fg(
        "dim",
        this.search
          ? "type to filter · ↑↓ move · enter choose · esc back"
          : "↑↓ move · enter edit/start · ←→ change · esc cancel",
      ),
    );
    return frame(lines, width, t);
  }

  private renderRows(line: (text?: string) => void): void {
    const t = this.theme;
    const labels = Object.fromEntries(WORKFLOWS[this.selection.workflow].roles.map((role) => [role.id, role.label]));
    const source = (key: string) => (this.sources[key] ? t.fg("dim", `  (${this.sources[key]})`) : "");
    this.rows.forEach((row, index) => {
      const selected = index === this.cursor;
      const cursor = selected ? t.fg("accent", "› ") : "  ";
      const label = (text: string) => (selected ? t.fg("accent", text) : text);
      if (row.kind === "model") {
        const pick = this.selection.roles[row.role];
        line(`${cursor}${label(`${labels[row.role]} model`.padEnd(24))}${t.bold(pick.model)}${source(row.role)}`);
      } else if (row.kind === "thinking") {
        const value = this.selection.roles[row.role].thinking;
        line(`${cursor}${label(`  thinking`.padEnd(24))}${selected ? `‹ ${value} ›` : value}`);
      } else if (row.kind === "rounds") {
        const value = String(this.selection.rounds);
        line(`${cursor}${label(WORKFLOWS[this.selection.workflow].roundsLabel.padEnd(24))}${selected ? `‹ ${value} ›` : value}${source("rounds")}`);
      } else {
        line();
        const text = this.checking ? "Checking…" : "Start";
        line(`${cursor}${selected ? t.bold(t.fg("accent", `[ ${text} ]`)) : `[ ${text} ]`}`);
      }
    });
  }

  private renderSearch(line: (text?: string) => void, inner: number): void {
    const t = this.theme;
    const search = this.search!;
    const role = WORKFLOWS[this.selection.workflow].roles.find((r) => r.id === search.role)!;
    line(`${role.label} model: ${search.query}${t.fg("accent", "▏")}`);
    const found = this.matches();
    if (!found.length) {
      line(t.fg("muted", search.query.trim() ? `  no listed model matches; enter uses "${search.query.trim()}" as given` : "  no models listed"));
      return;
    }
    const start = Math.max(0, Math.min(search.index - Math.floor(MAX_LIST / 2), found.length - MAX_LIST));
    for (const [offset, model] of found.slice(start, start + MAX_LIST).entries()) {
      const selected = start + offset === search.index;
      line(truncateToWidth(selected ? t.fg("accent", `› ${model}`) : `  ${model}`, inner));
    }
    if (found.length > MAX_LIST) line(t.fg("dim", `  ${search.index + 1}/${found.length}`));
  }
}

/** A rounded border around the lines, each padded and truncated to the inner width. */
function frame(lines: string[], width: number, t: PickerTheme): string[] {
  const inner = Math.max(20, width - 4);
  const border = (text: string) => t.fg("borderAccent", text);
  const out = [border(`╭${"─".repeat(inner + 2)}╮`)];
  for (const text of lines) {
    const fitted = truncateToWidth(text, inner);
    out.push(`${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`);
  }
  out.push(border(`╰${"─".repeat(inner + 2)}╯`));
  return out;
}

