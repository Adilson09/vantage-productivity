// Aster Mail: imported Desktop registrations stay local and cannot become a web-client flow.
import { describe, expect, it } from "vitest";
import { googleDesktopClient } from "./googleClient";

describe("Google Desktop client import", () => {
  it("reads only a Desktop client ID and optional issued secret", () => {
    expect(googleDesktopClient(JSON.stringify({ installed: { client_id: "123-desktop.apps.googleusercontent.com", client_secret: " issued ", auth_uri: "https://untrusted.invalid", refresh_token: "ignored" } }))).toEqual({ client_id: "123-desktop.apps.googleusercontent.com", client_secret: "issued" });
    expect(googleDesktopClient(JSON.stringify({ installed: { client_id: "123-desktop.apps.googleusercontent.com" } }))).toEqual({ client_id: "123-desktop.apps.googleusercontent.com" });
  });
  it.each(["{}", "[]", '{"web":{"client_id":"123-web.apps.googleusercontent.com"}}', '{"installed":{"client_id":"not-a-google-client"}}', '{"installed":{"client_id":42}}']) ("rejects a non-Desktop registration: %s", (text) => {
    expect(() => googleDesktopClient(text)).toThrow();
  });
});
