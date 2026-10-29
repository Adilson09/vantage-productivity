// Aster Mail: the product has an independent name and an explicit upstream credit in both languages.
import { describe, expect, it } from "vitest";
import { i18n, t } from "./i18n.svelte";

describe("Aster Mail identity", () => {
  it.each(["en", "ru"] as const)("uses the Aster name while retaining source attribution in %s", (lang) => {
    i18n.lang = lang;
    expect(t("app.name")).toBe("Aster Mail");
    expect(t("app.origin")).toContain("Depesha");
    expect(t("wizard.lead")).toContain("Aster Mail");
    expect(t("settings.unsupportedNote")).toContain("Aster Mail");
    expect(t("wizard.googleAccessHelp")).toContain("Test users");
  });
});
