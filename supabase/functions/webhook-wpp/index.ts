// ============================================================
// webhook-wpp v27 — Roleta + Handoff IA/Humano + tudo de v26
// Atualizado em 2026-04-13
// OPENAI_API_KEY deve estar configurada como secret no Supabase
// v27: Roleta de vendedores (round-robin entre online), handoff
//      automatico quando cliente pede humano, pausa IA quando
//      vendedor responde manualmente.
// ============================================================
// NOTA: OPENAI_API_KEY vem do secret do Supabase (Deno.env.get)
// EVOKEY e SK estao hardcoded na versao deployada (Edge Function), mas
// aqui no repo ficam como placeholders por seguranca.
const OAIKEY=Deno.env.get("OPENAI_API_KEY")||"";
const EVO="https://evolution.fechoupro.com.br";
const EVOKEY=Deno.env.get("EVOLUTION_API_KEY")||"";
const SB=Deno.env.get("SUPABASE_URL")||"https://udtoojqdjcbxnvevazum.supabase.co";
const SK=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
const SUB="mileniofitness-altamira";
const MODEL="gpt-5.4-mini";
const WAIT_NOVO=7000;
const WAIT_CONV=20000;
const PIX_CHAVE="22.852.765/0001-92";
const PIX_NOME="A. E. DE MELO JUNIOR COMERCIO LTDA";
const PIX_BANCO="BRADESCO";
const HORAS_NOVO_ATENDIMENTO=12;
const MAX_NORMAL=15;
const MAX_EXTENDIDO=22;
const H={"apikey":SK,"Authorization":"Bearer "+SK,"Content-Type":"application/json"};

// v33: Validacao rigorosa de nome de pessoa
function ehNomePessoaValido(nome: string): boolean {
  if (!nome) return false;
  const n = nome.trim();
  if (n.length < 2 || n.length > 60) return false;
  // Rejeita se eh apenas numeros / telefones
  if (/^\+?[\d\s().-]+$/.test(n)) return false;
  // Rejeita se contem urls
  if (/(https?:\/\/|www\.|\.com|\.br)/i.test(n)) return false;
  // Rejeita se eh emoji puro / muito emoji
  const semEmoji = n.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}❤♥]/gu, "").trim();
  if (semEmoji.length < 2) return false;
  if ((n.length - semEmoji.length) > semEmoji.length) return false; // mais emoji que letra
  // Rejeita expressoes/frases comuns que NAO sao nome
  const blacklist = [
    /^(eu|tu|ele|ela|nos|voces|vc|vcs)\s/i,
    /\b(nao|n[ãa]o|sim|ok|tchau|oi|ola|alo|bom\s+dia|boa\s+tarde|boa\s+noite)\b/i,
    /\b(quero|preciso|tenho|vou|vai|sou|estou|tava|tava|fui|gostaria)\b/i,
    /\b(meu\s+numero|wpp|whats|insta|email|telefone|celular)\b/i,
    /\b(loja|empresa|comercial|vendas|atendimento|fornecedor|distribuidora|distribuidor)\b/i,
    /[!?.,;:]{2,}/, // pontuacao excessiva
    /^(usuario|user|cliente|amigo|amiga)$/i,
  ];
  for (const re of blacklist) if (re.test(n)) return false;
  // So aceita se for predominantemente letras + espacos (nome de pessoa)
  const letras = (n.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  const total = n.replace(/\s/g, "").length;
  if (total > 0 && letras / total < 0.7) return false;
  // Rejeita se nao tem nenhuma maiuscula (provavel ser frase em msg, nao nome)
  if (n === n.toLowerCase() && n.length > 4 && n.indexOf(" ") < 0) {
    // mono-palavra sem maiuscula com mais de 4 chars: provavel substantivo, nao nome
    // mas aceita nomes comuns como "ana", "leo", "maria" etc
    const nomesCurtos = ["ana", "leo", "lia", "luna", "kai", "nina", "ivo", "iva", "noa", "rai", "tom", "pri", "duda"];
    if (!nomesCurtos.includes(n.toLowerCase())) return false;
  }
  return true;
}

