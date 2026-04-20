-- Setup pg_cron para disparar recuperar-conversa a cada 2 minutos
DO $$
BEGIN
  PERFORM cron.unschedule('recuperar-conversa-db');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'recuperar-conversa-db',
  '*/2 * * * *',
  $cmd$
    SELECT net.http_post(
      url := 'https://udtoojqdjcbxnvevazum.supabase.co/functions/v1/recuperar-conversa',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVkdG9vanFkamNieG52ZXZhenVtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM5NjM3NzQsImV4cCI6MjA4OTUzOTc3NH0.-HENtNoiH3yiEMxWIZeVrcB20BOOzoTw6oJsuvanBtM'
      ),
      body := '{}'::jsonb
    );
  $cmd$
);

SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'recuperar-conversa-db';
