// A routine that reports to a group should speak only when it has something to say. A run that finds
// nothing new answers with this one marker (or says plainly that there is nothing to report), and the
// group stays quiet: a daily check is not a message every day. A run that failed or was missed is never quiet.

/** The marker a routine's bot ends with when there is nothing to tell the group. */
export const QUIET_MARKER = "NO_REPLY";

const NOTHING = /^(?:nothing\s+(?:new|to\s+report)|no\s+(?:changes?|news|updates?|new\s+\w+)|tidak\s+ada\s+(?:perubahan|kabar|update|yang\s+baru|laporan))\.?$/i;

/** True when a finished run's output has nothing worth posting: empty, the marker, or a plain "nothing new". */
export function isQuietReport(output: string | undefined): boolean {
  const text = (output ?? "").replace(/^[*_`>#\s]+|[*_`>#\s]+$/g, "");
  return !text || text.toUpperCase() === QUIET_MARKER || NOTHING.test(text);
}

/** What a routine's bot is told when its report goes to a group. */
export const QUIET_INSTRUCTION = `When this routine reports to a group: if there is nothing new or nothing the group needs to act on, reply with only ${QUIET_MARKER} and the group stays quiet. Otherwise report what changed, briefly.`;