// Formato de saida imposto pelo sistema (independe do prompt do usuario)
const FORMATO=`

REGRAS ABSOLUTAS DE FORMATO (NAO QUEBRE NUNCA):
1. Responda usando de 1 a 4 mensagens CURTAS, separadas pelo delimitador ||| (tres barras verticais).
2. Cada mensagem: MAXIMO 15 palavras. Limite absoluto 22 palavras.
3. Cada mensagem eh um PENSAMENTO COMPLETO. Nunca termine no meio da ideia.
4. Va direto ao ponto. Proibido usar: "amigo", "meu irmao", "entao", "olha so", "mas relaxa", "verdade", "tipo assim", "cara", "nossa".
5. Maximo 1 pergunta por resposta inteira. Nao ofereca 2 opcoes se 1 resolver.
6. Nao repita o que o cliente disse. Nao use saudacoes desnecessarias no meio de uma conversa ja iniciada.
7. Use numeros (19h, R$150) em vez de extenso.
8. Respostas simples (oi, obrigado, ok) = 1 unica mensagem de ate 6 palavras.

EXEMPLO CORRETO:
Fica aberto ate 19h.|||Endereco: Av. Djalma Dutra, 1554, Centro.|||Quer ver o que tem disponivel?

EXEMPLO ERRADO (NAO FACA):
Oi amigo! Entao, olha so, a loja fica aberta ate 19h e o endereco eh Av. Djalma Dutra numero 1554, no centro de Altamira, viu? Quer que eu ja separe alguma coisa pra voce ou prefere ir ai na loja direto? Eh so me falar!`;

// ---------- OpenAI helper ----------
async function oai(messages,maxTok){
  const r=await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{"Content-Type":"application/json","Authorization":"Bearer "+OAIKEY},
    body:JSON.stringify({model:MODEL,max_completion_tokens:maxTok,messages})
  });
  const d=await r.json();
  return d?.choices?.[0]?.message?.content||"";
}

// Abreviacoes que NAO devem ser tratadas como fim de frase
const ABREV=new Set(["av","r","dr","dra","sr","sra","srta","no","nº","vs","pra","pro","vc","ex","etc","cia","ltda","prof","profa","exmo","sto","sta","pg","pag","ref","obs","ps"]);

