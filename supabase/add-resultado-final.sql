-- =====================================================
-- CORREÇÕES TABELA leads - FechouPro CRM
-- Execute este SQL no Supabase SQL Editor
-- =====================================================

-- 1. Adicionar coluna created_at (não existia!)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

-- 2. Adicionar coluna resultado_final
ALTER TABLE leads ADD COLUMN IF NOT EXISTS resultado_final TEXT DEFAULT '';

-- 3. Atualizar leads antigos com etapa 'fechado' → 'finalizado'
UPDATE leads SET etapa = 'finalizado', resultado_final = 'venda' WHERE etapa = 'fechado';

-- 4. Atualizar leads antigos com observacao finalizada → 'finalizado'
UPDATE leads SET etapa = 'finalizado', resultado_final = 'nao_venda' WHERE etapa = 'observacao' AND finalizado_em IS NOT NULL;
