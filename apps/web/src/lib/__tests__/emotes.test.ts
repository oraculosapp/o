import { describe, expect, it } from "vitest";
import { EMOTE_IDS, isEmoteId } from "@phygitalia/engine";

/**
 * Contrato del flujo "emote" (M-5): la lista blanca del engine es la única
 * fuente de verdad — realtime.ts la usa para validar broadcasts entrantes y el
 * EmoteMenu de la web debe pintar exactamente estos ids.
 */
describe("emotes — lista blanca del engine", () => {
  it("expone los 5 emotes de la casa", () => {
    expect([...EMOTE_IDS]).toEqual(["dance1", "dance2", "wave", "spin", "jump-cheer"]);
  });

  it("isEmoteId acepta sólo la lista blanca (broadcasts no son de fiar)", () => {
    for (const id of EMOTE_IDS) expect(isEmoteId(id)).toBe(true);
    expect(isEmoteId("twerk")).toBe(false);
    expect(isEmoteId("")).toBe(false);
    expect(isEmoteId("http://evil")).toBe(false);
  });
});
