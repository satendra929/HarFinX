// The one path for everything the engine prints on stdout. It remembers how the last output ended, so a line always
// starts on a fresh line and a note gets exactly one blank line above it, whatever was printed before. Pure: no I/O of its own.

export function createPrinter(io: { write(text: string): void }, pending: () => string = () => "") {
  let tail = "\n\n"; // the last two characters written; the start counts as a blank line
  const put = (t: string): void => {
    if (!t) return;
    io.write(t);
    tail = (tail + t).slice(-2);
  };
  // Answer text that was cut off before its line ended is shown as it is, then an open line is closed.
  const settle = (): void => {
    put(pending());
    if (!tail.endsWith("\n")) put("\n");
  };
  return {
    /** Answer text, already safe for the terminal (and marked when it is whole lines). */
    text: put,
    /** A progress or status line, on its own line. */
    line(s: string): void {
      settle();
      put(s + "\n");
    },
    /** A line set apart from what is above it by one blank line (not two when one is already there). */
    note(s: string): void {
      settle();
      if (tail !== "\n\n") put("\n");
      put(s + "\n");
    },
    /** A new question starts: the caller has left a blank line, whatever was printed before. */
    begin(): void {
      tail = "\n\n";
    },
    /** The end of the answer: shows what is left of it and closes the line. */
    end: settle,
  };
}
