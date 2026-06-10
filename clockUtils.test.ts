import {
	parseTime,
	formatTime,
	formatDuration,
	parseSegment,
	buildSegment,
	parseSegments,
	serializeSegment,
	serializeSegments,
	segmentDurationMinutes,
	totalMinutes,
	countOpen,
	hasInvalid,
	countInvalid,
	isTrackedWorkDay,
	summarizeClockDay,
	summarizeClockBalance,
	balanceLabel,
	formatSignedDuration,
	addOpenSegment,
	closeOpenSegment,
	addBlankRow,
	updateRow,
	deleteRow,
	Segment,
} from "./clockUtils";

describe("parseTime", () => {
	it("parses valid HH:mm into minutes since midnight", () => {
		expect(parseTime("00:00")).toBe(0);
		expect(parseTime("09:00")).toBe(540);
		expect(parseTime("13:30")).toBe(810);
		expect(parseTime("23:59")).toBe(1439);
	});

	it("accepts single-digit hours and surrounding whitespace", () => {
		expect(parseTime("9:05")).toBe(545);
		expect(parseTime("  9:05  ")).toBe(545);
	});

	it("rejects invalid times", () => {
		expect(parseTime("24:00")).toBeNull();
		expect(parseTime("12:60")).toBeNull();
		expect(parseTime("9")).toBeNull();
		expect(parseTime("9:5")).toBeNull();
		expect(parseTime("")).toBeNull();
		expect(parseTime("abc")).toBeNull();
		expect(parseTime(null as unknown as string)).toBeNull();
	});
});

describe("formatTime", () => {
	it("zero-pads hours and minutes", () => {
		expect(formatTime(0)).toBe("00:00");
		expect(formatTime(545)).toBe("09:05");
		expect(formatTime(1439)).toBe("23:59");
	});

	it("wraps values outside a single day", () => {
		expect(formatTime(1440)).toBe("00:00");
		expect(formatTime(-60)).toBe("23:00");
	});
});

describe("formatDuration", () => {
	it("formats minutes as Xh Ym", () => {
		expect(formatDuration(0)).toBe("0h 00m");
		expect(formatDuration(545)).toBe("9h 05m");
		expect(formatDuration(540)).toBe("9h 00m");
		expect(formatDuration(125)).toBe("2h 05m");
	});

	it("never returns negative durations", () => {
		expect(formatDuration(-30)).toBe("0h 00m");
	});
});

describe("parseSegment", () => {
	it("parses a closed segment", () => {
		const seg = parseSegment("09:00-11:00");
		expect(seg.status).toBe("closed");
		expect(seg.start).toBe(540);
		expect(seg.end).toBe(660);
	});

	it("parses an open segment", () => {
		const seg = parseSegment("13:00-");
		expect(seg.status).toBe("open");
		expect(seg.start).toBe(780);
		expect(seg.end).toBeNull();
		expect(seg.endRaw).toBe("");
	});

	it("flags a missing dash as invalid-format", () => {
		const seg = parseSegment("0900");
		expect(seg.status).toBe("invalid-format");
	});

	it("flags an invalid time", () => {
		expect(parseSegment("25:00-11:00").status).toBe("invalid-time");
		expect(parseSegment("09:00-99:99").status).toBe("invalid-time");
	});

	it("flags end before start", () => {
		const seg = parseSegment("11:00-09:00");
		expect(seg.status).toBe("end-before-start");
		expect(seg.start).toBe(660);
		expect(seg.end).toBe(540);
	});

	it("tolerates whitespace around parts", () => {
		const seg = parseSegment("  09:00 - 11:00  ");
		expect(seg.status).toBe("closed");
		expect(seg.startRaw).toBe("09:00");
		expect(seg.endRaw).toBe("11:00");
	});
});

describe("parseSegments", () => {
	it("parses an array of strings", () => {
		const segs = parseSegments(["09:00-11:00", "13:00-"]);
		expect(segs).toHaveLength(2);
		expect(segs[0].status).toBe("closed");
		expect(segs[1].status).toBe("open");
	});

	it("returns empty array for non-array / missing input", () => {
		expect(parseSegments(undefined)).toEqual([]);
		expect(parseSegments(null)).toEqual([]);
		expect(parseSegments("09:00-11:00")).toEqual([]);
	});
});

describe("serialize", () => {
	it("round-trips a closed segment", () => {
		expect(serializeSegment(parseSegment("09:00-11:00"))).toBe("09:00-11:00");
	});

	it("round-trips an open segment", () => {
		expect(serializeSegment(parseSegment("13:00-"))).toBe("13:00-");
	});

	it("serializes a list", () => {
		const segs = parseSegments(["09:00-11:00", "13:00-"]);
		expect(serializeSegments(segs)).toEqual(["09:00-11:00", "13:00-"]);
	});
});

