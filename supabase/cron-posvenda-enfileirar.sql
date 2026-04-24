-- Agenda cron pra chamar a Edge Function processar-posvenda (enfileirar cashbacks) a cada 10 min
DO $$
BEGIN
  PERFORM cron.unschedule('processar-posvenda-enfileirar');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'processar-posvenda-enfileirar',
  '*/10 * * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://udtoojqdjcbxnvevazum.supabase.co/functions/v1/processar-posvenda',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkdG9vanFkamNieG52ZXZhenVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NjM3NzQsImV4cCI6MjA4OTUzOTc3NH0.-HENtNoiH3yiEMxWIZeVrcB20BOOzoTw6oJsuvanBtM'
      ),
      body := '{}'::jsonb
    );
  $cmd$
);

SELECT jobname, schedule, active FROM cron.job ORDER BY jobname;
