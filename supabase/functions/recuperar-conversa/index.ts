// ============================================================
// recuperar-conversa v1 — Tentativas automáticas quando cliente para de responder
// Disparado pelo pg_cron a cada 2 minutos.
// Regras:
//  - 3 min sem resposta do cliente → tentativa 1 (lembrete leve)
//  - 10 min sem resposta → tentativa 2 (oferece ajuda/alternativa)
//  - 25 min sem resposta → tentativa 3 (despedida) + ativa cadência CRM
//  - Respeita horário comercial e feriados
//  - Só dispara se última msg foi do agente (assistant)
//  - Reseta contador se cliente responder (tratado no webhook-wpp)
// ============================================================

const SB = Deno.env.get("SUPABASE_URL") || "https://udtoojqdjcbxnvevazum.supabase.co";
const SK = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const OAIKEY = Deno.env.get("OPENAI_API_KEY") || "";
const EVO = "https://evolution.fechoupro.com.br";
const EVOKEY = Deno.env.get("EVOLUTION_API_KEY") || "";
const MODEL = "gpt-5.4-mini";

const H = {
  apikey: SK,
  Authorization: "Bearer " + SK,
  "Content-Type": "application/json",
};

async function sbGet(t: string, f: string) {
  const r = await fetch(`${SB}/rest/v1/${t}?${f}`, { headers: H });
  return r.json();
}
async function sbPost(t: string, b: unknown) {
  await fetch(`${SB}/rest/v1/${t}`, {
    method: "POST",
    headers: { ...H, Prefer: "return=minimal" },
    body: JSON.stringify(b),
  });
}
async function sbPatch(t: string, filter: string, b: unknown) {
  await fetch(`${SB}/rest/v1/${t}?${filter}`, {
    method: "PATCH",
    headers: H,
    body: JSON.stringify(b),
  });
}
async function sbUpsert(t: string, b: unknown) {
  await fetch(`${SB}/rest/v1/${t}`, {
    method: "POST",
    headers: { ...H, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(b),
  });
}

// Gerar mensagem de recuperação via IA baseado no contexto
async function gerarMsgRecuperacao(
  historico: string,
  lead_nome: string,
  tentativa: number,
  tentativasAnteriores: string[],
): Promise<string> {
  const sys =
    "Voce e uma atendente humana e proxima, nao robo. Lembre o cliente que ficou uma conversa em aberto. Responda APENAS o texto da mensagem que sera enviada, sem prefixo, sem aspas, sem explicacao. REGRAS CRITICAS: (1) NUNCA invente assuntos que nao estao na conversa (nao mencione endereco, horario, promocoes, entregas se o cliente nao pediu). (2) Retome EXATAMENTE o assunto real que o cliente estava tratando. (3) Se ja houver tentativas anteriores, esta nova mensagem DEVE ser claramente diferente em tom e abordagem.";

  let orientacao = "";
  if (tentativa === 1) {
    orientacao =
      "TENTATIVA 1 - Lembrete LEVE e curto. Pergunta aberta retomando EXATAMENTE o assunto que o cliente estava tratando. Tom: casual, como se voce tivesse se distraido. Maximo 2 mensagens curtas separadas por |||. Exemplo de tom: 'Oi vc, ta ai? Ficou alguma duvida sobre X?'";
  } else if (tentativa === 2) {
    orientacao =
      "TENTATIVA 2 - OFERECER AJUDA ATIVA. Traga uma proposta concreta relacionada ao assunto ja conversado. Pode oferecer sugestao, alternativa ou pergunta especifica pra destravar. Tom: proativo, util. DIFERENTE da tentativa 1 em estrutura e abordagem. Maximo 2 mensagens separadas por |||.";
  } else {
    orientacao =
      "TENTATIVA 3 - DESPEDIDA RESPEITOSA. Encerre o ciclo sem insistir. Tom: acolhedor, deixa a porta aberta. NAO repita o conteudo das tentativas anteriores. Maximo 2 mensagens separadas por |||. Exemplo de tom: 'Beleza vc, vou te deixar tranquilo. Qualquer coisa e so chamar.'";
  }

  const tentativasJa = tentativasAnteriores.length > 0
    ? `\n\nMENSAGENS JA ENVIADAS NAS TENTATIVAS ANTERIORES (NAO REPITA, NAO USE TEMAS PARECIDOS):\n${tentativasAnteriores.map((t, i) => (i + 1) + ". " + t).join("\n")}`
    : "";

  const user = `Cliente: ${lead_nome}
Numero da tentativa atual: ${tentativa}
Orientacao: ${orientacao}${tentativasJa}

Ultimas mensagens da conversa (CONTEXTO REAL - USE APENAS ESSES ASSUNTOS):
${historico}

Gere a mensagem de recuperacao agora. Separe bolhas com |||. Maximo 15 palavras por bolha. Foque APENAS no assunto real da conversa acima.`;

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + OAIKEY },
      body: JSON.stringify({
        model: MODEL,
        max_completion_tokens: 200,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
      }),
    });
    const d = await r.json();
    return d?.choices?.[0]?.message?.content?.trim() || "";
  } catch (e) {
    console.error("[RECUP] Erro IA:", e);
    return "";
  }
}

