/**
 * Persistencia de memoria privada del Oráculo (modo private + usuario autenticado).
 *
 * Usa el cliente service-role (omite RLS). Todo va envuelto en try/catch: la
 * persistencia NUNCA debe romper el streaming de la respuesta al usuario.
 *
 * Mantiene un `summary` rodante: cada SUMMARY_EVERY mensajes se regenera un
 * resumen con el mismo modelo y se guarda en oracle_conversations.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChatModel } from "./chat-model";

export const SUMMARY_EVERY = 20;

/**
 * Verifica el access token (Bearer) contra Supabase y devuelve el user id, o
 * null si es anónimo/ inválido. Los usuarios anónimos de Supabase tienen uid
 * pero `is_anonymous = true`: para la MEMORIA sólo cuentan usuarios registrados.
 */
export async function resolveRegisteredUserId(
  service: SupabaseClient,
  accessToken: string | null
): Promise<string | null> {
  if (!accessToken) return null;
  try {
    const { data, error } = await service.auth.getUser(accessToken);
    if (error || !data.user) return null;
    // Un usuario anónimo no obtiene memoria persistente (gancho de registro).
    if (data.user.is_anonymous) return null;
    return data.user.id;
  } catch {
    return null;
  }
}

/**
 * Garantiza una conversación para (userId, oracleId). Si `conversationId` viene
 * y pertenece al usuario, la reutiliza; si no, crea una nueva. Devuelve el id o
 * null si algo falla.
 */
export async function ensureConversation(
  service: SupabaseClient,
  params: { userId: string; oracleId: string; conversationId?: string }
): Promise<string | null> {
  const { userId, oracleId, conversationId } = params;
  try {
    if (conversationId) {
      const { data } = await service
        .from("oracle_conversations")
        .select("id")
        .eq("id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();
      if (data?.id) return data.id as string;
    }
    const { data, error } = await service
      .from("oracle_conversations")
      .insert({ user_id: userId, oracle_id: oracleId })
      .select("id")
      .single();
    if (error || !data) return null;
    return data.id as string;
  } catch {
    return null;
  }
}

/**
 * Inserta el turno (mensaje del usuario + respuesta del Oráculo) y, cada
 * SUMMARY_EVERY mensajes, regenera el resumen rodante.
 */
export async function persistPrivateTurn(
  service: SupabaseClient,
  chatModel: ChatModel,
  params: {
    conversationId: string;
    userContent: string;
    oracleContent: string;
  }
): Promise<void> {
  const { conversationId, userContent, oracleContent } = params;
  try {
    await service.from("oracle_messages").insert([
      { conversation_id: conversationId, role: "user", content: userContent },
      { conversation_id: conversationId, role: "oracle", content: oracleContent },
    ]);
    // touch updated_at
    await service
      .from("oracle_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", conversationId);

    const { count } = await service
      .from("oracle_messages")
      .select("id", { count: "exact", head: true })
      .eq("conversation_id", conversationId);

    if (typeof count === "number" && count > 0 && count % SUMMARY_EVERY === 0) {
      await regenerateSummary(service, chatModel, conversationId);
    }
  } catch {
    // best-effort: no romper el turno del usuario
  }
}

async function regenerateSummary(
  service: SupabaseClient,
  chatModel: ChatModel,
  conversationId: string
): Promise<void> {
  try {
    const { data: rows } = await service
      .from("oracle_messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true })
      .limit(SUMMARY_EVERY * 3);
    if (!rows || rows.length === 0) return;

    const transcript = rows
      .map((r) => `${r.role === "oracle" ? "Oráculo" : "Usuario"}: ${r.content}`)
      .join("\n");

    const summary = await chatModel.complete(
      [
        {
          role: "system",
          content:
            "Resume en 3-4 frases, en español, lo esencial de esta conversación " +
            "para que el Oráculo recuerde a la persona (temas, tono, lo que busca). " +
            "No inventes; sé conciso.",
        },
        { role: "user", content: transcript },
      ],
      { maxTokens: 200, temperature: 0.3 }
    );

    if (summary && summary.trim().length > 0) {
      await service
        .from("oracle_conversations")
        .update({ summary: summary.trim() })
        .eq("id", conversationId);
    }
  } catch {
    // best-effort
  }
}
