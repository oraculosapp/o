import { describe, it, expect } from "vitest";
import {
  voiceChannelName,
  VOICE_CHANNEL_PREFIX,
  membersFromPresence,
  peerIdsFromPresence,
  iInitiateOffer,
  diffPeers,
  offerMessage,
  answerMessage,
  iceMessage,
} from "../signaling";

// Estado de presence al estilo Supabase: { [key]: Array<meta> }.
function presence(entries: Array<{ key: string; identity?: string; name?: string }>) {
  const state: Record<string, Array<{ identity: string; name: string }>> = {};
  for (const e of entries) {
    state[e.key] = [{ identity: e.identity ?? e.key, name: e.name ?? "" }];
  }
  // El tipo real es RealtimePresenceState; el shape es el que consumimos.
  return state as unknown as Parameters<typeof membersFromPresence>[0];
}

describe("voiceChannelName", () => {
  it("prefija con voz:<biosphereId>", () => {
    expect(voiceChannelName("paqo")).toBe("voz:paqo");
    expect(VOICE_CHANNEL_PREFIX).toBe("voz:");
  });
});

describe("membersFromPresence", () => {
  it("extrae identidad y nombre; usa la clave si falta identity", () => {
    const members = membersFromPresence(
      presence([
        { key: "a", name: "Ana" },
        { key: "b", identity: "b", name: "  Beto  " },
        { key: "c" }, // sin nombre → cae en la identidad
      ])
    );
    expect(members).toEqual([
      { identity: "a", name: "Ana" },
      { identity: "b", name: "Beto" },
      { identity: "c", name: "c" },
    ]);
  });

  it("deduplica por identidad", () => {
    const members = membersFromPresence(
      presence([
        { key: "a", identity: "x", name: "Uno" },
        { key: "b", identity: "x", name: "Dos" },
      ])
    );
    expect(members).toHaveLength(1);
    expect(members[0].identity).toBe("x");
  });
});

describe("peerIdsFromPresence", () => {
  it("excluye la propia identidad", () => {
    const peers = peerIdsFromPresence(
      presence([{ key: "me" }, { key: "a" }, { key: "b" }]),
      "me"
    );
    expect(peers.sort()).toEqual(["a", "b"]);
  });
});

describe("iInitiateOffer (anti-glare)", () => {
  it("ofrece a quien YA estaba cuando llegué", () => {
    expect(iInitiateOffer(true)).toBe(true);
  });
  it("no ofrece a quien llega DESPUÉS que yo (él me ofrece)", () => {
    expect(iInitiateOffer(false)).toBe(false);
  });
});

describe("diffPeers", () => {
  it("detecta entrantes y salientes", () => {
    const { joined, left } = diffPeers(["a", "b"], ["b", "c"]);
    expect(joined).toEqual(["c"]);
    expect(left).toEqual(["a"]);
  });
  it("sin cambios → listas vacías", () => {
    const { joined, left } = diffPeers(["a", "b"], ["a", "b"]);
    expect(joined).toEqual([]);
    expect(left).toEqual([]);
  });
});

describe("constructores de mensaje", () => {
  it("offer/answer/ice fijan kind, from, to y payload", () => {
    expect(offerMessage("me", "you", { sdp: 1 })).toEqual({
      kind: "offer",
      from: "me",
      to: "you",
      payload: { sdp: 1 },
    });
    expect(answerMessage("me", "you", { sdp: 2 }).kind).toBe("answer");
    expect(iceMessage("me", "you", { candidate: "x" })).toEqual({
      kind: "ice",
      from: "me",
      to: "you",
      payload: { candidate: "x" },
    });
  });
});
