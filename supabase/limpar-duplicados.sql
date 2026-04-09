-- =====================================================
-- LIMPAR LEADS DUPLICADOS - FechouPro CRM
-- Execute este SQL no Supabase SQL Editor
-- =====================================================

-- Verificar quantos duplicados existem
SELECT telefone, COUNT(*) as total
FROM leads
WHERE cliente_subdominio = 'mileniofitness-altamira'
GROUP BY telefone
HAVING COUNT(*) > 1
ORDER BY total DESC;

-- Deletar duplicados, mantendo apenas o lead com MAIOR id (mais recente) por telefone
DELETE FROM leads
WHERE id NOT IN (
  SELECT MAX(id)
  FROM leads
  GROUP BY cliente_subdominio, telefone
);
