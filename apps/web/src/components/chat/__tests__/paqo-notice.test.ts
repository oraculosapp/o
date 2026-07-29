import { describe, it, expect } from "vitest";
import { paqoNoticeCopy, type PaqoNoticeReason } from "../paqo-notice";

describe("paqoNoticeCopy", () => {
  it("tiene una frase para cada motivo de MentionPaqoOutcome (ok:false)", () => {
    const reasons: PaqoNoticeReason[] = ["cooldown", "rate-limited", "unavailable", "network"];
    for (const reason of reasons) {
      const copy = paqoNoticeCopy(reason);
      expect(typeof copy).toBe("string");
      expect(copy.length).toBeGreaterThan(0);
    }
  });

  it("cooldown avisa que Paqo acaba de responder a otro viajero", () => {
    expect(paqoNoticeCopy("cooldown")).toMatch(/paqo/i);
  });

  it("cada motivo tiene una frase DISTINTA (no un mensaje genérico repetido)", () => {
    const reasons: PaqoNoticeReason[] = ["cooldown", "rate-limited", "unavailable", "network"];
    const copies = new Set(reasons.map(paqoNoticeCopy));
    expect(copies.size).toBe(reasons.length);
  });
});