// Regra: cada msg termina um pensamento completo.
// Prioridade 1: delimitador ||| (o modelo eh instruido a usar).
// Prioridade 2: quebras de linha duplas.
// Prioridade 3: sentencas completas, respeitando abreviacoes e numeros com ponto.
// Se sentenca >22 palavras, divide em virgulas/conjuncoes (nunca corta palavra).
function quebrar(txt){
  if(!txt)return["Como posso ajudar?"];
  let s=txt.replace(/[\u{1F000}-\u{1FFFF}]/gu,"").replace(/[\u{2600}-\u{27FF}]/gu,"").replace(/[\u{1F100}-\u{1F9FF}]/gu,"").replace(/[\u{FE00}-\u{FEFF}]/gu,"").trim();
  s=s.replace(/\*+([^*\n]+)\*+/g,"$1").replace(/_+([^_\n]+)_+/g,"$1").replace(/^#{1,6} */gm,"").trim();
  if(!s)return["Como posso ajudar?"];

  // PRIORIDADE 1: delimitador ||| (forma oficial)
  if(s.includes("|||")){
    const partes=s.split("|||").map(p=>p.replace(/\s+/g," ").trim()).filter(p=>p.length>0);
    if(partes.length>0)return partes.slice(0,5);
  }

  // PRIORIDADE 2: paragrafos (linhas duplas)
  const paragrafos=s.split(/\n{2,}/).map(p=>p.replace(/\s+/g," ").trim()).filter(p=>p.length>0);
  if(paragrafos.length>1)return paragrafos.slice(0,5);

  // PRIORIDADE 3: separar em sentencas respeitando abreviacoes e numeros
  s=s.replace(/\n+/g," ").replace(/\s+/g," ").trim();
  const sentencas=[];
  let buf="";
  for(let i=0;i<s.length;i++){
    buf+=s[i];
    const c=s[i];
    const prox=s[i+1]||"";
    const prox2=s[i+2]||"";
    if(c==="."||c==="!"||c==="?"){
      // Nao quebra se proximo char eh digito (numero tipo 1.554 ou 13.00)
      if(c==="."&&/\d/.test(prox)){continue;}
      // Nao quebra se o proximo eh letra minuscula (abreviacao colada "av.Djalma")
      if(/[a-z]/.test(prox)&&prox!==" "){continue;}
      // Ponto soh eh fim de frase se proximo for espaco, \n, fim, ou maiuscula/pontuacao
      if(prox!==" "&&prox!=="\n"&&prox!==""){continue;}
      // Verifica se a ultima "palavra" antes do ponto eh abreviacao
      if(c==="."){
        const words=buf.trim().replace(/[.!?]$/,"").split(/\s+/);
        const last=(words[words.length-1]||"").toLowerCase().replace(/[^a-zà-úº]/g,"");
        if(ABREV.has(last)){continue;}
      }
      const f=buf.trim();
      if(f)sentencas.push(f);
      buf="";
    }
  }
  if(buf.trim())sentencas.push(buf.trim());

  // Se sentenca >MAX_EXTENDIDO, divide em virgulas/conjuncoes (sem cortar palavra)
  const resultado=[];
  for(const sent of sentencas){
    const words=sent.split(/\s+/).filter(w=>w.length>0);
    if(words.length===0)continue;
    if(words.length<=MAX_EXTENDIDO){
      resultado.push(words.join(" "));
      continue;
    }
    // Tentar dividir em virgulas ou conjuncoes naturais
    const partes=sent.split(/,\s+|\s+(?:e|mas|ou|porem|entretanto|entao|pois|porque)\s+/i)
      .map(p=>p.trim()).filter(p=>p.length>0);
    let atual="";
    for(const parte of partes){
      const comb=(atual?atual+", ":"")+parte;
      const lenComb=comb.split(/\s+/).length;
      if(lenComb<=MAX_EXTENDIDO){
        atual=comb;
      } else {
        if(atual)resultado.push(atual);
        // Se a propria parte eh maior que MAX_EXTENDIDO, aceita do jeito que veio
        // (melhor msg longa do que cortada no meio)
        atual=parte;
      }
    }
    if(atual)resultado.push(atual);
  }

  const final=resultado.filter(r=>r.trim().length>0);
  return final.length>0?final.slice(0,5):["Como posso ajudar?"];
}

async function enviar(inst,jid,blocos){
  for(let i=0;i<blocos.length;i++){
    if(!blocos[i]?.trim())continue;
    await fetch(EVO+"/message/sendText/"+inst,{method:"POST",headers:{"Content-Type":"application/json","apikey":EVOKEY},body:JSON.stringify({number:jid,text:blocos[i]})});
    if(i<blocos.length-1)await new Promise(r=>setTimeout(r,1200));
  }
}

async function sbGet(t,f){const r=await fetch(SB+"/rest/v1/"+t+"?"+f,{headers:H});return r.json();}
async function sbPost(t,b){await fetch(SB+"/rest/v1/"+t,{method:"POST",headers:{...H,"Prefer":"return=minimal"},body:JSON.stringify(b)});}
async function sbUpsert(t,b){await fetch(SB+"/rest/v1/"+t,{method:"POST",headers:{...H,"Prefer":"resolution=merge-duplicates,return=minimal"},body:JSON.stringify(b)});}
async function sbDelete(t,f){await fetch(SB+"/rest/v1/"+t+"?"+f,{method:"DELETE",headers:H});}
async function sbPatch(t,f,b){await fetch(SB+"/rest/v1/"+t+"?"+f,{method:"PATCH",headers:{...H,"Prefer":"return=minimal"},body:JSON.stringify(b)});}

// ---------- ROLETA: atribuir vendedor round-robin ----------
async function roletaAtribuir(numero:string):Promise<{vendedor_id:number|null,vendedor_nome:string}>{
  try{
    // Buscar vendedores online e ativos
    const vendedores=await sbGet("usuarios","cliente_subdominio=eq."+SUB+"&role=eq.vendedor&ativo=eq.true&online=eq.true&select=id,nome&order=id.asc");
    if(!vendedores?.length)return{vendedor_id:null,vendedor_nome:"Agente IA"};

    // Buscar ultimo vendedor da roleta
    const state=await sbGet("roleta_state","cliente_subdominio=eq."+SUB+"&select=ultimo_vendedor_id&limit=1");
    const ultimoId=state?.[0]?.ultimo_vendedor_id||0;

    // Encontrar proximo na lista (round-robin)
    let idx=vendedores.findIndex((v:{id:number})=>v.id>ultimoId);
    if(idx<0)idx=0; // volta ao inicio
    const escolhido=vendedores[idx];

    // Atualizar estado da roleta
    await sbUpsert("roleta_state",{cliente_subdominio:SUB,ultimo_vendedor_id:escolhido.id,updated_at:new Date().toISOString()});

    return{vendedor_id:escolhido.id,vendedor_nome:escolhido.nome};
  }catch(e){console.error("roleta err:"+String(e));return{vendedor_id:null,vendedor_nome:"Agente IA"};}
}

// ---------- HANDOFF: detectar pedido de humano ----------
const HANDOFF_PATTERNS=[
  /\b(quero|preciso|pode|gostaria).{0,20}(falar|conversar|atendente|humano|pessoa|vendedor|alguem)\b/i,
  /\b(atendente|humano|pessoa real|vendedor)\b/i,
  /\bfalar com (alguem|uma pessoa|um vendedor|o dono|a dona)\b/i,
  /\bnao (quero|gosto).{0,10}(robo|bot|ia|inteligencia artificial|maquina)\b/i
];

function detectarHandoff(texto:string):boolean{
  return HANDOFF_PATTERNS.some(p=>p.test(texto));
}

// Pausar IA para este numero e atribuir vendedor
async function handoffParaHumano(numero:string,vendedorId:number|null,vendedorNome:string){
  // Desativar IA para este contato
  await sbUpsert("ia_status",{cliente_subdominio:SUB,numero,ia_ativa:false,motivo:"handoff_cliente",vendedor_id:vendedorId,updated_at:new Date().toISOString()});
  // Atualizar lead com vendedor
  if(vendedorId){
    await sbPatch("leads","cliente_subdominio=eq."+SUB+"&telefone=eq."+numero,{vendedor:vendedorNome,vendedor_id:vendedorId});
  }
}

async function baixarMidia(inst,data){
  try{const r=await fetch(EVO+"/chat/getBase64FromMediaMessage/"+inst,{method:"POST",headers:{"Content-Type":"application/json","apikey":EVOKEY},body:JSON.stringify({message:data,convertToMp4:false})});const d=await r.json();return d?.base64||null;}catch(_){return null;}
}

async function verificarPix(b64,tipo,valEsp){
  const prompt="Analise o comprovante Pix. Retorne APENAS JSON valido (sem markdown, sem cercas): {destinatario,chave,valor,banco,destinatario_ok,chave_ok,valor_ok,valido,motivo}. Dados corretos: nome="+PIX_NOME+", chave="+PIX_CHAVE+", banco="+PIX_BANCO+(valEsp?", valor="+valEsp:"")+".";
  const dataUrl="data:"+tipo+";base64,"+b64;
  const txt=await oai([{role:"user",content:[{type:"text",text:prompt},{type:"image_url",image_url:{url:dataUrl}}]}],400);
  try{return JSON.parse((txt||"{}").match(/\{[\s\S]*\}/)?.[0]||"{}");}catch(_){return null;}
}

Deno.serve(async(req)=>{
  if(req.method!=="POST")return new Response("OK",{status:200});
  let body;try{body=await req.json();}catch{return new Response("OK",{status:200});}
  if(body?.event!=="messages.upsert")return new Response("OK",{status:200});
  const data=body?.data;
  if(!data||data?.key?.fromMe)return new Response("OK",{status:200});
  const inst=body?.instance||SUB;
  let jid=data?.key?.remoteJid||"";
  // v32: Se vier @lid (WhatsApp moderno), priorizar remoteJidAlt (numero real)
  // Ordem: remoteJidAlt > senderPn > participantPn > participant
  if(jid.indexOf("@lid")>=0){
    const alt=data?.key?.remoteJidAlt||"";
    const pn=data?.key?.senderPn||data?.key?.participantPn||data?.key?.participant||"";
    if(alt&&alt.indexOf("@lid")<0){jid=alt.indexOf("@")>=0?alt:(alt.replace(/\D/g,"")+"@s.whatsapp.net");}
    else if(pn&&pn.indexOf("@lid")<0&&pn.replace(/\D/g,"").length>=10){jid=pn.indexOf("@")>=0?pn:(pn.replace(/\D/g,"")+"@s.whatsapp.net");}
    else{console.log("[WEBHOOK] Ignorando @lid sem remoteJidAlt nem senderPn valido:",JSON.stringify(data?.key));return new Response("OK",{status:200});}
  }
  const num=jid.replace(/@[^@]+$/,"");
  if(!num||!/^\d{10,15}$/.test(num)){console.log("[WEBHOOK] Numero invalido:",num,"jid:",jid);return new Response("OK",{status:200});}
  const msgData=data?.message||{};
  const txt=msgData.conversation||msgData.extendedTextMessage?.text||"";
  const isImg=!!(msgData.imageMessage);
  const isDoc=!!(msgData.documentMessage);
  if(!txt.trim()&&!isImg&&!isDoc)return new Response("OK",{status:200});

  // v29: Reset recuperacao_sessao quando cliente volta a responder
  // (cancela tentativas futuras se o cliente retoma a conversa)
  try{
    await fetch(SB+"/rest/v1/recuperacao_sessao?cliente_subdominio=eq."+SUB+"&numero=eq."+num,{method:"DELETE",headers:H});
  }catch(_){}

  // v34: REATIVAR lead se estava finalizado e cliente respondeu
  // Regra: SO o cliente reativa o lead. Mensagens automaticas/sistema nao reativam.
  // Como esse codigo so executa quando msg do cliente chega (fromMe=false), aqui eh seguro reativar.
  try{
    const leadAtual=await sbGet("leads","cliente_subdominio=eq."+SUB+"&telefone=eq."+num+"&select=id,nome,etapa,resultado_final&limit=1");
    if(leadAtual?.[0]){
      const l=leadAtual[0];
      const precisaReativar=l.etapa==="finalizado"||l.resultado_final==="venda"||l.resultado_final==="nao_venda";
      if(precisaReativar){
        await sbPatch("leads","id=eq."+l.id,{
          etapa:"atendimento",
          resultado_final:null,
          finalizado_em:null,
          reativado_em:new Date().toISOString()
        });
        console.log("[WEBHOOK v34] Lead reativado: "+(l.nome||num)+" (id "+l.id+") — cliente voltou a responder");
      }
    }
  }catch(e){console.error("[WEBHOOK v34] Erro reativar lead:",String(e));}

  // ---- v33: persistir pushName (nome do perfil WhatsApp) — validacao rigorosa ----
  // Roda em paralelo ao resto, nao bloqueia resposta da Mila
  const pushNameRaw=(data?.pushName||"").trim();
  const nomeValido=ehNomePessoaValido(pushNameRaw);
  if(nomeValido){
    (async()=>{
      try{
        // 1. Verificar se contato ja tem nome salvo
        const ct=await sbGet("contatos","cliente_subdominio=eq."+SUB+"&numero=eq."+num+"&select=nome&limit=1");
        const temNome=ct?.[0]?.nome && !/^WhatsApp\s*\+?\d*$/i.test(ct[0].nome);
        if(!temNome){
          // Upsert em contatos (cria novo ou atualiza se nome estava vazio/placeholder)
          await fetch(SB+"/rest/v1/contatos?on_conflict=cliente_subdominio,numero",{
            method:"POST",
            headers:{...H,"Prefer":"resolution=merge-duplicates,return=minimal"},
            body:JSON.stringify({cliente_subdominio:SUB,numero:num,nome:pushNameRaw,updated_at:new Date().toISOString()})
          });
        }
        // 2. Corrigir leads.nome se tiver placeholder "WhatsApp +xxxx"
        await fetch(SB+"/rest/v1/leads?cliente_subdominio=eq."+SUB+"&telefone=eq."+num+"&nome=like.WhatsApp*",{
          method:"PATCH",
          headers:{...H,"Prefer":"return=minimal"},
          body:JSON.stringify({nome:pushNameRaw})
        });
      }catch(e){console.error("pushName persist falhou:"+String(e));}
    })();
  }
  // ---- fim v26 pushName ----

  try{
    const hist=await sbGet("conversas_wpp","cliente_subdominio=eq."+SUB+"&numero=eq."+num+"&role=neq.system&select=role,content,created_at&order=created_at.desc&limit=40");
    const todasMsgs=(hist||[]).reverse();
    const semHistorico=todasMsgs.length===0;

    let eNovoAtendimento=semHistorico;
    if(!semHistorico){
      const ultima=todasMsgs[todasMsgs.length-1];
      const diffHoras=(Date.now()-new Date(ultima.created_at).getTime())/(1000*60*60);
      if(diffHoras>=HORAS_NOVO_ATENDIMENTO){eNovoAtendimento=true;}
    }

    if(!eNovoAtendimento&&!isImg&&!isDoc){
      const semResp=[];
      for(let i=todasMsgs.length-1;i>=0;i--){
        if(todasMsgs[i].role==="assistant")break;
        if(todasMsgs[i].role==="user")semResp.unshift(todasMsgs[i]);
      }
      if(semResp.length===0)return new Response(JSON.stringify({ok:true,ignorado:true}),{status:200});
    }

    let iaOn=true;
    let iaVendedorId:number|null=null;
    try{const s=await sbGet("ia_status","cliente_subdominio=eq."+SUB+"&numero=eq."+num+"&select=ia_ativa,vendedor_id&limit=1");if(s?.[0]){iaOn=s[0].ia_ativa;iaVendedorId=s[0].vendedor_id||null;}}catch(_){}

    // v27: Detectar pedido de handoff para humano
    if(iaOn&&txt.trim()&&detectarHandoff(txt)){
      const roleta=await roletaAtribuir(num);
      await handoffParaHumano(num,roleta.vendedor_id,roleta.vendedor_nome);
      await sbPost("conversas_wpp",{cliente_subdominio:SUB,numero:num,role:"user",content:txt});
      const handoffMsg=roleta.vendedor_id
        ?["Vou transferir voce para "+roleta.vendedor_nome+"!","Ele(a) ja vai te atender."]
        :["Vou chamar alguem pra te atender!","Aguarde um momento."];
      await enviar(inst,jid,handoffMsg);
      await sbPost("conversas_wpp",{cliente_subdominio:SUB,numero:num,role:"assistant",content:handoffMsg.join(" ")});
      return new Response(JSON.stringify({ok:true,handoff:true}),{status:200});
    }

    if((isImg||isDoc)&&iaOn){
      const b64=await baixarMidia(inst,data);
      if(!b64){await enviar(inst,jid,["Nao consegui abrir. Manda de novo?"]);return new Response("OK",{status:200});}
      let valEsp=null;
      try{const ct=await sbGet("contatos","cliente_subdominio=eq."+SUB+"&numero=eq."+num+"&select=contexto&limit=1");if(ct?.[0]?.contexto){const c=JSON.parse(ct[0].contexto);valEsp=c.valor_total||null;}}catch(_){}
      const res=await verificarPix(b64,isImg?"image/jpeg":"application/pdf",valEsp);
      let blocos=[];
      if(!res)blocos=["Nao consegui ler.","Manda foto mais clara?"];
      else if(res.valido)blocos=["Pagamento confirmado!","R$ "+res.valor+" recebido.","Qual seu endereco completo?"];
      else{const p=[];if(!res.destinatario_ok)p.push("destinatario incorreto");if(!res.chave_ok)p.push("chave errada");if(!res.valor_ok&&valEsp)p.push("valor incorreto");blocos=["Pagamento nao confirmado: "+p.join(", ")+".","Chave Pix: "+PIX_CHAVE,"Destinatario: "+PIX_NOME];}
      await enviar(inst,jid,blocos);
      await sbPost("conversas_wpp",[{cliente_subdominio:SUB,numero:num,role:"user",content:"[COMPROVANTE PIX]"},{cliente_subdominio:SUB,numero:num,role:"assistant",content:blocos.join(" ")}]);
      return new Response("OK",{status:200});
    }

    if(!txt.trim())return new Response("OK",{status:200});
    if(!iaOn){await sbPost("conversas_wpp",{cliente_subdominio:SUB,numero:num,role:"user",content:txt});return new Response("OK",{status:200});}

    const mid="msg_"+num+"_"+Date.now();
    try{await sbUpsert("mensagens_fila",{id:mid,cliente_subdominio:SUB,numero:num,texto:txt,created_at:new Date().toISOString()});}catch(_){}
    await new Promise(r=>setTimeout(r,eNovoAtendimento?WAIT_NOVO:WAIT_CONV));
    let fila=[];
    try{fila=await sbGet("mensagens_fila","cliente_subdominio=eq."+SUB+"&numero=eq."+num+"&select=id,texto&order=created_at.asc");}catch(_){}
    if(!fila?.length)fila=[{id:mid,texto:txt}];
    else if(fila[fila.length-1].id!==mid)return new Response("OK",{status:200});
    const txFull=fila.map(m=>m.texto).join(" ");
    try{await sbDelete("mensagens_fila","cliente_subdominio=eq."+SUB+"&numero=eq."+num);}catch(_){}

    const ag=await sbGet("agente_config","cliente_subdominio=eq."+SUB+"&select=prompt&limit=1");
    const sys=ag?.[0]?.prompt||"Voce e Mila da Milenio Fitness.";

    const agora=Date.now();
    const msgsRecentes=todasMsgs.filter(m=>(agora-new Date(m.created_at).getTime())<(HORAS_NOVO_ATENDIMENTO*60*60*1000));
    const msgsParaAgente=eNovoAtendimento?[]:msgsRecentes.map(m=>({role:m.role,content:m.content}));

    // Sempre le o contexto salvo em contatos (inclui nome)
    let ctx={nome:null,objetivo:null,cidade:null,produtos_interesse:[],valor_total:null};
    try{const ct=await sbGet("contatos","cliente_subdominio=eq."+SUB+"&numero=eq."+num+"&select=nome,contexto&limit=1");if(ct?.[0]){ctx.nome=ct[0].nome||null;if(ct[0].contexto)try{ctx={...ctx,...JSON.parse(ct[0].contexto)};}catch(_){}}}catch(_){}

    // Extracao de contexto a cada 5 msgs
    if(msgsParaAgente.length>0&&msgsParaAgente.length%5===0){
      try{
        const extrTxt=await oai([
          {role:"system",content:"Extraia info do cliente. Use null se nao tiver certeza. Para nome, retorne SO o primeiro nome de pessoa real (NUNCA expressoes, frases, nome de empresa, emoji ou negacoes como 'eu nao'). Responda APENAS JSON valido (sem markdown): {nome,objetivo,cidade,produtos_interesse,valor_total}."},
          {role:"user",content:"Contexto atual:"+JSON.stringify(ctx)+"\nHistorico:\n"+msgsParaAgente.slice(-8).map(m=>m.role+":"+m.content).join("\n")}
        ],200);
        const novo=JSON.parse((extrTxt||"{}").match(/\{[\s\S]*\}/)?.[0]||"{}");
        // v33: validar nome antes de aceitar
        if (novo.nome && !ehNomePessoaValido(novo.nome)) {
          console.log("[WEBHOOK v33] IA retornou nome invalido:", novo.nome);
          delete novo.nome;
        }
        ctx={...ctx,...novo};
        // Se nome final ainda for invalido, salvar como null
        const nomeParaSalvar = ctx.nome && ehNomePessoaValido(ctx.nome) ? ctx.nome : null;
        await sbUpsert("contatos",{cliente_subdominio:SUB,numero:num,nome:nomeParaSalvar,contexto:JSON.stringify(ctx),updated_at:new Date().toISOString()});
      }catch(_){}
    }

    let pb="";
    try{const p=await sbGet("playbook_itens","cliente_subdominio=eq."+SUB+"&texto=neq.&select=nome,texto");if(p?.length)pb="\nBASE DE CONHECIMENTO:\n"+p.map(x=>"["+x.nome+"]\n"+x.texto).join("\n\n");}catch(_){}

    let prod="";
    const trm=["preco","quanto","custa","whey","creatina","suplemento","proteina","vitamina","legging","tenis","camiseta","bcaa","colageno","kit","conjunto","pasta","amendoim","pretreino","pre treino","termogenico","shorts","bermuda","calca","macacaozinho","omega"];
    if(trm.some(t=>txFull.toLowerCase().includes(t))){
      try{const ws=txFull.toLowerCase().split(/\s+/).filter(w=>w.length>3).sort((a,b)=>b.length-a.length);if(ws[0]){const ps=await sbGet("produtos","cliente_subdominio=eq."+SUB+"&quantidade=gt.0&nome=ilike.*"+encodeURIComponent(ws[0])+"*&select=nome,preco,preco_oferta&limit=10");if(ps?.length)prod="\nESTOQUE:\n"+ps.map(p=>"- "+p.nome+": "+(p.preco_oferta?"R$"+p.preco_oferta+" (oferta)":"R$"+p.preco)).join("\n");}}catch(_){}
    }

    // v33: usar pushName SO se passar na validacao rigorosa de nome de pessoa
    const nomeContextoValido = ctx.nome && ehNomePessoaValido(ctx.nome);
    if (ctx.nome && !nomeContextoValido) {
      // Nome no banco ta errado (ex: "eu nao", "Loja XYZ"). Limpar pra Mila perguntar.
      console.log("[WEBHOOK v33] Nome invalido em contexto, ignorando:", ctx.nome);
      ctx.nome = null;
    }
    const pushNameComoSugestao = nomeValido && !nomeContextoValido ? pushNameRaw : null;
    const ctxStr=Object.entries(ctx).filter(([k,v])=>k!=='nome'&&v&&(Array.isArray(v)?v.length:true)).map(([k,v])=>k+": "+(Array.isArray(v)?v.join(","):v)).join(" | ");
    let instr="";
    if(eNovoAtendimento&&nomeContextoValido){
      instr="\nCONTEXTO: Novo atendimento. Cliente ja conhecido, nome: "+ctx.nome+"."+(ctxStr?" Dados em memoria (use SOMENTE se ele mencionar o assunto): "+ctxStr+".":"")+" Cumprimente pelo nome de forma breve e natural. NAO pergunte o nome de novo. NAO retome assuntos anteriores.";
    } else if(eNovoAtendimento){
      const dica = pushNameComoSugestao ? " O perfil WhatsApp dele exibe '"+pushNameComoSugestao+"' — confirme pedindo educadamente o primeiro nome (ex: 'Posso te chamar de "+pushNameComoSugestao.split(' ')[0]+"?')." : " IMPORTANTE: pergunte de forma natural o PRIMEIRO NOME do cliente (ex: 'E como posso te chamar?'). Nao aceite respostas como 'eu nao', expressoes ou nome de empresa — se vier algo assim, pergunte de novo.";
      instr="\nCONTEXTO: Novo atendimento. Cliente novo, nome desconhecido. Apresente-se como Mila."+dica;
    } else if(nomeContextoValido){
      instr="\nCLIENTE: "+ctx.nome+"."+(ctxStr?" Dados: "+ctxStr+".":"")+" Atendimento em andamento. NAO se reapresente. NAO pergunte o nome (ja sabemos). Responda APENAS as msgs novas.";
    } else {
      const dica = pushNameComoSugestao ? " Perfil WhatsApp dele exibe '"+pushNameComoSugestao+"'. Confirme se pode te chamar assim ou peça o nome correto." : " Pergunte o nome quando fizer sentido na conversa, mas SEM forcar.";
      instr="\nCLIENTE: ainda sem nome confirmado."+dica+" Atendimento em andamento. NAO se reapresente. Responda APENAS as msgs novas.";
    }

    // Chamada principal ao GPT-5.4-mini
    // FORMATO eh injetado POR ULTIMO pra ter prioridade absoluta sobre o prompt do usuario
    const bruto=await oai([
      {role:"system",content:sys+instr+pb+prod+FORMATO},
      ...msgsParaAgente,
      {role:"user",content:txFull}
    ],400)||"Como posso ajudar?";

    const blocos=quebrar(bruto);
    console.log("v27 eNovo:"+eNovoAtendimento+" push:"+(pushNameRaw||"-")+" bruto:"+bruto.length+"ch blocos:"+blocos.length+" maxW:"+Math.max(...blocos.map(b=>b.split(" ").length)));

    await enviar(inst,jid,blocos);
    await sbPost("conversas_wpp",[{cliente_subdominio:SUB,numero:num,role:"user",content:txFull},{cliente_subdominio:SUB,numero:num,role:"assistant",content:blocos.join(" ")}]);

    // v33: Fallback regex captura nome com validacao rigorosa
    if(!nomeContextoValido){
      // Tentar varios padroes
      const padroes=[
        /(?:me chamo|meu nome (?:e|é))\s+([A-Za-zÀ-ÿ]{2,}(?:\s+[A-Za-zÀ-ÿ]{2,}){0,2})/i,
        /(?:^|\s)(?:sou (?:o|a))\s+([A-Za-zÀ-ÿ]{3,}(?:\s+[A-Za-zÀ-ÿ]{3,})?)/i,
        /(?:pode me chamar de)\s+([A-Za-zÀ-ÿ]{2,}(?:\s+[A-Za-zÀ-ÿ]{2,})?)/i,
        // Resposta direta a "qual seu nome": uma palavra capitalizada
        /^([A-ZÀ-Ý][a-zà-ÿ]{2,}(?:\s+[A-ZÀ-Ý][a-zà-ÿ]{2,})?)\s*[!.]?$/,
      ];
      for (const re of padroes){
        const m = txFull.match(re);
        if (m && m[1]){
          const nomeCandidato = m[1].trim();
          if (ehNomePessoaValido(nomeCandidato)){
            try{
              await sbUpsert("contatos",{cliente_subdominio:SUB,numero:num,nome:nomeCandidato,updated_at:new Date().toISOString()});
              ctx.nome = nomeCandidato;
              console.log("[WEBHOOK v33] Nome extraido do texto:", nomeCandidato);
            }catch(_){}
            break;
          }
        }
      }
    }

    // v27: Auto-criar lead + roleta para contatos novos
    if(eNovoAtendimento){
      try{
        const leadExiste=await sbGet("leads","cliente_subdominio=eq."+SUB+"&telefone=eq."+num+"&select=id,vendedor_id&limit=1");
        if(!leadExiste?.length){
          // Novo lead — atribuir via roleta
          const roleta=await roletaAtribuir(num);
          const nomeContato=ctx.nome||pushNameRaw||("WhatsApp +"+num);
          await sbPost("leads",{
            cliente_subdominio:SUB,
            nome:nomeContato,
            telefone:num,
            origem:"WhatsApp",
            etapa:"novo",
            vendedor:roleta.vendedor_nome,
            vendedor_id:roleta.vendedor_id,
            valor:0
          });
          console.log("v27 lead criado: "+nomeContato+" -> "+roleta.vendedor_nome);
        } else if(!leadExiste[0].vendedor_id){
          // Lead existe mas sem vendedor — atribuir via roleta
          const roleta=await roletaAtribuir(num);
          await sbPatch("leads","id=eq."+leadExiste[0].id,{vendedor:roleta.vendedor_nome,vendedor_id:roleta.vendedor_id});
          console.log("v27 lead reatribuido: "+num+" -> "+roleta.vendedor_nome);
        }
      }catch(e){console.error("v27 lead/roleta err:"+String(e));}
    }

    return new Response(JSON.stringify({ok:true}),{status:200});
  }catch(err){console.error("ERRO v27:"+String(err));return new Response("OK",{status:200});}
});
