<script lang="ts">
  // Aster Mail: a missing publisher registration leads to explicit local configuration.
  import { api, asError } from "../../lib/api";
  import { t } from "../../lib/i18n.svelte";
  import { googleClient, googleDesktopClient } from "../../lib/googleClient";

  let { onConfigured, onCancel }: { onConfigured: () => Promise<void>; onCancel: () => void } = $props();
  let clientId = $state("");
  let clientSecret = $state("");
  let busy = $state(false);
  let error = $state("");
  let imported = $state(false);

  async function open(url: string) {
    try { await api.openLink(url); } catch (e) { error = asError(e).message; }
  }

  async function importFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    error = "";
    imported = false;
    try {
      if (file.size > 64 * 1024) throw new Error("google-desktop-json");
      const client = googleDesktopClient(await file.text());
      clientId = client.client_id;
      clientSecret = client.client_secret ?? "";
      imported = true;
    } catch {
      // JSON diagnostics can contain registration fields; show only fixed, translated guidance.
      error = t("wizard.googleImportError");
    }
    finally { input.value = ""; }
  }

  async function save() {
    error = "";
    let client;
    try { client = googleClient(clientId, clientSecret); }
    catch {
      // The validator emits an internal code; the field needs translated setup guidance.
      error = t("wizard.googleClientIdError");
      return;
    }
    busy = true;
    try {
      const current = await api.settings();
      await api.settingsPatch({ oauth_clients: { ...current.oauth_clients, google: client } });
      await onConfigured();
    } catch (e) { error = asError(e).message; }
    finally { busy = false; }
  }
</script>

<section class="google-setup" aria-labelledby="google-setup-title">
  <h4 id="google-setup-title">{t("wizard.googleSetupTitle")}</h4>
  <p class="muted">{t("wizard.googleSetupLead")}</p>
  <ol>
    <li>{t("wizard.googleSetupStep1")}</li>
    <li>{t("wizard.googleSetupStep2")}</li>
    <li>{t("wizard.googleSetupStep3")}</li>
  </ol>
  <div class="setup-links">
    <button class="btn" onclick={() => open("https://console.cloud.google.com/apis/credentials")} disabled={busy}>{t("wizard.googleConsole")}</button>
    <button class="link" onclick={() => open("https://developers.google.com/identity/protocols/oauth2/native-app")} disabled={busy}>{t("wizard.googleOfficialHelp")}</button>
  </div>
  <label class="field"><span>{t("wizard.googleImport")}</span><input type="file" accept=".json,application/json" onchange={importFile} disabled={busy} /></label>
  {#if imported}<p class="muted" role="status">{t("wizard.googleImported")}</p>{/if}
  <label class="field"><span>{t("wizard.googleClientId")}</span><input class="input" name="google-client-id" bind:value={clientId} autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="123-example.apps.googleusercontent.com" disabled={busy} /></label>
  <label class="field"><span>{t("wizard.googleClientSecret")}</span><input class="input" name="google-client-secret" type="password" bind:value={clientSecret} autocomplete="off" disabled={busy} /></label>
  <p class="muted small">{t("wizard.googleClientStorage")}</p>
  <p class="muted small">{t("wizard.googlePublisherNote")}</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="setup-actions">
    <button class="btn ghost" onclick={onCancel} disabled={busy}>{t("wizard.back")}</button>
    <button class="btn primary" onclick={save} disabled={busy || !clientId.trim()}>{busy ? t("wizard.saving") : t("wizard.googleSaveSetup")}</button>
  </div>
</section>

<style>
  .google-setup { display: flex; flex-direction: column; gap: 12px; }
  h4, p { margin: 0; }
  h4 { font-size: 16px; }
  p, li { line-height: 1.5; }
  ol { margin: 0; padding-left: 22px; }
  li + li { margin-top: 7px; }
  .setup-links, .setup-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
  .setup-actions { justify-content: flex-end; padding-top: 6px; }
  .small { font-size: 12px; }
  .link { border: none; background: none; color: var(--link); padding: 0; text-decoration: underline; }
  input[type="file"] { max-width: 100%; }
</style>
