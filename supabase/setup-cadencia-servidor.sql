-- =====================================================
-- CADÊNCIA DE RECUPERAÇÃO - PROCESSAMENTO NO SERVIDOR
-- FechouPro CRM
--
-- Execute este SQL no Supabase SQL Editor.
-- Roda a cada minuto via pg_cron, envia mensagens automaticamente
-- mesmo com a página fechada — RESPEITANDO:
--   Segunda a sexta: 08h às 18h (Brasília)
--   Sábado:          08h às 11h (Brasília)
--   Domingo:         sem envio
--   Feriados:        sem envio (tabela feriados)
-- =====================================================

-- 0. Tabela de feriados (pre-populada via API Management)
CREATE TABLE IF NOT EXISTS feriados (
  id SERIAL PRIMARY KEY,
  data DATE NOT NULL,
  descricao TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('nacional','estadual','municipal')),
  cliente_subdominio TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(data, descricao, cliente_subdominio)
);
CREATE INDEX IF NOT EXISTS idx_feriados_data ON feriados(data);
ALTER TABLE feriados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS feriados_select ON feriados;
CREATE POLICY feriados_select ON feriados FOR SELECT USING (true);

-- 1. Função auxiliar: retorna TRUE se estamos na janela comercial E nao é feriado
CREATE OR REPLACE FUNCTION fp_dentro_horario_comercial(p_sub TEXT DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  dow INT;
  h INT;
  hoje DATE;
  eh_feriado BOOLEAN;
BEGIN
  hoje := (NOW() AT TIME ZONE 'America/Sao_Paulo')::DATE;
  dow  := EXTRACT(DOW  FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::INT;
  h    := EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'America/Sao_Paulo'))::INT;

  -- feriado nacional (NULL) ou do cliente
  SELECT EXISTS(
    SELECT 1 FROM feriados
    WHERE data = hoje AND (cliente_subdominio IS NULL OR cliente_subdominio = p_sub)
  ) INTO eh_feriado;
  IF eh_feriado THEN RETURN FALSE; END IF;

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
--    DISTINCT ON(lead_id): só 1 msg por lead por ciclo — preserva intervalo
--    Após enviar, reagenda a próxima msg do lead baseado no intervalo original
CREATE OR REPLACE FUNCTION processar_cadencia_auto()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  item RECORD;
  prox RECORD;
  diff INTERVAL;
  evo_config JSONB;
  evo_url TEXT;
  evo_token TEXT;
  evo_instance TEXT;
  jid TEXT;
  send_url TEXT;
BEGIN
  FOR item IN
    SELECT DISTINCT ON (cq.lead_id) cq.*
    FROM cadencia_queue cq
    WHERE cq.enviado = FALSE
      AND cq.enviar_em <= NOW()
      AND fp_dentro_horario_comercial(cq.cliente_subdominio)
    ORDER BY cq.lead_id, cq.enviar_em ASC
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

      -- REAGENDAR próxima msg do mesmo lead preservando intervalo original
      SELECT * INTO prox FROM cadencia_queue
        WHERE lead_id = item.lead_id
          AND cliente_subdominio = item.cliente_subdominio
          AND enviado = FALSE
          AND step_num > item.step_num
        ORDER BY step_num ASC LIMIT 1;
      IF prox.id IS NOT NULL THEN
        diff := prox.enviar_em - item.enviar_em;
        IF diff > INTERVAL '0 seconds' THEN
          UPDATE cadencia_queue SET enviar_em = NOW() + diff WHERE id = prox.id;
        END IF;
      END IF;

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
