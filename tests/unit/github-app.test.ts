/**
 * Unit tests for GitHub App authentication and token broker (T5.2).
 */

import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGitHubAppJwt, mintGitHubInstallationToken } from "../../core/github-app.js";

describe("T5.2 GitHub App Token Broker", () => {
  // Generate a test RSA keypair
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  it("generates signed RS256 JWT matching GitHub specifications", () => {
    const jwt = createGitHubAppJwt("123456", privateKey, 1788739000);
    const parts = jwt.split(".");

    expect(parts).toHaveLength(3);

    const header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf-8"));
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8"));

    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    expect(payload.iss).toBe("123456");
    expect(payload.exp - payload.iat).toBe(660); // 10 min + 60s skew
  });

  it("mints installation access token using mock GitHub API", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string, _init?: RequestInit) => {
      if (url.includes("/repos/acme/api/installation")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 987654 }),
        };
      }
      if (url.includes("/installations/987654/access_tokens")) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            token: "ghs_testInstallationToken123",
            expires_at: "2026-09-06T19:00:00Z",
            permissions: { contents: "write", pull_requests: "write" },
          }),
        };
      }
      return { ok: false, status: 404 };
    });

    const result = await mintGitHubInstallationToken({
      appId: "123456",
      privateKeyPem: privateKey,
      repositoryName: "acme/api",
      fetchFn: mockFetch as unknown as typeof fetch,
    });

    expect(result.token).toBe("ghs_testInstallationToken123");
    expect(result.expiresAt).toBe("2026-09-06T19:00:00Z");
    expect(result.permissions.contents).toBe("write");
  });
});
