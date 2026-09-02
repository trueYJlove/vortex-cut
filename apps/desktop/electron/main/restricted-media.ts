import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { isAbsolute, normalize, resolve } from "node:path";
import { Readable } from "node:stream";

export const RESTRICTED_MEDIA_SCHEME = "aivideo";
export type RestrictedMediaPurpose = "asset" | "proxy" | "artifact";

export interface RestrictedMediaTicket {
  ticket: string;
  entity_id: string;
  purpose: RestrictedMediaPurpose;
  path: string;
  expires_at: number;
}

export class RestrictedMediaRegistry {
  private readonly entities = new Map<string, { path: string; purpose: RestrictedMediaPurpose }>();
  private readonly tickets = new Map<string, RestrictedMediaTicket>();

  constructor(private readonly ttlMs = 5 * 60_000, private readonly now = () => Date.now()) {}

  register(entityId: string, inputPath: string, purpose: RestrictedMediaPurpose = "asset"): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(entityId) || !isAbsolute(inputPath)) throw new Error("Invalid restricted media registration");
    this.entities.set(`${purpose}:${entityId}`, { path: normalize(resolve(inputPath)), purpose });
  }

  remove(entityId: string, purpose: RestrictedMediaPurpose = "asset"): void { this.entities.delete(`${purpose}:${entityId}`); }
  registeredPath(entityId: string, purpose: RestrictedMediaPurpose = "asset"): string | undefined { return this.entities.get(`${purpose}:${entityId}`)?.path; }

  issue(entityId: string, purpose: RestrictedMediaPurpose = "asset"): string {
    const entity = this.entities.get(`${purpose}:${entityId}`);
    if (!entity) throw new Error("Restricted media entity is not registered");
    let ticket = randomBytes(24).toString("base64url");
    while (this.tickets.has(ticket)) ticket = randomBytes(24).toString("base64url");
    this.tickets.set(ticket, { ticket, entity_id: entityId, purpose, path: entity.path, expires_at: this.now() + this.ttlMs });
    return `${RESTRICTED_MEDIA_SCHEME}://media/${ticket}`;
  }

  resolveUrl(value: string, expectedPurpose?: RestrictedMediaPurpose): RestrictedMediaTicket | undefined {
    let url: URL;
    try { url = new URL(value); } catch { return undefined; }
    if (url.protocol !== `${RESTRICTED_MEDIA_SCHEME}:` || url.hostname !== "media" || url.search || url.hash) return undefined;
    const raw = url.pathname.replace(/^\//, "");
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(raw) || raw.includes("..") || raw.includes("%")) return undefined;
    const item = this.tickets.get(raw);
    if (!item || item.expires_at <= this.now() || (expectedPurpose && item.purpose !== expectedPurpose)) { if (item?.expires_at && item.expires_at <= this.now()) this.tickets.delete(raw); return undefined; }
    return item;
  }
}

export function ticketFromRestrictedUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== `${RESTRICTED_MEDIA_SCHEME}:` || url.hostname !== "media" || url.search || url.hash) return null;
    const ticket = url.pathname.replace(/^\//, "");
    return /^[A-Za-z0-9_-]{32,128}$/.test(ticket) && !ticket.includes("..") ? ticket : null;
  } catch { return null; }
}

export async function serveRestrictedMedia(request: Request, registry: RestrictedMediaRegistry): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 403 });
  const item = registry.resolveUrl(request.url);
  if (!item) return new Response(null, { status: 404 });
  try {
    const info = await stat(item.path);
    if (!info.isFile()) return new Response(null, { status: 403 });
    const range = request.headers.get("range");
    let start = 0; let end = info.size - 1; let status = 200;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!match) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
      if (match[1] === "" && match[2] !== "") { const suffix = Number(match[2]); start = Math.max(0, info.size - suffix); }
      else { start = Number(match[1] || 0); end = match[2] ? Number(match[2]) : end; }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= info.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
      end = Math.min(end, info.size - 1); status = 206;
    }
    const headers = new Headers({ "Accept-Ranges": "bytes", "Content-Length": String(Math.max(0, end - start + 1)), "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" });
    if (status === 206) headers.set("Content-Range", `bytes ${start}-${end}/${info.size}`);
    if (request.method === "HEAD") return new Response(null, { status, headers });
    return new Response(Readable.toWeb(createReadStream(item.path, { start, end })) as ReadableStream, { status, headers });
  } catch { return new Response(null, { status: 404 }); }
}
