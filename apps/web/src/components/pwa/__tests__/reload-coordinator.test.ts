import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetReloadCoordinatorForTests,
  deferReason,
  forceReload,
  isChatComposerFocusedIn,
  isGameRunningIn,
  isReloadArmed,
  isReloadDeferred,
  isVoiceActiveIn,
  requestReload,
  shouldReloadNow,
} from "../reload-coordinator";

describe("shouldReloadNow", () => {
  it("recarga cuando la pestaña está visible y no hay partida", () => {
    expect(shouldReloadNow({ visible: true, gameRunning: false })).toBe(true);
  });

  it("NO recarga en background (pestaña oculta) aunque no haya partida", () => {
    expect(shouldReloadNow({ visible: false, gameRunning: false })).toBe(false);
  });

  it("NO recarga si hay una partida en curso aunque la pestaña sea visible", () => {
    expect(shouldReloadNow({ visible: true, gameRunning: true })).toBe(false);
  });

  it("NO recarga si está oculta Y hay partida", () => {
    expect(shouldReloadNow({ visible: false, gameRunning: true })).toBe(false);
  });

  it("NO recarga mientras se escribe en el chat", () => {
    expect(shouldReloadNow({ visible: true, gameRunning: false, chatTyping: true })).toBe(false);
  });

  it("NO recarga mientras hay una sesión de voz activa", () => {
    expect(shouldReloadNow({ visible: true, gameRunning: false, voiceActive: true })).toBe(false);
  });

  it("recarga si el chat y la voz están explícitamente inactivos", () => {
    expect(
      shouldReloadNow({ visible: true, gameRunning: false, chatTyping: false, voiceActive: false }),
    ).toBe(true);
  });
});

describe("deferReason", () => {
  it("null cuando hay vía libre", () => {
    expect(deferReason({ visible: true, gameRunning: false })).toBe(null);
  });

  it("la visibilidad manda sobre el resto de motivos", () => {
    expect(
      deferReason({ visible: false, gameRunning: true, chatTyping: true, voiceActive: true }),
    ).toBe("hidden");
  });

  it("la partida manda sobre voz y chat", () => {
    expect(
      deferReason({ visible: true, gameRunning: true, chatTyping: true, voiceActive: true }),
    ).toBe("game");
  });

  it("la voz manda sobre el chat (colgar la llamada es peor que perder un borrador)", () => {
    expect(
      deferReason({ visible: true, gameRunning: false, chatTyping: true, voiceActive: true }),
    ).toBe("voice");
  });

  it("informa del chat cuando es el único motivo", () => {
    expect(deferReason({ visible: true, gameRunning: false, chatTyping: true })).toBe("chat");
  });
});

describe("isGameRunningIn", () => {
  const runningWorld = { __PAQO__: { game: { snapshot: () => ({ phase: "running" }) } } };

  it("es true cuando phase === 'running'", () => {
    expect(isGameRunningIn(runningWorld)).toBe(true);
  });

  it("es false para otras fases (idle, ended, etc.)", () => {
    expect(isGameRunningIn({ __PAQO__: { game: { snapshot: () => ({ phase: "idle" }) } } })).toBe(
      false,
    );
    expect(isGameRunningIn({ __PAQO__: { game: { snapshot: () => ({ phase: "ended" }) } } })).toBe(
      false,
    );
  });

  it("es false (degrada) si no existe el global __PAQO__ o su cadena", () => {
    expect(isGameRunningIn({})).toBe(false);
    expect(isGameRunningIn({ __PAQO__: {} })).toBe(false);
    expect(isGameRunningIn({ __PAQO__: { game: {} } })).toBe(false);
    expect(isGameRunningIn(undefined)).toBe(false);
    expect(isGameRunningIn(null)).toBe(false);
  });

  it("es false (degrada) si snapshot lanza una excepción", () => {
    const boom = {
      __PAQO__: {
        game: {
          snapshot: () => {
            throw new Error("boom");
          },
        },
      },
    };
    expect(isGameRunningIn(boom)).toBe(false);
  });

  it("es false si snapshot no devuelve phase", () => {
    expect(isGameRunningIn({ __PAQO__: { game: { snapshot: () => ({}) } } })).toBe(false);
  });
});

// --- Chat: foco en el composer ---------------------------------------------
// Documento falso pato-tipado: `closest` devuelve un ancestro simulado sólo para
// los selectores que el elemento "tiene encima". Así probamos la lógica sin DOM.
function docWithFocus(el: unknown) {
  return { activeElement: el };
}

function focusable(tagName: string, ancestors: string[] = [], isContentEditable = false) {
  return {
    tagName,
    isContentEditable,
    closest: (selector: string) => (ancestors.includes(selector) ? { tagName: "SECTION" } : null),
  };
}

const CHAT_ATTR = "[data-chat-ready]";
const CHAT_ARIA = '[role="region"][aria-label^="Chat"]';

