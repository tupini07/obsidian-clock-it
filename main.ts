import {
	App,
	MarkdownPostProcessorContext,
	MarkdownRenderChild,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
} from "obsidian";

import {
	Segment,
	parseTime,
	parseSegments,
	serializeSegments,
	totalMinutes,
	countOpen,
	formatDuration,
	formatSignedDuration,
	balanceLabel,
	isTrackedWorkDay,
	summarizeClockDay,
	summarizeClockBalance,
	ClockBalanceSummary,
	addOpenSegment,
	closeOpenSegment,
	addBlankRow,
	updateRow,
	deleteRow,
	buildSegment,
} from "./clockUtils";

const FRONTMATTER_KEY = "clock-in";
const TARGET_KEY = "clock-in-target";

interface ClockInSettings {
	/** Default daily target in hours, used when a note has no clock-in-target. */
	targetHours: number;
	/** Show the "X worked / Y target · N days" detail line in the summary. */
	showSummaryDetails: boolean;
}

const DEFAULT_SETTINGS: ClockInSettings = {
	targetHours: 8,
	showSummaryDetails: true,
};

/** Current local wall-clock time as minutes since midnight. */
function nowMinutes(): number {
	const d = new Date();
	return d.getHours() * 60 + d.getMinutes();
}

/** Today's date as a local "YYYY-MM-DD" string, used to match daily notes. */
function todayKey(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/**
 * Whether a note path belongs to "today", inferred from a leading
 * "YYYY-MM-DD" in its basename (the default Daily Notes format). Used to decide
 * if an open/running segment should count live toward the balance.
 */
function isTodayNote(path: string): boolean {
	const base = path.split("/").pop() ?? path;
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(base);
	return match ? match[1] === todayKey() : false;
}

export default class ClockInPlugin extends Plugin {
	settings: ClockInSettings;

	/** All mounted daily widgets, ticked once per second to refresh live totals. */
	private widgets: Set<ClockInWidget> = new Set();

	/** All mounted summary widgets, refreshed on data change and (live) per second. */
	private summaryWidgets: Set<ClockSummaryWidget> = new Set();

	async onload() {
		await this.loadSettings();

		this.registerMarkdownCodeBlockProcessor(
			"clock-in",
			(_source, el, ctx) => {
				const widget = new ClockInWidget(el, this, ctx);
				ctx.addChild(widget);
			}
		);

		this.registerMarkdownCodeBlockProcessor(
			"clock-in-summary",
			(_source, el, ctx) => {
				const widget = new ClockSummaryWidget(el, this, ctx);
				ctx.addChild(widget);
			}
		);

		this.addSettingTab(new ClockInSettingTab(this.app, this));

		// Single plugin-wide ticker. Updates only the live total text of each
		// widget; it never rebuilds segment rows (so it can't disturb editing).
		this.registerInterval(
			window.setInterval(() => {
				this.widgets.forEach((w) => w.tick());
				this.summaryWidgets.forEach((w) => w.tick());
			}, 1000)
		);

		// Refresh widgets when their file's frontmatter changes externally.
		this.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				this.widgets.forEach((w) => {
					if (w.filePath === file.path) {
						w.onExternalChange();
					}
				});
				// Any note's clock-in data can affect the cumulative balance.
				this.summaryWidgets.forEach((w) => w.render());
			})
		);

		// Deleting a tracked note also changes the balance.
		this.registerEvent(
			this.app.vault.on("delete", () => {
				this.summaryWidgets.forEach((w) => w.render());
			})
		);
	}

	registerWidget(w: ClockInWidget) {
		this.widgets.add(w);
	}

	unregisterWidget(w: ClockInWidget) {
		this.widgets.delete(w);
	}

	registerSummaryWidget(w: ClockSummaryWidget) {
		this.summaryWidgets.add(w);
	}

	unregisterSummaryWidget(w: ClockSummaryWidget) {
		this.summaryWidgets.delete(w);
	}

	/** Default daily target (in minutes) from settings. */
	defaultTargetMinutes(): number {
		return Math.round(this.settings.targetHours * 60);
	}

	/** Effective per-day target in minutes, honouring a clock-in-target override. */
	effectiveTargetMinutes(frontmatter: Record<string, unknown> | undefined): number {
		const raw = frontmatter?.[TARGET_KEY];
		if (typeof raw === "string") {
			const parsed = parseTime(raw);
			if (parsed !== null) return parsed;
		}
		return this.defaultTargetMinutes();
	}

	/**
	 * Scan every markdown note for clock-in data and roll it up into a
	 * cumulative balance. "Today" (a daily note whose filename date is today) is
	 * excluded so the headline reflects the real standing balance carried into
	 * today rather than being skewed by today's not-yet-worked target. Today's
	 * progress is shown by its own clock-in widget.
	 */
	computeBalance(): {
		carried: ClockBalanceSummary;
		totalTrackedDays: number;
		todayTracked: boolean;
	} {
		const now = nowMinutes();
		const carriedDays = [];
		let totalTrackedDays = 0;
		let todayTracked = false;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
			const raw = fm?.[FRONTMATTER_KEY];
			if (!isTrackedWorkDay(raw)) continue;
			totalTrackedDays++;
			if (isTodayNote(file.path)) {
				todayTracked = true;
				continue; // today is excluded from the carried balance
			}
			const segments = parseSegments(raw);
			const target = this.effectiveTargetMinutes(fm);
			// Every carried day is in the past, so an open segment is stale
			// (forgotten clock) and never counts live.
			carriedDays.push(
				summarizeClockDay(file.path, segments, target, now, false)
			);
		}
		return {
			carried: summarizeClockBalance(carriedDays),
			totalTrackedDays,
			todayTracked,
		};
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Re-read targets in any open widgets.
		this.widgets.forEach((w) => w.render());
		this.summaryWidgets.forEach((w) => w.render());
	}
}

