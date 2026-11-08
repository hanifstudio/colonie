import { expect, test } from "vitest";
import { isQuietReport, QUIET_MARKER } from "./quiet-report.ts";

test("nothing, the marker, or a plain nothing-new is quiet", () => {
  for (const text of [undefined, "", "  \n", QUIET_MARKER, "no_reply", "**NO_REPLY**", "Nothing new.", "nothing to report", "No changes", "No updates.", "Tidak ada perubahan.", "tidak ada kabar"]) expect(isQuietReport(text)).toBe(true);
});

test("anything with content is not quiet, even when it starts like a quiet one", () => {
  for (const text of ["Revenue dropped 12% since Monday.", "No changes to the budget, but the venue cancelled.", "NO_REPLY is what I would say, but the build is red", "Nothing new on sales; 2 invoices are overdue."]) expect(isQuietReport(text)).toBe(false);
});
