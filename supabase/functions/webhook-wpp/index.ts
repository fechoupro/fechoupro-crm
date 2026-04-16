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
const EVOKEY="REDACTED_EVOLUTION_KEY";
const SB="https://udtoojqdjcbxnvevazum.supabase.co";
const SK="REDACTED_SUPABASE_ANON_KEY";
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
  // v28: se vier @lid (id local WhatsApp), usar senderPn (numero real) se disponivel
  if(jid.indexOf("@lid")>=0){
    const pn=data?.key?.senderPn||data?.key?.participant||"";
    if(pn&&pn.indexOf("@lid")<0){jid=pn.indexOf("@")>=0?pn:(pn.replace(/\D/g,"")+"@s.whatsapp.net");}
    else{console.log("[WEBHOOK] Ignorando @lid sem senderPn:",jid);return new Response("OK",{status:200});}
  }
  const num=jid.replace(/@[^@]+$/,"");
  if(!num||!/^\d{10,15}$/.test(num))return new Response("OK",{status:200});
  const msgData=data?.message||{};
  const txt=msgData.conversation||msgData.extendedTextMessage?.text||"";
  const isImg=!!(msgData.imageMessage);
  const isDoc=!!(msgData.documentMessage);
  if(!txt.trim()&&!isImg&&!isDoc)return new Response("OK",{status:200});

  // ---- v26: persistir pushName (nome do perfil WhatsApp) ----
  // Roda em paralelo ao resto, nao bloqueia resposta da Mila
  const pushNameRaw=(data?.pushName||"").trim();
  const nomeValido=pushNameRaw
    && pushNameRaw.length>=2
    && !/^\+?\d+$/.test(pushNameRaw)
    && !/meu.?numero/i.test(pushNameRaw);
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
          {role:"system",content:"Extraia info do cliente. Responda APENAS JSON valido (sem markdown): {nome,objetivo,cidade,produtos_interesse,valor_total}."},
          {role:"user",content:"Contexto atual:"+JSON.stringify(ctx)+"\nHistorico:\n"+msgsParaAgente.slice(-8).map(m=>m.role+":"+m.content).join("\n")}
        ],200);
        const novo=JSON.parse((extrTxt||"{}").match(/\{[\s\S]*\}/)?.[0]||"{}");
        ctx={...ctx,...novo};
        await sbUpsert("contatos",{cliente_subdominio:SUB,numero:num,nome:ctx.nome||null,contexto:JSON.stringify(ctx),updated_at:new Date().toISOString()});
      }catch(_){}
    }

    let pb="";
    try{const p=await sbGet("playbook_itens","cliente_subdominio=eq."+SUB+"&texto=neq.&select=nome,texto");if(p?.length)pb="\nBASE DE CONHECIMENTO:\n"+p.map(x=>"["+x.nome+"]\n"+x.texto).join("\n\n");}catch(_){}

    let prod="";
    const trm=["preco","quanto","custa","whey","creatina","suplemento","proteina","vitamina","legging","tenis","camiseta","bcaa","colageno","kit","conjunto","pasta","amendoim","pretreino","pre treino","termogenico","shorts","bermuda","calca","macacaozinho","omega"];
    if(trm.some(t=>txFull.toLowerCase().includes(t))){
      try{const ws=txFull.toLowerCase().split(/\s+/).filter(w=>w.length>3).sort((a,b)=>b.length-a.length);if(ws[0]){const ps=await sbGet("produtos","cliente_subdominio=eq."+SUB+"&quantidade=gt.0&nome=ilike.*"+encodeURIComponent(ws[0])+"*&select=nome,preco,preco_oferta&limit=10");if(ps?.length)prod="\nESTOQUE:\n"+ps.map(p=>"- "+p.nome+": "+(p.preco_oferta?"R$"+p.preco_oferta+" (oferta)":"R$"+p.preco)).join("\n");}}catch(_){}
    }

    const ctxStr=Object.entries(ctx).filter(([,v])=>v&&(Array.isArray(v)?v.length:true)).map(([k,v])=>k+": "+(Array.isArray(v)?v.join(","):v)).join(" | ");
    let instr="";
    if(eNovoAtendimento&&ctx.nome){
      instr="\nCONTEXTO: Novo atendimento. Cliente ja conhecido, nome: "+ctx.nome+"."+(ctxStr?" Dados em memoria (use SOMENTE se ele mencionar o assunto): "+ctxStr+".":"")+" Cumprimente pelo nome de forma breve e natural. NAO pergunte o nome de novo. NAO retome assuntos anteriores.";
    } else if(eNovoAtendimento){
      instr="\nCONTEXTO: Novo atendimento. Cliente novo, nome desconhecido. Apresente-se como Mila e pergunte o nome.";
    } else if(ctx.nome){
      instr="\nCLIENTE: "+ctx.nome+"."+(ctxStr?" Dados: "+ctxStr+".":"")+" Atendimento em andamento. NAO se reapresente. NAO pergunte o nome (ja sabemos). Responda APENAS as msgs novas.";
    } else {
      instr="\nCLIENTE: sem dados salvos. Atendimento em andamento. NAO se reapresente. Responda APENAS as msgs novas.";
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

    // Fallback regex para capturar nome se ainda nao temos
    if(!ctx.nome){const m=txFull.match(/(?:me chamo|meu nome|sou o|sou a)\s+([A-Za-zÀ-ú]{3,}(?:\s+[A-Za-zÀ-ú]{3,})?)/i);if(m)try{await sbUpsert("contatos",{cliente_subdominio:SUB,numero:num,nome:m[1],updated_at:new Date().toISOString()});}catch(_){}}

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
