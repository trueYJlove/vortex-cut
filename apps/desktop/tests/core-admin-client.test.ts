import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CoreAdminClient, CoreHttpError } from "../electron/main/core-admin-client.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
});

async function clientFor(status: number, body = "") {
  const requests: Array<{ method?: string; url?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url });
    request.resume();
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(body);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server");
  return { client: new CoreAdminClient(`http://127.0.0.1:${address.port}`, "test-admin-token"), requests };
}

describe("Core admin response handling", () => {
  it("accepts the real empty 204 response for provider secret deletion", async () => {
    const { client, requests } = await clientFor(204);
    await expect(client.deleteProviderSecret("provider_1")).resolves.toBeUndefined();
    expect(requests).toEqual([{ method: "DELETE", url: "/api/v1/internal/provider-secrets/provider_1" }]);
  });

  it("accepts empty 204 for image provider secret deletion too", async () => {
    const { client } = await clientFor(204);
    await expect(client.deleteImageProviderSecret("image_provider_1")).resolves.toBeUndefined();
  });

  it("does not treat empty HTTP errors as success", async () => {
    const { client } = await clientFor(403);
    await expect(client.deleteProviderSecret("provider_1")).rejects.toBeInstanceOf(CoreHttpError);
    await expect(client.deleteProviderSecret("provider_1")).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
  });

  it("still parses successful JSON and rejects malformed nonempty JSON", async () => {
    const valid = await clientFor(200, '{"provider_config_id":"provider_1","credential_status":"configured"}');
    await expect(valid.client.setProviderSecret("provider_1", "test-only")).resolves.toMatchObject({ credential_status: "configured" });
    const invalid = await clientFor(200, "{");
    await expect(invalid.client.setProviderSecret("provider_1", "test-only")).rejects.toBeInstanceOf(SyntaxError);
  });
});

