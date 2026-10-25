import { useEffect, useMemo, useRef, useState } from 'react';
import { PLATE_PRESETS } from './presets';
import { DEFAULT_PARAMS, MAX_BLOW, Params, PlateSpec, Stage, pinSpans, StressField, Analysis } from './analyze';
import { Pt, bbox, multiToPath, ringToPath, union, rect, MultiPoly } from './geom';
import { useAnalysis } from './useAnalysis';

type View = 'original' | 'scaffold';

const clone = (s: PlateSpec): PlateSpec => JSON.parse(JSON.stringify(s));

export default function ScaffoldLab({ presetId, onPreset }: { presetId: string; onPreset: (id: string) => void }) {
  const preset = PLATE_PRESETS.find((p) => p.id === presetId) ?? PLATE_PRESETS[0];
  const [spec, setSpec] = useState<PlateSpec>(() => clone(preset));
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [view, setView] = useState<View>('original');
  const [showStress, setShowStress] = useState(true);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    setSpec(clone(preset));
    setView('original');
  }, [preset]);

  const { result, forSpec, busy, error } = useAnalysis(spec, params);
  const fresh = result && forSpec && forSpec.id === spec.id ? result : null;
  const stage: Stage | null = fresh ? (view === 'scaffold' && fresh.scaffold ? fresh.scaffold.stage : fresh.base) : null;
  const scaffold = fresh?.scaffold ?? null;

  useEffect(() => setHover(null), [spec, view, params]);
  useEffect(() => {
    if (view === 'scaffold' && fresh && !fresh.scaffold) setView('original');
  }, [fresh, view]);

  // the plate is drawn resting on A with its pins just entering the slots
  const dy = params.T * 0.85;

  // ---- geometry for drawing ----
  const pinX = pinSpans(spec.L, spec.pins);
  const plateMP = useMemo(() => {
    try {
      const outline: MultiPoly = [[spec.outline]];
      return union(outline, ...pinX.map(([a, b]) => rect(a, -params.T, b, 0.01)));
    } catch {
      return [] as MultiPoly;
    }
  }, [spec, params.T]); // eslint-disable-line react-hooks/exhaustive-deps

  const view0 = useMemo(() => {
    const boxes: MultiPoly = [[spec.outline]];
    const [x0, , x1, y1] = bbox(scaffold ? union(boxes, scaffold.pieces) : boxes);
    const minX = Math.min(x0, -18), maxX = Math.max(x1, spec.L + 18);
    const top = y1 + 46;
    const bottom = -params.T - 26 - 6;
    return { x: minX - 14, y: -top, w: maxX - minX + 28, h: top - bottom };
  }, [spec, scaffold, params.T]);

  // ---- editing ----
  const svgRef = useRef<SVGSVGElement>(null);
  // screen px per drawing unit, so labels can be sized like the page text
  const [scale, setScale] = useState(2);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const measure = () => {
      const r = svg.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) setScale(Math.min(r.width / view0.w, r.height / view0.h));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(svg);
    return () => ro.disconnect();
  }, [view0.w, view0.h]);
  const u = (px: number) => px / scale;
  const drag = useRef<{ kind: 'o' | 'h'; hole: number; i: number } | null>(null);
  const toWorld = (e: React.PointerEvent | React.MouseEvent): Pt => {
    const svg = svgRef.current!;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    return [Math.round(p.x), Math.round(-p.y)];
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    let [x, y] = toWorld(e);
    setSpec((s) => {
      const n = clone(s);
      if (d.kind === 'o') {
        if (d.i === 1) {
          x = Math.max(30, Math.min(400, x));
          n.outline[1] = [x, 0];
          n.L = x;
        } else n.outline[d.i] = [x, Math.max(2, y)];
      } else {
        n.holes[d.hole][d.i] = [x, Math.max(2, y)];
      }
      return n;
    });
  };
  const editable = view === 'original';
  const insertVertex = (i: number, e: React.MouseEvent) => {
    const p = toWorld(e);
    setSpec((s) => {
      const n = clone(s);
      n.outline.splice(i + 1, 0, [p[0], Math.max(2, p[1])]);
      return n;
    });
  };
  const deleteVertex = (i: number) => {
    if (i < 2 || spec.outline.length <= 3) return;
    setSpec((s) => {
      const n = clone(s);
      n.outline.splice(i, 1);
      return n;
    });
  };

  const heat = useHeatmap(stage?.field ?? null, params.sigmaAllow);
  const best = stage && stage.strike.targets.length ? stage.targets[stage.strike.targets[0]] : null;
  const shown = hover !== null && stage ? stage.targets[hover] : null;
  const barsFor: { r: number[]; label: string } | null = stage
    ? shown
      ? { r: shown.r, label: 'hovered target' }
      : best
        ? { r: barsForStrike(stage), label: view === 'scaffold' ? 'scaffolding targets' : 'best target' }
        : null
    : null;

  const showScaffold = view === 'scaffold' && scaffold;

  return (
    <div className="demo1">
      <div className="card stage-wrap">
        <div className="stage-top">
          <div className="pick">
            <label htmlFor="plate-model">Model:</label>
            <select id="plate-model" value={preset.id} onChange={(e) => onPreset(e.target.value)}>
              {PLATE_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button className="btn sm" onClick={() => setSpec(clone(preset))}>Reset shape</button>
          </div>
        </div>
        <div className="viz">
          <label className="check viz-top" title={fresh && !scaffold ? 'No scaffolding needed for this plate' : ''}>
            <input
              type="checkbox"
              checked={view === 'scaffold'}
              disabled={!scaffold}
              onChange={(e) => setView(e.target.checked ? 'scaffold' : 'original')}
            />
            With scaffolding
          </label>
          {busy && <div className="busy"><span className="spin" />FEA</div>}
        <svg
          ref={svgRef}
          className="stage"
          viewBox={`${view0.x} ${view0.y} ${view0.w} ${view0.h}`}
          style={{ height: 400 }}
          onPointerMove={onMove}
          onPointerUp={() => (drag.current = null)}
          onPointerLeave={() => (drag.current = null)}
        >
          <defs>
            <pattern id="knurl" width="3" height="3" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="1.2" height="3" fill="var(--scaffold-ink)" opacity="0.5" />
            </pattern>
          </defs>
          <g transform="scale(1,-1)">
            <AssemblyBlock L={spec.L} T={params.T} pinX={pinX} u={u} />
            <g transform={`translate(0,${dy})`}>
              {heat && showStress ? (
                <>
                  <clipPath id="plateclip">
                    <path d={multiToPath(stage!.solid)} clipRule="evenodd" />
                  </clipPath>
                  <path d={multiToPath(plateMP)} fill="var(--plate)" opacity={0.25} />
                  <image
                    href={heat.url}
                    x={heat.x}
                    y={heat.y}
                    width={heat.w}
                    height={heat.h}
                    preserveAspectRatio="none"
                    style={{ imageRendering: 'pixelated' }}
                    clipPath="url(#plateclip)"
                  />
                </>
              ) : null}
              <path
                d={multiToPath(plateMP) + spec.holes.map((h) => ringToPath(h)).join('')}
                fill={heat && showStress ? 'none' : 'var(--plate)'}
                fillRule="evenodd"
                fillOpacity={1}
                stroke="#000"
                strokeWidth={1} vectorEffect="non-scaling-stroke"
              />
              {showScaffold && (
                <g>
                  <path
                    d={multiToPath(scaffold!.pieces)}
                    fill="var(--scaffold)"
                    fillOpacity={heat && showStress ? 0.55 : 1}
                    fillRule="evenodd"
                    stroke="#000"
                    strokeWidth={1} vectorEffect="non-scaling-stroke"
                  />
                  {scaffold!.trapezoids.map((t, i) => (
                    <g key={i}>
                      <path d={ringToPath(t)} fill="none" stroke="#000" strokeDasharray="3 3" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                      <rect x={t[3][0]} y={t[3][1] - 2.5} width={t[2][0] - t[3][0]} height={2.5} fill="url(#knurl)" />
                    </g>
                  ))}
                  {scaffold!.tabs.map((p, i) => (
                    <circle key={i} cx={p[0]} cy={p[1]} r={1.6} fill="var(--ink)" />
                  ))}
                </g>
              )}
              {stage && (
                <Targets
                  stage={stage}
                  hover={hover}
                  setHover={setHover}
                  effMin={params.effMin}
                  scaffoldView={view === 'scaffold'}
                  u={u}
                />
              )}
              {editable && (
                <g>
                  {spec.outline.map((p, i) => {
                    const q = spec.outline[(i + 1) % spec.outline.length];
                    if (i === 0) return null;
                    return (
                      <line
                        key={'e' + i}
                        x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]}
                        stroke="transparent" strokeWidth={5}
                        style={{ cursor: 'copy' }}
                        onDoubleClick={(e) => insertVertex(i, e)}
                      />
                    );
                  })}
                  {spec.outline.map((p, i) =>
                    i === 0 ? null : (
                      <circle
                        key={'v' + i}
                        cx={p[0]} cy={p[1]} r={i === 1 ? 3 : 2.6}
                        fill="var(--panel)" stroke="#000" strokeWidth={1} vectorEffect="non-scaling-stroke"
                        style={{ cursor: i === 1 ? 'ew-resize' : 'grab' }}
                        onPointerDown={(e) => {
                          (e.target as Element).setPointerCapture?.(e.pointerId);
                          drag.current = { kind: 'o', hole: -1, i };
                        }}
                        onDoubleClick={() => deleteVertex(i)}
                      />
                    ),
                  )}
                  {spec.holes.map((h, hi) =>
                    h.map((p, i) => (
                      <circle
                        key={`h${hi}-${i}`}
                        cx={p[0]} cy={p[1]} r={1.8}
                        fill="var(--panel)" stroke="#000" strokeWidth={1} vectorEffect="non-scaling-stroke"
                        style={{ cursor: 'grab' }}
                        onPointerDown={(e) => {
                          (e.target as Element).setPointerCapture?.(e.pointerId);
                          drag.current = { kind: 'h', hole: hi, i };
                        }}
                      />
                    )),
                  )}
                </g>
              )}
            </g>
            {barsFor && <PinShares pinX={pinX} r={barsFor.r} T={params.T} effMin={params.effMin} u={u} />}
          </g>
        </svg>
        {barsFor && <div className="viz-caption">Under each pin: its share of the impact ({barsFor.label}; 100% = fair share)</div>}
        </div>
        <Verdict stage={stage} fresh={fresh} view={view} spec={spec} error={error} />
        <details className="details">
          <summary>Details: algorithm steps, numbers and parameters</summary>
          <Readout stage={stage} fresh={fresh} view={view} params={params} setParams={setParams} spec={spec} setSpec={setSpec} error={error} showStress={showStress} setShowStress={setShowStress} />
        </details>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function barsForStrike(stage: Stage): number[] {
  // each pin's share from the target responsible for it, scaled so that
  // PinBars (which multiplies by n) shows 100% for a fair share within the group
  const s = stage.strike;
  const n = stage.targets[s.targets[0]].r.length;
  const out = new Array(n).fill(0);
  s.targets.forEach((ti, j) => {
    for (const i of s.groups[j]) out[i] = (stage.targets[ti].r[i] * s.groups[j].length) / n;
  });
  return out;
}