/**
 * One interactive clock widget, bound to the lifecycle of a single rendered
 * ` ```clock-in ``` ` code block via MarkdownRenderChild.
 */
class ClockInWidget extends MarkdownRenderChild {
	readonly filePath: string;
	private plugin: ClockInPlugin;

	/** Render source of truth, seeded from frontmatter and user actions. */
	private segments: Segment[] = [];

	// Live-updating DOM references (updated by tick(), never rebuilt by it).
	private totalEl: HTMLElement | null = null;

	constructor(
		containerEl: HTMLElement,
		plugin: ClockInPlugin,
		ctx: MarkdownPostProcessorContext
	) {
		super(containerEl);
		this.plugin = plugin;
		this.filePath = ctx.sourcePath;
	}

	onload() {
		this.plugin.registerWidget(this);
		this.segments = this.readSegments();
		this.render();
	}

	onunload() {
		this.plugin.unregisterWidget(this);
	}

	// --- File / frontmatter access -----------------------------------------

	private getFile(): TFile | null {
		const f = this.plugin.app.vault.getAbstractFileByPath(this.filePath);
		return f instanceof TFile ? f : null;
	}

	private readSegments(): Segment[] {
		const file = this.getFile();
		if (!file) return [];
		const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
		return parseSegments(fm?.[FRONTMATTER_KEY]);
	}

	private targetMinutes(): number {
		const file = this.getFile();
		const fm = file
			? this.plugin.app.metadataCache.getFileCache(file)?.frontmatter
			: undefined;
		return this.plugin.effectiveTargetMinutes(fm);
	}

