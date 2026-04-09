-- =====================================================
-- SETUP CADÊNCIA DE RECUPERAÇÃO - FechouPro CRM
-- Execute este SQL no Supabase SQL Editor
-- =====================================================

-- 1. Tabela de fila de mensagens de recuperação
CREATE TABLE IF NOT EXISTS cadencia_queue (
  id BIGSERIAL PRIMARY KEY,
  cliente_subdominio TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  lead_nome TEXT,
  numero TEXT NOT NULL,
  step_num INTEGER DEFAULT 0,
  titulo TEXT,
  mensagem TEXT NOT NULL,
  enviar_em TIMESTAMPTZ NOT NULL,
  enviado BOOLEAN DEFAULT FALSE,
  enviado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Índice para busca rápida de msgs pendentes
CREATE INDEX IF NOT EXISTS idx_cadencia_pendentes
  ON cadencia_queue (enviado, enviar_em)
  WHERE enviado = FALSE;

CREATE INDEX IF NOT EXISTS idx_cadencia_cliente
  ON cadencia_queue (cliente_subdominio, lead_id);

-- 2. Tabela de configurações por cliente (Evolution API, etc)
CREATE TABLE IF NOT EXISTS config_cliente (
  id BIGSERIAL PRIMARY KEY,
  cliente_subdominio TEXT NOT NULL,
  chave TEXT NOT NULL,
  valor TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(cliente_subdominio, chave)
);

-- 3. Habilitar extensões necessárias
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- 4. Agendar Edge Function para rodar a cada minuto
-- IMPORTANTE: Substitua a URL do seu projeto Supabase abaixo
-- Formato: https://SEU-PROJECT-ID.supabase.co/functions/v1/processar-cadencia
SELECT cron.schedule(
  'processar-cadencia',
  '* * * * *',  -- a cada minuto
  $$
  SELECT net.http_post(
    url := 'https://udtoojqdjcbxnvevazum.supabase.co/functions/v1/processar-cadencia',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkdG9vanFkamNieG52ZXZhenVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NjM3NzQsImV4cCI6MjA4OTUzOTc3NH0.-HENtNoiH3yiEMxWIZeVrcB20BOOzoTw6oJsuvanBtM'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- 5. Verificar se o cron foi criado
SELECT * FROM cron.job WHERE jobname = 'processar-cadencia';
