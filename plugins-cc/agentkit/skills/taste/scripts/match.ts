declare const self: Worker;

// A rule that reads a value out of the command gets it from here too, rather
// than compiling the pattern a second time somewhere the deadline cannot reach.
const MAX_CAPTURES = 20;

function captured(pattern: string, subject: string): { matched: boolean; captures: string[] } {
  const regex = new RegExp(pattern, 'g');
  const captures: string[] = [];
  let found = regex.exec(subject);
  while (found !== null && captures.length < MAX_CAPTURES) {
    captures.push(found[1] ?? found[0]);
    if (found[0] === '') regex.lastIndex += 1;
    found = regex.exec(subject);
  }
  return { matched: captures.length > 0, captures };
}

// One rule's pattern against one command, on a thread that can be terminated.
// A regular expression cannot be interrupted once it starts backtracking, so the
// only way to bound it is to run it somewhere abandonable.
self.onmessage = (event: MessageEvent) => {
  const { pattern, subject, capture } = event.data as {
    pattern: string;
    subject: string;
    capture?: boolean;
  };
  try {
    postMessage(
      capture === true
        ? captured(pattern, subject)
        : { matched: new RegExp(pattern).test(subject), captures: [] },
    );
  } catch (error) {
    postMessage({ failed: (error as Error).message });
  }
};
