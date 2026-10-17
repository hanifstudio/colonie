// The smallest RouteContext a route module can be driven with: `json` records
// instead of writing to a socket, `readBody` returns the given body. Modules
// may only touch these fields (see ../routes/table.ts).
import type { RouteContext } from "../routes/table.ts";

export interface SentResponse {
  status: number;
  body: unknown;
}

export function callRoute(path: string, method = "GET", body: unknown = {}) {
  const sent: SentResponse[] = [];
  const url = new URL(`http://127.0.0.1${path}`);
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 200,
    setHeader: () => {},
    writeHead: () => {},
    end: () => {},
  };
  const ctx = {
    req: {},
    res,
    url,
    path: url.pathname,
    method,
    auth: { scopes: [] },
    json: async (_res: unknown, status: number, payload: unknown) => {
      sent.push({ status, body: payload });
    },
    readBody: async () => body,
  } as unknown as RouteContext;
  return { ctx, sent };
}