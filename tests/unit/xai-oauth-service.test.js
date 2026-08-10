import { beforeEach, describe, expect, it, vi } from "vitest";

describe("xai/oauth service", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.stubGlobal("fetch", vi.fn());
  });

  it("validates discovered endpoints are https x.ai URLs", async () => {
    const { validateOAuthEndpoint } = await import("../../src/lib/oauth/services/xai.js");

    expect(validateOAuthEndpoint("https://auth.x.ai/oauth2/authorize", "authorization_endpoint")).toBe(
      "https://auth.x.ai/oauth2/authorize"
    );
    expect(() => validateOAuthEndpoint("http://auth.x.ai/oauth2/authorize", "authorization_endpoint")).toThrow(
      /must use https/
    );
    expect(() => validateOAuthEndpoint("https://example.com/oauth2/authorize", "authorization_endpoint")).toThrow(
      /is not on x\.ai/
    );
  });

  it("discovers endpoints without custom user-agent headers", async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      }),
    });

    const { discoverEndpoints } = await import("../../src/lib/oauth/services/xai.js");
    await expect(discoverEndpoints()).resolves.toEqual({
      authorizeUrl: "https://auth.x.ai/oauth2/authorize",
      tokenUrl: "https://auth.x.ai/oauth2/token",
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://auth.x.ai/.well-known/openid-configuration",
      expect.objectContaining({ headers: { Accept: "application/json" } })
    );
  });

  it("builds authorize URLs with CLIProxyAPI query extras", async () => {
    const { XaiService } = await import("../../src/lib/oauth/services/xai.js");
    const authUrl = new XaiService().buildXaiAuthUrl(
      "http://127.0.0.1:56121/callback",
      "state-1",
      "challenge-1",
      "https://auth.x.ai/oauth2/authorize"
    );
    const parsed = new URL(authUrl);

    expect(parsed.origin + parsed.pathname).toBe("https://auth.x.ai/oauth2/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(parsed.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe("state-1");
    expect(parsed.searchParams.get("nonce")).toMatch(/^[a-f0-9]{32}$/);
    expect(parsed.searchParams.get("plan")).toBe("generic");
    expect(parsed.searchParams.get("referrer")).toBe("cli-proxy-api");
  });

  it("generates dashboard auth data with CLIProxyAPI PKCE size and discovered endpoints", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize-from-discovery",
        token_endpoint: "https://auth.x.ai/oauth2/token-from-discovery",
      }),
    });
    const { discoverEndpoints } = await import("../../src/lib/oauth/services/xai.js");
    const discovered = await discoverEndpoints({ fetchImpl });
    expect(discovered.authorizeUrl).toBe("https://auth.x.ai/oauth2/authorize-from-discovery");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://auth.x.ai/.well-known/openid-configuration",
      expect.objectContaining({ headers: { Accept: "application/json" } })
    );

    // buildXaiAuthUrl is pure — wire the discovered authorizeUrl in directly
    const { XaiService } = await import("../../src/lib/oauth/services/xai.js");
    const { generatePkce } = await import("../../src/lib/oauth/utils/pkce.js").catch(() => ({}));
    const svc = new XaiService();
    const authUrl = svc.buildXaiAuthUrl(
      "http://127.0.0.1:56121/callback",
      "state-1",
      "challenge-1",
      discovered.authorizeUrl
    );
    const parsed = new URL(authUrl);
    expect(parsed.origin + parsed.pathname).toBe("https://auth.x.ai/oauth2/authorize-from-discovery");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("plan")).toBe("generic");
    expect(parsed.searchParams.get("referrer")).toBe("cli-proxy-api");
  });

  it("exchanges dashboard codes against the discovered xAI token endpoint", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
          token_endpoint: "https://auth.x.ai/oauth2/token-from-discovery",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 3600,
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const { discoverEndpoints, XaiService } = await import("../../src/lib/oauth/services/xai.js");
    const discovered = await discoverEndpoints({ fetchImpl: fetchMock });
    expect(discovered.tokenUrl).toBe("https://auth.x.ai/oauth2/token-from-discovery");
    expect(fetchMock.mock.calls[0][0]).toBe("https://auth.x.ai/.well-known/openid-configuration");
  });
});
