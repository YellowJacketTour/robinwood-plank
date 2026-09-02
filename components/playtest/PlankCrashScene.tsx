"use client";

import { Billboard, Sparkles, useTexture } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useReducedMotion } from "motion/react";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { flightViewport, multiplierBpsAtMs, sampleFlightPath, type RoundClockView } from "@/lib/playtest-live-shared";

export type PlankCrashSceneProps = {
  /** Authoritative presentation clock (see lib/playtest-live-shared). */
  clock: RoundClockView;
  /** performance.now() at which `clock` was computed, for smooth interpolation. */
  clockAtPerfMs: number;
  crashMultiplier: number | null;
  className?: string;
};

/* Exact DESIGN.md tokens. WebGL materials cannot resolve CSS custom properties. */
const PALETTE = {
  cream: "#fff2cf",
  creamMuted: "#c9b58a",
  gold: "#e9b43f",
  goldSoft: "#f8d98a",
  wood: "#1b120a",
  woodMid: "#3d2513",
  forest: "#123322",
} as const;

/* ── One coordinate system, defined anchors ────────────────────────────────
 * GROUND_Y      world y of the terrain disc.
 * PAD_BASE_Y    center of the pad plinth (fixed to the ground, never moves).
 * PAD_TOP_Y     the pad's top surface: the resting contact plane.
 * VEHICLE_REST_Y vehicle-group origin such that the sprite's feet sit ON the
 *               pad top at T=0 (art-calibrated for Chalkstronaut4.png, whose
 *               painted figure occupies the middle ~55% of the 3.05 plane).
 * Altitude during flight derives ONLY from the shared flight clock. */
const GROUND_Y = -1.68;
const PAD_BASE_Y = GROUND_Y + 0.11; // plinth half-height 0.11 resting on ground
const PAD_TOP_Y = PAD_BASE_Y + 0.11 + 0.12; // plinth top + collar height
const VEHICLE_REST_Y = PAD_TOP_Y + 0.62;
const MAX_ALTITUDE = 2.35;

/** Normalized altitude from the multiplier: log-scaled so early flight
 * visibly lifts off and a 10× flight approaches the top of the scene. */
function altitudeFor(bps: number): number {
  const progress = Math.min(1, Math.log(Math.max(1, bps / 10_000)) / Math.log(10));
  return MAX_ALTITUDE * progress;
}

/** Effective flight elapsed at this animation frame: the prop clock advanced
 * by the frame's own monotonic delta, never rewound. */
function frameFlightMs(clock: RoundClockView, clockAtPerfMs: number, perfNow: number): number | null {
  if (clock.kind === "flight") return clock.flightMs + Math.max(0, perfNow - clockAtPerfMs);
  if (clock.kind === "crashed") return clock.flightMs;
  return null;
}

function LaunchRig({ clock, clockAtPerfMs, reduceMotion }: {
  clock: RoundClockView; clockAtPerfMs: number; reduceMotion: boolean;
}) {
  const vehicle = useRef<THREE.Group>(null);
  const rings = useRef<THREE.Group>(null);
  const flying = clock.kind === "flight";
  const crashed = clock.kind === "crashed";

  useFrame(({ clock: frameClock }, delta) => {
    if (!vehicle.current || !rings.current) return;
    const perfNow = performance.now();
    const flightMs = frameFlightMs(clock, clockAtPerfMs, perfNow);
    // At and before T=0 the vehicle RESTS on the pad: no floating, no motion.
    let y = VEHICLE_REST_Y;
    let tilt = 0;
    if (flightMs !== null) {
      y = VEHICLE_REST_Y + altitudeFor(multiplierBpsAtMs(flightMs));
      if (crashed) { y = Math.max(VEHICLE_REST_Y, y - 0.45); tilt = -0.27; }
      else if (!reduceMotion) tilt = Math.sin(frameClock.elapsedTime * 0.7) * 0.018;
    }
    if (reduceMotion) {
      vehicle.current.position.y = y;
      vehicle.current.rotation.z = tilt;
      return;
    }
    // Damp only within the flight; the rest pose is assigned exactly so a
    // phase change can never ease in from a stale off-pad position.
    if (flightMs === null) {
      vehicle.current.position.y = VEHICLE_REST_Y;
      vehicle.current.rotation.z = THREE.MathUtils.damp(vehicle.current.rotation.z, 0, 6, delta);
    } else {
      vehicle.current.position.y = THREE.MathUtils.damp(vehicle.current.position.y, y, 8, delta);
      vehicle.current.rotation.z = THREE.MathUtils.damp(vehicle.current.rotation.z, tilt, 4, delta);
    }
    rings.current.rotation.z += delta * (flying ? 0.44 : 0.12);
  });

  return (
    <group>
      {/* Guidance rings: fixed scenery around the pad. */}
      <group ref={rings} position={[0, GROUND_Y + 0.5, -0.35]} rotation={[Math.PI / 2, 0, 0]}>
        {[1.35, 1.75, 2.15].map((radius, index) => (
          <mesh key={radius}>
            <torusGeometry args={[radius, 0.025 + index * 0.008, 8, 72]} />
            <meshBasicMaterial color={index === 1 ? PALETTE.goldSoft : PALETTE.gold} transparent opacity={0.35 - index * 0.06} />
          </mesh>
        ))}
      </group>
      {/* Launch pad: FIXED to the ground. The vehicle departs from it. */}
      <group position={[0, 0, -0.12]}>
        <mesh position={[0, PAD_BASE_Y, 0]}>
          <cylinderGeometry args={[0.72, 1.22, 0.22, 8]} />
          <meshStandardMaterial color={PALETTE.woodMid} metalness={0.22} roughness={0.72} />
        </mesh>
        <mesh position={[0, PAD_BASE_Y + 0.11 + 0.06, 0]}>
          <cylinderGeometry args={[0.5, 0.72, 0.12, 8]} />
          <meshStandardMaterial color={PALETTE.gold} emissive={PALETTE.gold} emissiveIntensity={flying ? 0.55 : 0.12} />
        </mesh>
      </group>
      {/* Vehicle: rests on PAD_TOP_Y at T=0; all motion from the flight clock. */}
      <group ref={vehicle} position={[0, VEHICLE_REST_Y, 0]}>
        <Chalkstronaut />
        {flying ? (
          <group position={[0, -0.72, -0.12]}>
            <mesh rotation={[0, 0, Math.PI]}>
              <coneGeometry args={[0.3, 1.1, 20]} />
              <meshBasicMaterial color={PALETTE.goldSoft} transparent opacity={0.7} />
            </mesh>
            <Sparkles count={reduceMotion ? 0 : 28} scale={[0.85, 1.5, 0.5]} position={[0, -0.5, 0]} size={3} speed={0.75} color={PALETTE.gold} />
          </group>
        ) : null}
      </group>
    </group>
  );
}

