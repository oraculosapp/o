import { redirect } from "next/navigation";

/**
 * Entrada SIN fricción (S8, dirección "nube"): la raíz redirige DIRECTO al mundo
 * (/b/paqo). Al primer ingreso, la página de la biósfera asigna color pastel +
 * nombre aleatorios y entra sin selector ni splash.
 *
 * El splash ceremonial (nebulosa + ruleta 3D de arquetipos) queda DESCONECTADO:
 * sus archivos se conservan (splash-home.tsx, page.module.css, avatar-carousel)
 * por si se quiere reactivar como página de marca más adelante.
 */
export default function Home() {
  redirect("/b/paqo");
}
