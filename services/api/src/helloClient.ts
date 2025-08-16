export interface HelloHealth {
    ok: boolean;
    via: string; // where the response came from (mock or base URL)
  }
  
  export interface HelloClient {
    health(): Promise<HelloHealth>;
  }
  
  /**
   * HELLO_MOCK=1 -> return a mock result (for integration tests)
   * HELLO_URL     -> base URL of the hello service (e.g., http://hello:3001 or http://hello.svc.local:3001)
   */
  export function makeHelloClient(env: NodeJS.ProcessEnv = process.env): HelloClient {
    if (env.HELLO_MOCK === '1') {
      return {
        async health() {
          return { ok: true, via: 'mock' };
        },
      };
    }
  
    const base = env.HELLO_URL ?? 'http://hello.svc.local:3001';
  
    return {
      async health() {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 3_000);
        try {
          const r = await fetch(`${base}/healthz`, { signal: ac.signal });
          if (!r.ok) throw new Error(`health status ${r.status}`);
          return { ok: true, via: base };
        } finally {
          clearTimeout(t);
        }
      },
    };
  }