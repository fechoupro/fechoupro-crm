// ============================================================
// webhook-wpp v23 — GPT-5.4-mini (migrado de Claude Haiku/Opus)
// Migrado em 2026-04-10
// OPENAI_API_KEY deve estar configurada como secret no Supabase
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

// Regra: cada msg termina um pensamento
// - ate 15 palavras: envia como esta
// - entre 16 e 22 palavras: termina o pensamento ate 22 palavras (nao corta)
// - acima de 22 palavras: divide em sentencas, cada sentenca max 22 palavras
function quebrar(txt){
  if(!txt)return["Como posso ajudar?"];
  let s=txt.replace(/[\u{1F000}-\u{1FFFF}]/gu,"").replace(/[\u{2600}-\u{27FF}]/gu,"").replace(/[\u{1F100}-\u{1F9FF}]/gu,"").replace(/[\u{FE00}-\u{FEFF}]/gu,"").trim();
  s=s.replace(/\*+([^*\n]+)\*+/g,"$1").replace(/_+([^_\n]+)_+/g,"$1").replace(/^#{1,6} */gm,"").trim();
  if(!s)return["Como posso ajudar?"];

  // Separar em sentencas por . ! ? ou quebra de linha
  const sentencas=[];
  let buf="";
  for(let i=0;i<s.length;i++){
    buf+=s[i];
    const c=s[i];
    const prox=s[i+1]||"";
    if((c==="."||c==="!"||c==="?")&&(prox===" "||prox==="\n"||prox==="")){
      const f=buf.trim();
      if(f)sentencas.push(f);
      buf="";
    } else if(c==="\n"){
      const f=buf.trim();
      if(f)sentencas.push(f);
      buf="";
    }
  }
  if(buf.trim())sentencas.push(buf.trim());

  const resultado=[];
  for(const sent of sentencas){
    const words=sent.split(/\s+/).filter(w=>w.length>0);
    if(words.length===0)continue;
    if(words.length<=MAX_EXTENDIDO){
      resultado.push(words.join(" "));
    } else {
      let i=0;
      while(i<words.length){
        const chunk=words.slice(i,i+MAX_EXTENDIDO);
        resultado.push(chunk.join(" "));
        i+=MAX_EXTENDIDO;
      }
    }
  }
  return resultado.filter(r=>r.trim().length>0).length>0
    ?resultado.filter(r=>r.trim().length>0)
    :["Como posso ajudar?"];
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
  const jid=data?.key?.remoteJid||"";
  const num=jid.replace(/@[^@]+$/,"");
  if(!num)return new Response("OK",{status:200});
  const msgData=data?.message||{};
  const txt=msgData.conversation||msgData.extendedTextMessage?.text||"";
  const isImg=!!(msgData.imageMessage);
  const isDoc=!!(msgData.documentMessage);
  if(!txt.trim()&&!isImg&&!isDoc)return new Response("OK",{status:200});

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
    try{const s=await sbGet("ia_status","cliente_subdominio=eq."+SUB+"&numero=eq."+num+"&select=ia_ativa&limit=1");if(s?.[0])iaOn=s[0].ia_ativa;}catch(_){}

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
    const bruto=await oai([
      {role:"system",content:sys+instr+pb+prod},
      ...msgsParaAgente,
      {role:"user",content:txFull}
    ],400)||"Como posso ajudar?";

    const blocos=quebrar(bruto);
    console.log("v23(gpt-5.4-mini) eNovo:"+eNovoAtendimento+" blocos:"+blocos.length+" max:"+Math.max(...blocos.map(b=>b.split(" ").length)));

    await enviar(inst,jid,blocos);
    await sbPost("conversas_wpp",[{cliente_subdominio:SUB,numero:num,role:"user",content:txFull},{cliente_subdominio:SUB,numero:num,role:"assistant",content:blocos.join(" ")}]);

    // Fallback regex para capturar nome se ainda nao temos
    if(!ctx.nome){const m=txFull.match(/(?:me chamo|meu nome|sou o|sou a)\s+([A-Za-zÀ-ú]{3,}(?:\s+[A-Za-zÀ-ú]{3,})?)/i);if(m)try{await sbUpsert("contatos",{cliente_subdominio:SUB,numero:num,nome:m[1],updated_at:new Date().toISOString()});}catch(_){}}

    return new Response(JSON.stringify({ok:true}),{status:200});
  }catch(err){console.error("ERRO v23:"+String(err));return new Response("OK",{status:200});}
});
