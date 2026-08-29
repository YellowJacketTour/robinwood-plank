"use client";

import { Billboard, Float, Sparkles, useTexture } from "@react-three/drei";
import { Canvas, useFrame } from "@react-three/fiber";
import { useReducedMotion } from "motion/react";
import { Suspense, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

export type PlankCrashSceneProps = {
  phase: "lobby" | "running" | "settled";
  liveMultiplier: number;
  crashMultiplier: number | null;
  deadlinePassed: boolean;
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

function LaunchRig({ phase, reduceMotion }: { phase: PlankCrashSceneProps["phase"]; reduceMotion: boolean }) {
  const rig = useRef<THREE.Group>(null);
  const rings = useRef<THREE.Group>(null);
  const launched = phase === "running";
  const crashed = phase === "settled";

  useFrame(({ clock }, delta) => {
    if (!rig.current || !rings.current || reduceMotion) return;
    const time = clock.elapsedTime;
    const desiredY = launched ? 0.9 + Math.sin(time * 1.8) * 0.09 : crashed ? -0.5 : -0.15;
    rig.current.position.y = THREE.MathUtils.damp(rig.current.position.y, desiredY, 3.8, delta);
    rig.current.rotation.z = THREE.MathUtils.damp(rig.current.rotation.z, crashed ? -0.27 : Math.sin(time * 0.7) * 0.018, 4, delta);
    rings.current.rotation.z += delta * (launched ? 0.44 : 0.12);
  });

  return (
    <group>
      <group ref={rings} position={[0, -1.18, -0.35]} rotation={[Math.PI / 2, 0, 0]}>
        {[1.35, 1.75, 2.15].map((radius, index) => (
          <mesh key={radius}>
            <torusGeometry args={[radius, 0.025 + index * 0.008, 8, 72]} />
            <meshBasicMaterial color={index === 1 ? PALETTE.goldSoft : PALETTE.gold} transparent opacity={0.35 - index * 0.06} />
          </mesh>
        ))}
      </group>
      <group ref={rig} position={[0, -0.15, 0]}>
        <Chalkstronaut reduceMotion={reduceMotion} />
        <mesh position={[0, -1.26, -0.12]}>
          <cylinderGeometry args={[0.72, 1.22, 0.22, 8]} />
          <meshStandardMaterial color={PALETTE.woodMid} metalness={0.22} roughness={0.72} />
        </mesh>
        <mesh position={[0, -1.13, -0.12]}>
          <cylinderGeometry args={[0.5, 0.72, 0.12, 8]} />
          <meshStandardMaterial color={PALETTE.gold} emissive={PALETTE.gold} emissiveIntensity={launched ? 0.55 : 0.12} />
        </mesh>
        {launched ? (
          <group position={[0, -1.42, -0.12]}>
            <mesh rotation={[0, 0, Math.PI]}>
              <coneGeometry args={[0.34, 1.45, 20]} />
              <meshBasicMaterial color={PALETTE.goldSoft} transparent opacity={0.7} />
            </mesh>
            <Sparkles count={reduceMotion ? 0 : 28} scale={[0.85, 1.8, 0.5]} position={[0, -0.65, 0]} size={3} speed={0.75} color={PALETTE.gold} />
          </group>
        ) : null}
      </group>
    </group>
  );
}

function Chalkstronaut({ reduceMotion }: { reduceMotion: boolean }) {
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

  return (
    <Float speed={reduceMotion ? 0 : 1.2} rotationIntensity={reduceMotion ? 0 : 0.035} floatIntensity={reduceMotion ? 0 : 0.15}>
      <Billboard follow lockX={false} lockY={false} lockZ={false}>
        <mesh position={[0, -0.2, 0]} material={material}>
          <planeGeometry args={[3.05, 3.05]} />
        </mesh>
      </Billboard>
    </Float>
  );
}

function Scene({ phase, reduceMotion }: { phase: PlankCrashSceneProps["phase"]; reduceMotion: boolean }) {
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
      <pointLight position={[-3, 0, 2]} intensity={phase === "running" ? 18 : 7} color={PALETTE.gold} distance={10} />
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[starPositions, 3]} />
        </bufferGeometry>
        <pointsMaterial color={PALETTE.cream} size={0.035} transparent opacity={0.72} sizeAttenuation />
      </points>
      <LaunchRig phase={phase} reduceMotion={reduceMotion} />
      <mesh position={[0, -1.68, -0.55]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[4.5, 72]} />
        <meshStandardMaterial color={PALETTE.forest} roughness={0.92} />
      </mesh>
    </>
  );
}

export default function PlankCrashScene({
  phase,
  liveMultiplier,
  crashMultiplier,
  deadlinePassed,
  className = "",
}: PlankCrashSceneProps) {
  const prefersReducedMotion = useReducedMotion();
  const reduceMotion = Boolean(prefersReducedMotion);
  const shownMultiplier = phase === "running" ? liveMultiplier : phase === "settled" ? crashMultiplier ?? 1 : 1;
  const status = deadlinePassed && phase === "running" ? "Crash deadline reached" : phase === "running" ? "In flight" : phase === "settled" ? "Round settled" : "Ready on the launch rail";

  return (
    <div className={`relative isolate min-h-[26rem] overflow-hidden bg-panel-strong ${className}`}>
      <div aria-hidden className="absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,var(--color-forest-800),var(--color-wood-950)_68%)]" />
      <Canvas
        aria-hidden
        className="absolute inset-0"
        camera={{ position: [0, 0.15, 6.8], fov: 43 }}
        dpr={[1, 1.5]}
        frameloop={reduceMotion ? "demand" : "always"}
        gl={{ alpha: true, antialias: true, powerPreference: "high-performance" }}
      >
        <Suspense fallback={null}>
          <Scene phase={phase} reduceMotion={reduceMotion} />
        </Suspense>
      </Canvas>
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center px-3 pt-5 text-center sm:pt-7">
        <p className="rounded-full border border-line bg-panel-strong px-3 py-2 text-[11px] font-black uppercase tracking-[.18em] text-gold-300">{status}</p>
        <output aria-label={`Current multiplier ${shownMultiplier.toFixed(2)} times`} className="mt-2 font-mono text-6xl font-black tabular-nums text-cream drop-shadow-lg sm:text-8xl">
          {shownMultiplier.toFixed(2)}×
        </output>
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-bg-panel-strong to-transparent" />
      <p className="sr-only" aria-live="polite">{status}. Multiplier {shownMultiplier.toFixed(2)} times.</p>
    </div>
  );
}