function Chalkstronaut() {
  const texture = useTexture("/arcade/art/Chalkstronaut4.png");
  const material = useMemo(() => new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    uniforms: { map: { value: texture } },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      varying vec2 vUv;
      void main() {
        vec4 sampleColor = texture2D(map, vUv);
        vec3 cyanMatte = vec3(0.039, 0.647, 0.882);
        float alpha = smoothstep(0.10, 0.24, distance(sampleColor.rgb, cyanMatte)) * sampleColor.a;
        if (alpha < 0.02) discard;
        gl_FragColor = vec4(sampleColor.rgb, alpha);
      }
    `,
  }), [texture]);

  useEffect(() => () => material.dispose(), [material]);

  // No <Float>: pre-launch hover was exactly the "starts above the pad"
  // artifact. The vehicle group owns ALL motion via the flight clock.
  return (
    <Billboard follow lockX={false} lockY={false} lockZ={false}>
      <mesh position={[0, 0.85, 0]} material={material}>
        <planeGeometry args={[3.05, 3.05]} />
      </mesh>
    </Billboard>
  );
}

function Scene({ clock, clockAtPerfMs, reduceMotion }: {
  clock: RoundClockView; clockAtPerfMs: number; reduceMotion: boolean;
}) {
  const starPositions = useMemo(() => {
    const values = new Float32Array(72 * 3);
    // Deterministic field: remounts and replay exports show the same sky.
    for (let index = 0; index < 72; index += 1) {
      const angle = index * 2.399963;
      const radius = 2.8 + (index % 13) * 0.34;
      values[index * 3] = Math.cos(angle) * radius;
      values[index * 3 + 1] = Math.sin(angle * 1.31) * 3.7;
      values[index * 3 + 2] = -1.5 - (index % 9) * 0.32;
    }
    return values;
  }, []);

  return (
    <>
      <ambientLight intensity={1.15} />
      <directionalLight position={[4, 6, 5]} intensity={2.1} color={PALETTE.cream} />
      <pointLight position={[-3, 0, 2]} intensity={clock.kind === "flight" ? 18 : 7} color={PALETTE.gold} distance={10} />
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[starPositions, 3]} />
        </bufferGeometry>
        <pointsMaterial color={PALETTE.cream} size={0.035} transparent opacity={0.72} sizeAttenuation />
      </points>
      <LaunchRig clock={clock} clockAtPerfMs={clockAtPerfMs} reduceMotion={reduceMotion} />
      <mesh position={[0, GROUND_Y, -0.55]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[4.5, 72]} />
        <meshStandardMaterial color={PALETTE.forest} roughness={0.92} />
      </mesh>
    </>
  );
}

/** Live multiplier trace built from the shared M(t) kernel: origin-anchored,
 * continuous, monotone, dynamically scaled (never full-round axes). Redraws
 * from the clock every frame so a resize can never reset or distort it. */
function LiveFlightGraph({ clock, clockAtPerfMs, reduceMotion }: {
  clock: RoundClockView; clockAtPerfMs: number; reduceMotion: boolean;
}) {
  const [framePerfMs, setFramePerfMs] = useState<number | null>(null);
  const raf = useRef(0);
  useEffect(() => {
    if (reduceMotion || clock.kind !== "flight") return;
    const loop = () => { setFramePerfMs(performance.now()); raf.current = requestAnimationFrame(loop); };
    raf.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf.current);
  }, [clock.kind, reduceMotion]);

  // A stale animation frame from an earlier flight can never advance a new
  // clock: it is only trusted when it is not older than the prop clock.
  const effectivePerf = framePerfMs !== null && framePerfMs > clockAtPerfMs ? framePerfMs : clockAtPerfMs;
  const flightMs = frameFlightMs(clock, clockAtPerfMs, effectivePerf);
  if (flightMs === null) return null;
  const currentBps = multiplierBpsAtMs(flightMs);
  const view = flightViewport(flightMs, currentBps);
  const samples = sampleFlightPath(flightMs, 96);
  const W = 320, H = 132, padL = 44, padB = 18, padT = 8, padR = 8;
  const x = (tMs: number) => padL + (tMs / view.tMaxMs) * (W - padL - padR);
  const y = (bps: number) => H - padB - ((bps - 10_000) / (view.bpsMax - 10_000)) * (H - padB - padT);
  const points = samples.map((s) => `${x(s.tMs).toFixed(2)},${y(s.bps).toFixed(2)}`).join(" ");
  const end = samples[samples.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Live multiplier ${(currentBps / 10_000).toFixed(2)} times after ${(flightMs / 1_000).toFixed(1)} seconds`}
      className="pointer-events-none absolute bottom-2 left-2 z-10 h-28 w-[min(60%,20rem)] rounded-lg border border-line bg-panel-strong/80 sm:bottom-4 sm:left-4 sm:h-32"
    >
      {view.ticksBps.map((tick) => (
        <g key={tick}>
          <line x1={padL} x2={W - padR} y1={y(tick)} y2={y(tick)} stroke="#e9b43f2b" strokeWidth="1" />
          <text x={padL - 4} y={y(tick) + 3} textAnchor="end" fontSize="9" fill="#c9b58a" fontFamily="ui-monospace">
            {(tick / 10_000).toFixed(2)}×
          </text>
        </g>
      ))}
      <text x={W - padR} y={H - 5} textAnchor="end" fontSize="9" fill="#c9b58a" fontFamily="ui-monospace">
        0–{(view.tMaxMs / 1_000).toFixed(0)}s
      </text>
      <polyline points={points} fill="none" stroke={clock.kind === "crashed" ? "#fb7185" : "#f8d98a"} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={x(end.tMs)} cy={y(end.bps)} r="3.5" fill={clock.kind === "crashed" ? "#fb7185" : "#34d399"} />
    </svg>
  );
}