describe("segmentDurationMinutes", () => {
	const now = 14 * 60; // 14:00

	it("computes closed duration", () => {
		expect(segmentDurationMinutes(parseSegment("09:00-11:00"), now)).toBe(120);
	});

	it("computes open duration up to now", () => {
		expect(segmentDurationMinutes(parseSegment("13:00-"), now)).toBe(60);
	});

	it("returns 0 for invalid or end-before-start", () => {
		expect(segmentDurationMinutes(parseSegment("0900"), now)).toBe(0);
		expect(segmentDurationMinutes(parseSegment("11:00-09:00"), now)).toBe(0);
	});

	it("clamps open segments starting after now to 0", () => {
		expect(segmentDurationMinutes(parseSegment("15:00-"), now)).toBe(0);
	});
});

describe("totalMinutes", () => {
	it("sums closed and open segments", () => {
		const segs = parseSegments(["09:00-11:00", "13:00-"]);
		// 120 + (14:00 - 13:00 = 60) = 180
		expect(totalMinutes(segs, 14 * 60)).toBe(180);
	});

	it("ignores invalid segments", () => {
		const segs = parseSegments(["09:00-11:00", "bad", "11:00-09:00"]);
		expect(totalMinutes(segs, 14 * 60)).toBe(120);
	});

	it("is 0 for empty list", () => {
		expect(totalMinutes([], 14 * 60)).toBe(0);
	});
});

describe("countOpen / hasInvalid", () => {
	it("counts open segments", () => {
		expect(countOpen(parseSegments(["09:00-11:00", "13:00-"]))).toBe(1);
		expect(countOpen(parseSegments(["13:00-", "14:00-"]))).toBe(2);
		expect(countOpen(parseSegments(["09:00-11:00"]))).toBe(0);
	});

	it("detects invalid segments", () => {
		expect(hasInvalid(parseSegments(["09:00-11:00"]))).toBe(false);
		expect(hasInvalid(parseSegments(["bad"]))).toBe(true);
		expect(hasInvalid(parseSegments(["11:00-09:00"]))).toBe(true);
		expect(hasInvalid(parseSegments(["09:00-25:00"]))).toBe(true);
	});
});

describe("mutation helpers", () => {
	it("addOpenSegment appends an open segment and does not mutate input", () => {
		const segs: Segment[] = parseSegments(["09:00-11:00"]);
		const next = addOpenSegment(segs, 13 * 60);
		expect(segs).toHaveLength(1);
		expect(next).toHaveLength(2);
		expect(next[1].status).toBe("open");
		expect(next[1].startRaw).toBe("13:00");
	});

	it("closeOpenSegment closes the last open segment", () => {
		const segs = parseSegments(["09:00-11:00", "13:00-"]);
		const next = closeOpenSegment(segs, 15 * 60);
		expect(next[1].status).toBe("closed");
		expect(next[1].endRaw).toBe("15:00");
	});

	it("closeOpenSegment returns input unchanged when nothing open", () => {
		const segs = parseSegments(["09:00-11:00"]);
		expect(closeOpenSegment(segs, 15 * 60)).toBe(segs);
	});

	it("closeOpenSegment closes only the latest open segment", () => {
		const segs = parseSegments(["10:00-", "13:00-"]);
		const next = closeOpenSegment(segs, 15 * 60);
		expect(next[0].status).toBe("open");
		expect(next[1].status).toBe("closed");
	});

	it("addBlankRow appends an invalid blank row", () => {
		const next = addBlankRow(parseSegments(["09:00-11:00"]));
		expect(next).toHaveLength(2);
		expect(next[1].status).toBe("invalid-time");
	});

	it("updateRow rebuilds the targeted row", () => {
		const segs = parseSegments(["09:00-11:00"]);
		const next = updateRow(segs, 0, "09:30", "11:30");
		expect(next[0].start).toBe(570);
		expect(next[0].end).toBe(690);
		expect(segs[0].start).toBe(540); // original untouched
	});

	it("updateRow ignores out-of-range index", () => {
		const segs = parseSegments(["09:00-11:00"]);
		expect(updateRow(segs, 5, "00:00", "01:00")).toBe(segs);
	});

	it("deleteRow removes the targeted row", () => {
		const segs = parseSegments(["09:00-11:00", "13:00-"]);
		const next = deleteRow(segs, 0);
		expect(next).toHaveLength(1);
		expect(next[0].status).toBe("open");
	});

	it("deleteRow ignores out-of-range index", () => {
		const segs = parseSegments(["09:00-11:00"]);
		expect(deleteRow(segs, 9)).toBe(segs);
	});
});

describe("buildSegment", () => {
	it("treats empty end as open", () => {
		expect(buildSegment("09:00", "").status).toBe("open");
	});

	it("treats empty start as invalid", () => {
		expect(buildSegment("", "").status).toBe("invalid-time");
	});
});

