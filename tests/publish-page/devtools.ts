// A devtools session over the launched browser's websocket. `--dump-dom` prints
// at a milestone of its own and cannot be asked "is it there yet"; a session can
// be asked, and asked again.
export interface Session {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  logs: string[];
  close(): void;
}

export async function attach(url: string): Promise<Session> {
  const ws = new WebSocket(url);
  const pending = new Map<number, (message: any) => void>();
  const logs: string[] = [];
  let id = 0;
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) pending.get(message.id)?.(message);
    else if (message.method === 'Runtime.exceptionThrown' || message.method === 'Log.entryAdded') {
      logs.push(JSON.stringify(message.params).slice(0, 300));
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params?.type === 'error') {
      logs.push(JSON.stringify(message.params.args).slice(0, 300));
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`devtools socket failed: ${url}`)));
  });
  return {
    send(method, params = {}) {
      const messageId = ++id;
      return new Promise((resolve) => {
        pending.set(messageId, resolve);
        ws.send(JSON.stringify({ id: messageId, method, params }));
      });
    },
    logs,
    close: () => ws.close(),
  };
}

// A probe that throws reports its value as undefined, which reads downstream as
// "the page said nothing" rather than "the probe broke". The description is the
// only place the reason survives.
export async function evaluate(session: Session, expression: string): Promise<unknown> {
  const reply = await session.send('Runtime.evaluate', { expression, returnByValue: true });
  const thrown = reply?.result?.exceptionDetails;
  if (thrown) {
    throw new Error(`probe threw in the page: ${thrown.exception?.description ?? JSON.stringify(thrown)}`);
  }
  return reply?.result?.result?.value;
}
