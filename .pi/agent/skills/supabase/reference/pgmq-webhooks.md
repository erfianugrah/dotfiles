# pgmq queues and database webhooks

Read when building background work behind RLS or notifying an external
system from a trigger.

## pgmq

```sql
CREATE EXTENSION IF NOT EXISTS pgmq;

-- Create a queue
SELECT pgmq.create('image_processing');

-- Enqueue
SELECT pgmq.send('image_processing', '{"path": "uploads/abc.jpg", "user_id": "uuid"}');

-- Consume (in a pg_cron job or Edge Function)
SELECT * FROM pgmq.read('image_processing', 30, 5);
-- 30 = visibility timeout (seconds); 5 = max messages to read

-- Acknowledge
SELECT pgmq.delete('image_processing', <msg_id>);

-- Or: archive instead of delete (keeps history)
SELECT pgmq.archive('image_processing', <msg_id>);
```

**RLS via wrapper functions** - `pgmq.send`/`read` run as the queue owner. Do
not expose them directly to PostgREST; wrap:

```sql
CREATE OR REPLACE FUNCTION enqueue_image(p_path text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  msg_id bigint;
BEGIN
  -- RLS-equivalent check
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'unauthenticated'; END IF;
  SELECT pgmq.send('image_processing', jsonb_build_object(
    'path', p_path, 'user_id', auth.uid()
  )) INTO msg_id;
  RETURN msg_id;
END $$;
```

**Worker pattern**: a pg_cron job every minute reads up to N messages, calls
an Edge Function (`pg_net.http_post`), the Edge Function acks via
`pgmq.delete`. A failed Edge Function return leaves the message visible after
the 30s VT - automatic retry.

## Database webhooks

Supabase Database Webhooks send HTTP requests on INSERT/UPDATE/DELETE. Backed
by `pg_net.http_post` from a trigger. Two flavours:

```sql
-- 1. Built-in Webhooks UI (Dashboard -> Database -> Webhooks)
--    Manages the trigger + function for you. Use for simple "notify on insert".

-- 2. Direct pg_net (full control)
CREATE OR REPLACE FUNCTION public.notify_external() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  PERFORM net.http_post(
    url := 'https://example.com/webhook',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Signature', encode(hmac(row_to_json(NEW)::text, 'shared-secret', 'sha256'), 'hex')
    ),
    body := row_to_json(NEW)::jsonb,
    timeout_milliseconds := 5000
  );
  RETURN NEW;
END $$;

CREATE TRIGGER on_new_thing
  AFTER INSERT ON public.things
  FOR EACH ROW EXECUTE FUNCTION public.notify_external();
```

**Caveat**: webhook delivery is fire-and-forget. `pg_net` retries on
connection error but NOT on 5xx. For at-least-once delivery, write to `pgmq`
first and have a consumer call the webhook with its own retry logic.
