/** Verifies a bounded empty read cannot certify whole-calendar availability. */
import { describe, expect, it } from "vitest";
import { buildNextCalendarEventContext } from "./calendar-normalize.js";
import {
  formatNextEventContext,
  formatNextEventContextForUser,
} from "./format.js";

describe("next-event absence scope", () => {
  it("states non-exhaustive coverage and the exclusive end boundary", () => {
    const context = {
      ...buildNextCalendarEventContext(null, new Date("2026-09-30T10:40:00Z")),
      readScope: {
        selection: "next_event" as const,
        timeMin: "2026-09-30T07:00:00Z",
        timeMax: "2026-10-30T07:00:00Z",
        exhaustive: false,
      },
    };
    const facts = formatNextEventContext(context);
    expect(facts).toContain("end is exclusive");
    expect(facts).toContain("does not establish that the calendar is clear");
    expect(facts).toContain("2026-09-30T07:00:00Z");
    expect(facts).toContain("2026-10-30T07:00:00Z");
    expect(facts).toContain("bounded, non-exhaustive");
    expect(facts).toContain("Report absence only in these checked sources");
    expect(facts).toContain("Checked connected sources: (not reported)");
  });
  it("names only the connected sources actually checked, without source credentials", () => {
    const context = {
      ...buildNextCalendarEventContext(null, new Date("2026-09-30T10:40:00Z")),
      calendarSources: [
        {
          key: "private-connector-scope",
          summary: "Work calendar",
          accessRole: "owner" as const,
          visibility: "details" as const,
          status: "fresh" as const,
          syncedAt: "2026-09-30T10:40:00Z",
          error: null,
        },
      ],
      readScope: {
        selection: "next_event" as const,
        timeMin: "2026-09-30T07:00:00Z",
        timeMax: "2026-10-30T07:00:00Z",
        exhaustive: false as const,
      },
    };
    const facts = formatNextEventContext(context);
    expect(facts).toContain('Checked connected sources: ["Work calendar"]');
    expect(facts).not.toContain("private-connector-scope");
    expect(facts).toContain("do not generalize to other calendars");
  });
  it.each([
    [
      "same-day clock bounds",
      "2026-10-04T14:00:00Z",
      "2026-10-04T22:00:00Z",
      "Oct 4, 2026, 10:00 AM EDT to before Oct 4, 2026, 6:00 PM EDT",
    ],
    [
      "nonmidnight multi-day bounds",
      "2026-10-04T14:00:00Z",
      "2026-10-11T14:00:00Z",
      "Oct 4, 2026, 10:00 AM EDT to before Oct 11, 2026, 10:00 AM EDT",
    ],
    [
      "local midnight date-only bounds",
      "2026-10-04T04:00:00Z",
      "2026-10-11T04:00:00Z",
      "Oct 4, 2026 to before Oct 11, 2026",
    ],
    [
      "a midnight end after a nonmidnight start",
      "2026-10-04T14:00:00Z",
      "2026-10-11T04:00:00Z",
      "Oct 4, 2026, 10:00 AM EDT to before Oct 11, 2026",
    ],
    [
      "repeated clocks across the DST transition",
      "2026-11-01T05:30:00Z",
      "2026-11-01T06:30:00Z",
      "Nov 1, 2026, 1:30 AM EDT to before Nov 1, 2026, 1:30 AM EST",
    ],
    [
      "subminute bounds",
      "2026-10-04T14:00:01.250Z",
      "2026-10-04T22:00:02.500Z",
      "Oct 4, 2026, 10:00:01.250 AM EDT to before Oct 4, 2026, 6:00:02.500 PM EDT",
    ],
  ])(
    "preserves %s in exported human copy",
    (_label, timeMin, timeMax, range) => {
      const context = {
        ...buildNextCalendarEventContext(null, new Date(timeMin)),
        timeReference: { asOf: timeMin, timeZone: "America/New_York" },
        calendarSources: [
          {
            key: "private-connector-scope",
            summary: "Work calendar",
            accessRole: "owner" as const,
            visibility: "details" as const,
            status: "fresh" as const,
            syncedAt: timeMin,
            error: null,
          },
        ],
        readScope: {
          selection: "next_event" as const,
          timeMin,
          timeMax,
          exhaustive: false,
        },
      };
      expect(formatNextEventContextForUser(context)).toBe(
        `No upcoming event was found in Work calendar from ${range}.`,
      );
      expect(formatNextEventContext(context)).toContain(timeMin);
      expect(formatNextEventContext(context)).toContain(timeMax);
      expect(formatNextEventContext(context)).toContain(
        "bounded, non-exhaustive",
      );
      expect(formatNextEventContextForUser(context)).not.toContain(
        "private-connector-scope",
      );
    },
  );
  it("preserves the existing unknown-scope absence statement", () => {
    const context = buildNextCalendarEventContext(
      null,
      new Date("2026-09-30T10:40:00Z"),
    );
    expect(formatNextEventContext(context)).toBe(
      "No upcoming event was found in the checked calendar window.",
    );
  });
});