	/**
	 * Persist the current in-memory segments to frontmatter. Fully-empty rows
	 * are dropped on write so a never-filled "add row" doesn't leave a stub.
	 * No-op writes are skipped to avoid needless metadata churn / re-render.
	 */
	private async persist() {
		const file = this.getFile();
		if (!file) return;

		const toStore = this.segments.filter(
			(s) => !(s.startRaw === "" && s.endRaw === "")
		);
		const serialized = serializeSegments(toStore);

		const current =
			this.plugin.app.metadataCache.getFileCache(file)?.frontmatter?.[
				FRONTMATTER_KEY
			];
		if (
			Array.isArray(current) &&
			current.length === serialized.length &&
			current.every((v, i) => String(v) === serialized[i])
		) {
			return; // no change
		}

		await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
			fm[FRONTMATTER_KEY] = serialized;
		});
	}

	// --- External change / live tick ---------------------------------------

	/** True if any input inside this widget currently has focus. */
	private isEditing(): boolean {
		const active = document.activeElement;
		return !!active && this.containerEl.contains(active);
	}

	onExternalChange() {
		// Don't clobber the user mid-edit; they'll see updates once they blur.
		if (this.isEditing()) return;
		this.segments = this.readSegments();
		this.render();
	}

	/** Cheap per-second update of the live total only. */
	tick() {
		if (!this.totalEl) return;
		if (countOpen(this.segments) === 0) return; // nothing running, no change
		this.updateTotalText();
	}

	private updateTotalText() {
		if (!this.totalEl) return;
		const total = totalMinutes(this.segments, nowMinutes());
		const target = this.targetMinutes();
		const remaining = Math.max(0, target - total);
		this.totalEl.setText(
			`${formatDuration(total)} / ${formatDuration(target)}` +
				(remaining > 0 ? `  (${formatDuration(remaining)} left)` : "  ✓")
		);
	}

	// --- Rendering ----------------------------------------------------------

	render() {
		const el = this.containerEl;
		el.empty();
		el.addClass("clock-in-widget");

		const open = countOpen(this.segments);

		// Header: title + live total.
		const header = el.createDiv({ cls: "clock-in-header" });
		header.createSpan({ cls: "clock-in-title", text: "Clock In" });
		this.totalEl = header.createSpan({ cls: "clock-in-total" });
		this.updateTotalText();

		if (open > 1) {
			el.createDiv({
				cls: "clock-in-warning",
				text: "Multiple running segments found. Fix the rows below (only one may be open) to re-enable the buttons.",
			});
		}

		// Controls.
		const controls = el.createDiv({ cls: "clock-in-controls" });
		const startBtn = controls.createEl("button", {
			cls: "clock-in-btn clock-in-start",
			text: "▶ Start",
		});
		startBtn.disabled = open >= 1;
		startBtn.onclick = () => this.handleStart();

		const stopBtn = controls.createEl("button", {
			cls: "clock-in-btn clock-in-stop",
			text: "■ Stop",
		});
		stopBtn.disabled = open !== 1;
		stopBtn.onclick = () => this.handleStop();

		// Segment rows.
		const rows = el.createDiv({ cls: "clock-in-rows" });
		if (this.segments.length === 0) {
			rows.createDiv({
				cls: "clock-in-empty",
				text: "No segments yet. Press Start or add a row.",
			});
		}
		this.segments.forEach((seg, index) => this.renderRow(rows, seg, index));

		// Add row.
		const addBtn = el.createEl("button", {
			cls: "clock-in-btn clock-in-add",
			text: "+ Add row",
		});
		addBtn.onclick = () => this.handleAddRow();
	}

	private renderRow(parent: HTMLElement, seg: Segment, index: number) {
		const row = parent.createDiv({ cls: "clock-in-row" });

		const startInput = row.createEl("input", {
			cls: "clock-in-input",
			attr: { type: "text", placeholder: "HH:mm", value: seg.startRaw },
		});
		row.createSpan({ cls: "clock-in-dash", text: "–" });
		const endInput = row.createEl("input", {
			cls: "clock-in-input",
			attr: {
				type: "text",
				placeholder: "running",
				value: seg.endRaw,
			},
		});

		const commit = () => this.handleEdit(index, startInput.value, endInput.value);
		for (const input of [startInput, endInput]) {
			input.addEventListener("blur", commit);
			input.addEventListener("keydown", (ev: KeyboardEvent) => {
				if (ev.key === "Enter") {
					ev.preventDefault();
					(ev.target as HTMLInputElement).blur();
				}
			});
		}

		if (seg.status === "invalid-format" || seg.status === "invalid-time") {
			row.addClass("clock-in-row-invalid");
			row.setAttr("title", "Invalid time. Use HH:mm (e.g. 09:00).");
		} else if (seg.status === "end-before-start") {
			row.addClass("clock-in-row-invalid");
			row.setAttr(
				"title",
				"End is before start. Crossing midnight is not supported."
			);
		} else if (seg.status === "open") {
			row.addClass("clock-in-row-open");
		}

		const del = row.createEl("button", {
			cls: "clock-in-btn clock-in-delete",
			text: "×",
			attr: { "aria-label": "Delete row" },
		});
		del.onclick = () => this.handleDelete(index);
	}

	// --- Actions ------------------------------------------------------------

	private async handleStart() {
		if (countOpen(this.segments) >= 1) {
			new Notice("A segment is already running. Stop it first.");
			return;
		}
		this.segments = addOpenSegment(this.segments, nowMinutes());
		await this.persist();
		this.render();
	}

	private async handleStop() {
		if (countOpen(this.segments) !== 1) return;
		this.segments = closeOpenSegment(this.segments, nowMinutes());
		await this.persist();
		this.render();
	}

	private handleAddRow() {
		// Keep blank row in memory only; persisted once it has valid times.
		this.segments = addBlankRow(this.segments);
		this.render();
		const inputs = this.containerEl.querySelectorAll<HTMLInputElement>(
			".clock-in-row .clock-in-input"
		);
		// Focus the start input of the newly added (last) row.
		const startIdx = (this.segments.length - 1) * 2;
		inputs[startIdx]?.focus();
	}

	private async handleEdit(index: number, startRaw: string, endRaw: string) {
		const next = buildSegment(startRaw, endRaw);
		const existing = this.segments[index];
		if (
			existing &&
			existing.startRaw === next.startRaw &&
			existing.endRaw === next.endRaw
		) {
			return; // unchanged
		}
		this.segments = updateRow(this.segments, index, startRaw, endRaw);
		await this.persist();
		// Refresh totals/status/buttons, but not while the user is still editing
		// another field in this widget (avoids stealing focus when tabbing).
		window.setTimeout(() => {
			if (!this.isEditing()) this.render();
		}, 0);
	}

	private async handleDelete(index: number) {
		this.segments = deleteRow(this.segments, index);
		await this.persist();
		this.render();
	}
}

