import { describe, expect, it } from "vitest";
import {
  FOUND_COOLDOWN_MS,
  FOUND_STORAGE_KEY,
  PAQO_GREETINGS,
  PAQO_QUEST_COMPLETE,
  PAQO_QUEST_HINTS,
  hintTargetName,
  parseLastFoundAt,
  pickGuideMessage,
  pickVariant,
  progressPhrase,
  shouldCelebrateFound,
} from "../paqo-found";
import { ORACLE_IDS, type OracleId } from "../oracle-quest";

const ALL = new Set<OracleId>(ORACLE_IDS);
const NADIE = new Set<OracleId>();

describe("paqo-found — constantes de la ceremonia", () => {
  it("el cooldown por visita es de 2 minutos", () => {
    expect(FOUND_COOLDOWN_MS).toBe(120_000);
  });

  it("la clave de persistencia va en el espacio de nombres de la casa", () => {
    expect(FOUND_STORAGE_KEY).toMatch(/^phy:/);
  });

  it("hay 3-4 saludos en voz de Paqo, únicos y de una línea", () => {
    expect(PAQO_GREETINGS.length).toBeGreaterThanOrEqual(3);
    expect(PAQO_GREETINGS.length).toBeLessThanOrEqual(4);
    expect(new Set(PAQO_GREETINGS).size).toBe(PAQO_GREETINGS.length);
    for (const m of PAQO_GREETINGS) {
      expect(m.length).toBeGreaterThan(20);
      // El saludo es la carraspera, no el plato fuerte: cabe con la pista detrás.
      expect(m.length).toBeLessThanOrEqual(60);
    }
  });

  it("hay cierre de quest completo, en varias variantes", () => {
    expect(PAQO_QUEST_COMPLETE.length).toBeGreaterThanOrEqual(2);
    expect(new Set(PAQO_QUEST_COMPLETE).size).toBe(PAQO_QUEST_COMPLETE.length);
    for (const m of PAQO_QUEST_COMPLETE) {
      expect(m.length).toBeLessThanOrEqual(110);
    }
  });
});

