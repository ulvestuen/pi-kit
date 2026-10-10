import type { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, Text, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { progressLines, type Details, type Progress } from "./runner.ts";
import { terminalText, transcriptText } from "./trace.ts";

export function agentTranscript(result: Progress): string {
  let transcript = result.transcript;
  // The full final answer is shown below; don't also display its streamed copy.
  if (transcript && result.answer) {
    const last = transcript.entries.at(-1);
    const finalIds = new Set(transcript.finalTextIds ??
      (last?.kind === "text" && last.text === result.answer ? [last.id] : []));
    transcript = { ...transcript, entries: transcript.entries.filter((entry) => !finalIds.has(entry.id)) };
  }
  return terminalText([
    `Task: ${result.task}`,
    ...(transcript?.entries.length || !result.answer ? [transcriptText(transcript)] : []),
    ...(result.error ? [`${result.status}: ${result.error}`] : []),
    ...(result.answer ? [`Final answer:\n${result.answer}`] : []),
  ].join("\n\n"));
}

export class SubagentView implements Component {
  private body = new Text("", 1, 0);
  private scroll = new ScrollView(this.body, { follow: "end", scrollbar: "hidden" });
  private paused = false;
  private bodySource?: Progress;
  private bodyText = "";

  constructor(
    private details: Details,
    private selected: number,
    private theme: Theme,
    private height: () => number,
    private requestRender: () => void,
    private done: () => void,
  ) {
    this.update(details);
  }

  invalidate() {
    this.body.invalidate();
  }

  render(width: number): string[] {
    const maxHeight = Math.max(0, Math.floor(this.height()));
    if (width < 1 || maxHeight < 1) return [];
    const framed = width >= 3 && maxHeight >= 3;
    const innerWidth = width - (framed ? 2 : 0);
    const rows = maxHeight - (framed ? 2 : 0);
    // Reserve transcript space before assigning rows to non-wrapping chrome.
    const chromeBudget = rows - Math.min(3, Math.max(1, rows - 2));
    const footerBudget = Math.min(chromeBudget > 3 ? 2 : 1, chromeBudget);
    const headerBudget = Math.min(3, chromeBudget - footerBudget);
    const chromeWidth = Math.max(0, innerWidth - 2);
    const chromeLine = (text: string) => " " + truncateToWidth(text, chromeWidth);
    const tabs = (compact: boolean) => this.details.results.map((r, i) => {
      const label = compact ? `${r.id}` : `${r.id} ${r.role}`;
      return i === this.selected ? this.theme.fg("accent", `[${label}]`) : this.theme.fg("muted", label);
    }).join("  ");
    const fullTabs = tabs(false);
    const header = [this.theme.fg("accent", "Subagent transcript"),
      visibleWidth(fullTabs) <= chromeWidth ? fullTabs : tabs(true),
      terminalText(progressLines(this.details)[this.selected + 1]),
    ].slice(3 - headerBudget).map(chromeLine);
    const state = this.paused ? "Paused" : "Following";
    let footer = new Text(this.theme.fg("muted",
      `${state} · 1–8/←/→ agent · ↑/↓/PgUp/PgDn scroll · End follow · Esc close`), 1, 0).render(innerWidth);
    if (footer.length > footerBudget) {
      const controls = chromeWidth >= 20 ? "End live · Esc close" : "Esc close";
      footer = (footerBudget === 2 ? [`${state} · 1–8 agent · ↑/↓ scroll`, controls]
        : footerBudget === 1 ? [controls] : []).map((line) => chromeLine(this.theme.fg("muted", line)));
    }
    const lines = this.scroll.render(innerWidth);
    const height = rows - header.length - footer.length;
    // Pi 1.1 overlays call render(width), even in fullscreen mode, rather than
    // running the viewport layout engine. Supply that viewport to ScrollView.
    this.scroll.updateLayout(lines.length, height, this.requestRender);
    if (this.paused) this.scroll.scrollTo(this.scroll.scrollTop, { disableFollow: true });
    const visible = lines.slice(this.scroll.scrollTop, this.scroll.scrollTop + height);
    const content = [...header, ...visible, ...Array(Math.max(0, height - visible.length)).fill(""), ...footer];
    if (!framed) return content;
    const border = (text: string) => this.theme.fg("borderMuted", text);
    return [
      border(`┌${"─".repeat(innerWidth)}┐`),
      ...content.map((line) => border("│") + line + " ".repeat(Math.max(0, innerWidth - visibleWidth(line))) + border("│")),
      border(`└${"─".repeat(innerWidth)}┘`),
    ];
  }

  private refreshBody() {
    if (this.paused) return;
    const result = this.details.results[this.selected];
    const previous = this.bodySource;
    // Runner snapshots are immutable. Sibling progress and elapsed-time ticks
    // must not rebuild or invalidate the selected child's wrapped transcript.
    if (previous && previous.task === result.task && previous.transcript === result.transcript &&
      previous.answer === result.answer && previous.error === result.error && previous.status === result.status) return;
    const text = agentTranscript(result);
    if (text !== this.bodyText) {
      this.body.setText(text);
      this.bodyText = text;
    }
    this.bodySource = result;
  }

  update(details: Details) {
    this.details = details;
    this.selected = Math.min(this.selected, details.results.length - 1);
    this.refreshBody();
    this.requestRender();
  }

  handleInput(data: string) {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.done();
      return;
    }
    let selected = this.selected;
    if (/^[1-8]$/.test(data)) selected = Number(data) - 1;
    else if (matchesKey(data, "right") || matchesKey(data, "tab")) selected = (selected + 1) % this.details.results.length;
    else if (matchesKey(data, "left") || matchesKey(data, "shift+tab")) selected = (selected + this.details.results.length - 1) % this.details.results.length;
    else if (matchesKey(data, "up")) { this.paused = true; this.scroll.scrollBy(-1); }
    else if (matchesKey(data, "down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp")) { this.paused = true; this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight - 1)); }
    else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight - 1));
    else if (matchesKey(data, "home")) { this.paused = true; this.scroll.scrollToStart(); }
    else if (matchesKey(data, "end")) {
      this.paused = false;
      this.refreshBody();
      this.scroll.scrollToEnd();
    }
    if (selected !== this.selected && selected < this.details.results.length) {
      this.selected = selected;
      this.paused = false;
      this.scroll.scrollToEnd();
      this.update(this.details);
    }
    if (this.paused) this.scroll.scrollTo(this.scroll.scrollTop, { disableFollow: true });
    this.requestRender();
  }
}