function AssemblyBlock({ L, T, pinX, u }: { L: number; T: number; pinX: [number, number][]; u: (px: number) => number }) {
  const x0 = -16, x1 = L + 16, y0 = -T - 26;
  let d = `M${x0},${y0}L${x1},${y0}L${x1},0`;
  for (let k = pinX.length - 1; k >= 0; k--) {
    const [a, b] = pinX[k];
    d += `L${b},0L${b},${-T}L${a},${-T}L${a},0`;
  }
  d += `L${x0},0Z`;
  return (
    <g>
      <path d={d} fill="var(--assembly)" stroke="#000" strokeWidth={1} vectorEffect="non-scaling-stroke" />
      <text transform="scale(1,-1)" x={x1 - 3} y={T + 14} fontSize={u(13.33)} textAnchor="end" fill="var(--assembly-ink)" fontWeight={700}>A</text>
    </g>
  );
}

/** a soft dark outline behind the green pin numbers, so they stay readable on A */
const halo = (u: (px: number) => number) => ({
  stroke: 'rgba(0, 0, 0, 0.45)',
  strokeWidth: u(2.5),
  strokeLinejoin: 'round' as const,
  paintOrder: 'stroke',
});

/** each pin's share of the impact, written under the pin inside A (100% = fair share) */
function PinShares({ pinX, r, T, effMin, u }: { pinX: [number, number][]; r: number[]; T: number; effMin: number; u: (px: number) => number }) {
  const n = pinX.length;
  return (
    <g>
      {pinX.map(([a, b], i) => {
        const v = r[i] * n;
        return (
          <text
            key={i}
            transform="scale(1,-1)"
            x={(a + b) / 2}
            y={T + u(17)}
            fontSize={u(11)}
            fontWeight={700}
            textAnchor="middle"
            fill={v >= effMin ? 'var(--ok)' : 'var(--bad)'}
            {...(v >= effMin ? halo(u) : {})}
          >
            {Math.round(Math.max(0, v) * 100)}%
          </text>
        );
      })}
    </g>
  );
}

