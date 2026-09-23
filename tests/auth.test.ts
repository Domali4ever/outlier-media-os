import { describe, expect, it } from "vitest";
import { changePassword, login, operatorConfigured, setupOperator, validateSession } from "@/core/auth";
import { freshDb } from "./helpers";

describe("operator authentication", () => {
  it("first-run setup, login, session validation and lockout", () => {
    freshDb();
    expect(operatorConfigured()).toBe(false);
    expect(() => setupOperator("short")).toThrow(/12/);
    setupOperator("correct horse battery");
    expect(() => setupOperator("another long password")).toThrow(/already/);
    const { token } = login("correct horse battery", "k", null);
    expect(validateSession(token)).toBe(true);
    expect(validateSession("forged")).toBe(false);
    for (let i = 0; i < 5; i++) expect(() => login("wrong", "attacker", null)).toThrow();
    expect(() => login("correct horse battery", "attacker", null)).toThrow(/Too many/);
    changePassword("correct horse battery", "new long passphrase!");
    expect(validateSession(token)).toBe(false);
  });
});
