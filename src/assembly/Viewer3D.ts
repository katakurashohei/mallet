import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Model, V3, Plate, sub, dot, cross, norm } from './model';
import { polyNormal } from './scaffold3d';
import type { Step } from './planner';

export const COLORS = {
  // assembly A and plate P in the paper's colours
  placed: 0xfbdeb3,
  scaffold: 0x92ca68,
  current: 0x90c3f1,
  issue: 0xd62728,
  ghost: 0x9a9284,
  arrow: 0x1f4f9e,
};

export interface Frame {
  placed: Set<number>;
  current: number | null;
  step: Step | null;
  t: number; // 0..1 progress of the current insertion
  /** trapezoidal scaffolding carried by the current plate, if it needs one */
  scaffold?: { key: string; polys: V3[][]; tabs: V3[] } | null;
  breakT?: number; // 0..1 progress of breaking the scaffolding off after insertion
  /** which plate the mallet hits; onA: the blow lands on A's receiving plate (P still slides in) */
  strike?: { plate: number; dir: V3; onA: boolean } | null;
  /** joints changed by a fix (drawn green) */
  greenJoints?: Set<number>;
  /** current plate: blue as usual, red when it runs into a problem, green when a fix is applied */
  look?: 'normal' | 'issue' | 'fix';
}

const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);
const ease = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : 1 - Math.pow(1 - t, 3));

interface PlateObj {
  group: THREE.Group;
  mesh: THREE.Mesh;
  mat: THREE.MeshLambertMaterial;
  edges: THREE.LineLoop;
  edgeMat: THREE.LineBasicMaterial;
}

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 1, 5000);
  private controls: OrbitControls;
  private plates: PlateObj[] = [];
  private joints: { mesh: THREE.Line; a: number; b: number }[] = [];
  private arrow: THREE.ArrowHelper;
  private scaf = { key: '', group: new THREE.Group(), fill: new THREE.MeshLambertMaterial({ color: COLORS.scaffold, side: THREE.DoubleSide, transparent: true }), line: new THREE.LineBasicMaterial({ color: 0x000000, transparent: true }) };
  private root = new THREE.Group();
  private model: Model | null = null;
  private center = new THREE.Vector3();
  private raf = 0;
  private ro: ResizeObserver;

  constructor(private el: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    el.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enableZoom = false;
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f70, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(200, -300, 500);
    this.scene.add(sun);
    this.scene.add(this.root);
    this.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, -1), new THREE.Vector3(), 50, COLORS.arrow, 14, 9);
    this.arrow.visible = false;
    this.scene.add(this.arrow);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(el);
    this.resize();
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.raf = requestAnimationFrame(loop);
    };
    loop();
  }

  private resize() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
  }

  setModel(model: Model) {
    this.model = model;
    this.root.clear();
    this.plates = [];
    this.joints = [];
    const box = new THREE.Box3();
    for (const p of model.plates) {
      const obj = makePlate(p);
      this.plates.push(obj);
      this.root.add(obj.group);
      p.poly.forEach((q) => box.expandByPoint(v3(q)));
    }
    for (const j of model.joints) {
      // a joint is only drawn (green) once a fix modifies it, e.g. the sweep
      // carved for a rotary insertion; otherwise the plate outlines show it
      const geo = new THREE.BufferGeometry().setFromPoints([v3(j.e0), v3(j.e1)]);
      // drawn after the (transparent-pass) black outlines that lie on the same edge
      const mesh = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: COLORS.scaffold, transparent: true }));
      mesh.renderOrder = 1;
      mesh.visible = false;
      this.root.add(mesh);
      this.joints.push({ mesh, a: j.a, b: j.b });
    }
    box.getCenter(this.center);
    const r = box.getSize(new THREE.Vector3()).length() / 2;
    this.controls.target.copy(this.center);
    this.camera.position.copy(this.center).add(new THREE.Vector3(1.1, -1.9, 1.15).normalize().multiplyScalar(r * 3.3));
    this.camera.updateProjectionMatrix();
  }

  setFrame(f: Frame) {
    const model = this.model;
    if (!model) return;
    model.plates.forEach((p, i) => {
      const o = this.plates[i];
      o.group.position.set(0, 0, 0);
      o.group.quaternion.identity();
      if (f.placed.has(i)) {
        style(o, COLORS.placed, 1, 1);
      } else if (f.current === i && f.step) {
        const look = f.look ?? 'normal';
        style(o, look === 'issue' ? COLORS.issue : look === 'fix' ? COLORS.scaffold : COLORS.current, 1, 1);
        const u = ease(f.t);
        if (f.step.dir) {
          const d = v3(f.step.dir);
          o.group.position.copy(d.clone().multiplyScalar(-90 * (1 - u)));
        } else if (f.step.rotary && f.step.pivot !== undefined) {
          const j = model.joints[f.step.pivot];
          const axisP = v3(j.e0);
          const axis = v3(j.dir);
          const ang = ((1 - u) * 38 * Math.PI) / 180;
          const sign = swingSign(p, axisP, axis);
          const q = new THREE.Quaternion().setFromAxisAngle(axis, sign * ang);
          // rotate about the line through axisP
          o.group.quaternion.copy(q);
          o.group.position.copy(axisP.clone().sub(axisP.clone().applyQuaternion(q)));
        } else if (f.placed.size === 0) {
          o.group.position.set(0, 0, 40 * (1 - u));
        }
      } else {
        style(o, COLORS.ghost, 0.06, 0.12);
      }
    });
    this.joints.forEach((j, k) => {
      const present = (i: number) => f.placed.has(i) || f.current === i;
      j.mesh.visible = !!f.greenJoints?.has(k) && present(j.a) && present(j.b);
      // follow the assembly when it is the part that moves
      const anchor = f.placed.has(j.a) ? j.a : j.b;
      j.mesh.position.copy(this.plates[anchor].group.position);
    });
    // scaffolding rides along with the plate, then breaks off and falls away
    const sc = f.current !== null && f.scaffold ? f.scaffold : null;
    const brk = f.breakT ?? 0;
    if (sc && brk < 1) {
      if (this.scaf.key !== sc.key) this.buildScaffold(sc);
      const hostId = f.strike?.plate ?? f.current!;
      const host = this.plates[hostId].group;
      if (this.scaf.group.parent !== host) host.add(this.scaf.group);
      // snap off backwards (against the strike) and tip away from the plate's outer face
      const d = v3(f.strike?.dir ?? f.step!.dir ?? [0, 0, -1]);
      const out = v3(model.plates[hostId].n);
      this.scaf.group.position.copy(d.multiplyScalar(-20 * brk)).add(out.multiplyScalar(90 * brk * brk));
      this.scaf.fill.opacity = this.scaf.line.opacity = 1 - brk;
      this.scaf.group.visible = true;
    } else {
      this.scaf.group.removeFromParent();
      this.scaf.group.visible = false;
    }
    // mallet / strike direction (aimed at the scaffolding's target when there is one)
    if (f.current !== null && f.step?.dir && f.t < 0.98) {
      const hostId = f.strike?.plate ?? f.current;
      const p = model.plates[hostId];
      const d = v3(f.strike?.dir ?? f.step.dir);
      // aim at the far edge of the struck plate (or of its scaffolding)
      let best = Infinity;
      for (const q of sc ? sc.polys.flat() : p.poly) best = Math.min(best, v3(q).dot(d));
      const centre = v3(p.c);
      const aim = centre.add(d.clone().multiplyScalar(best - centre.dot(d)));
      aim.add(this.plates[hostId].group.position);
      const start = aim.add(d.clone().multiplyScalar(-60));
      this.arrow.position.copy(start);
      this.arrow.setDirection(d);
      this.arrow.visible = true;
    } else this.arrow.visible = false;
  }

  private buildScaffold(sc: { key: string; polys: V3[][]; tabs: V3[] }) {
    const g = this.scaf.group;
    g.clear();
    for (const poly of sc.polys) {
      if (poly.length < 3) continue;
      const n = polyNormal(poly);
      const u = norm(sub(poly[1], poly[0]));
      const v = cross(n, u);
      const shape = new THREE.Shape(poly.map((q) => new THREE.Vector2(dot(sub(q, poly[0]), u), dot(sub(q, poly[0]), v))));
      const geo = new THREE.ShapeGeometry(shape);
      geo.applyMatrix4(new THREE.Matrix4().makeBasis(v3(u), v3(v), v3(n)).setPosition(v3(poly[0])));
      g.add(new THREE.Mesh(geo, this.scaf.fill));
      g.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(poly.map(v3)), this.scaf.line));
    }
    for (const t of sc.tabs) {
      const dot3 = new THREE.Mesh(new THREE.SphereGeometry(2.2, 8, 6), this.scaf.line);
      dot3.position.copy(v3(t));
      g.add(dot3);
    }
    this.scaf.key = sc.key;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

