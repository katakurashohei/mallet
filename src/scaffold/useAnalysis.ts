import { useEffect, useRef, useState } from 'react';
import type { Analysis, Params, PlateSpec } from './analyze';

interface State {
  result: Analysis | null;
  forSpec: PlateSpec | null;
  busy: boolean;
  error: string | null;
}

/** runs `analyze` in a worker; while one solve is in flight only the latest request is queued */
export function useAnalysis(spec: PlateSpec, params: Params): State {
  const [state, setState] = useState<State>({ result: null, forSpec: null, busy: true, error: null });
  const worker = useRef<Worker | null>(null);
  const inFlight = useRef<{ id: number; spec: PlateSpec } | null>(null);
  const pending = useRef<{ id: number; spec: PlateSpec; params: Params } | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const w = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.current = w;
    w.onmessage = (e: MessageEvent<{ id: number; result?: Analysis; error?: string }>) => {
      const done = inFlight.current;
      inFlight.current = null;
      const next = pending.current;
      if (next) {
        pending.current = null;
        inFlight.current = { id: next.id, spec: next.spec };
        w.postMessage(next);
      }
      if (!done || done.id !== e.data.id) return;
      setState({
        result: e.data.result ?? null,
        forSpec: done.spec,
        busy: !!next,
        error: e.data.error ?? null,
      });
    };
    return () => w.terminate();
  }, []);

  useEffect(() => {
    const id = ++seq.current;
    setState((s) => ({ ...s, busy: true }));
    const t = setTimeout(() => {
      const w = worker.current;
      if (!w) return;
      const req = { id, spec, params };
      if (inFlight.current) pending.current = req;
      else {
        inFlight.current = { id, spec };
        w.postMessage(req);
      }
    }, 90);
    return () => clearTimeout(t);
  }, [spec, params]);

  return state;
}
