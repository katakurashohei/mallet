import { useEffect, useRef, useState } from 'react';
import type { Analysis } from '../scaffold/analyze';
import { DEFAULT_PARAMS } from '../scaffold/analyze';
import type { Model } from './model';
import type { Step } from './planner';
import { scaffoldJob, toScaffold3D, Scaffold3D, ScaffoldJob } from './scaffold3d';

export interface ScaffoldState {
  /** per step index: the scaffolding result, null if the step gets none, undefined while pending */
  byStep: (Scaffold3D | null | undefined)[];
  keys: (string | null)[];
  /** per step: which plate is struck, in which direction, and whether it belongs to A */
  jobs: (ScaffoldJob | null)[];
  pending: number;
}

/** furniture-scale plates: let the trapezoids rise 25 mm above the plate so the target reads in 3D */
const PARAMS_3D = { ...DEFAULT_PARAMS, margin: 25 };

// results survive model switches and re-renders
const cache = new Map<string, Scaffold3D>();

/** runs demo 01's FEA for every in-plane insertion step, one job at a time in a worker */
export function useScaffolds(model: Model, steps: Step[], enabled: boolean): ScaffoldState {
  const [, bump] = useState(0);
  const kick = useRef<() => void>(() => {});
  const busy = useRef(false);
  const queue = useRef<ScaffoldJob[]>([]);

  const jobs = steps.map((s) => scaffoldJob(model, s));

  useEffect(() => {
    const w = new Worker(new URL('../scaffold/worker.ts', import.meta.url), { type: 'module' });
    busy.current = false; // a (StrictMode) remount starts with an idle worker
    let current: ScaffoldJob | null = null;
    const next = () => {
      current = queue.current.shift() ?? null;
      busy.current = !!current;
      if (current) w.postMessage({ id: 0, spec: current.spec, params: PARAMS_3D });
    };
    w.onmessage = (e: MessageEvent<{ result?: Analysis }>) => {
      if (current && e.data.result) cache.set(current.key, toScaffold3D(current, e.data.result));
      bump((x) => x + 1);
      next();
    };
    kick.current = next;
    return () => w.terminate();
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const want = jobs.filter((j): j is ScaffoldJob => !!j && !cache.has(j.key));
    const seen = new Set<string>();
    queue.current = want.filter((j) => (seen.has(j.key) ? false : (seen.add(j.key), true)));
    if (!busy.current) kick.current();
  }, [enabled, model, steps]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    byStep: jobs.map((j) => (j ? cache.get(j.key) : null)),
    keys: jobs.map((j) => j?.key ?? null),
    jobs,
    pending: jobs.filter((j) => j && !cache.has(j.key)).length,
  };
}
