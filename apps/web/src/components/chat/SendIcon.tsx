/**
 * Avioncito de papel — glifo del botón ENVIAR del composer (canal abierto y Paqo).
 * Trazo `currentColor` (hereda el color del botón, dorado sobre gradiente de la
 * casa), sin relleno. Puramente decorativo: el botón que lo envuelve lleva el
 * aria-label "Enviar", así que el SVG es aria-hidden.
 */
export function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M22 2 11 13"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M22 2 15 22l-4-9-9-4 20-7Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