/**
 * Renders a ` ```clock-in-summary ``` ` block: the cumulative balance of worked
 * vs. target hours carried into today (every tracked work day except today).
 */
class ClockSummaryWidget extends MarkdownRenderChild {
	private plugin: ClockInPlugin;

	// Live DOM references, plus the day we last rendered for (to catch the
	// balance changing when the clock rolls over midnight while the note stays
	// open). The carried balance has no per-second component, so we only
	// recompute on data changes and on a day rollover.
	private deltaEl: HTMLElement | null = null;
	private detailEl: HTMLElement | null = null;
	private renderedDay = "";

	constructor(
		containerEl: HTMLElement,
		plugin: ClockInPlugin,
		_ctx: MarkdownPostProcessorContext
	) {
		super(containerEl);
		this.plugin = plugin;
	}

	onload() {
		this.plugin.registerSummaryWidget(this);
		this.render();
	}

	onunload() {
		this.plugin.unregisterSummaryWidget(this);
	}

	/** Re-render only when the day rolls over (today moves into the balance). */
	tick() {
		if (this.renderedDay !== todayKey()) this.render();
	}

	render() {
		const el = this.containerEl;
		el.empty();
		el.addClass("clock-in-summary");
		this.renderedDay = todayKey();

		const { carried, totalTrackedDays } = this.plugin.computeBalance();

		const header = el.createDiv({ cls: "clock-in-summary-header" });
		header.createSpan({
			cls: "clock-in-summary-title",
			text: "Clock In — Balance",
		});

		if (carried.dayCount === 0) {
			// Distinguish "nothing tracked at all" from "only today tracked".
			el.createDiv({
				cls: "clock-in-summary-empty",
				text:
					totalTrackedDays === 0
						? "No tracked work days yet. Add a clock-in block to a note and press Start; tracked days will appear here automatically."
						: "No work days before today yet. Your standing balance starts once you have a tracked day in the past.",
			});
			this.deltaEl = null;
			this.detailEl = null;
			return;
		}

		const label = balanceLabel(carried.deltaMinutes);
		this.deltaEl = el.createDiv({
			cls: `clock-in-summary-delta clock-in-delta-${label}`,
			text:
				label === "balanced"
					? "On target"
					: `${formatSignedDuration(carried.deltaMinutes)} ${label}`,
		});

		if (this.plugin.settings.showSummaryDetails) {
			this.detailEl = el.createDiv({
				cls: "clock-in-summary-detail",
				text:
					"before today · " +
					`${formatDuration(carried.workedMinutes)} worked / ` +
					`${formatDuration(carried.targetMinutes)} target · ` +
					`${carried.dayCount} work day${carried.dayCount === 1 ? "" : "s"}`,
			});
		} else {
			this.detailEl = null;
		}

		const warnings: string[] = [];
		if (carried.invalidCount > 0) {
			warnings.push(
				`${carried.invalidCount} invalid segment${
					carried.invalidCount === 1 ? "" : "s"
				} (counted as 0)`
			);
		}
		if (carried.staleOpenCount > 0) {
			warnings.push(
				`${carried.staleOpenCount} running segment${
					carried.staleOpenCount === 1 ? "" : "s"
				} in past notes (not counted — stop them to include)`
			);
		}
		if (warnings.length > 0) {
			el.createDiv({
				cls: "clock-in-summary-warning",
				text: `Heads up: ${warnings.join("; ")}.`,
			});
		}
	}
}