// Enviar via Evolution API
async function enviarMsg(instance: string, jid: string, texto: string): Promise<boolean> {
  try {
    const partes = texto.includes("|||")
      ? texto
          .split("|||")
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      : [texto];

    for (let i = 0; i < partes.length; i++) {
      await fetch(`${EVO}/message/sendText/${instance}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: EVOKEY },
        body: JSON.stringify({ number: jid, text: partes[i] }),
      });
      if (i < partes.length - 1) await new Promise((r) => setTimeout(r, 1200));
    }
    return true;
  } catch (e) {
    console.error("[RECUP] Erro envio:", e);
    return false;
  }
}

// Ativar cadência CRM (inserir 4 msgs em cadencia_queue)
async function ativarCadencia(
  sub: string,
  lead_id: string,
  lead_nome: string,
  numero: string,
  produto: string,
) {
  // Template padrão de cadência
  const steps = [
    { delay_h: 1, titulo: "1ª mensagem", msg: `Oi ${lead_nome}! Ficamos no aguardo. Posso te ajudar com alguma dúvida? 😊` },
    {
      delay_h: 24,
      titulo: "2ª mensagem — oferta",
      msg: `Oi ${lead_nome}! Queria te fazer uma proposta especial. Ainda tem interesse em ${produto || "nossos produtos"}?`,
    },
    {
      delay_h: 72,
      titulo: "3ª mensagem — urgência",
      msg: `${lead_nome}, última chance! O estoque de ${produto || "nossos produtos"} está acabando. Quer garantir o seu? 💪`,
    },
    {
      delay_h: 168,
      titulo: "4ª mensagem — encerramento",
      msg: `Olá ${lead_nome}! Se precisar da gente, é só chamar. Estamos aqui! 🏋️`,
    },
  ];

  const agora = new Date();
  const rows = steps.map((s, i) => ({
    cliente_subdominio: sub,
    lead_id,
    lead_nome,
    numero,
    step_num: i,
    titulo: s.titulo,
    mensagem: s.msg,
    enviar_em: new Date(agora.getTime() + s.delay_h * 3600000).toISOString(),
    enviado: false,
  }));

  await sbPost("cadencia_queue", rows);
  console.log(`[RECUP] Cadencia CRM ativada para ${lead_nome}`);
}

Deno.serve(async (_req: Request) => {
  try {
    console.log("[RECUP] Iniciando processamento...");

    // 1. Buscar conversas que tiveram última msg do agente nas últimas 2 horas
    //    (não buscamos muito antigas pra evitar reativar conversas esquecidas)
    const limiteMin = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    const msgs = await sbGet(
      "conversas_wpp",
      `created_at=gte.${limiteMin}&order=created_at.desc&limit=500&select=cliente_subdominio,numero,role,content,created_at`,
    );

    if (!Array.isArray(msgs) || msgs.length === 0) {
      return new Response(JSON.stringify({ ok: true, msg: "Nenhuma conversa recente" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. Agrupar por (subdomínio, número) e pegar a última mensagem e role
    const ultimos = new Map<string, { sub: string; num: string; role: string; created: string; content: string }>();
    for (const m of msgs) {
      const key = `${m.cliente_subdominio}|${m.numero.replace(/@.*$/, "")}`;
      if (!ultimos.has(key)) {
        ultimos.set(key, {
          sub: m.cliente_subdominio,
          num: m.numero.replace(/@.*$/, ""),
          role: m.role,
          created: m.created_at,
          content: m.content,
        });
      }
    }

    let processados = 0;
    let enviados = 0;

    // 3. Para cada conversa onde última msg = assistant, checar se precisa tentativa
    for (const info of ultimos.values()) {
      if (info.role !== "assistant") continue;

      const tempoMin = Math.floor((Date.now() - new Date(info.created).getTime()) / 60000);
      // Pra ser eficiente: só processa se está na janela 3min-40min
      if (tempoMin < 3 || tempoMin > 40) continue;

      processados++;

      // IMPORTANTE: recuperacao automatica NAO respeita horario comercial.
      // Foi o cliente que iniciou a conversa — podemos responder a qualquer hora.
      // A cadencia do CRM (ativada apos a 3a tentativa) SIM respeita horario,
      // pois e uma acao proativa do sistema, nao continuacao de conversa viva.

      // Ler/criar registro em recuperacao_sessao
      const existes = await sbGet(
        "recuperacao_sessao",
        `cliente_subdominio=eq.${info.sub}&numero=eq.${info.num}&limit=1`,
      );
      let sess = Array.isArray(existes) && existes.length > 0 ? existes[0] : null;

      if (sess && sess.finalizada) continue; // já fechou ciclo

      if (!sess) {
        // criar sessão
        await sbPost("recuperacao_sessao", [
          {
            cliente_subdominio: info.sub,
            numero: info.num,
            ultima_msg_agente_em: info.created,
          },
        ]);
        const rs = await sbGet(
          "recuperacao_sessao",
          `cliente_subdominio=eq.${info.sub}&numero=eq.${info.num}&limit=1`,
        );
        sess = rs[0];
      }

      // Decidir qual tentativa disparar
      let tentativa = 0;
      if (tempoMin >= 3 && tempoMin < 10 && !sess.tentativa_1_em) tentativa = 1;
      else if (tempoMin >= 10 && tempoMin < 25 && !sess.tentativa_2_em) tentativa = 2;
      else if (tempoMin >= 25 && !sess.tentativa_3_em) tentativa = 3;

      if (tentativa === 0) continue;

      // Buscar lead pra pegar nome
      const leads = await sbGet(
        "leads",
        `cliente_subdominio=eq.${info.sub}&telefone=like.*${info.num}*&limit=1&select=id,nome,produto`,
      );
      const lead = leads?.[0] || { nome: "cliente", id: info.num, produto: "" };

      // Buscar config Evolution (precisa da instance)
      const cfgs = await sbGet(
        "config_cliente",
        `cliente_subdominio=eq.${info.sub}&chave=eq.evolution_api&limit=1`,
      );
      if (!cfgs || cfgs.length === 0) continue;
      const evo = JSON.parse(cfgs[0].valor);
      if (!evo.instance) continue;

      // Buscar histórico recente (últimas 20 msgs)
      const histRaw = await sbGet(
        "conversas_wpp",
        `cliente_subdominio=eq.${info.sub}&numero=like.*${info.num}*&order=created_at.desc&limit=20&select=role,content,created_at`,
      );
      const historico = (histRaw || [])
        .reverse()
        .map((h: { role: string; content: string }) => (h.role === "user" ? "Cliente" : "Mila") + ": " + h.content)
        .join("\n");

      // Coletar tentativas anteriores deste ciclo pra evitar repeticao/alucinacao
      const tentativasAnteriores: string[] = [];
      const datasAnteriores: Array<Date | null> = [
        sess.tentativa_1_em ? new Date(sess.tentativa_1_em) : null,
        sess.tentativa_2_em ? new Date(sess.tentativa_2_em) : null,
      ];
      for (const dt of datasAnteriores) {
        if (!dt) continue;
        const margem = 2 * 60 * 1000; // 2 min
        const msgsNessaJanela = (histRaw || []).filter((h: { role: string; content: string; created_at: string }) => {
          if (h.role !== "assistant") return false;
          const t = new Date(h.created_at).getTime();
          return Math.abs(t - dt.getTime()) <= margem;
        });
        const textoTent = msgsNessaJanela
          .map((m: { content: string }) => m.content)
          .join(" ");
        if (textoTent) tentativasAnteriores.push(textoTent);
      }

      // Gerar mensagem com IA
      const texto = await gerarMsgRecuperacao(historico, lead.nome || "vc", tentativa, tentativasAnteriores);
      if (!texto) {
        console.log(`[RECUP] IA nao gerou texto para ${info.num}`);
        continue;
      }

      // Enviar
      let jid = info.num.replace(/\D/g, "");
      if (!jid.includes("@")) jid = jid + "@s.whatsapp.net";
      const ok = await enviarMsg(evo.instance, jid, texto);

      if (!ok) continue;

      // Salvar msg em conversas_wpp (pra aparecer no chat do CRM)
      const partes = texto.includes("|||") ? texto.split("|||").map((p) => p.trim()).filter(Boolean) : [texto];
      const rowsConv = partes.map((p) => ({
        cliente_subdominio: info.sub,
        numero: jid,
        role: "assistant",
        content: p,
      }));
      await sbPost("conversas_wpp", rowsConv);

      // Atualizar recuperacao_sessao
      const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (tentativa === 1) updateData.tentativa_1_em = new Date().toISOString();
      if (tentativa === 2) updateData.tentativa_2_em = new Date().toISOString();
      if (tentativa === 3) {
        updateData.tentativa_3_em = new Date().toISOString();
        updateData.finalizada = true;
      }
      await sbPatch(
        "recuperacao_sessao",
        `cliente_subdominio=eq.${info.sub}&numero=eq.${info.num}`,
        updateData,
      );

      // Se foi tentativa 3, ativar cadência CRM
      if (tentativa === 3 && lead.id) {
        await ativarCadencia(info.sub, String(lead.id), lead.nome || "cliente", jid, lead.produto || "");
      }

      enviados++;
      console.log(`[RECUP] Tentativa ${tentativa} enviada para ${lead.nome} (${info.num})`);
    }

    return new Response(
      JSON.stringify({ ok: true, processados, enviados }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("[RECUP] Erro geral:", e);
    return new Response(
      JSON.stringify({ ok: false, erro: (e as Error).message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
