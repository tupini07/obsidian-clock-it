// Pure time-tracking logic for the Clock In plugin.
// This module has NO Obsidian dependencies so it can be fully unit-tested.

export type SegmentStatus =
	| "closed" // valid start and end, end >= start
	| "open" // valid start, no end (running)
	| "invalid-format" // could not be split into start/end parts
	| "invalid-time" // start or end is not a valid HH:mm
	| "end-before-start"; // both valid but end < start

export interface Segment {
	/** Raw start text as stored/typed (may be invalid). */
	startRaw: string;
	/** Raw end text as stored/typed. Empty string means "no end" (open). */
	endRaw: string;
	/** Parsed start minutes since midnight, or null if invalid. */
	start: number | null;
	/** Parsed end minutes since midnight, or null if open/invalid. */
	end: number | null;
	status: SegmentStatus;
}

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

/**
 * Parse an "HH:mm" string into minutes since midnight.
 * Returns null if the string is not a valid 24h time.
 */
export function parseTime(value: string): number | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	const match = TIME_RE.exec(trimmed);
	if (!match) return null;
	const hours = parseInt(match[1], 10);
	const minutes = parseInt(match[2], 10);
	if (hours > 23 || minutes > 59) return null;
	return hours * 60 + minutes;
}

/** Format minutes since midnight as a zero-padded "HH:mm" string. */
export function formatTime(minutes: number): string {
	const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
	const hh = Math.floor(m / 60);
	const mm = m % 60;
	return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Format a duration in minutes as "Xh Ym" (e.g. 545 -> "9h 05m"). */
export function formatDuration(totalMinutes: number): string {
	const safe = Math.max(0, Math.round(totalMinutes));
	const hours = Math.floor(safe / 60);
	const minutes = safe % 60;
	return `${hours}h ${String(minutes).padStart(2, "0")}m`;
}

/**
 * Parse a single compact segment string such as "09:00-11:00" or "13:00-"
 * into a typed Segment, classifying any problems instead of throwing.
 */
export function parseSegment(raw: string): Segment {
	const text = typeof raw === "string" ? raw.trim() : "";
	const dashIndex = text.indexOf("-");
	if (dashIndex === -1) {
		return {
			startRaw: text,
			endRaw: "",
			start: null,
			end: null,
			status: "invalid-format",
		};
	}

	const startRaw = text.slice(0, dashIndex).trim();
	const endRaw = text.slice(dashIndex + 1).trim();
	return buildSegment(startRaw, endRaw);
}

/**
 * Build a classified Segment from raw start/end text. Shared by parseSegment
 * and the row-editing helpers so classification stays consistent.
 */
export function buildSegment(startRaw: string, endRaw: string): Segment {
	const start = parseTime(startRaw);
	const hasEnd = endRaw.trim().length > 0;
	const end = hasEnd ? parseTime(endRaw) : null;

	let status: SegmentStatus;
	if (start === null) {
		status = "invalid-time";
	} else if (!hasEnd) {
		status = "open";
	} else if (end === null) {
		status = "invalid-time";
	} else if (end < start) {
		status = "end-before-start";
	} else {
		status = "closed";
	}

	return { startRaw: startRaw.trim(), endRaw: endRaw.trim(), start, end, status };
}

/** Parse a frontmatter list value into Segments. Tolerates non-array input. */
export function parseSegments(list: unknown): Segment[] {
	if (!Array.isArray(list)) return [];
	return list.map((item) => parseSegment(String(item ?? "")));
}

/** Serialize a Segment back to its compact "HH:mm-HH:mm" / "HH:mm-" form. */
export function serializeSegment(seg: Segment): string {
	return `${seg.startRaw}-${seg.endRaw}`;
}

/** Serialize a list of Segments to compact strings for frontmatter storage. */
export function serializeSegments(segments: Segment[]): string[] {
	return segments.map(serializeSegment);
}

/**
 * Duration of a segment in minutes.
 * - closed: end - start
 * - open: nowMinutes - start (clamped to >= 0)
 * - invalid / end-before-start: 0
 */
export function segmentDurationMinutes(seg: Segment, nowMinutes: number): number {
	if (seg.status === "closed" && seg.start !== null && seg.end !== null) {
		return seg.end - seg.start;
	}
	if (seg.status === "open" && seg.start !== null) {
		return Math.max(0, nowMinutes - seg.start);
	}
	return 0;
}

/** Sum of all segment durations in minutes. */
export function totalMinutes(segments: Segment[], nowMinutes: number): number {
	return segments.reduce(
		(sum, seg) => sum + segmentDurationMinutes(seg, nowMinutes),
		0
	);
}

/** Count how many segments are currently open (running). */
export function countOpen(segments: Segment[]): number {
	return segments.filter((seg) => seg.status === "open").length;
}

/** True if any segment cannot be cleanly interpreted. */
export function hasInvalid(segments: Segment[]): boolean {
	return segments.some(
		(seg) =>
			seg.status === "invalid-format" ||
			seg.status === "invalid-time" ||
			seg.status === "end-before-start"
	);
}

// --- Mutation helpers (return new arrays; never mutate in place) -------------

/** Append a new open segment starting at nowMinutes. */
export function addOpenSegment(segments: Segment[], nowMinutes: number): Segment[] {
	const startRaw = formatTime(nowMinutes);
	return [...segments, buildSegment(startRaw, "")];
}

/**
 * Close the (last) open segment with nowMinutes. If no open segment exists the
 * list is returned unchanged.
 */
export function closeOpenSegment(segments: Segment[], nowMinutes: number): Segment[] {
	let lastOpen = -1;
	for (let i = segments.length - 1; i >= 0; i--) {
		if (segments[i].status === "open") {
			lastOpen = i;
			break;
		}
	}
	if (lastOpen === -1) return segments;
	const next = segments.slice();
	const seg = next[lastOpen];
	next[lastOpen] = buildSegment(seg.startRaw, formatTime(nowMinutes));
	return next;
}

/** Append a blank (invalid until filled) row for inline editing. */
export function addBlankRow(segments: Segment[]): Segment[] {
	return [...segments, buildSegment("", "")];
}

/** Replace the row at index with a segment rebuilt from new raw start/end text. */
export function updateRow(
	segments: Segment[],
	index: number,
	startRaw: string,
	endRaw: string
): Segment[] {
	if (index < 0 || index >= segments.length) return segments;
	const next = segments.slice();
	next[index] = buildSegment(startRaw, endRaw);
	return next;
}

/** Remove the row at index. */
export function deleteRow(segments: Segment[], index: number): Segment[] {
	if (index < 0 || index >= segments.length) return segments;
	return segments.filter((_, i) => i !== index);
}