/** start the swing tilted outwards (along P's outward normal), i.e. outside the solid */
function swingSign(p: Plate, axisP: THREE.Vector3, axis: THREE.Vector3) {
  const c = v3(p.c);
  const out = v3(p.n);
  const q = new THREE.Quaternion().setFromAxisAngle(axis, 0.3);
  const moved = c.clone().sub(axisP).applyQuaternion(q).add(axisP).sub(c);
  return moved.dot(out) > 0 ? 1 : -1;
}

function style(o: PlateObj, color: number, opacity: number, edgeOpacity: number) {
  o.mat.color.setHex(color);
  o.mat.opacity = opacity;
  o.mat.transparent = opacity < 1;
  o.mat.depthWrite = opacity >= 1;
  o.edgeMat.opacity = edgeOpacity;
}

/** a plate is drawn as its flat face (no thickness) with an outline */
function makePlate(p: Plate): PlateObj {
  const u = norm(sub(p.poly[1], p.poly[0]));
  const v = cross(p.n, u);
  const shape = new THREE.Shape(p.poly.map((q) => new THREE.Vector2(dot(sub(q, p.poly[0]), u), dot(sub(q, p.poly[0]), v))));
  const geo = new THREE.ShapeGeometry(shape);
  geo.applyMatrix4(new THREE.Matrix4().makeBasis(v3(u), v3(v), v3(p.n)).setPosition(v3(p.poly[0])));
  const mat = new THREE.MeshLambertMaterial({ color: COLORS.placed, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 1 });
  const outline = new THREE.BufferGeometry().setFromPoints(p.poly.map((q) => v3(q)));
  const edges = new THREE.LineLoop(outline, edgeMat);
  const group = new THREE.Group();
  group.add(mesh, edges);
  return { group, mesh, mat, edges, edgeMat };
}
