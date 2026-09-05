# Realtime channels (subscribe / broadcast / presence)

Read when wiring a client to Realtime or deciding between `postgres_changes`
and broadcast. The SQL/trigger side (Broadcast-from-trigger, RLS on
`realtime.messages`) is in the `supabase-postgres-best-practices` skill.

Three channel modes - different infrastructure, different costs.

```ts
// 1. postgres_changes - listens to DB CDC events (INSERT/UPDATE/DELETE)
//    Cost: counts toward your Realtime "messages" quota PER ROW per subscriber.
//    Requires the table to be in the supabase_realtime publication.
const channel = supabase
  .channel('todos-changes')
  .on('postgres_changes',
    { event: '*', schema: 'public', table: 'todos', filter: `user_id=eq.${userId}` },
    (payload) => {
      console.log(payload.eventType, payload.new, payload.old)
    })
  .subscribe()

// Required (run once): enable the table in the publication
//   ALTER PUBLICATION supabase_realtime ADD TABLE public.todos;
// Required: RLS policy on todos for SELECT - Realtime respects RLS

// 2. broadcast - pub/sub between clients, NO DB involvement
//    Cost: only counts the messages you send.
channel.on('broadcast', { event: 'cursor' }, ({ payload }) => {
  console.log('cursor:', payload.x, payload.y)
})
channel.send({ type: 'broadcast', event: 'cursor', payload: { x: 100, y: 200 } })

// 3. presence - tracks online users in a channel
channel.on('presence', { event: 'sync' }, () => {
  const state = channel.presenceState()  // { userId: [{ presence_ref, ... }] }
})
channel.track({ userId, online_at: new Date().toISOString() })

// Cleanup
supabase.removeChannel(channel)
```

**Auth for Realtime**: pass the user JWT during channel creation so
RLS-protected `postgres_changes` work. Use the publishable key, not the old
`SUPABASE_ANON_KEY` name:

```ts
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  global: { headers: { Authorization: `Bearer ${userJwt}` } },
  realtime: { params: { eventsPerSecond: 10 } },   // client-side throttle
})
```

**Free-tier quota** is small (200 concurrent + 2M messages/month).
`postgres_changes` on a busy table burns through it fast - broadcast is
cheaper if you only need fan-out, not DB CDC.

## CSP gotcha for `wss://`

CSP `connect-src 'self'` blocks the WebSocket to `wss://<ref>.supabase.co`.
Before designing for browser-side Realtime, verify the frontend CSP allows it
(`connect-src 'self' wss://<ref>.supabase.co`).

If CSP is locked to `'self'` (Worker BFF stack), do not install Realtime
triggers - they burn message quota with no subscriber. Two ways to end up with
dead infrastructure:

1. Trigger installed before the frontend subscribes - every insert costs a
   quota message.
2. CSP locked before the Realtime subscriber is added - the subscriber can
   never connect.

Verify the subscriber path end-to-end before shipping the trigger.