describe("isChatComposerFocusedIn", () => {
  it("es true con un INPUT dentro del dock (detectado por data-chat-ready)", () => {
    expect(isChatComposerFocusedIn(docWithFocus(focusable("INPUT", [CHAT_ATTR])))).toBe(true);
  });

  it("es true con un TEXTAREA dentro del dock (detectado por role+aria-label)", () => {
    expect(isChatComposerFocusedIn(docWithFocus(focusable("TEXTAREA", [CHAT_ARIA])))).toBe(true);
  });

  it("es true con un contentEditable dentro del dock", () => {
    expect(isChatComposerFocusedIn(docWithFocus(focusable("DIV", [CHAT_ATTR], true)))).toBe(true);
  });

  it("acepta el tagName en minúsculas (documentos no-HTML)", () => {
    expect(isChatComposerFocusedIn(docWithFocus(focusable("input", [CHAT_ATTR])))).toBe(true);
  });

  it("es false para un input FUERA del chat (perfil, registro…)", () => {
    expect(isChatComposerFocusedIn(docWithFocus(focusable("INPUT", [])))).toBe(false);
  });

  it("es false para un botón del chat (no se está escribiendo)", () => {
    expect(isChatComposerFocusedIn(docWithFocus(focusable("BUTTON", [CHAT_ATTR])))).toBe(false);
  });

  it("es false sin foco, sin documento o con basura", () => {
    expect(isChatComposerFocusedIn(docWithFocus(null))).toBe(false);
    expect(isChatComposerFocusedIn({})).toBe(false);
    expect(isChatComposerFocusedIn(undefined)).toBe(false);
    expect(isChatComposerFocusedIn(null)).toBe(false);
  });

  it("es false (degrada) si closest lanza una excepción", () => {
    const boom = {
      tagName: "INPUT",
      closest: () => {
        throw new Error("boom");
      },
    };
    expect(isChatComposerFocusedIn(docWithFocus(boom))).toBe(false);
  });

  it("es false si el elemento enfocado no expone closest", () => {
    expect(isChatComposerFocusedIn(docWithFocus({ tagName: "INPUT" }))).toBe(false);
  });
});

// --- Voz: sesión activa ------------------------------------------------------
function globalWithVoiceDom(opts: { dataVoice?: string; selectors?: string[] } = {}) {
  const selectors = opts.selectors ?? [];
  return {
    document: {
      documentElement: { dataset: opts.dataVoice ? { voice: opts.dataVoice } : {} },
      querySelector: (sel: string) => (selectors.includes(sel) ? { tagName: "BUTTON" } : null),
    },
  };
}

const VOICE_ATTR = '[data-voice="on"]';
const VOICE_LEAVE_BTN = 'button[aria-label="Salir de la voz"]';

describe("isVoiceActiveIn", () => {
  it("es true con html[data-voice=on] (contrato propuesto)", () => {
    expect(isVoiceActiveIn(globalWithVoiceDom({ dataVoice: "on" }))).toBe(true);
  });

  it("es false con html[data-voice=off]", () => {
    expect(isVoiceActiveIn(globalWithVoiceDom({ dataVoice: "off" }))).toBe(false);
  });

  it("es true con el botón 'Salir de la voz' en el DOM (heurística de hoy)", () => {
    expect(isVoiceActiveIn(globalWithVoiceDom({ selectors: [VOICE_LEAVE_BTN] }))).toBe(true);
  });

  it("es true con un nodo marcado data-voice=on en cualquier parte", () => {
    expect(isVoiceActiveIn(globalWithVoiceDom({ selectors: [VOICE_ATTR] }))).toBe(true);
  });

  it("es false sin ninguna señal (fuera del canal)", () => {
    expect(isVoiceActiveIn(globalWithVoiceDom())).toBe(false);
  });

  it("el evento phy:voice-state MANDA sobre el DOM cuando dice que sí", () => {
    expect(isVoiceActiveIn(globalWithVoiceDom(), true)).toBe(true);
  });

  it("el evento phy:voice-state MANDA sobre el DOM cuando dice que no (ya colgué)", () => {
    expect(isVoiceActiveIn(globalWithVoiceDom({ selectors: [VOICE_LEAVE_BTN] }), false)).toBe(false);
  });

  it("sin pista de evento (null/undefined) cae a las señales del DOM", () => {
    expect(isVoiceActiveIn(globalWithVoiceDom({ selectors: [VOICE_LEAVE_BTN] }), null)).toBe(true);
    expect(isVoiceActiveIn(globalWithVoiceDom({ selectors: [VOICE_LEAVE_BTN] }), undefined)).toBe(
      true,
    );
  });

  it("es false (degrada) sin document, sin global o con basura", () => {
    expect(isVoiceActiveIn({})).toBe(false);
    expect(isVoiceActiveIn({ document: null })).toBe(false);
    expect(isVoiceActiveIn(undefined)).toBe(false);
    expect(isVoiceActiveIn(null)).toBe(false);
  });

  it("es false (degrada) si querySelector lanza una excepción", () => {
    const boom = {
      document: {
        documentElement: { dataset: {} },
        querySelector: () => {
          throw new Error("boom");
        },
      },
    };
    expect(isVoiceActiveIn(boom)).toBe(false);
  });
});

