import { describe, expect, it } from "vitest";
import {
  ORACLE_CARDS,
  ORACLE_COUNT,
  ORACLE_IDS,
  QUEST_COMPLETE_TOAST,
  QUEST_STORAGE_KEY,
  addFound,
  announceFind,
  getOracleCard,
  hasFound,
  isNewFind,
  isOracleId,
  missingOracles,
  parseFound,
  questProgress,
  serializeFound,
  type OracleId,
} from "../oracle-quest";

const ALL = new Set<OracleId>(ORACLE_IDS);

describe("oracle-quest — el elenco de los nueve", () => {
  it("son nueve, sin repetidos, y Paqo NO va en la lista (él es la brújula)", () => {
    expect(ORACLE_IDS).toHaveLength(9);
    expect(ORACLE_COUNT).toBe(9);
    expect(new Set(ORACLE_IDS).size).toBe(9);
    expect(ORACLE_IDS).not.toContain("paqo" as unknown as OracleId);
    // Baba Totik existe en el lore pero aún no está en el mundo: no se busca.
    expect(ORACLE_IDS).not.toContain("baba-totik" as unknown as OracleId);
  });

  it("la clave de persistencia va en el espacio de nombres de la casa", () => {
    expect(QUEST_STORAGE_KEY).toBe("phy:oracles:found");
  });

  it("cada uno tiene ficha completa: nombre, color hex y mini-historia", () => {
    for (const id of ORACLE_IDS) {
      const card = ORACLE_CARDS[id];
      expect(card.id).toBe(id);
      expect(card.name.length).toBeGreaterThan(2);
      expect(card.color).toMatch(/^#[0-9a-f]{6}$/);
      // 1-2 frases: lo bastante para presentarse, lo bastante corto para un toast.
      expect(card.story.length).toBeGreaterThan(40);
      expect(card.story.length).toBeLessThanOrEqual(160);
    }
  });

  it("los colores de aro son los del contrato con el engine", () => {
    expect(ORACLE_CARDS.brangulio.color).toBe("#58c47f");
    expect(ORACLE_CARDS.nin.color).toBe("#f078b6");
    expect(ORACLE_CARDS.espinosito.color).toBe("#e0483a");
    expect(ORACLE_CARDS["eme-y-uru"].color).toBe("#43d9c2");
    expect(ORACLE_CARDS.cosmogenes.color).toBe("#4f7df0");
    expect(ORACLE_CARDS.tecnomancio.color).toBe("#a6f050");
    expect(ORACLE_CARDS.chemajo.color).toBe("#f5d442");
    expect(ORACLE_CARDS.mavea.color).toBe("#b268e0");
    expect(ORACLE_CARDS.personage.color).toBe("#ff8c3b");
  });

  it("los nombres se muestran con sus acentos", () => {
    expect(getOracleCard("cosmogenes").name).toBe("Cosmógenes");
    expect(getOracleCard("eme-y-uru").name).toBe("Eme y Uru");
  });

  it("ningún color se repite (cada aro se distingue del de al lado)", () => {
    const colors = ORACLE_IDS.map((id) => ORACLE_CARDS[id].color);
    expect(new Set(colors).size).toBe(colors.length);
  });
});

describe("isOracleId", () => {
  it("reconoce a los nueve", () => {
    for (const id of ORACLE_IDS) expect(isOracleId(id)).toBe(true);
  });

  it("rechaza a Paqo, a los que no están y a la basura", () => {
    expect(isOracleId("paqo")).toBe(false);
    expect(isOracleId("baba-totik")).toBe(false);
    expect(isOracleId("MAVEA")).toBe(false);
    expect(isOracleId("")).toBe(false);
    expect(isOracleId(null)).toBe(false);
    expect(isOracleId(7)).toBe(false);
    expect(isOracleId({ id: "nin" })).toBe(false);
  });
});

describe("parseFound — localStorage es tierra de nadie", () => {
  it("sin valor guardado, el quest empieza en cero", () => {
    expect(parseFound(null).size).toBe(0);
    expect(parseFound(undefined).size).toBe(0);
    expect(parseFound("").size).toBe(0);
    expect(parseFound("   ").size).toBe(0);
  });

  it("tolera JSON roto sin lanzar", () => {
    expect(parseFound("{no soy json").size).toBe(0);
    expect(parseFound("['nin'").size).toBe(0);
  });

  it("tolera que no sea un array", () => {
    expect(parseFound('"nin"').size).toBe(0);
    expect(parseFound('{"nin":true}').size).toBe(0);
    expect(parseFound("42").size).toBe(0);
    expect(parseFound("null").size).toBe(0);
  });

  it("filtra ids desconocidos y elementos que no son cadenas", () => {
    const set = parseFound('["nin","paqo","gandalf",7,null,{"a":1},"mavea"]');
    expect([...set].sort()).toEqual(["mavea", "nin"]);
  });

  it("deduplica", () => {
    expect(parseFound('["nin","nin","nin"]').size).toBe(1);
  });

  it("lee lo que escribió serializeFound (ida y vuelta)", () => {
    const set = new Set<OracleId>(["mavea", "chemajo"]);
    expect(parseFound(serializeFound(set))).toEqual(set);
  });
});

describe("serializeFound", () => {
  it("guarda en el orden canónico, no en el de descubrimiento", () => {
    const a = serializeFound(new Set<OracleId>(["personage", "brangulio"]));
    const b = serializeFound(new Set<OracleId>(["brangulio", "personage"]));
    expect(a).toBe(b);
    expect(a).toBe('["brangulio","personage"]');
  });

  it("acepta cualquier iterable", () => {
    expect(serializeFound(["nin"])).toBe('["nin"]');
  });

  it("con el conjunto vacío guarda un array vacío", () => {
    expect(serializeFound(new Set())).toBe("[]");
  });
});

describe("addFound — pura, sin mutar", () => {
  it("devuelve un conjunto NUEVO y deja intacto el original", () => {
    const before = new Set<OracleId>(["nin"]);
    const after = addFound(before, "mavea");
    expect(after).not.toBe(before);
    expect(before.size).toBe(1);
    expect(after.size).toBe(2);
    expect(after.has("mavea")).toBe(true);
  });

  it("añadir dos veces al mismo no cambia la cuenta", () => {
    expect(addFound(addFound(new Set(), "nin"), "nin").size).toBe(1);
  });

  it("ignora en silencio un id que no es de los nueve", () => {
    expect(addFound(new Set(), "paqo").size).toBe(0);
    expect(addFound(new Set(), "gandalf").size).toBe(0);
  });
});

describe("hasFound / isNewFind — el toast sólo suena una vez", () => {
  it("un Oráculo recién visto es descubrimiento nuevo", () => {
    expect(isNewFind(new Set(), "nin")).toBe(true);
    expect(hasFound(new Set(), "nin")).toBe(false);
  });

  it("uno persistido de otra sesión NO vuelve a anunciarse", () => {
    const found = parseFound('["nin"]');
    expect(isNewFind(found, "nin")).toBe(false);
    expect(hasFound(found, "nin")).toBe(true);
  });

  it("un id que no es de los nueve nunca es descubrimiento", () => {
    expect(isNewFind(new Set(), "paqo")).toBe(false);
    expect(hasFound(new Set(), "paqo")).toBe(false);
  });
});

describe("questProgress — n de nueve", () => {
  it("empieza en cero de nueve", () => {
    expect(questProgress(new Set())).toEqual({
      found: 0,
      total: 9,
      remaining: 9,
      complete: false,
    });
  });

  it("cuenta lo que lleva", () => {
    const p = questProgress(new Set<OracleId>(["nin", "mavea", "chemajo"]));
    expect(p.found).toBe(3);
    expect(p.remaining).toBe(6);
    expect(p.complete).toBe(false);
  });

  it("con los nueve se cierra el círculo", () => {
    const p = questProgress(ALL);
    expect(p.found).toBe(9);
    expect(p.remaining).toBe(0);
    expect(p.complete).toBe(true);
  });

  it("con ocho todavía NO está completo (el noveno importa)", () => {
    const ocho = new Set<OracleId>(ORACLE_IDS.slice(0, 8));
    expect(questProgress(ocho).complete).toBe(false);
    expect(questProgress(ocho).remaining).toBe(1);
  });
});

describe("missingOracles", () => {
  it("sin nada encontrado faltan los nueve, en orden canónico", () => {
    expect(missingOracles(new Set())).toEqual([...ORACLE_IDS]);
  });

  it("quita los ya conocidos y conserva el orden", () => {
    const missing = missingOracles(new Set<OracleId>(["nin", "cosmogenes"]));
    expect(missing).toHaveLength(7);
    expect(missing).not.toContain("nin");
    expect(missing[0]).toBe("brangulio");
  });

  it("con todos conocidos no falta nadie", () => {
    expect(missingOracles(ALL)).toEqual([]);
  });
});

describe("announceFind — lo que se anuncia al descubrir", () => {
  it("trae nombre, color y mini-historia del recién conocido", () => {
    const found = addFound(new Set(), "mavea");
    const a = announceFind(found, "mavea");
    expect(a.name).toBe("Mavea");
    expect(a.color).toBe("#b268e0");
    expect(a.story).toContain("visiones");
    expect(a.progress.found).toBe(1);
  });

  it("sin ser el noveno no hay celebración especial", () => {
    const found = addFound(new Set(), "nin");
    expect(announceFind(found, "nin").celebration).toBeNull();
  });

  it("al NOVENO llega la celebración del quest completo", () => {
    const ocho = new Set<OracleId>(ORACLE_IDS.slice(0, 8));
    const nueve = addFound(ocho, ORACLE_IDS[8]);
    const a = announceFind(nueve, ORACLE_IDS[8]);
    expect(a.progress.complete).toBe(true);
    expect(a.celebration).toBe(QUEST_COMPLETE_TOAST);
    expect(a.celebration).toMatch(/todos/i);
  });
});
