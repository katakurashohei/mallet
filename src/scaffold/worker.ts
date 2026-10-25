import { analyze, PlateSpec, Params } from './analyze';

self.onmessage = (e: MessageEvent<{ id: number; spec: PlateSpec; params: Params }>) => {
  const { id, spec, params } = e.data;
  try {
    (self as unknown as Worker).postMessage({ id, result: analyze(spec, params) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