function Targets({
  stage, hover, setHover, effMin, scaffoldView, u,
}: { stage: Stage; hover: number | null; setHover: (i: number | null) => void; effMin: number; scaffoldView: boolean; u: (px: number) => number }) {
  const struck = new Set(stage.strike.targets);
  return (
    <g>
      {stage.targets.map((t, i) => {
        const isBest = struck.has(i);
        if (!t.reachable && !isBest) return null;
        const col = t.eff >= effMin ? 'var(--ok)' : t.eff > 0.2 ? 'var(--warn)' : 'var(--bad)';
        const L = isBest ? 18 : 11;
        const tail: Pt = [t.p[0] - t.d[0] * (L + 2), t.p[1] - t.d[1] * (L + 2)];
        const tip: Pt = [t.p[0] - t.d[0] * 2, t.p[1] - t.d[1] * 2];
        const nx = -t.d[1], ny = t.d[0];
        const ah = isBest ? 3.4 : 2.4;
        const head = `M${tip[0]},${tip[1]}L${tip[0] - t.d[0] * ah * 1.6 + nx * ah},${tip[1] - t.d[1] * ah * 1.6 + ny * ah}L${tip[0] - t.d[0] * ah * 1.6 - nx * ah},${tip[1] - t.d[1] * ah * 1.6 - ny * ah}Z`;
        const on = hover === i;
        return (
          <g
            key={i}
            onPointerEnter={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            style={{ cursor: 'help' }}
            opacity={hover !== null && !on ? 0.35 : 1}
          >
            <line x1={tail[0]} y1={tail[1]} x2={tip[0]} y2={tip[1]} stroke="transparent" strokeWidth={8} />
            {(isBest || on) && (
              <line x1={t.a[0]} y1={t.a[1]} x2={t.b[0]} y2={t.b[1]} stroke={col} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            )}
            <line x1={tail[0]} y1={tail[1]} x2={tip[0] - t.d[0] * ah} y2={tip[1] - t.d[1] * ah} stroke={col} strokeWidth={1} vectorEffect="non-scaling-stroke" />
            <path d={head} fill={col} />
            {(isBest || on) && (
              <text transform="scale(1,-1)" x={tail[0]} y={-tail[1] - u(4)} fontSize={u(12)} textAnchor="middle" fontWeight={700} fill={col}>
                {scaffoldView || isBest ? (on ? `e=${Math.round(Math.max(0, t.eff) * 100)}%` : 'strike here') : `e=${Math.round(Math.max(0, t.eff) * 100)}%`}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}

// ---------------------------------------------------------------------------

function useHeatmap(field: StressField | null, sigmaAllow: number) {
  return useMemo(() => {
    if (!field || typeof document === 'undefined') return null;
    const { nx, cells, vm } = field;
    let ny = 0;
    for (const c of cells) ny = Math.max(ny, Math.floor(c / nx) + 1);
    const cv = document.createElement('canvas');
    cv.width = nx;
    cv.height = ny;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(nx, ny);
    for (let e = 0; e < cells.length; e++) {
      const c = cells[e];
      const i = c % nx, j = Math.floor(c / nx);
      const [r, g, b] = ramp(vm[e] / sigmaAllow);
      const k = (j * nx + i) * 4;
      img.data[k] = r; img.data[k + 1] = g; img.data[k + 2] = b; img.data[k + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return { url: cv.toDataURL(), x: field.x0, y: field.y0, w: nx * field.h, h: ny * field.h };
  }, [field, sigmaAllow]);
}

const STOPS: [number, [number, number, number]][] = [
  [0, [92, 140, 225]],
  [0.25, [110, 190, 200]],
  [0.55, [245, 215, 95]],
  [1.0, [232, 80, 45]],
  [1.6, [125, 15, 30]],
];
function ramp(t: number): [number, number, number] {
  if (t <= 0) return STOPS[0][1];
  for (let i = 1; i < STOPS.length; i++) {
    if (t <= STOPS[i][0]) {
      const [a, ca] = STOPS[i - 1], [b, cb] = STOPS[i];
      const u = (t - a) / (b - a);
      return [0, 1, 2].map((k) => Math.round(ca[k] + (cb[k] - ca[k]) * u)) as [number, number, number];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

// ---------------------------------------------------------------------------

function Verdict({
  stage, fresh, view, spec, error,
}: { stage: Stage | null; fresh: Analysis | null; view: View; spec: PlateSpec; error: string | null }) {
  if (error) return <div className="verdict bad">Geometry error: {error}</div>;
  if (!stage || !fresh) return <div className="verdict hint">Running FEA&hellip;</div>;
  const s = stage.strike;
  const scaffold = fresh.scaffold;
  return (
      <div className={`verdict ${s.ok ? 'ok' : 'bad'}`}>
        <span>{s.ok ? '✓' : '✗'}</span>
        <div>
          {s.ok
            ? view === 'scaffold' ? 'Assembles reliably with scaffolding' : 'An existing feature works as the target'
            : 'Hammering this plate will fail'}
          <div className="sub">
            {s.ok
              ? `${s.targets.length > 1 ? `${s.targets.length} blows of` : 'One blow of'} ~${s.Freq.toFixed(0)} N drives all ${spec.pins} pins home.`
              : view === 'original' && scaffold
                ? 'Check “With scaffolding” to see the fix.'
                : 'No target passes the check.'}
          </div>
        </div>
      </div>
  );
}

function Readout({
  stage, fresh, view, params, setParams, spec, setSpec, error, showStress, setShowStress,
}: {
  stage: Stage | null;
  fresh: Analysis | null;
  view: View;
  params: Params;
  setParams: (p: Params) => void;
  spec: PlateSpec;
  setSpec: (s: PlateSpec) => void;
  error: string | null;
  showStress: boolean;
  setShowStress: (v: boolean) => void;
}) {
  if (error || !stage || !fresh) return <div className="readout hint">{error ? '' : 'Running FEA\u2026'}</div>;
  const s = stage.strike;
  const reachable = stage.targets.filter((t) => t.reachable).length;
  const scaffold = fresh.scaffold;
  const set = (k: keyof Params, v: number) => setParams({ ...params, [k]: v });
  const fmtF = (f: number) => (f > MAX_BLOW ? `> ${MAX_BLOW} N` : `${f.toFixed(0)} N`);
  return (
    <div className="readout">
      {!s.ok && (
        <div className="fails">
          {s.fails.map((f, i) => (
            <div className="fail" key={i}><span className={`tag c${f.issue}`}>{f.issue}</span><span>{f.text}</span></div>
          ))}
        </div>
      )}

      <div>
        <h4>{view === 'original' ? 'Algorithm, steps 1–5' : 'Scaffolding'}</h4>
        {view === 'original' ? (
          <ol className="steps">
            <li><span className="k">1</span><span>Place <b>{stage.targets.length}</b> candidate targets on the outline; <b>{reachable}</b> can be reached by a mallet.</span></li>
            <li><span className="k">2</span><span>FEA ({stage.cells} cells): the share of each target&rsquo;s impact that reaches each pin. Hover an arrow.</span></li>
            <li><span className="k">3</span><span>Best target: the weakest pin gets <b>{Math.round(Math.max(0, s.eff) * 100)}%</b> of its fair share.</span></li>
            <li><span className="k">4</span><span>Check whether the plate survives the blow needed: <b>{fmtF(s.Freq)}</b>.</span></li>
            <li><span className="k">5</span><span>{s.ok ? <>Passes, <b>no scaffolding needed</b>.</> : <>Fails, so extend P with <b>{scaffold?.k ?? 1} trapezoid{(scaffold?.k ?? 1) > 1 ? 's' : ''}</b>.</>}</span></li>
          </ol>
        ) : (
          <ol className="steps">
            <li><span className="k">a</span><span>Unite P with a trapezoid: a flat {params.scaffoldTop} mm target centred over the joint.</span></li>
            <li><span className="k">b</span><span>Subtract P. The rest is the <b style={{ color: 'var(--scaffold-ink)' }}>scaffolding</b>, holes it touches included.</span></li>
            <li><span className="k">c</span><span>Connect it with {scaffold?.tabs.length ?? 0} break-away tab{scaffold?.tabs.length === 1 ? '' : 's'} (&#9679;).</span></li>
            {scaffold && scaffold.tried.length > 1 && (
              <li><span className="k">d</span><span>Long joint: tried {scaffold.tried.map((t) => `${t.k}× (${Math.round(Math.max(0, t.eff) * 100)}%)`).join(', ')}, kept <b>{scaffold.k}</b>.</span></li>
            )}
          </ol>
        )}
      </div>

      <div>
        <h4>Check</h4>
        <div className="metric">
          <span>Weakest pin share</span><span className={`v ${s.eff >= params.effMin ? 'ok' : 'bad'}`}>{Math.round(Math.max(0, s.eff) * 100)}% <small>/ {Math.round(params.effMin * 100)}%</small></span>
          <span>Blow needed</span><span className={`v ${s.Freq <= MAX_BLOW ? '' : 'bad'}`}>{fmtF(s.Freq)}</span>
          <span>Contact pressure</span><span className={`v ${s.pressure <= params.sigmaCrush ? 'ok' : 'bad'}`}>{s.pressure.toFixed(1)} <small>/ {params.sigmaCrush} MPa</small></span>
          <span>Max body stress</span><span className={`v ${s.sigmaMax <= params.sigmaAllow ? 'ok' : 'bad'}`}>{s.sigmaMax.toFixed(1)} <small>/ {params.sigmaAllow} MPa</small></span>
        </div>
      </div>

      <label className="check">
        <input type="checkbox" checked={showStress} onChange={(e) => setShowStress(e.target.checked)} /> Show stress (von Mises) in the view
      </label>

      <details className="more">
        <summary>Parameters</summary>
        <div className="param">
          <span>Pins in the joint</span><span className="v">{spec.pins}</span>
          <input type="range" min={2} max={14} value={spec.pins} onChange={(e) => setSpec({ ...spec, pins: +e.target.value })} />
          <span>Force to seat one tight pin</span><span className="v">{params.pinForce} N</span>
          <input type="range" min={50} max={400} step={10} value={params.pinForce} onChange={(e) => set('pinForce', +e.target.value)} />
          <span>Plywood strength (body)</span><span className="v">{params.sigmaAllow} MPa</span>
          <input type="range" min={8} max={60} value={params.sigmaAllow} onChange={(e) => set('sigmaAllow', +e.target.value)} />
          <span>Dent threshold (target)</span><span className="v">{params.sigmaCrush} MPa</span>
          <input type="range" min={4} max={40} value={params.sigmaCrush} onChange={(e) => set('sigmaCrush', +e.target.value)} />
          <span>Min. share for the weakest pin</span><span className="v">{Math.round(params.effMin * 100)}%</span>
          <input type="range" min={0.1} max={0.9} step={0.05} value={params.effMin} onChange={(e) => set('effMin', +e.target.value)} />
          <span>Scaffolding target width</span><span className="v">{params.scaffoldTop} mm</span>
          <input type="range" min={10} max={60} value={params.scaffoldTop} onChange={(e) => set('scaffoldTop', +e.target.value)} />
        </div>
        <p className="hint" style={{ marginTop: 8 }}>
          6 mm birch plywood (E = {params.E / 1000} GPa). Plane-stress FEA; the pins are held at their tips. The pin shares
          come from one solve per pin (Maxwell&ndash;Betti reciprocity), so every target is evaluated at once.
        </p>
      </details>
    </div>
  );
}
