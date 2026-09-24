export function createEventStreams(emitter, { limit = 20, heartbeatMs = 30000 } = {}) {
  const clients = new Set();
  let disposed = false;
  return {
    get size() { return clients.size; },
    open(signal) {
      if (disposed || clients.size >= limit) return null;
      const encoder = new TextEncoder();
      let cleanup;
      const stream = new ReadableStream({
        start(controller) {
          let closed = false, heartbeat;
          cleanup = () => {
            if (closed) return;
            closed = true;
            clearInterval(heartbeat);
            emitter.off('update', send);
            signal?.removeEventListener('abort', cleanup);
            clients.delete(cleanup);
            try { controller.close(); } catch {}
          };
          const send = (data) => {
            if (closed) return;
            try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
            catch { cleanup(); }
          };
          clients.add(cleanup);
          emitter.on('update', send);
          heartbeat = setInterval(() => send({ type: 'ping' }), heartbeatMs);
          heartbeat.unref?.();
          signal?.addEventListener('abort', cleanup, { once: true });
          if (signal?.aborted) cleanup();
          else send({ type: 'connected', appId: 'token-tracker-app' });
        },
        cancel() { cleanup?.(); },
      });
      return stream;
    },
    dispose() { disposed = true; for (const close of [...clients]) close(); },
  };
}
