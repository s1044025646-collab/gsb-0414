import http from "node:http";
import { LinkError } from "./model.js";
import { compareJobs, Store } from "./store.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function sendError(res: http.ServerResponse, e: unknown): void {
  if (e instanceof LinkError) sendJson(res, 400, { error: { code: e.code, message: e.message } });
  else if (e instanceof SyntaxError) sendJson(res, 400, { error: { code: "E_BAD_JSON", message: "请求体不是合法 JSON" } });
  else sendJson(res, 500, { error: { code: "E_INTERNAL", message: String(e) } });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length ? JSON.parse(text) : {};
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      // POST /sets  { modules: [...] }  导入模块集合
      if (req.method === "POST" && parts[0] === "sets" && parts.length === 1) {
        const body = (await readBody(req)) as { modules?: unknown[] };
        if (!Array.isArray(body.modules)) throw new LinkError("E_BAD_INPUT", "需要 modules 数组");
        const setId = store.importModules(body.modules as never);
        return sendJson(res, 201, { setId, moduleCount: body.modules.length });
      }
      if (req.method === "GET" && parts[0] === "sets" && parts.length === 1) {
        return sendJson(res, 200, { sets: store.listSets() });
      }
      // POST /validate { modules: [...] } 仅校验
      if (req.method === "POST" && parts[0] === "validate") {
        const body = (await readBody(req)) as { modules?: unknown[]; base?: number };
        if (!Array.isArray(body.modules)) throw new LinkError("E_BAD_INPUT", "需要 modules 数组");
        const { linkModules } = await import("./linker.js");
        const result = linkModules(body.modules, body.base ?? 0);
        return sendJson(res, 200, { ok: true, imageSize: result.imageSize, sections: result.sections, symbols: result.symbols });
      }
      // POST /link { setId, base } 或 { modules, base }
      if (req.method === "POST" && parts[0] === "link") {
        const body = (await readBody(req)) as { setId?: number; modules?: unknown[]; base?: number };
        const base = body.base ?? 0;
        let setId = body.setId;
        if (setId === undefined) {
          if (!Array.isArray(body.modules)) throw new LinkError("E_BAD_INPUT", "需要 setId 或 modules");
          setId = store.importModules(body.modules as never);
        }
        const { jobId, result } = store.link(setId, base);
        return sendJson(res, 201, {
          jobId, setId, base: result.base, imageSize: result.imageSize,
          sections: result.sections, symbols: result.symbols, patches: result.patches,
        });
      }
      if (req.method === "GET" && parts[0] === "jobs" && parts.length === 1) {
        return sendJson(res, 200, { jobs: store.listJobs() });
      }
      if (req.method === "GET" && parts[0] === "jobs" && parts.length >= 2) {
        const jobId = Number(parts[1]);
        if (!Number.isInteger(jobId)) throw new LinkError("E_BAD_INPUT", "jobId 非法");
        if (parts.length === 2) return sendJson(res, 200, store.getJob(jobId));
        const sub = parts[2];
        const { manifest } = store.getJob(jobId);
        if (sub === "layout") return sendJson(res, 200, { base: manifest.base, imageSize: manifest.imageSize, sections: manifest.sections });
        if (sub === "symbols") return sendJson(res, 200, { symbols: manifest.symbols });
        if (sub === "patches") return sendJson(res, 200, { patches: manifest.patches });
        if (sub === "manifest") return sendJson(res, 200, manifest);
        if (sub === "image") {
          const image = store.getImage(jobId);
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename="job-${jobId}.bin"` });
          return res.end(image);
        }
        if (sub === "compare" && parts.length === 3) {
          const otherId = Number(url.searchParams.get("with"));
          if (!Number.isInteger(otherId)) throw new LinkError("E_BAD_INPUT", "需要 ?with=<jobId>");
          const other = store.getJob(otherId);
          return sendJson(res, 200, compareJobs(manifest, other.manifest));
        }
      }
      sendJson(res, 404, { error: { code: "E_NOT_FOUND", message: "未知路由" } });
    } catch (e) {
      sendError(res, e);
    }
  });
}

export function startServer(store: Store, port: number): Promise<{ port: number; server: http.Server }> {
  return new Promise((resolve) => {
    const server = createServer(store);
    server.listen(port, () => {
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : port, server });
    });
  });
}
