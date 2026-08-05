declare const self: Worker;

// One rule's pattern against one command, on a thread that can be terminated.
// A regular expression cannot be interrupted once it starts backtracking, so the
// only way to bound it is to run it somewhere abandonable.
self.onmessage = (event: MessageEvent) => {
  const { pattern, subject } = event.data as { pattern: string; subject: string };
  try {
    postMessage({ matched: new RegExp(pattern).test(subject) });
  } catch (error) {
    postMessage({ failed: (error as Error).message });
  }
};
