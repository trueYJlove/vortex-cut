import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(fileURLToPath(new URL("..", import.meta.url)), "out/renderer"));
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = createServer((request, response) => {
  const requestPath = decodeURIComponent((request.url ?? "/").split("?")[0]);
  const relativePath = requestPath === "/" ? "/index.html" : requestPath;
  const candidate = normalize(join(root, relativePath));
  if (!candidate.startsWith(root) || !existsSync(candidate) || !statSync(candidate).isFile()) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, { "Content-Type": contentTypes[extname(candidate)] ?? "application/octet-stream" });
  createReadStream(candidate).pipe(response);
});

server.listen(5173, "127.0.0.1");
