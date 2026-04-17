-- =====================================================
-- CADÊNCIA DE RECUPERAÇÃO - PROCESSAMENTO NO SERVIDOR
-- FechouPro CRM
--
-- Execute este SQL no Supabase SQL Editor.
-- Roda a cada minuto via pg_cron, envia mensagens automaticamente
-- mesmo com a página fechada — RESPEITANDO o horário comercial:
--   Segunda a sexta: 08h às 18h (Brasília)
--   Sábado:          08h às 11h (Brasília)
--   Domingo:         sem envio
-- =====================================================

-- 1. Função auxiliar: retorna TRUE se estamos na janela comercial
CREATE OR REPLACE FUNCTION fp_dentro_horario_comercial()
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  dow INT;
  h INT;
BEGIN
  dow := EXTRACT(DOW FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::INT;
  h   := EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::INT;
  -- dow: 0=Dom, 1=Seg ... 6=Sab
  IF dow BETWEEN 1 AND 5 THEN
    RETURN h >= 8 AND h < 18;
  ELSIF dow = 6 THEN
    RETURN h >= 8 AND h < 11;
  ELSE
    RETURN FALSE; -- domingo
  END IF;
END;
$$;

-- 2. Função principal: processa a fila de cadência
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
  -- Respeitar horário comercial (se fora, msgs ficam aguardando)
  IF NOT fp_dentro_horario_comercial() THEN
    RAISE NOTICE 'CADENCIA: fora do horario comercial, nao processando';
    RETURN;
  END IF;

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

      IF evo_config IS NULL THEN
        RAISE NOTICE 'Sem config Evolution para %', item.cliente_subdominio;
        CONTINUE;
      END IF;

      evo_url := evo_config->>'url';
      evo_token := evo_config->>'token';
      evo_instance := evo_config->>'instance';

      IF evo_url IS NULL OR evo_token IS NULL OR evo_instance IS NULL THEN
        RAISE NOTICE 'Config Evolution incompleta para %', item.cliente_subdominio;
        CONTINUE;
      END IF;

      -- Preparar JID
      jid := regexp_replace(item.numero, '[^0-9]', '', 'g');
      IF position('@' IN item.numero) = 0 THEN
        jid := jid || '@s.whatsapp.net';
      ELSE
        jid := item.numero;
      END IF;

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

-- 3. Remover cron antigo (se existir)
DO $$
BEGIN
  PERFORM cron.unschedule('processar-cadencia');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

-- 4. Agendar a cada minuto (a função faz a checagem de horário por conta própria)
SELECT cron.schedule(
  'processar-cadencia-db',
  '* * * * *',
  $$SELECT processar_cadencia_auto();$$
);

-- 5. Verificar
SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'processar-cadencia-db';
SELECT fp_dentro_horario_comercial() AS dentro_horario_agora;
