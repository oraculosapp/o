import { redirect } from "next/navigation";

/**
 * Compatibilidad hacia atrás: el mundo se MUDÓ a la RAÍZ (o.oraculos.app). Esta
 * ruta antigua /b/paqo sólo redirige a "/" para no romper enlaces ni bookmarks
 * viejos. La carpeta se conserva a propósito (no borrar) mientras existan enlaces
 * en circulación apuntando a /b/paqo.
 */
export default function PaqoRedirect() {
  redirect("/");
}