class ClockInSettingTab extends PluginSettingTab {
	plugin: ClockInPlugin;

	constructor(app: App, plugin: ClockInPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Daily target (hours)")
			.setDesc(
				`Default daily goal shown in the widget. A note can override this with a "${TARGET_KEY}: HH:mm" frontmatter key.`
			)
			.addText((text) =>
				text
					.setPlaceholder("8")
					.setValue(String(this.plugin.settings.targetHours))
					.onChange(async (value) => {
						const parsed = parseFloat(value);
						this.plugin.settings.targetHours =
							isNaN(parsed) || parsed < 0 ? DEFAULT_SETTINGS.targetHours : parsed;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show balance details")
			.setDesc(
				"In the clock-in-summary block, show the breakdown line (total worked / total target · number of work days) under the headline balance."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showSummaryDetails)
					.onChange(async (value) => {
						this.plugin.settings.showSummaryDetails = value;
						await this.plugin.saveSettings();
					})
			);

		const help = containerEl.createDiv({ cls: "clock-in-help" });
		help.createEl("p", {
			text: "Add a clock-in code block to a note to track a day:",
		});
		const pre = help.createEl("pre");
		pre.createEl("code", { text: "```clock-in\n```" });
		help.createEl("p", {
			text: "Add a clock-in-summary block anywhere to see your cumulative balance across all tracked days:",
		});
		const pre2 = help.createEl("pre");
		pre2.createEl("code", { text: "```clock-in-summary\n```" });
	}
}
