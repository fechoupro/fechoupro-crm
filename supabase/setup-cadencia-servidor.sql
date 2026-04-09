-- =====================================================
-- CADÊNCIA DE RECUPERAÇÃO - PROCESSAMENTO NO SERVIDOR
-- FechouPro CRM
--
-- Execute este SQL no Supabase SQL Editor
-- Isso faz as mensagens serem enviadas automaticamente
-- mesmo com a página fechada!
-- =====================================================

-- 1. Função que processa a fila de cadência
CREATE OR REPLACE FUNCTION processar_cadencia_auto()
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
  -- Buscar até 10 mensagens pendentes cujo horário já passou
  FOR item IN
    SELECT cq.*
    FROM cadencia_queue cq
    WHERE cq.enviado = FALSE
      AND cq.enviar_em <= NOW()
    ORDER BY cq.enviar_em ASC
    LIMIT 10
  LOOP
    BEGIN
      -- Buscar config do Evolution API para este cliente
      SELECT valor::jsonb INTO evo_config
      FROM config_cliente
      WHERE cliente_subdominio = item.cliente_subdominio
        AND chave = 'evolution_api'
      LIMIT 1;

      -- Se não tem config, pular
      IF evo_config IS NULL THEN
        RAISE NOTICE 'Sem config Evolution para %', item.cliente_subdominio;
        CONTINUE;
      END IF;

      evo_url := evo_config->>'url';
      evo_token := evo_config->>'token';
      evo_instance := evo_config->>'instance';

      -- Validar config
      IF evo_url IS NULL OR evo_token IS NULL OR evo_instance IS NULL THEN
        RAISE NOTICE 'Config Evolution incompleta para %', item.cliente_subdominio;
        CONTINUE;
      END IF;

      -- Preparar número (JID)
      jid := regexp_replace(item.numero, '[^0-9]', '', 'g');
      IF position('@' IN item.numero) = 0 THEN
        jid := jid || '@s.whatsapp.net';
      ELSE
        jid := item.numero;
      END IF;

      -- Remover barra final da URL
      evo_url := rtrim(evo_url, '/');
      send_url := evo_url || '/message/sendText/' || evo_instance;

      -- Enviar via Evolution API usando pg_net
      PERFORM net.http_post(
        url := send_url,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'apikey', evo_token
        ),
        body := jsonb_build_object(
          'number', jid,
          'text', item.mensagem
        )
      );

      -- Marcar como enviado
      UPDATE cadencia_queue
      SET enviado = TRUE, enviado_em = NOW()
      WHERE id = item.id;

      -- Registrar na conversas_wpp para aparecer no chat
      INSERT INTO conversas_wpp (cliente_subdominio, numero, role, content)
      VALUES (item.cliente_subdominio, jid, 'assistant', item.mensagem);

      RAISE NOTICE 'CADENCIA: Enviado para % (%): %', item.lead_nome, item.numero, item.titulo;

    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'CADENCIA ERRO item %: %', item.id, SQLERRM;
    END;
  END LOOP;

  -- Limpar mensagens enviadas com mais de 7 dias
  DELETE FROM cadencia_queue
  WHERE enviado = TRUE
    AND enviado_em < NOW() - INTERVAL '7 days';

END;
$$;

-- 2. Remover cron antigo (se existir) que chamava Edge Function
SELECT cron.unschedule('processar-cadencia');

-- 3. Agendar a função para rodar a cada minuto
SELECT cron.schedule(
  'processar-cadencia-db',
  '* * * * *',
  $$SELECT processar_cadencia_auto();$$
);

-- 4. Verificar se o cron foi criado
SELECT * FROM cron.job WHERE jobname = 'processar-cadencia-db';
