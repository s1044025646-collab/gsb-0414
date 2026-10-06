import * as http from "node:http";
import * as net from "node:net";
import { AddressInfo } from "node:net";
import { Store } from "./store";
import { link } from "./linker";
import { LinkError } from "./errors";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new LinkError("E_BAD_INPUT", "请求体必须是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      // POST /sets  导入模块集合 {modules:[...]}
      if (req.method === "POST" && path === "/sets") {
        const body = await readBody(req);
        // 先完整校验再入库
        link(body.modules, 0);
        const r = store.importModules(body.modules);
        return send(res, r.created ? 201 : 200, r);
      }
      if (req.method === "GET" && path === "/sets") return send(res, 200, store.listSets());
      const mSet = path.match(/^\/sets\/(\d+)$/);
      if (req.method === "GET" && mSet) return send(res, 200, { modules: store.getModules(Number(mSet[1])) });

      // POST /sets/:id/validate 仅校验
      const mVal = path.match(/^\/sets\/(\d+)\/validate$/);
      if (req.method === "POST" && mVal) {
        const modules = store.getModules(Number(mVal[1]));
        const body = await readBody(req);
        const base = body.base ?? 0;
        const r = link(modules, base);
        return send(res, 200, { ok: true, layout: r.layout, symbols: r.symbols, patches: r.patches });
      }

      // POST /sets/:id/link {base} 链接并保存版本
      const mLink = path.match(/^\/sets\/(\d+)\/link$/);
      if (req.method === "POST" && mLink) {
        const body = await readBody(req);
        const { versionId, result, reused } = store.linkAndStore(Number(mLink[1]), body.base ?? 0);
        return send(res, reused ? 200 : 201, {
          versionId,
          reused,
          base: result.base,
          imageSize: result.image.length,
          layout: result.layout,
          symbols: result.symbols,
          patches: result.patches,
        });
      }

      if (req.method === "GET" && path === "/versions") {
        return send(res, 200, store.listVersions().map((v) => ({ ...v, summary: undefined })));
      }
      const mVer = path.match(/^\/versions\/(\d+)(\/image|\/layout|\/symbols|\/patches)?$/);
      if (req.method === "GET" && mVer) {
        const v = store.getVersion(Number(mVer[1]));
        const sub = mVer[2];
        if (sub === "/image") {
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="image-v${v.row.id}.bin"`,
          });
          return res.end(v.image);
        }
        if (sub === "/layout") return send(res, 200, v.summary.layout);
        if (sub === "/symbols") return send(res, 200, v.summary.symbols);
        if (sub === "/patches") return send(res, 200, v.summary.patches);
        return send(res, 200, { id: v.row.id, base: v.row.base, ...v.summary });
      }

      // GET /compare?a=1&b=2
      if (req.method === "GET" && path === "/compare") {
        const a = Number(url.searchParams.get("a"));
        const b = Number(url.searchParams.get("b"));
        return send(res, 200, store.compare(a, b));
      }

      send(res, 404, { error: { code: "E_NOT_FOUND", message: `未知路由 ${req.method} ${path}` } });
    } catch (e) {
      if (e instanceof LinkError) {
        send(res, 400, { error: { code: e.code, message: e.message, details: e.details } });
      } else {
        send(res, 500, { error: { code: "E_INTERNAL", message: String(e) } });
      }
    }
  });
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

export async function startServer(port?: number, dbPath?: string): Promise<{ server: http.Server; port: number }> {
  const store = new Store(dbPath);
  const server = createServer(store);
  const p = port ?? (await findFreePort());
  await new Promise<void>((resolve) => server.listen(p, resolve));
  return { server, port: p };
}

if (require.main === module) {
  const idx = process.argv.indexOf("--port");
  const port = idx >= 0 ? Number(process.argv[idx + 1]) : undefined;
  startServer(port).then(({ port }) => {
    console.log(`链接服务已启动: http://localhost:${port}`);
  });
}
