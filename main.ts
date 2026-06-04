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
}

const DEFAULT_SETTINGS: ClockInSettings = {
	targetHours: 8,
};

/** Current local wall-clock time as minutes since midnight. */
function nowMinutes(): number {
	const d = new Date();
	return d.getHours() * 60 + d.getMinutes();
}

export default class ClockInPlugin extends Plugin {
	settings: ClockInSettings;

	/** All mounted widgets, ticked once per second to refresh live totals. */
	private widgets: Set<ClockInWidget> = new Set();

	async onload() {
		await this.loadSettings();

		this.registerMarkdownCodeBlockProcessor(
			"clock-in",
			(_source, el, ctx) => {
				const widget = new ClockInWidget(el, this, ctx);
				ctx.addChild(widget);
			}
		);

		this.addSettingTab(new ClockInSettingTab(this.app, this));

		// Single plugin-wide ticker. Updates only the live total text of each
		// widget; it never rebuilds segment rows (so it can't disturb editing).
		this.registerInterval(
			window.setInterval(() => {
				this.widgets.forEach((w) => w.tick());
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
			})
		);
	}

	registerWidget(w: ClockInWidget) {
		this.widgets.add(w);
	}

	unregisterWidget(w: ClockInWidget) {
		this.widgets.delete(w);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Re-read targets in any open widgets.
		this.widgets.forEach((w) => w.render());
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
		const raw = fm?.[TARGET_KEY];
		if (typeof raw === "string") {
			const parsed = parseTime(raw);
			if (parsed !== null) return parsed;
		}
		return Math.round(this.plugin.settings.targetHours * 60);
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

		const help = containerEl.createDiv({ cls: "clock-in-help" });
		help.createEl("p", {
			text: "Add a clock-in code block to a note to show the widget:",
		});
		const pre = help.createEl("pre");
		pre.createEl("code", { text: "```clock-in\n```" });
	}
}
