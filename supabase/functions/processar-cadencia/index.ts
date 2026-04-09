// Edge Function: processar-cadencia
// Roda a cada minuto via pg_cron, envia msgs de recuperação pendentes
// Deploy: supabase functions deploy processar-cadencia

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req: Request) => {
  try {
    // 1. Buscar msgs pendentes (enviado=false e enviar_em <= agora)
    const agora = new Date().toISOString()
    const pendentesRes = await fetch(
      `${SUPABASE_URL}/rest/v1/cadencia_queue?enviado=eq.false&enviar_em=lte.${agora}&order=enviar_em.asc&limit=20`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    )
    const pendentes = await pendentesRes.json()

    if (!pendentes || pendentes.length === 0) {
      return new Response(JSON.stringify({ ok: true, enviados: 0, msg: 'Nenhuma msg pendente' }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }

    let enviados = 0
    const erros: string[] = []

    for (const item of pendentes) {
      try {
        // 2. Buscar config do Evolution API para este cliente
        const cfgRes = await fetch(
          `${SUPABASE_URL}/rest/v1/config_cliente?cliente_subdominio=eq.${item.cliente_subdominio}&chave=eq.evolution_api&limit=1`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        )
        const cfgs = await cfgRes.json()

        if (!cfgs || cfgs.length === 0) {
          erros.push(`Sem config Evolution para ${item.cliente_subdominio}`)
          continue
        }

        const evo = JSON.parse(cfgs[0].valor)
        if (!evo.url || !evo.token || !evo.instance) {
          erros.push(`Config Evolution incompleta para ${item.cliente_subdominio}`)
          continue
        }

        // 3. Preparar número (adicionar @s.whatsapp.net se necessário)
        let jid = item.numero.replace(/\D/g, '')
        if (!jid.includes('@')) jid = jid + '@s.whatsapp.net'

        // 4. Enviar via Evolution API
        const evoUrl = evo.url.replace(/\/$/, '')
        const sendRes = await fetch(`${evoUrl}/message/sendText/${evo.instance}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', apikey: evo.token },
          body: JSON.stringify({ number: jid, text: item.mensagem })
        })

        const sendResult = await sendRes.json()
        console.log(`[CADENCIA] Enviado para ${item.lead_nome} (${item.numero}): ${item.titulo}`, sendResult)

        // 5. Marcar como enviado
        await fetch(
          `${SUPABASE_URL}/rest/v1/cadencia_queue?id=eq.${item.id}`,
          {
            method: 'PATCH',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ enviado: true, enviado_em: new Date().toISOString() })
          }
        )

        // 6. Registrar na conversas_wpp para aparecer no chat
        await fetch(
          `${SUPABASE_URL}/rest/v1/conversas_wpp`,
          {
            method: 'POST',
            headers: {
              apikey: SUPABASE_KEY,
              Authorization: `Bearer ${SUPABASE_KEY}`,
              'Content-Type': 'application/json',
              Prefer: 'return=minimal'
            },
            body: JSON.stringify({
              cliente_subdominio: item.cliente_subdominio,
              numero: jid,
              role: 'assistant',
              content: item.mensagem
            })
          }
        )

        enviados++
      } catch (e) {
        erros.push(`Erro item ${item.id}: ${(e as Error).message}`)
      }
    }

    // 7. Limpar msgs enviadas com mais de 7 dias
    const seteDiasAtras = new Date(Date.now() - 7 * 86400000).toISOString()
    await fetch(
      `${SUPABASE_URL}/rest/v1/cadencia_queue?enviado=eq.true&enviado_em=lt.${seteDiasAtras}`,
      {
        method: 'DELETE',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
      }
    )

    return new Response(
      JSON.stringify({ ok: true, enviados, pendentes: pendentes.length, erros }),
      { headers: { 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, erro: (e as Error).message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    )
  }
})
