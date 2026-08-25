"use client";

import { Canvas, type ThreeEvent, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { EffectComposer, Bloom, Scanline, Vignette } from "@react-three/postprocessing";
import { useMemo, useRef, useState } from "react";
import * as THREE from "three";

type EvidenceSale = { timestamp?: string | null; tokenId?: string | null; tokenName?: string | null; priceAmount?: string | null; priceUsd?: number | null; priceSymbol: string | null; transaction: string | null };

const PALETTE = ["#f4c95d", "#b47cff", "#48d7a4", "#58a6ff", "#ff718b", "#d7d0c7"];

function EvidenceCloud({ sales, active, onActive }: { sales: EvidenceSale[]; active: number | null; onActive: (index: number | null) => void }) {
  const points = useMemo(() => sales.map((sale, sourceIndex) => ({ sale, sourceIndex, time: sale.timestamp ? Date.parse(sale.timestamp) : NaN, usd: sale.priceUsd ?? NaN })).filter((row) => Number.isFinite(row.time) && Number.isFinite(row.usd)), [sales]);
  const currencies = useMemo(() => [...new Set(points.map((row) => row.sale.priceSymbol || "Unknown"))], [points]);
  const geometry = useMemo(() => {
    const times = points.map((row) => row.time);
    const prices = points.map((row) => row.usd);
    const minTime = Math.min(...times), maxTime = Math.max(...times);
    const minPrice = Math.min(...prices), maxPrice = Math.max(...prices);
    const positions = new Float32Array(points.length * 3);
    const colors = new Float32Array(points.length * 3);
    points.forEach((row, index) => {
      positions[index * 3] = ((row.time - minTime) / Math.max(1, maxTime - minTime) - .5) * 12;
      positions[index * 3 + 1] = (Math.log1p(row.usd) - Math.log1p(minPrice)) / Math.max(.0001, Math.log1p(maxPrice) - Math.log1p(minPrice)) * 5 - 2.5;
      positions[index * 3 + 2] = (currencies.indexOf(row.sale.priceSymbol || "Unknown") - (currencies.length - 1) / 2) * 1.4;
      new THREE.Color(PALETTE[currencies.indexOf(row.sale.priceSymbol || "Unknown") % PALETTE.length]).toArray(colors, index * 3);
    });
    const next = new THREE.BufferGeometry();
    next.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    next.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return next;
  }, [points, currencies]);
  const material = useMemo(() => new THREE.PointsMaterial({ size: .16, vertexColors: true, transparent: true, opacity: .94, sizeAttenuation: true }), []);
  const group = useRef<THREE.Group>(null);
  useFrame((state) => { if (group.current) group.current.position.y = Math.sin(state.clock.elapsedTime * .35) * .04; });
  return <group ref={group}>
    <points geometry={geometry} material={material} onPointerMove={(event: ThreeEvent<PointerEvent>) => { event.stopPropagation(); onActive(event.index ?? null); }} onPointerOut={() => onActive(null)} />
    {active != null && geometry.attributes.position && <mesh position={new THREE.Vector3().fromBufferAttribute(geometry.attributes.position as THREE.BufferAttribute, active)}><sphereGeometry args={[.25, 20, 20]}/><meshBasicMaterial color="#ffffff" transparent opacity={.42}/></mesh>}
  </group>;
}

export default function CollectionEvidenceSpace({ sales }: { sales: EvidenceSale[] }) {
  const [active, setActive] = useState<number | null>(null);
  const rows = useMemo(() => sales.map((sale) => ({ sale, time: sale.timestamp ? Date.parse(sale.timestamp) : NaN, usd: sale.priceUsd ?? NaN })).filter((row) => Number.isFinite(row.time) && Number.isFinite(row.usd)), [sales]);
  const selected = active == null ? null : rows[active]?.sale;
  if (!rows.length) return <div className="grid min-h-72 place-items-center rounded-xl border border-dashed border-line bg-background/55 p-6 text-center text-xs text-foreground/45">Spatial evidence requires timestamped, USD-valued observations. No points are invented when valuation or time is missing.</div>;
  return <article className="relative overflow-hidden rounded-xl border border-purple-400/35 bg-[#07050d]" aria-label="Interactive spatial market evidence">
    <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-sm"><p className="text-[0.58rem] font-black uppercase tracking-[0.18em] text-purple-300">Evidence space</p><h4 className="font-display text-lg text-gold-300">Time × value × currency</h4><p className="text-[0.65rem] text-foreground/55">Drag to orbit · wheel or pinch to zoom · hover any point for its exact record.</p></div>
    <div className="h-[26rem] max-h-[62vh] min-h-72 w-full"><Canvas dpr={[1, 1.75]} camera={{ position: [7, 4.5, 10], fov: 45 }} gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }} frameloop="demand"><color attach="background" args={["#07050d"]}/><ambientLight intensity={.5}/><gridHelper args={[16, 16, "#5f407d", "#1c1428"]} position={[0, -2.8, 0]}/><EvidenceCloud sales={sales} active={active} onActive={setActive}/><OrbitControls makeDefault enableDamping dampingFactor={.08} minDistance={5} maxDistance={24}/>
      {/* Real HUD glow, not decoration for its own sake: Bloom lifts the
          already-real evidence points and grid lines into a visible glow so
          the scene reads as instrument-panel light instead of a flat plot.
          Scanline+Vignette are the same real, maintained @react-three/
          postprocessing effects (MIT, pmndrs) the HUD research brief cited
          -- low opacity, never obscures a real data point. */}
      <EffectComposer multisampling={0}>
        <Bloom luminanceThreshold={0.15} luminanceSmoothing={0.4} intensity={0.6} mipmapBlur />
        <Scanline density={1.75} opacity={0.06} />
        <Vignette eskil={false} offset={0.25} darkness={0.55} />
      </EffectComposer>
    </Canvas></div>
    <div className="absolute inset-x-3 bottom-3 z-10 rounded-lg border border-line bg-background/90 p-2 backdrop-blur-md"><p className="text-[0.6rem] font-black uppercase tracking-wider text-foreground/45">{selected ? "Exact observed event" : `${rows.length.toLocaleString()} evidence points`}</p>{selected ? <p className="truncate text-xs"><strong className="text-gold-300">${selected.priceUsd?.toLocaleString(undefined, { maximumFractionDigits: 2 })}</strong> · {selected.priceAmount} {selected.priceSymbol} · {selected.timestamp ? new Date(selected.timestamp).toLocaleString() : "time unavailable"} · {selected.tokenName || (selected.tokenId ? `#${selected.tokenId}` : "collection sale")} · {selected.transaction}</p> : <p className="text-xs text-foreground/55">Horizontal: chronology · vertical: logarithmic USD value · depth: payment currency. This is evidence geometry, not simulated scenery.</p>}</div>
  </article>;
}