export default function PlankCrashScene({
  clock,
  clockAtPerfMs,
  crashMultiplier,
  className = "",
}: PlankCrashSceneProps) {
  const prefersReducedMotion = useReducedMotion();
  const reduceMotion = Boolean(prefersReducedMotion);
  const shownMultiplier = clock.kind === "flight" ? clock.bps / 10_000
    : clock.kind === "crashed" || clock.kind === "intermission" ? crashMultiplier ?? 1
    : 1;
  const status = clock.kind === "crashed" ? "Crash deadline reached"
    : clock.kind === "flight" ? "In flight"
    : clock.kind === "intermission" ? "Round settled"
    : clock.kind === "countdown" ? `Launch in ${clock.displaySeconds}` : "Ready on the launch rail";

  return (
    <div className={`relative isolate min-h-[22rem] overflow-hidden bg-panel-strong sm:min-h-[26rem] ${className}`}>
      <div aria-hidden className="absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,var(--color-forest-800),var(--color-wood-950)_68%)]" />
      <Canvas
        aria-hidden
        className="absolute inset-0"
        camera={{ position: [0, 1.05, 6.8], fov: 43 }}
        dpr={[1, 1.5]}
        frameloop={reduceMotion ? "demand" : "always"}
        gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
      >
        <Suspense fallback={null}>
          <Scene clock={clock} clockAtPerfMs={clockAtPerfMs} reduceMotion={reduceMotion} />
        </Suspense>
      </Canvas>
      <LiveFlightGraph clock={clock} clockAtPerfMs={clockAtPerfMs} reduceMotion={reduceMotion} />
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center px-3 pt-4 text-center sm:pt-7">
        <p className="rounded-full border border-line bg-panel-strong px-3 py-2 text-[11px] font-black uppercase tracking-[.18em] text-gold-300">{status}</p>
        {clock.kind === "countdown" || clock.kind === "intermission" ? (
          <output aria-label={`Next launch in ${clock.displaySeconds} seconds`} className="mt-2 font-mono text-5xl font-black tabular-nums text-cream drop-shadow-lg sm:text-7xl">
            {clock.displaySeconds}
          </output>
        ) : (
          <output aria-label={`Current multiplier ${shownMultiplier.toFixed(2)} times`} className="mt-2 font-mono text-5xl font-black tabular-nums text-cream drop-shadow-lg sm:text-8xl">
            {shownMultiplier.toFixed(2)}×
          </output>
        )}
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-bg-panel-strong to-transparent" />
      <p className="sr-only" aria-live="polite">{status}. Multiplier {shownMultiplier.toFixed(2)} times.</p>
    </div>
  );
}
