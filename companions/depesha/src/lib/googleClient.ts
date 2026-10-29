// Aster Mail: provider registration is configuration, never proof of authentication.
import type { OAuthClient } from "./types";

export function googleClient(clientId: string, clientSecret = ""): OAuthClient {
  const client_id = clientId.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.apps\.googleusercontent\.com$/.test(client_id)) {
    throw new Error("google-client-id");
  }
  const client_secret = clientSecret.trim();
  return client_secret ? { client_id, client_secret } : { client_id };
}

export function googleDesktopClient(text: string): OAuthClient {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || !("installed" in value)) throw new Error("google-desktop-json");
  const installed = value.installed;
  if (!installed || typeof installed !== "object" || !("client_id" in installed) || typeof installed.client_id !== "string") {
    throw new Error("google-desktop-json");
  }
  const secret = "client_secret" in installed ? installed.client_secret : undefined;
  if (secret !== undefined && typeof secret !== "string") throw new Error("google-desktop-json");
  return googleClient(installed.client_id, secret);
}
