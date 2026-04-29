// ============================================================
// webhook-instagram v1 — Recebe DMs do Instagram via Meta Graph API
// Endpoints:
//   GET  /functions/v1/webhook-instagram?hub.verify_token=X&hub.challenge=Y
//        → Validação do webhook pelo Meta (retorna o challenge)
//   POST /functions/v1/webhook-instagram
//        → Recebe eventos de mensagens do Instagram Direct
//
// Fluxo:
//   1. Meta manda POST com evento messages
//   2. Extrai sender_id (IG scoped ID), page_id, texto
//   3. Busca config do cliente pelo page_id em config_cliente
//   4. Registra em conversas_wpp com canal='ig'
//   5. Cria/atualiza lead com canal='ig'
//   6. Chama Mila (IA) com histórico
//   7. Responde via Graph API: POST /{page-id}/messages
// ============================================================

const SB = Deno.env.get("SUPABASE_URL") || "https://udtoojqdjcbxnvevazum.supabase.co";
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OAIKEY = Deno.env.get("OPENAI_API_KEY") || "";
const META_VERIFY_TOKEN = Deno.env.get("META_VERIFY_TOKEN") || "fechoupro_verify_2026";
const GRAPH = "https://graph.facebook.com/v21.0";
const MODEL = "gpt-5.4-mini";

const H = { apikey: SK, Authorization: "Bearer " + SK, "Content-Type": "application/json" };

async function sbGet(t: string, f: string) {
  const r = await fetch(`${SB}/rest/v1/${t}?${f}`, { headers: H });
  return r.json();
}
async function sbPost(t: string, b: unknown) {
  await fetch(`${SB}/rest/v1/${t}`, { method: "POST", headers: { ...H, Prefer: "return=minimal" }, body: JSON.stringify(b) });
}
async function sbPatch(t: string, filter: string, b: unknown) {
  await fetch(`${SB}/rest/v1/${t}?${filter}`, { method: "PATCH", headers: H, body: JSON.stringify(b) });
}

// Buscar config Instagram pelo page_id
async function getIgConfig(page_id: string): Promise<{ sub: string; access_token: string; page_id: string; ig_user_id?: string; instance_name?: string } | null> {
  const all = await sbGet("config_cliente", `chave=eq.instagram_api&select=cliente_subdominio,valor`);
  if (!Array.isArray(all)) return null;
  for (const row of all) {
    try {
      const v = JSON.parse(row.valor);
      if (v.page_id === page_id) {
        return { sub: row.cliente_subdominio, access_token: v.access_token, page_id: v.page_id, ig_user_id: v.ig_user_id, instance_name: v.instance_name };
      }
    } catch {}
  }
  return null;
}

// Gerar resposta via IA (Mila) usando o prompt salvo do cliente
async function gerarRespostaIA(sub: string, historico: string, msgAtual: string, nomeCliente: string): Promise<string> {
  // Buscar prompt da Mila salvo nas configurações do cliente
  const cfgPrompt = await sbGet("config_cliente", `cliente_subdominio=eq.${sub}&chave=eq.agente_prompt&limit=1`);
  const promptSalvo = cfgPrompt?.[0]?.valor || "";

  const sys = promptSalvo || "Voce e Mila, atendente virtual da loja. Responda de forma natural, humana, curta. Separe mensagens com |||.";

  const user = `Cliente: ${nomeCliente}\n\nHistorico recente:\n${historico}\n\nNova mensagem do cliente: "${msgAtual}"\n\nResponda agora como Mila.`;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + OAIKEY },
      body: JSON.stringify({
        model: MODEL,
        max_completion_tokens: 400,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    });
    const d = await r.json();
    return d?.choices?.[0]?.message?.content?.trim() || "Oi! Tudo bem?";
  } catch (e) {
    console.error("[IG-WEBHOOK] Erro IA:", e);
    return "Oi! Tudo bem? Como posso ajudar?";
  }
}