// --- Máquina de aplazamiento / reintento ------------------------------------
// El entorno de vitest es `node` (sin DOM), así que se inyecta un window/document
// falsos mínimos: lo justo para que el coordinador crea que está en el navegador.
// Con timers falsos se comprueba lo importante: que una recarga BLOQUEADA vuelve a
// la cola (antes se quedaba armada para siempre) y que el backoff no martillea.

const CHAT_ATTR_SEL = "[data-chat-ready]";
const LEAVE_BTN_SEL = 'button[aria-label="Salir de la voz"]';

interface FakeDoc {
  visibilityState: string;
  activeElement: unknown;
  documentElement: { dataset: Record<string, string | undefined> };
  querySelector: (sel: string) => unknown;
  addEventListener: () => void;
  removeEventListener: () => void;
}

describe("máquina de recarga (aplazar, reintentar, re-armar)", () => {
  let reloads = 0;
  let doc: FakeDoc;
  let liveSelectors: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    reloads = 0;
    liveSelectors = [];
    doc = {
      visibilityState: "visible",
      activeElement: null,
      documentElement: { dataset: {} },
      querySelector: (sel: string) => (liveSelectors.includes(sel) ? { tagName: "BUTTON" } : null),
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const win = {
      document: doc,
      location: {
        reload: () => {
          reloads += 1;
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);
    __resetReloadCoordinatorForTests();
  });

  afterEach(() => {
    __resetReloadCoordinatorForTests();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("recarga al instante cuando hay vía libre", () => {
    requestReload();
    expect(reloads).toBe(1);
    expect(isReloadArmed()).toBe(true);
  });

  it("REGRESIÓN: una recarga bloqueada se desarma y se reintenta (antes moría ahí)", () => {
    requestReload();
    expect(reloads).toBe(1);
    expect(isReloadArmed()).toBe(true);

    // Seguimos vivos pasado el watchdog → la recarga no ocurrió: vuelve a la cola.
    vi.advanceTimersByTime(5_000);
    expect(isReloadArmed()).toBe(false);
    expect(isReloadDeferred()).toBe(true);

    // Reintento con la espera del backoff (2º tramo: 30s), no antes.
    vi.advanceTimersByTime(29_000);
    expect(reloads).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(reloads).toBe(2);
  });

  it("aplaza mientras hay voz activa y recarga en cuanto se cuelga", () => {
    liveSelectors = [LEAVE_BTN_SEL];
    requestReload();
    expect(reloads).toBe(0);
    expect(isReloadDeferred()).toBe(true);

    // Primer reintento (15s) con la voz aún activa: sigue sin recargar.
    vi.advanceTimersByTime(15_000);
    expect(reloads).toBe(0);

    liveSelectors = [];
    vi.advanceTimersByTime(30_000); // segundo tramo del backoff
    expect(reloads).toBe(1);
  });

  it("aplaza mientras el foco está en el composer del chat", () => {
    doc.activeElement = {
      tagName: "INPUT",
      closest: (sel: string) => (sel === CHAT_ATTR_SEL ? { tagName: "SECTION" } : null),
    };
    requestReload();
    expect(reloads).toBe(0);

    vi.advanceTimersByTime(15_000);
    expect(reloads).toBe(0);

    doc.activeElement = null;
    vi.advanceTimersByTime(30_000);
    expect(reloads).toBe(1);
  });

  it("aplaza en background y no martillea: el backoff crece hasta 60s (tope)", () => {
    doc.visibilityState = "hidden";
    requestReload();
    expect(reloads).toBe(0);

    // 15s + 30s + 60s + 60s: cuatro esperas, ni una recarga (sigue oculta).
    vi.advanceTimersByTime(15_000 + 30_000 + 60_000 + 60_000);
    expect(reloads).toBe(0);
    expect(isReloadDeferred()).toBe(true);

    doc.visibilityState = "visible";
    vi.advanceTimersByTime(59_000);
    expect(reloads).toBe(0); // el tope es 60s: no se acelera solo
    vi.advanceTimersByTime(1_000);
    expect(reloads).toBe(1);
  });

  it("llamarla dos veces no produce dobles recargas", () => {
    requestReload();
    requestReload();
    expect(reloads).toBe(1);
  });

  it("forceReload IGNORA el guardarraíl (decisión explícita del usuario)", () => {
    liveSelectors = [LEAVE_BTN_SEL];
    doc.visibilityState = "hidden";
    forceReload();
    expect(reloads).toBe(1);
  });

  it("forceReload bloqueada también se desarma (la píldora vuelve a funcionar)", () => {
    forceReload();
    expect(isReloadArmed()).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(isReloadArmed()).toBe(false);
  });
});
