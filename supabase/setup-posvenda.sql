-- =====================================================
-- PÓS-VENDA IMEDIATA - PROCESSAMENTO SERVER-SIDE
-- FechouPro CRM
--
-- Tipos suportados na fila:
--   cashback      — enviado 2 dias após fechamento (automático)
--   agradecimento — enviado manualmente ou agendado
--
-- Respeita horário comercial via fp_dentro_horario_comercial()
-- =====================================================

CREATE OR REPLACE FUNCTION processar_posvenda_auto()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  item RECORD;
  evo_config JSONB;
  evo_url TEXT;
  evo_token TEXT;
  evo_instance TEXT;
  jid TEXT;
  send_url TEXT;
BEGIN
  FOR item IN
    SELECT pq.*
    FROM posvenda_queue pq
    WHERE pq.enviado = FALSE
      AND pq.cancelado = FALSE
      AND pq.enviar_em <= NOW()
      AND fp_dentro_horario_comercial(pq.cliente_subdominio)
    ORDER BY pq.enviar_em ASC
    LIMIT 15
  LOOP
    BEGIN
      SELECT valor::jsonb INTO evo_config FROM config_cliente
        WHERE cliente_subdominio = item.cliente_subdominio AND chave = 'evolution_api' LIMIT 1;
      IF evo_config IS NULL THEN CONTINUE; END IF;

      evo_url := evo_config->>'url';
      evo_token := evo_config->>'token';
      evo_instance := evo_config->>'instance';
      IF evo_url IS NULL OR evo_token IS NULL OR evo_instance IS NULL THEN CONTINUE; END IF;

      jid := regexp_replace(item.numero, '[^0-9]', '', 'g');
      IF position('@' IN item.numero) = 0 THEN
        jid := jid || '@s.whatsapp.net';
      ELSE
        jid := item.numero;
      END IF;
      evo_url := rtrim(evo_url, '/');

      -- Envia TEXTO se modo permite
      IF item.modo IN ('msg_midia','only_msg') AND item.mensagem IS NOT NULL AND LENGTH(item.mensagem) > 0 THEN
        send_url := evo_url || '/message/sendText/' || evo_instance;
        PERFORM net.http_post(
          url := send_url,
          headers := jsonb_build_object('Content-Type','application/json','apikey',evo_token),
          body := jsonb_build_object('number',jid,'text',item.mensagem)
        );
      END IF;

      -- Envia MÍDIA se modo permite e tem URL
      IF item.modo IN ('msg_midia','only_midia') AND item.anexo_url IS NOT NULL THEN
        send_url := evo_url || '/message/sendMedia/' || evo_instance;
        PERFORM net.http_post(
          url := send_url,
          headers := jsonb_build_object('Content-Type','application/json','apikey',evo_token),
          body := jsonb_build_object(
            'number', jid,
            'mediatype', COALESCE(item.anexo_tipo,'image'),
            'media', item.anexo_url,
            'caption', CASE WHEN item.modo='only_midia' THEN item.mensagem ELSE '' END,
            'fileName', regexp_replace(item.anexo_url, '^.*/', ''),
            'mimetype', CASE
              WHEN COALESCE(item.anexo_tipo,'image') = 'image' THEN 'image/jpeg'
              WHEN item.anexo_tipo = 'video' THEN 'video/mp4'
              WHEN item.anexo_tipo = 'audio' THEN 'audio/mpeg'
              ELSE 'application/octet-stream'
            END
          )
        );
      END IF;

      -- Marca como enviado
      UPDATE posvenda_queue
        SET enviado = TRUE, enviado_em = NOW()
        WHERE id = item.id;

      -- Registra no chat (texto + marcador de anexo, se houver)
      IF item.mensagem IS NOT NULL AND LENGTH(item.mensagem) > 0 AND item.modo <> 'only_midia' THEN
        INSERT INTO conversas_wpp (cliente_subdominio, numero, role, content, canal)
        VALUES (item.cliente_subdominio, jid, 'assistant', item.mensagem, 'wpp');
      END IF;
      IF item.anexo_url IS NOT NULL THEN
        INSERT INTO conversas_wpp (cliente_subdominio, numero, role, content, canal)
        VALUES (
          item.cliente_subdominio,
          jid,
          'assistant',
          CASE
            WHEN COALESCE(item.anexo_tipo,'image') = 'image' THEN '[📷 Imagem] ' || item.anexo_url
            WHEN item.anexo_tipo = 'video' THEN '[🎥 Vídeo] ' || item.anexo_url
            WHEN item.anexo_tipo = 'audio' THEN '[🎵 Áudio] ' || item.anexo_url
            ELSE '[📎 Arquivo] ' || item.anexo_url
          END
          || CASE WHEN item.modo='only_midia' AND item.mensagem IS NOT NULL AND LENGTH(item.mensagem)>0
                  THEN E'\n' || item.mensagem ELSE '' END,
          'wpp'
        );
      END IF;

      RAISE NOTICE 'POSVENDA: Enviada % para % (%)', item.tipo, item.lead_nome, item.numero;

    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'POSVENDA ERRO item %: %', item.id, SQLERRM;
    END;
  END LOOP;

  -- Limpar enviadas com > 30 dias
  DELETE FROM posvenda_queue WHERE enviado = TRUE AND enviado_em < NOW() - INTERVAL '30 days';
END;
$$;

-- Remove cron antigo (se existir)
DO $$
BEGIN
  PERFORM cron.unschedule('processar-posvenda-db');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- Agenda pra rodar a cada minuto
SELECT cron.schedule(
  'processar-posvenda-db',
  '* * * * *',
  $cmd$SELECT processar_posvenda_auto();$cmd$
);

-- Valida
SELECT jobname, schedule, active FROM cron.job
WHERE jobname IN ('processar-posvenda-db','processar-cadencia-db','recuperar-conversa-db')
ORDER BY jobname;
