/**
 * Buffers de ruido pre-generados (una vez) para el soundscape. WebAudio no trae
 * un nodo de ruido: se sintetiza rellenando un AudioBuffer y reproduciéndolo en
 * bucle. Reutilizamos UN buffer por color de ruido para toda la sesión (viento,
 * agua y pasos comparten el mismo material) → cero asignaciones por evento.
 *
 * Los bucles NO son audibles porque cada capa los filtra con LFOs lentos que
 * decorrelacionan el periodo, y los buffers son largos (~6 s).
 */

export type NoiseColor = "white" | "pink" | "brown";

/**
 * Genera un AudioBuffer mono de `seconds` con el color pedido.
 * - white: plano (energía uniforme por Hz).
 * - pink: −3 dB/octava (filtro económico de Paul Kellet) — timbre natural del
 *   viento y del agua.
 * - brown: −6 dB/octava (integración) — retumbe grave del valle.
 */
export function createNoiseBuffer(
  ctx: BaseAudioContext,
  seconds = 6,
  color: NoiseColor = "pink",
): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  if (color === "white") {
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  if (color === "brown") {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 3.5; // compensa la pérdida de energía
    }
    return buffer;
  }

  // pink — filtro de Paul Kellet (7 polos, económico y estable).
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    data[i] = pink * 0.11; // normaliza a ~[-1,1]
  }
  return buffer;
}