// Enviar mensagem via Graph API
async function enviarDM(page_id: string, access_token: string, recipient_id: string, texto: string): Promise<boolean> {
  const partes = texto.includes("|||") ? texto.split("|||").map((p) => p.trim()).filter((p) => p.length > 0) : [texto];
  try {
    for (let i = 0; i < partes.length; i++) {
      const r = await fetch(`${GRAPH}/${page_id}/messages?access_token=${access_token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipient_id },
          message: { text: partes[i] },
          messaging_type: "RESPONSE",
        }),
      });
      const j = await r.json();
      if (j.error) console.error("[IG-WEBHOOK] Erro envio:", j.error);
      if (i < partes.length - 1) await new Promise((res) => setTimeout(res, 1200));
    }
    return true;
  } catch (e) {
    console.error("[IG-WEBHOOK] Erro rede envio:", e);
    return false;
  }
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // GET: validação do webhook pelo Meta
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token === META_VERIFY_TOKEN && challenge) {
      console.log("[IG-WEBHOOK] Validacao OK");
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("OK", { status: 200 });

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response("OK", { status: 200 });
  }

  // Estrutura esperada: { object: 'instagram', entry: [{ messaging: [...] }] }
  if (body?.object !== "instagram" && body?.object !== "page") {
    return new Response("OK", { status: 200 });
  }

  const entries = body.entry || [];
  for (const entry of entries) {
    const page_id = entry.id;
    const cfg = await getIgConfig(page_id);
    if (!cfg) {
      console.log("[IG-WEBHOOK] Sem config pra page_id", page_id);
      continue;
    }

    const events = entry.messaging || [];
    for (const ev of events) {
      try {
        // Ignorar echoes (mensagens enviadas pela página)
        if (ev.message?.is_echo) continue;

        const sender_id = ev.sender?.id;
        const recipient_id = ev.recipient?.id;
        const txt = ev.message?.text || "";

        if (!sender_id || !txt) continue;

        // Ignorar mensagens que a própria página enviou
        if (sender_id === page_id || sender_id === cfg.ig_user_id) continue;

        console.log(`[IG-WEBHOOK] DM de ${sender_id}: ${txt.slice(0, 60)}`);

        // Reset recuperacao_sessao se existia
        try {
          await fetch(`${SB}/rest/v1/recuperacao_sessao?cliente_subdominio=eq.${cfg.sub}&numero=eq.${sender_id}`, { method: "DELETE", headers: H });
        } catch {}

        // v2: REATIVAR lead Instagram se estava finalizado e cliente respondeu
        try {
          const leadCheck = await sbGet("leads", `cliente_subdominio=eq.${cfg.sub}&telefone=eq.${sender_id}&select=id,nome,etapa,resultado_final&limit=1`);
          if (leadCheck?.[0]) {
            const l = leadCheck[0];
            const precisaReativar = l.etapa === "finalizado" || l.resultado_final === "venda" || l.resultado_final === "nao_venda";
            if (precisaReativar) {
              await sbPatch("leads", `id=eq.${l.id}`, {
                etapa: "atendimento",
                resultado_final: null,
                finalizado_em: null,
                reativado_em: new Date().toISOString()
              });
              console.log(`[IG-WEBHOOK v2] Lead reativado: ${l.nome || sender_id} (id ${l.id})`);
            }
          }
        } catch (e) { console.error("[IG-WEBHOOK v2] Erro reativar:", e); }

        // Buscar nome do remetente (pode ter sido salvo antes ou vir do payload)
        let nomeRemetente = "cliente";
        try {
          const userInfoRes = await fetch(`${GRAPH}/${sender_id}?fields=name,username&access_token=${cfg.access_token}`);
          const userInfo = await userInfoRes.json();
          if (userInfo.name) nomeRemetente = userInfo.name;
          else if (userInfo.username) nomeRemetente = userInfo.username;
        } catch {}

        // Salvar mensagem do cliente
        await sbPost("conversas_wpp", [{
          cliente_subdominio: cfg.sub,
          numero: sender_id,
          role: "user",
          content: txt,
          canal: "ig",
        }]);

        // Buscar histórico (últimas 20 msgs deste sender no canal ig)
        const histRaw = await sbGet("conversas_wpp", `cliente_subdominio=eq.${cfg.sub}&numero=eq.${sender_id}&canal=eq.ig&order=created_at.desc&limit=20&select=role,content`);
        const historico = (histRaw || []).reverse()
          .map((h: { role: string; content: string }) => (h.role === "user" ? "Cliente" : "Mila") + ": " + h.content)
          .join("\n");

        // Criar/atualizar lead
        const leadExiste = await sbGet("leads", `cliente_subdominio=eq.${cfg.sub}&numero=eq.${sender_id}&canal=eq.ig&limit=1`);
        if (!leadExiste || leadExiste.length === 0) {
          await sbPost("leads", {
            cliente_subdominio: cfg.sub,
            nome: nomeRemetente,
            numero: sender_id,
            telefone: sender_id,
            canal: "ig",
            etapa: "novo",
            origem: "Instagram Direct",
            vendedor: "Agente IA",
            produto: "",
            valor: 0,
          });
          console.log("[IG-WEBHOOK] Novo lead IG criado:", nomeRemetente);
        }

        // Atualizar/criar contato
        try {
          await fetch(`${SB}/rest/v1/contatos`, {
            method: "POST",
            headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({
              cliente_subdominio: cfg.sub,
              numero: sender_id,
              nome: nomeRemetente,
              canal: "ig",
            }),
          });
        } catch {}

        // Gerar resposta com IA (Mila)
        const resposta = await gerarRespostaIA(cfg.sub, historico, txt, nomeRemetente);

        // Enviar resposta
        await enviarDM(page_id, cfg.access_token, sender_id, resposta);

        // Salvar resposta enviada
        const partesResp = resposta.includes("|||") ? resposta.split("|||").map((p) => p.trim()).filter(Boolean) : [resposta];
        for (const p of partesResp) {
          await sbPost("conversas_wpp", [{
            cliente_subdominio: cfg.sub,
            numero: sender_id,
            role: "assistant",
            content: p,
            canal: "ig",
          }]);
        }
      } catch (e) {
        console.error("[IG-WEBHOOK] Erro processando evento:", e);
      }
    }
  }

  return new Response("OK", { status: 200 });
});