describe("countInvalid", () => {
	it("counts only uninterpretable segments", () => {
		const segs = parseSegments([
			"09:00-11:00", // closed
			"13:00-", // open
			"bad", // invalid-format
			"25:00-26:00", // invalid-time
			"11:00-09:00", // end-before-start
		]);
		expect(countInvalid(segs)).toBe(3);
	});
});

describe("isTrackedWorkDay", () => {
	it("is true when the array has at least one non-empty segment", () => {
		expect(isTrackedWorkDay(["09:00-11:00"])).toBe(true);
		expect(isTrackedWorkDay(["", "13:00-"])).toBe(true);
	});

	it("is false for empty/missing/non-array values", () => {
		expect(isTrackedWorkDay([])).toBe(false);
		expect(isTrackedWorkDay(["", "  "])).toBe(false);
		expect(isTrackedWorkDay(undefined)).toBe(false);
		expect(isTrackedWorkDay("09:00-11:00")).toBe(false);
		expect(isTrackedWorkDay(null)).toBe(false);
	});
});

describe("summarizeClockDay", () => {
	it("uses closed durations and the day's target", () => {
		const segs = parseSegments(["09:00-11:00", "13:00-15:30"]);
		const day = summarizeClockDay("a.md", segs, 480, 0, false);
		expect(day.workedMinutes).toBe(270); // 2h + 2h30
		expect(day.targetMinutes).toBe(480);
		expect(day.deltaMinutes).toBe(-210);
		expect(day.openCount).toBe(0);
		expect(day.invalidCount).toBe(0);
	});

	it("counts an open segment live only when countOpenLive is true", () => {
		const segs = parseSegments(["09:00-11:00", "13:00-"]); // 2h closed + open
		const now = 14 * 60; // 14:00 -> open contributes 60m when live
		const live = summarizeClockDay("today.md", segs, 480, now, true);
		expect(live.workedMinutes).toBe(180);
		expect(live.openCount).toBe(1);

		const stale = summarizeClockDay("old.md", segs, 480, now, false);
		expect(stale.workedMinutes).toBe(120); // open ignored
		expect(stale.openCount).toBe(1); // still reported for warnings
	});

	it("ignores invalid segments in worked time but reports their count", () => {
		const segs = parseSegments(["09:00-11:00", "bad", "11:00-09:00"]);
		const day = summarizeClockDay("x.md", segs, 0, 0, false);
		expect(day.workedMinutes).toBe(120);
		expect(day.invalidCount).toBe(2);
	});
});

describe("summarizeClockBalance", () => {
	it("sums worked, target and delta across days", () => {
		const days = [
			summarizeClockDay("a", parseSegments(["09:00-17:00"]), 480, 0, false), // 8h/8h
			summarizeClockDay("b", parseSegments(["09:00-18:00"]), 480, 0, false), // 9h/8h
			summarizeClockDay("c", parseSegments(["09:00-12:00"]), 480, 0, false), // 3h/8h
		];
		const bal = summarizeClockBalance(days);
		expect(bal.dayCount).toBe(3);
		expect(bal.workedMinutes).toBe(480 + 540 + 180);
		expect(bal.targetMinutes).toBe(1440);
		expect(bal.deltaMinutes).toBe(1200 - 1440); // -240 (4h owed)
	});

	it("aggregates open and invalid counts and handles no days", () => {
		const empty = summarizeClockBalance([]);
		expect(empty).toEqual({
			workedMinutes: 0,
			targetMinutes: 0,
			deltaMinutes: 0,
			dayCount: 0,
			openCount: 0,
			staleOpenCount: 0,
			invalidCount: 0,
		});
	});

	it("reports stale open segments (open in a non-live day)", () => {
		const today = summarizeClockDay(
			"today",
			parseSegments(["09:00-"]),
			480,
			10 * 60,
			true
		);
		const old = summarizeClockDay(
			"old",
			parseSegments(["09:00-"]),
			480,
			10 * 60,
			false
		);
		const bal = summarizeClockBalance([today, old]);
		expect(bal.openCount).toBe(2);
		expect(bal.staleOpenCount).toBe(1); // only the old note's open is stale
	});
});

describe("balanceLabel", () => {
	it("classifies sign of the delta", () => {
		expect(balanceLabel(150)).toBe("ahead");
		expect(balanceLabel(-150)).toBe("owed");
		expect(balanceLabel(0)).toBe("balanced");
		expect(balanceLabel(0.4)).toBe("balanced"); // rounds to 0
	});
});

describe("formatSignedDuration", () => {
	it("prefixes a sign and never shows a negative inside the duration", () => {
		expect(formatSignedDuration(270)).toBe("+4h 30m");
		expect(formatSignedDuration(-210)).toBe("\u22123h 30m");
		expect(formatSignedDuration(0)).toBe("0h 00m");
	});
});