describe("PAQO_QUEST_HINTS — una pista por Oráculo", () => {
  it("cubre a los nueve, sin huecos", () => {
    for (const id of ORACLE_IDS) {
      expect(typeof PAQO_QUEST_HINTS[id]).toBe("string");
      expect(PAQO_QUEST_HINTS[id].length).toBeGreaterThan(30);
      expect(PAQO_QUEST_HINTS[id].length).toBeLessThanOrEqual(130);
    }
  });

  it("ninguna pista se repite", () => {
    const all = ORACLE_IDS.map((id) => PAQO_QUEST_HINTS[id]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("son atmosféricas: nada de coordenadas ni de metros", () => {
    for (const id of ORACLE_IDS) {
      expect(PAQO_QUEST_HINTS[id]).not.toMatch(/\d+\s*(m|metros|unidades|x:|z:)/i);
      expect(PAQO_QUEST_HINTS[id]).not.toMatch(/coordenad/i);
    }
  });

  it("las pistas de ejemplo del director creativo están honradas", () => {
    expect(PAQO_QUEST_HINTS.mavea).toMatch(/caverna/i);
    expect(PAQO_QUEST_HINTS.mavea).toMatch(/visiones/i);
    expect(PAQO_QUEST_HINTS.espinosito).toMatch(/fonda/i);
  });

  it("hintTargetName da el nombre mostrable", () => {
    expect(hintTargetName("mavea")).toBe("Mavea");
    expect(hintTargetName("cosmogenes")).toBe("Cosmógenes");
  });
});

describe("parseLastFoundAt", () => {
  it("devuelve null sin valor guardado", () => {
    expect(parseLastFoundAt(null)).toBeNull();
    expect(parseLastFoundAt(undefined)).toBeNull();
  });

  it("devuelve null con basura o valores no positivos", () => {
    expect(parseLastFoundAt("ayer")).toBeNull();
    expect(parseLastFoundAt("")).toBeNull();
    expect(parseLastFoundAt("0")).toBeNull();
    expect(parseLastFoundAt("-5")).toBeNull();
  });

  it("parsea un instante epoch válido", () => {
    expect(parseLastFoundAt("1700000000000")).toBe(1_700_000_000_000);
  });
});

describe("shouldCelebrateFound — primera vez + cooldown por visita", () => {
  const now = 1_700_000_000_000;

  it("celebra la primera vez (sin registro previo)", () => {
    expect(shouldCelebrateFound(null, now)).toBe(true);
    expect(shouldCelebrateFound(undefined, now)).toBe(true);
  });

  it("NO repite si el viajero entra y sale del claro en menos de 2 min", () => {
    expect(shouldCelebrateFound(now - 1_000, now)).toBe(false);
    expect(shouldCelebrateFound(now - 119_999, now)).toBe(false);
  });

  it("vuelve a celebrar justo al cumplirse el cooldown", () => {
    expect(shouldCelebrateFound(now - FOUND_COOLDOWN_MS, now)).toBe(true);
    expect(shouldCelebrateFound(now - 10 * 60_000, now)).toBe(true);
  });

  it("con un instante en el futuro (reloj movido) prefiere callar", () => {
    expect(shouldCelebrateFound(now + 60_000, now)).toBe(false);
  });

  it("acepta un cooldown a medida", () => {
    expect(shouldCelebrateFound(now - 5_000, now, 1_000)).toBe(true);
    expect(shouldCelebrateFound(now - 500, now, 1_000)).toBe(false);
  });
});

describe("pickVariant — selector determinista", () => {
  it("siempre devuelve una de las variantes escritas", () => {
    for (let i = 0; i < 200; i++) {
      expect(PAQO_GREETINGS).toContain(pickVariant(i));
    }
  });

  it("es determinista para la misma semilla", () => {
    expect(pickVariant(1_700_000_000_003)).toBe(pickVariant(1_700_000_000_003));
  });

  it("evita repetir la variante anterior", () => {
    for (let i = 0; i < 50; i++) {
      const first = pickVariant(i);
      expect(pickVariant(i, first)).not.toBe(first);
    }
  });

  it("tolera semillas raras (NaN, negativas, decimales)", () => {
    expect(PAQO_GREETINGS).toContain(pickVariant(Number.NaN));
    expect(PAQO_GREETINGS).toContain(pickVariant(-7));
    expect(PAQO_GREETINGS).toContain(pickVariant(3.9));
  });

  it("con una sola variante la devuelve aunque sea la anterior", () => {
    expect(pickVariant(5, "sólo yo", ["sólo yo"])).toBe("sólo yo");
  });

  it("con lista vacía devuelve cadena vacía (degrada sin romper)", () => {
    expect(pickVariant(5, null, [])).toBe("");
  });
});

describe("progressPhrase — el progreso dicho en palabras", () => {
  it("con cero, lo dice sin regañar", () => {
    expect(progressPhrase(0)).toMatch(/ninguno/i);
    expect(progressPhrase(0)).toContain("9");
  });

  it("con uno usa singular", () => {
    expect(progressPhrase(1)).toMatch(/uno de los 9/i);
  });

  it("con varios da la cuenta", () => {
    expect(progressPhrase(4)).toBe("Has encontrado 4 de los 9.");
  });

  it("no se desborda con cuentas imposibles", () => {
    expect(progressPhrase(99)).toBe("Has encontrado 9 de los 9.");
    expect(progressPhrase(-3)).toMatch(/ninguno/i);
    expect(progressPhrase(Number.NaN)).toMatch(/ninguno/i);
  });
});

describe("pickGuideMessage — Paqo como brújula del quest", () => {
  it("ya no dice 'ya llegaste conmigo': ahora manda a buscar a otros", () => {
    const { text, hintFor, complete } = pickGuideMessage(NADIE, 1_700_000_000_000);
    expect(complete).toBe(false);
    expect(hintFor).not.toBeNull();
    expect(ORACLE_IDS).toContain(hintFor as OracleId);
    expect(text).toContain(PAQO_QUEST_HINTS[hintFor as OracleId]);
  });

  it("el mensaje trae saludo + progreso + pista", () => {
    const { text } = pickGuideMessage(new Set<OracleId>(["nin", "mavea"]), 3);
    expect(PAQO_GREETINGS.some((g) => text.startsWith(g))).toBe(true);
    expect(text).toContain("2 de los 9");
  });

  it("es determinista para la misma semilla y el mismo estado", () => {
    const found = new Set<OracleId>(["nin"]);
    const a = pickGuideMessage(found, 1_700_000_000_007);
    const b = pickGuideMessage(found, 1_700_000_000_007);
    expect(a).toEqual(b);
  });

  it("nunca manda a buscar a alguien que ya conoces", () => {
    for (let i = 0; i < 200; i++) {
      const found = new Set<OracleId>(ORACLE_IDS.slice(0, i % 9));
      const { hintFor } = pickGuideMessage(found, i);
      if (hintFor) expect(found.has(hintFor)).toBe(false);
    }
  });

  it("no repite la pista anterior mientras quede más de uno por conocer", () => {
    for (let i = 0; i < 60; i++) {
      const first = pickGuideMessage(NADIE, i);
      const second = pickGuideMessage(NADIE, i, first.hintFor);
      expect(second.hintFor).not.toBe(first.hintFor);
    }
  });

  it("si sólo falta UNO, insiste con ése aunque fuera la pista anterior", () => {
    const ocho = new Set<OracleId>(ORACLE_IDS.slice(0, 8));
    const ultimo = ORACLE_IDS[8];
    expect(pickGuideMessage(ocho, 5, ultimo).hintFor).toBe(ultimo);
    expect(pickGuideMessage(ocho, 5).complete).toBe(false);
  });

  it("con los nueve conocidos celebra el quest completo y no da pistas", () => {
    const msg = pickGuideMessage(ALL, 1_700_000_000_000);
    expect(msg.complete).toBe(true);
    expect(msg.hintFor).toBeNull();
    expect(PAQO_QUEST_COMPLETE).toContain(msg.text);
  });

  it("tolera semillas raras", () => {
    expect(pickGuideMessage(NADIE, Number.NaN).hintFor).not.toBeNull();
    expect(pickGuideMessage(NADIE, -13).hintFor).not.toBeNull();
    expect(pickGuideMessage(ALL, Number.NaN).complete).toBe(true);
  });

  it("ignora basura persistida: un conjunto con ids raros no rompe el progreso", () => {
    const sucio = new Set<OracleId>(["nin", "paqo" as OracleId, "gandalf" as OracleId]);
    const msg = pickGuideMessage(sucio, 11);
    expect(msg.text).toContain("uno de los 9");
    expect(msg.complete).toBe(false);
  });
});
