-- =====================================================
-- ADICIONAR COLUNA resultado_final NA TABELA leads
-- FechouPro CRM
--
-- Execute este SQL no Supabase SQL Editor
-- =====================================================

-- Adicionar coluna resultado_final para distinguir venda de não-venda
ALTER TABLE leads ADD COLUMN IF NOT EXISTS resultado_final TEXT DEFAULT '';

-- Atualizar leads existentes que já tinham etapa 'fechado' para 'finalizado' com resultado_final='venda'
UPDATE leads SET etapa = 'finalizado', resultado_final = 'venda' WHERE etapa = 'fechado';

-- Atualizar leads existentes que tinham observacao com finalizado_em para 'finalizado' com resultado_final='nao_venda'
UPDATE leads SET etapa = 'finalizado', resultado_final = 'nao_venda' WHERE etapa = 'observacao' AND finalizado_em IS NOT NULL;
