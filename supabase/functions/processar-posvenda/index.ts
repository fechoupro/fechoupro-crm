// ============================================================
// processar-posvenda v1 — Enfileira cashbacks automáticos
//
// Roda a cada 10 min via pg_cron.
// Busca leads com venda concluída há ~2 dias e ainda sem cashback
// enfileirado, aplica filtro de forma de pagamento, gera msg
// personalizada e insere em posvenda_queue (tipo='cashback').
//
// A função SQL processar_posvenda_auto() (no banco) é quem envia
// de fato via Evolution API, rodando a cada minuto.
// ============================================================

const SB = Deno.env.get("SUPABASE_URL") || "https://udtoojqdjcbxnvevazum.supabase.co";
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const H = { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "application/json" };

async function sbGet(t: string, f: string) {
  const r = await fetch(`${SB}/rest/v1/${t}?${f}`, { headers: H });
  return r.json();
}
async function sbPost(t: string, b: unknown) {
  return await fetch(`${SB}/rest/v1/${t}`, {
    method: "POST",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify(b),
  });
}

// Aceita filtro de forma de pagamento baseado na config
function pagamentoBate(formaLead: string | null, filtro: string): boolean {
  if (filtro === "todos") return true;
  if (!formaLead) return filtro === "todos";
  if (filtro === "avista") return ["avista", "pix", "dinheiro"].includes(formaLead.toLowerCase());
  if (filtro === "debito") return formaLead.toLowerCase() === "debito";
  if (filtro === "credito") return formaLead.toLowerCase() === "credito";
  return false;
}

Deno.serve(async (_req: Request) => {
  try {
    console.log("[POSVENDA-JOB] Iniciando...");

    // 1. Buscar todos os clientes com config de cashback ativa
    const configs = await sbGet(
      "config_cliente",
      "chave=eq.cashback_config&select=cliente_subdominio,valor",
    );
    if (!Array.isArray(configs) || configs.length === 0) {
      return new Response(JSON.stringify({ ok: true, msg: "Nenhum cliente com cashback configurado" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    let totalEnfileirados = 0;
    const porCliente: Record<string, number> = {};

    for (const cfgRow of configs) {
      let cfg;
      try {
        cfg = JSON.parse(cfgRow.valor);
      } catch {
        continue;
      }
      if (!cfg.ativo) continue;

      const sub = cfgRow.cliente_subdominio;
      const pct = parseInt(String(cfg.pct || 10), 10);
      const validade = parseInt(String(cfg.validade || 30), 10);
      const msgTpl = cfg.msg || "Olá {nome}! Você ganhou {pct}% de desconto na próxima compra! Válido por {dias} dias.";
      const filtroPagto = cfg.filtro_pagamento || "todos";
      const modo = cfg.modo || "msg_midia";
      const anexoUrl = cfg.anexo_url || null;
      const anexoTipo = cfg.anexo_tipo || null;
      const delayDias = parseInt(String(cfg.delay_dias || 2), 10);

      // 2. Buscar leads com venda concluída no dia X dias atrás
      const inicioDia = new Date();
      inicioDia.setDate(inicioDia.getDate() - delayDias);
      inicioDia.setHours(0, 0, 0, 0);
      const fimDia = new Date();
      fimDia.setDate(fimDia.getDate() - delayDias);
      fimDia.setHours(23, 59, 59, 999);

      const leads = await sbGet(
        "leads",
        `cliente_subdominio=eq.${sub}` +
          `&resultado_final=eq.venda` +
          `&finalizado_em=gte.${inicioDia.toISOString()}` +
          `&finalizado_em=lte.${fimDia.toISOString()}` +
          "&select=id,nome,telefone,numero,produto,valor,forma_pagamento",
      );

      if (!Array.isArray(leads) || leads.length === 0) continue;

      for (const lead of leads) {
        const numero = lead.numero || lead.telefone || "";
        if (!numero) continue;

        // Filtro forma de pagamento
        if (!pagamentoBate(lead.forma_pagamento, filtroPagto)) continue;

        // Ja enfileirado ou enviado?
        const exist = await sbGet(
          "posvenda_queue",
          `cliente_subdominio=eq.${sub}&lead_id=eq.${lead.id}&tipo=eq.cashback&limit=1`,
        );
        if (Array.isArray(exist) && exist.length > 0) continue;

        // Monta mensagem
        const nome = (lead.nome || "vc").split(" ")[0];
        const mensagem = msgTpl
          .replaceAll("{nome}", nome)
          .replaceAll("{pct}", String(pct))
          .replaceAll("{dias}", String(validade))
          .replaceAll("{produto}", lead.produto || "sua compra")
          .replaceAll("{valor}", "R$" + (lead.valor || 0).toFixed(2).replace(".", ","));

        const enviarEm = new Date().toISOString(); // enfileira pra enviar agora (função SQL vai respeitar horário)

        const res = await sbPost("posvenda_queue", [{
          cliente_subdominio: sub,
          lead_id: String(lead.id),
          lead_nome: lead.nome,
          numero: numero,
          tipo: "cashback",
          mensagem: mensagem,
          anexo_url: anexoUrl,
          anexo_tipo: anexoTipo,
          modo: modo,
          enviar_em: enviarEm,
        }]);
        if (res.ok) {
          totalEnfileirados++;
          porCliente[sub] = (porCliente[sub] || 0) + 1;
        }
      }
    }

    console.log("[POSVENDA-JOB] Enfileirados:", totalEnfileirados, porCliente);

    return new Response(
      JSON.stringify({ ok: true, total: totalEnfileirados, porCliente }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[POSVENDA-JOB] Erro:", e);
    return new Response(
      JSON.stringify({ ok: false, erro: (e as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
