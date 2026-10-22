'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import type { ForceGraphMethods, ForceGraphProps, LinkObject, NodeObject } from 'react-force-graph-2d';
import { forceCollide, forceManyBody, forceRadial, forceSimulation, forceX, forceY } from 'd3-force';
import { Maximize, Minus, Plus, RotateCcw } from 'lucide-react';
import { useSettings } from '@/context/SettingsContext';
import { useTheme, type Theme } from '@/context/ThemeContext';
import WordTooltip from './WordTooltip';
import {
    GROUP_COLORS, RELATION_GROUPS, groupOf,
    type Familiarity, type GraphData, type GraphNode, type RelationGroup,
} from '@/lib/graph-shared';

function GraphLoadingFallback() {
    const t = useTranslations('graph');
    return <div className="flex h-full items-center justify-center text-sm text-neutral-500">{t('loadingGraph')}</div>;
}

// next/dynamic drops the component's generics; re-attach them so callbacks get typed nodes.
type AtlasGraphProps = ForceGraphProps<NodeObject<AtlasNode>, LinkObject<AtlasNode, AtlasLink>> & {
    ref?: React.MutableRefObject<ForceGraphMethods<NodeObject<AtlasNode>, LinkObject<AtlasNode, AtlasLink>> | undefined>;
};
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), {
    ssr: false,
    loading: () => <GraphLoadingFallback />,
}) as unknown as React.ComponentType<AtlasGraphProps>;

interface PanelFissionGraphProps {
    word: string | null;
    onNodeClick?: (word: string) => void;
}

// ---------------------------------------------------------------------------
// Layout model. The API returns an ego network: the centre word, its direct neighbours (L1) and
// their neighbours (L2). Each L1 word belongs to one relation group; groups sit in their own
// sector around the centre, the word family hugs the centre inside a dashed bubble.
// ---------------------------------------------------------------------------

/** Neighbours shown per group before "show all". */
const GROUP_CAP = 10;
/** Second-degree words shown per neighbour. */
const L2_PER_PARENT = 3;
/** When a word is linked to the centre in several ways, the first group in this list wins. */
const GROUP_PRIORITY: RelationGroup[] = ['family', 'antonym', 'synonym', 'near_synonym', 'spelling_similar'];

const RADIUS = { center: 17, l1: 10, l2: 4.5 };
/** Simulation steps used to solve a layout. */
const LAYOUT_TICKS = 120;

// ---------------------------------------------------------------------------
// Motion. One spring drives every transition (words, camera, fades), so everything leaves and lands
// together; the layout is solved before the animation starts, so nothing moves once it has landed.
// ---------------------------------------------------------------------------

/** Critically damped spring, no overshoot (the feel of SwiftUI's default `.smooth`). */
const SPRING_RESPONSE_MS = 550;
const OMEGA = (2 * Math.PI) / SPRING_RESPONSE_MS;
/** By then the spring is within 0.05% of its target; snap to the exact end state. */
const SETTLE_MS = 900;
/** Hover emphasis eases with this time constant (about 95% there after three of them). */
const HOVER_EASE_MS = 60;
/** Screen space kept around the layout for labels and group pills. */
const FRAME_PADDING = 60;

/**
 * Offset from the target and velocity (per ms) of the spring, `ms` after it was released at `offset`
 * moving at `velocity`. Starting from the current velocity is what lets a transition that interrupts
 * another carry on without a jolt.
 */
function springState(offset: number, velocity: number, ms: number): [number, number] {
    if (ms >= SETTLE_MS) return [0, 0];
    const t = Math.max(0, ms);
    const c = velocity + OMEGA * offset;
    const e = Math.exp(-OMEGA * t);
    return [(offset + c * t) * e, (velocity - OMEGA * c * t) * e];
}

/** 0 → 1 along the same spring from rest; drives fades and morphs. */
const spring = (ms: number) => 1 - springState(1, 0, ms)[0];

// With the OS "reduce motion" setting on, transitions jump straight to their end state.
const reducedMotionQuery = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-reduced-motion: reduce)') : undefined;
const reducedMotion = () => reducedMotionQuery?.matches ?? false;

interface Point { x: number; y: number }
interface Camera { x: number; y: number; k: number }

/** A word's role in the graph, which decides its size, colour and label. */
interface Look { level: 0 | 1 | 2; group: RelationGroup | null; placeholder?: boolean }

interface AtlasNode extends GraphNode {
    group: RelationGroup | null;
    parentId?: string;
    /** Order inside its group (L1) or under its parent (L2). */
    rank: number;
    ax: number;
    ay: number;
    /** Distance from the centre the layout keeps this word at. */
    ring?: number;
    /** When the word started growing in (ms); 0 = it was already on screen before. */
    born?: number;
    /** Its role in the previous graph, while it changes into the new one (clicked word → centre). */
    morph?: { from: Look; at: number };
    x?: number;
    y?: number;
    fx?: number;
    fy?: number;
}

/** How a link is drawn. */
interface LinkStyle { group: RelationGroup; level: 1 | 2; pending: boolean }

interface AtlasLink extends LinkStyle {
    source: string | AtlasNode;
    target: string | AtlasNode;
    /** When the link started fading in (ms); 0 = it was already drawn before. */
    born?: number;
    /** Its style in the previous graph, while it changes colour or weight. */
    morph?: { from: LinkStyle; at: number };
}

interface Atlas {
    centerId: string;
    nodes: AtlasNode[];
    links: AtlasLink[];
    totals: Record<RelationGroup, number>;
    /** Where the centre word sits. Graphs are built around the clicked word's current position so the view never jumps. */
    origin: Point;
}

/** A group label ("Synonyms 10/13 +") as it was on screen: centre in graph coordinates, size in screen pixels. */
interface PillShot extends Point { w: number; h: number; alpha: number; text: string; group: RelationGroup }

/** The outgoing graph when the next one arrives: where its words are, so the new graph grows out of them. */
interface Snapshot {
    positions: Map<string, Point>;
    origin: Point;
    pills: PillShot[];
}

const endpointId = (end: string | { id: string }) => (typeof end === 'object' ? end.id : end);
/** Links are matched across graphs by the pair of words they join, whichever way round. */
const pairKey = (l: { source: string | { id: string }; target: string | { id: string } }) => {
    const a = endpointId(l.source), b = endpointId(l.target);
    return a < b ? `${a}|${b}` : `${b}|${a}`;
};

function buildAtlas(data: GraphData, from: Snapshot | null): Atlas | null {
    const center = data.nodes.find((n) => n.level === 0);
    if (!center) return null;
    const origin = from?.positions.get(center.id) ?? from?.origin ?? { x: 0, y: 0 };
    // Words that are already on screen start where they are.
    const carried = (id: string): Partial<AtlasNode> => {
        const p = from?.positions.get(id);
        return p ? { x: p.x, y: p.y } : {};
    };

    const l1Group = new Map<string, RelationGroup>();
    const l2Parent = new Map<string, string>();
    for (const link of data.links) {
        const s = endpointId(link.source as string | { id: string });
        const t = endpointId(link.target as string | { id: string });
        if (s === center.id && t !== center.id) {
            const g = groupOf(link.type);
            const prev = l1Group.get(t);
            if (!prev || GROUP_PRIORITY.indexOf(g) < GROUP_PRIORITY.indexOf(prev)) l1Group.set(t, g);
        } else if (t !== center.id && !l2Parent.has(t)) {
            l2Parent.set(t, s);
        }
    }

    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    const totals = Object.fromEntries(RELATION_GROUPS.map((g) => [g, 0])) as Record<RelationGroup, number>;
    const nodes: AtlasNode[] = [{
        ...center, group: null, rank: 0, ax: origin.x, ay: origin.y, ...carried(center.id),
        x: origin.x, y: origin.y, fx: origin.x, fy: origin.y,
    }];

    // Entries that exist in the dictionary first, then alphabetical.
    const l1 = [...l1Group.entries()]
        .filter(([id]) => byId.has(id))
        .sort(([a], [b]) => Number(!!byId.get(a)!.placeholder) - Number(!!byId.get(b)!.placeholder) || a.localeCompare(b));
    for (const [id, group] of l1) {
        nodes.push({ ...byId.get(id)!, level: 1, group, rank: totals[group]++, ax: 0, ay: 0, ...carried(id) });
    }

    const perParent = new Map<string, number>();
    for (const [id, parentId] of l2Parent) {
        const node = byId.get(id);
        if (!node || l1Group.has(id) || !l1Group.has(parentId)) continue;
        const rank = perParent.get(parentId) ?? 0;
        perParent.set(parentId, rank + 1);
        nodes.push({ ...node, level: 2, group: l1Group.get(parentId)!, parentId, rank, ax: 0, ay: 0, ...carried(id) });
    }

    const known = new Map(nodes.map((n) => [n.id, n]));
    const links: AtlasLink[] = [];
    const seen = new Set<string>();
    for (const link of data.links) {
        const s = endpointId(link.source as string | { id: string });
        const t = endpointId(link.target as string | { id: string });
        if (!known.has(s) || !known.has(t)) continue;
        const level = s === center.id ? 1 : 2;
        const key = `${s}|${t}`;
        if (seen.has(key)) continue;
        seen.add(key);
        links.push({
            // Endpoints as objects, so the first frame of a new graph can draw its links before
            // the layout engine has indexed them.
            source: known.get(s)!,
            target: known.get(t)!,
            group: level === 1 ? l1Group.get(t)! : groupOf(link.type),
            level,
            pending: link.status === 'pending',
        });
    }
    return { centerId: center.id, nodes, links, totals, origin };
}

interface Visibility {
    hidden: Set<RelationGroup>;
    expanded: Set<RelationGroup>;
    secondDegree: boolean;
}

/** Nodes and links on screen, with layout anchors assigned for the visible sectors. */
function visibleGraph(atlas: Atlas, vis: Visibility) {
    const showL1 = (n: AtlasNode) => !vis.hidden.has(n.group!) && (vis.expanded.has(n.group!) || n.rank < GROUP_CAP);
    const l1 = atlas.nodes.filter((n) => n.level === 1 && showL1(n));
    const l1Ids = new Set(l1.map((n) => n.id));
    const l2 = vis.secondDegree
        ? atlas.nodes.filter((n) => n.level === 2 && n.parentId && l1Ids.has(n.parentId) && n.rank < L2_PER_PARENT)
        : [];

    const { x: ox, y: oy } = atlas.origin;
    const family = l1.filter((n) => n.group === 'family');
    const familyRadius = family.length ? Math.max(72, 8 * family.length + 44) : 0;
    family.forEach((n, i) => {
        const a = (i / family.length) * Math.PI * 2 - Math.PI / 2;
        n.ax = ox + Math.cos(a) * familyRadius;
        n.ay = oy + Math.sin(a) * familyRadius;
    });

    // Each relation group owns a sector; its words fan out on an arc (two staggered rows) so a
    // big group spreads sideways instead of piling up toward the centre.
    const sectors = RELATION_GROUPS.filter((g) => g !== 'family' && l1.some((n) => n.group === g));
    const largest = Math.max(1, ...sectors.map((g) => l1.filter((n) => n.group === g).length));
    const sectorRadius = familyRadius + 150 + 4 * largest;
    const span = sectors.length ? (Math.PI * 2) / sectors.length : 0;
    const anchors = new Map<RelationGroup, { x: number; y: number }>();
    sectors.forEach((g, i) => {
        const center = i * span - Math.PI / 3;
        anchors.set(g, { x: ox + Math.cos(center) * sectorRadius, y: oy + Math.sin(center) * sectorRadius });
        const members = l1.filter((n) => n.group === g);
        const step = Math.min(span * 0.8 / Math.max(1, members.length), 0.3);
        members.forEach((n, k) => {
            const a = center + (k - (members.length - 1) / 2) * step;
            const r = sectorRadius + (k % 2) * 44;
            n.ax = ox + Math.cos(a) * r;
            n.ay = oy + Math.sin(a) * r;
        });
    });
    const l1ById = new Map(l1.map((n) => [n.id, n]));
    for (const n of l2) {
        const parent = l1ById.get(n.parentId!)!;
        const a = Math.atan2(parent.ay - oy, parent.ax - ox) + (n.rank - (L2_PER_PARENT - 1) / 2) * 0.12;
        const r = Math.hypot(parent.ax - ox, parent.ay - oy) + 70;
        n.ax = ox + Math.cos(a) * r;
        n.ay = oy + Math.sin(a) * r;
    }

    for (const n of [...l1, ...l2]) {
        n.ring = Math.hypot(n.ax - ox, n.ay - oy);
        // Words appearing for the first time start close to the centre and fan out to their slot.
        if (n.x === undefined) {
            n.x = ox + (n.ax - ox) * 0.18;
            n.y = oy + (n.ay - oy) * 0.18;
        }
    }

    const nodes = [atlas.nodes[0], ...l1, ...l2];
    const ids = new Set(nodes.map((n) => n.id));
    const links = atlas.links.filter((l) => {
        const s = endpointId(l.source), t = endpointId(l.target);
        if (!ids.has(s) || !ids.has(t)) return false;
        // Family membership is shown by the bubble, not by edges.
        return !(l.level === 1 && l.group === 'family');
    });
    return { nodes, links, family, sectors, familyRadius, sectorRadius, anchors, origin: atlas.origin };
}
type View = ReturnType<typeof visibleGraph>;

/** Radius of the word-family bubble around the centre word, from where its members are drawn now. */
function bubbleRadius(view: View): number {
    const { x: ox, y: oy } = view.origin;
    return Math.max(...view.family.map((n) => Math.hypot((n.x ?? n.ax) - ox, (n.y ?? n.ay) - oy))) + RADIUS.l1 + 14;
}

/** The group labels on screen, so they can fade out on the canvas once their elements are gone. */
function pillsOf(toGraph: ((x: number, y: number) => Point) | null, area: HTMLElement | null): PillShot[] {
    const pills: PillShot[] = [];
    if (!toGraph || !area) return pills;
    const box = area.getBoundingClientRect();
    for (const el of area.querySelectorAll<HTMLElement>('[data-pill]')) {
        const alpha = Number(el.style.opacity || 1);
        if (el.style.visibility !== 'visible' || alpha < 0.05) continue;
        const r = el.getBoundingClientRect();
        const c = toGraph(r.left - box.left + r.width / 2, r.top - box.top + r.height / 2);
        pills.push({ ...c, w: r.width, h: r.height, alpha, text: el.textContent ?? '', group: el.dataset.pill as RelationGroup });
    }
    return pills;
}

/** Where the outgoing graph's words are, taken when the next graph arrives. */
function snapshotOf(view: View | null, toGraph: ((x: number, y: number) => Point) | null, area: HTMLElement | null): Snapshot | null {
    if (!view) return null;
    const positions = new Map<string, Point>();
    for (const n of view.nodes) if (n.x !== undefined && n.y !== undefined) positions.set(n.id, { x: n.x, y: n.y });
    return { positions, origin: view.origin, pills: pillsOf(toGraph, area) };
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

const radiusOf = (n: Pick<AtlasNode, 'level'>) => (n.level === 0 ? RADIUS.center : n.level === 1 ? RADIUS.l1 : RADIUS.l2);

/** Room each word needs, label included. */
const collisionRadius = (n: Pick<AtlasNode, 'level' | 'name'>) => {
    if (n.level === 0) return RADIUS.center + 14;
    if (n.level === 2) return RADIUS.l2 + 10;
    return RADIUS.l1 + Math.min(34, n.name.length * 3.2) + 6;
};

/** Runs the layout to rest off-screen, so the animation can land every word exactly where it stays. */
function solveLayout(view: View): Map<string, Point> {
    const { x: ox, y: oy } = view.origin;
    const bodies = view.nodes.map((n) => ({
        id: n.id, level: n.level, name: n.name, ax: n.ax, ay: n.ay, ring: n.ring ?? 0,
        x: n.ax, y: n.ay,
        fx: n.level === 0 ? ox : undefined,
        fy: n.level === 0 ? oy : undefined,
    }));
    type Body = (typeof bodies)[number];
    // Words start on their anchors, which is already close to rest: 120 ticks land where 300 would
    // (within a unit for typical graphs) at a third of the cost of the frame that starts the transition.
    forceSimulation(bodies)
        .alphaDecay(1 - 0.001 ** (1 / LAYOUT_TICKS))
        .force('x', forceX<Body>((b) => b.ax).strength((b) => (b.level === 0 ? 0 : 0.2)))
        .force('y', forceY<Body>((b) => b.ay).strength((b) => (b.level === 0 ? 0 : 0.2)))
        .force('ring', forceRadial<Body>((b) => b.ring, ox, oy).strength((b) => (b.level === 0 ? 0 : 0.18)))
        .force('charge', forceManyBody<Body>().strength(-40).distanceMax(160))
        .force('collide', forceCollide<Body>(collisionRadius).strength(0.9).iterations(2))
        .stop()
        .tick(LAYOUT_TICKS);
    return new Map(bodies.map((b) => [b.id, { x: b.x, y: b.y }]));
}

/** The camera that frames these positions, leaving room for labels and pills. */
function cameraFor(nodes: AtlasNode[], positions: Map<string, Point>, width: number, height: number): Camera {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
        const p = positions.get(n.id);
        if (!p) continue;
        const r = radiusOf(n);
        minX = Math.min(minX, p.x - r);
        maxX = Math.max(maxX, p.x + r);
        minY = Math.min(minY, p.y - r);
        maxY = Math.max(maxY, p.y + r + 14);
    }
    if (minX === Infinity) return { x: 0, y: 0, k: 1 };
    const k = Math.min(1.8, Math.max(0.35, Math.min(
        (width - FRAME_PADDING * 2) / Math.max(1, maxX - minX),
        (height - FRAME_PADDING * 2) / Math.max(1, maxY - minY),
    )));
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, k };
}

/** Where the words come to rest: their targets mid-transition, otherwise where they are now. */
function restingPositions(nodes: AtlasNode[], motion: NodeMotion | null): Map<string, Point> {
    if (motion) return new Map(motion.moves.map((m) => [m.n.id, m.to]));
    return new Map(nodes.filter((n) => n.x !== undefined && n.y !== undefined).map((n) => [n.id, { x: n.x!, y: n.y! }]));
}

/** A word's position and velocity (graph units per ms). */
interface WordState { x: number; y: number; vx: number; vy: number }
interface Move { n: AtlasNode; to: Point; offset: Point; velocity: Point }
interface NodeMotion { start: number; moves: Move[] }
/** The camera rides the same spring; zoom runs on log k, so zooming in and out feel equally fast. */
interface CameraMotion { start: number; to: Camera; offset: Camera; velocity: Camera }

function moveAt(m: Move, ms: number): WordState {
    const [dx, vx] = springState(m.offset.x, m.velocity.x, ms);
    const [dy, vy] = springState(m.offset.y, m.velocity.y, ms);
    return { x: m.to.x + dx, y: m.to.y + dy, vx, vy };
}

/** Puts every word where the spring has it now. True once all have landed, each pinned exactly on its target. */
function stepMotion(motion: NodeMotion, now: number): boolean {
    const ms = now - motion.start;
    for (const m of motion.moves) {
        const s = moveAt(m, ms);
        m.n.fx = m.n.x = s.x;
        m.n.fy = m.n.y = s.y;
    }
    return ms >= SETTLE_MS;
}

/** Where each word of a view is drawn now and how fast it is moving. */
function statesOf(view: View | null, motion: NodeMotion | null, now: number): Map<string, WordState> {
    const states = new Map<string, WordState>();
    for (const n of view?.nodes ?? []) {
        if (n.x !== undefined && n.y !== undefined) states.set(n.id, { x: n.x, y: n.y, vx: 0, vy: 0 });
    }
    if (motion) for (const m of motion.moves) states.set(m.n.id, moveAt(m, now - motion.start));
    return states;
}

/** Sends every word from where it is drawn now, at the speed it already has, toward its solved position. */
function planMoves(nodes: AtlasNode[], targets: Map<string, Point>, from: Map<string, WordState>): Move[] {
    const moves: Move[] = [];
    for (const n of nodes) {
        const to = targets.get(n.id);
        if (!to) continue;
        const s = from.get(n.id) ?? { x: n.x ?? to.x, y: n.y ?? to.y, vx: 0, vy: 0 };
        n.fx = n.x = s.x;
        n.fy = n.y = s.y;
        moves.push({ n, to, offset: { x: s.x - to.x, y: s.y - to.y }, velocity: { x: s.vx, y: s.vy } });
    }
    return moves;
}

function cameraMotion(from: Camera, to: Camera, velocity: Camera, now: number): CameraMotion {
    return { start: now, to, offset: { x: from.x - to.x, y: from.y - to.y, k: Math.log(from.k / to.k) }, velocity };
}

/** The camera at `now`, its velocity, and whether it has landed. */
function cameraAt(c: CameraMotion, now: number): { camera: Camera; velocity: Camera; done: boolean } {
    const ms = now - c.start;
    const [dx, vx] = springState(c.offset.x, c.velocity.x, ms);
    const [dy, vy] = springState(c.offset.y, c.velocity.y, ms);
    const [dk, vk] = springState(c.offset.k, c.velocity.k, ms);
    return { camera: { x: c.to.x + dx, y: c.to.y + dy, k: c.to.k * Math.exp(dk) }, velocity: { x: vx, y: vy, k: vk }, done: ms >= SETTLE_MS };
}

const lookOf = (n: Look): Look => ({ level: n.level, group: n.group, placeholder: !!n.placeholder });
const sameLook = (a: Look, b: Look) => a.level === b.level && a.group === b.group && !!a.placeholder === !!b.placeholder;
const styleOf = (l: LinkStyle): LinkStyle => ({ group: l.group, level: l.level, pending: l.pending });
const sameStyle = (a: LinkStyle, b: LinkStyle) => a.group === b.group && a.level === b.level && a.pending === b.pending;

/**
 * Hands what is on screen over to the next view. Words and links that stay keep their state and, where
 * their role changed, morph into the new one (the clicked word grows into the centre); the rest fade in.
 */
function carryOver(target: View, outgoing: View | null, now: number) {
    const words = new Map(outgoing?.nodes.map((n) => [n.id, n]));
    for (const n of target.nodes) {
        const was = words.get(n.id);
        if (was === n) continue;
        n.born = was ? was.born ?? 0 : now;
        n.morph = was && !sameLook(was, n) ? { from: lookOf(was), at: now } : undefined;
    }
    const links = new Map(outgoing?.links.map((l) => [pairKey(l), l]));
    for (const l of target.links) {
        const was = links.get(pairKey(l));
        if (was === l) continue;
        l.born = was ? was.born ?? 0 : now;
        l.morph = was && !sameStyle(was, l) ? { from: styleOf(was), at: now } : undefined;
    }
}

/** Skips every fade and morph, for reduced motion. */
function markShown(view: View) {
    for (const n of view.nodes) { n.born = 0; n.morph = undefined; }
    for (const l of view.links) { l.born = 0; l.morph = undefined; }
}

/** What the outgoing view shows and the next one does not. It fades out, still gliding where it was heading. */
interface Ghosts {
    at: number;
    nodes: AtlasNode[];
    links: AtlasLink[];
    motion: NodeMotion | null;
    bubble: (Point & { r: number }) | null;
    pills: PillShot[];
}

function ghostsOf(target: View, outgoing: View, motion: NodeMotion | null, pills: PillShot[], now: number): Ghosts {
    const words = new Set(target.nodes.map((n) => n.id));
    const links = new Set(target.links.map(pairKey));
    const keepsBubble = target.family.length > 0 && target.origin === outgoing.origin;
    return {
        at: now,
        nodes: outgoing.nodes.filter((n) => !words.has(n.id) && n.x !== undefined),
        links: outgoing.links.filter((l) => !links.has(pairKey(l))),
        // Only the departing words: the ones that stay may be the very same objects, now moving on a new spring.
        motion: motion && { start: motion.start, moves: motion.moves.filter((m) => !words.has(m.n.id)) },
        bubble: outgoing.family.length && !keepsBubble ? { ...outgoing.origin, r: bubbleRadius(outgoing) } : null,
        pills,
    };
}

/** 0 → 1 as something new fades in, on the same spring as the movement (opacity leads slightly). */
const fadeIn = (born: number | undefined, now: number) => (!born ? 1 : clamp01(spring(now - born) * 1.6));
/** 0 → 1 as a word or link changes into its new role. */
const morphOf = (morph: { at: number } | undefined, now: number) => (morph ? spring(now - morph.at) : 1);

interface Eased { v: number; t: number }

/** Moves a stored value toward `target` with exponential easing, independent of the frame rate. */
function eased(store: Map<string, Eased>, key: string, target: number, now: number): number {
    const e = store.get(key);
    if (!e || reducedMotion()) {
        store.set(key, { v: target, t: now });
        return target;
    }
    if (now > e.t) {
        e.v = target + (e.v - target) * Math.exp(-(now - e.t) / HOVER_EASE_MS);
        e.t = now;
    }
    return e.v;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const PALETTE: Record<Theme, {
    bg: string; ink: string; muted: string; halo: string; edgeAlpha: number; bubbleFill: string;
    /** Progress ring around a node (familiarity); weak words get their own warning colour. */
    ring: string; weakRing: string;
    /** Centre word: highlight, body and rim of its gradient. */
    center: [string, string, string];
    /** Dark theme lets nodes glow; light theme gives them a soft drop shadow instead. */
    glow: boolean;
}> = {
    dark: {
        bg: '#05070d', ink: '#eaf2ff', muted: '#8ca3c4', halo: 'rgba(5,7,13,0.92)', edgeAlpha: 0.45,
        bubbleFill: 'rgba(167,139,250,0.06)', ring: 'rgba(234,242,255,0.9)', weakRing: '#fb7185',
        center: ['#e0f2fe', '#38bdf8', '#075985'], glow: true,
    },
    light: {
        bg: '#f1ede4', ink: '#20302c', muted: '#61706b', halo: 'rgba(241,237,228,0.95)', edgeAlpha: 0.5,
        bubbleFill: 'rgba(139,92,246,0.05)', ring: 'rgba(32,48,44,0.85)', weakRing: '#e11d48',
        center: ['#a7f3d0', '#1b6c53', '#0f3d2e'], glow: false,
    },
};
type Palette = (typeof PALETTE)[Theme];

const FAMILIARITY_ORDER: Array<Familiarity | 'new'> = ['new', 'seen', 'weak', 'learning', 'mastered'];
/** Share of the progress ring drawn for each familiarity level. */
const RING_FRACTION: Record<Familiarity, number> = { seen: 0.25, weak: 1, learning: 0.66, mastered: 1 };

/** Blend two #rrggbb colours; t = 0 gives `hex`, t = 1 gives `other`. */
function mix(hex: string, other: string, t: number): string {
    const a = parseInt(hex.slice(1), 16), b = parseInt(other.slice(1), 16);
    const channel = (shift: number) => {
        const from = (a >> shift) & 255, to = (b >> shift) & 255;
        return Math.round(from + (to - from) * t);
    };
    return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

// Jewels are rendered once per colour into a bitmap; stamping a bitmap is far cheaper than a blurred
// gradient per word per frame, which keeps animations at a steady frame rate.
const SPRITE_RADIUS = 40;
const SPRITE_PAD = 44;
const sprites = new Map<string, HTMLCanvasElement>();

function jewelSprite(stops: [string, string, string], glow: boolean): HTMLCanvasElement {
    const key = `${stops.join()}|${glow}`;
    let sprite = sprites.get(key);
    if (!sprite) {
        const size = (SPRITE_RADIUS + SPRITE_PAD) * 2;
        const c = size / 2;
        sprite = document.createElement('canvas');
        sprite.width = sprite.height = size;
        const ctx = sprite.getContext('2d')!;
        const [highlight, body, rim] = stops;
        if (glow) {
            ctx.shadowColor = body;
            ctx.shadowBlur = 36;
        } else {
            ctx.shadowColor = 'rgba(60, 45, 20, 0.30)';
            ctx.shadowBlur = 12;
            ctx.shadowOffsetY = 4;
        }
        const gradient = ctx.createRadialGradient(c - SPRITE_RADIUS * 0.35, c - SPRITE_RADIUS * 0.4, SPRITE_RADIUS * 0.1, c, c, SPRITE_RADIUS);
        gradient.addColorStop(0, highlight);
        gradient.addColorStop(0.55, body);
        gradient.addColorStop(1, rim);
        ctx.beginPath();
        ctx.arc(c, c, SPRITE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = gradient;
        ctx.fill();
        sprites.set(key, sprite);
    }
    return sprite;
}

/** Solid "jewel" node: a radial gradient in the relation colour, glowing on dark, shadowed on paper. */
function paintJewel(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, stops: [string, string, string], palette: Palette) {
    const sprite = jewelSprite(stops, palette.glow);
    const size = sprite.width * (r / SPRITE_RADIUS);
    ctx.drawImage(sprite, x - size / 2, y - size / 2, size, size);
}

/** The dashed word-family bubble. */
function paintBubble(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, palette: Palette, scale: number) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = palette.bubbleFill;
    ctx.fill();
    ctx.setLineDash([6 / scale, 5 / scale]);
    ctx.lineWidth = 1.2 / scale;
    ctx.strokeStyle = GROUP_COLORS.family;
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha * 0.65;
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.setLineDash([]);
}

/** A group label of the outgoing graph, redrawn on the canvas while it fades out. */
function paintPill(ctx: CanvasRenderingContext2D, pill: PillShot, palette: Palette, scale: number) {
    const w = pill.w / scale, h = pill.h / scale;
    const x = pill.x - w / 2, y = pill.y - h / 2;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, h / 2);
    ctx.fillStyle = palette.bg;
    ctx.fill();
    ctx.lineWidth = 1 / scale;
    ctx.strokeStyle = GROUP_COLORS[pill.group];
    ctx.stroke();
    ctx.fillStyle = GROUP_COLORS[pill.group];
    ctx.font = `600 ${11 / scale}px Geist, "Noto Sans SC", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pill.text, pill.x, pill.y);
}

/** Gradient stops for a relation colour. */
function jewelStops(color: string): [string, string, string] {
    return [mix(color, '#ffffff', 0.55), color, mix(color, '#000000', 0.3)];
}

/** Familiarity as a progress ring: a quarter once seen, two thirds while learning, closed when mastered. */
function paintProgressRing(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, level: Familiarity | undefined, palette: Palette, scale: number) {
    if (!level) return;
    const radius = r + 3.5;
    const color = level === 'weak' ? palette.weakRing : palette.ring;
    const fraction = RING_FRACTION[level];
    ctx.save();
    ctx.lineWidth = (level === 'mastered' ? 2.4 : 2) / scale;
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    if (fraction < 1) {
        ctx.globalAlpha *= 0.22;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha /= 0.22;
    }
    ctx.beginPath();
    ctx.arc(x, y, radius, -Math.PI / 2, -Math.PI / 2 + fraction * Math.PI * 2);
    ctx.stroke();
    ctx.restore();
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** While a role changes, the old look stays opaque until the new one is, so the word never thins out. */
const morphLayers = <T,>(from: T | undefined, to: T, m: number, same: boolean): Array<[T, number]> =>
    !from || same || m >= 1 ? [[to, 1]] : [[from, clamp01(2 * (1 - m))], [to, clamp01(2 * m)]];

/** Radius of a word in this role; `emphasis` (0–1) is how much it is hovered. */
function radiusFor(look: Look, emphasis: number): number {
    if (look.level === 0) return RADIUS.center;
    if (look.level === 1) return RADIUS.l1 * (1 + 0.2 * emphasis);
    return RADIUS.l2 * (1 + 0.4 * emphasis);
}

const hasRing = (look: Look) => look.level === 0 || (look.level === 1 && !look.placeholder);

/** A word's body: a jewel, a dashed hollow circle (no dictionary entry yet) or a small dot (second degree). */
function paintBody(ctx: CanvasRenderingContext2D, look: Look, x: number, y: number, r: number, emphasis: number, palette: Palette, scale: number) {
    if (look.level === 2) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = GROUP_COLORS[look.group!];
        ctx.globalAlpha *= look.placeholder ? 0.35 : 0.7;
        ctx.fill();
    } else if (look.level === 1 && look.placeholder) {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = palette.bg;
        ctx.fill();
        ctx.setLineDash([3 / scale, 3 / scale]);
        ctx.strokeStyle = palette.muted;
        ctx.lineWidth = 1.5 / scale;
        ctx.stroke();
        ctx.setLineDash([]);
    } else {
        const stops = look.level === 0 ? palette.center : jewelStops(GROUP_COLORS[look.group!]);
        paintJewel(ctx, x, y, r * (1 + 0.12 * emphasis), stops, palette);
    }
}

/** Everything that decides how one word is drawn in a frame. */
interface WordPaint {
    x: number;
    y: number;
    look: Look;
    /** Its previous role while `m` runs 0 → 1. */
    from?: Look;
    m: number;
    alpha: number;
    /** 0.6 → 1 while it grows in. */
    grow: number;
    emphasis: number;
    familiarity?: Familiarity;
    ringAlpha: number;
}

function paintWord(ctx: CanvasRenderingContext2D, w: WordPaint, palette: Palette, scale: number) {
    const from = w.from ?? w.look;
    const r = lerp(radiusFor(from, w.emphasis), radiusFor(w.look, w.emphasis), w.m) * w.grow;
    for (const [look, a] of morphLayers(w.from, w.look, w.m, false)) {
        if (a <= 0) continue;
        ctx.save();
        ctx.globalAlpha = w.alpha * a;
        paintBody(ctx, look, w.x, w.y, r, w.emphasis, palette, scale);
        ctx.restore();
    }
    const ring = lerp(Number(hasRing(from)), Number(hasRing(w.look)), w.m) * w.ringAlpha;
    if (ring > 0 && w.familiarity) {
        ctx.save();
        ctx.globalAlpha = w.alpha * ring;
        paintProgressRing(ctx, w.x, w.y, r + lerp(from.level === 0 ? 1.5 : 0, w.look.level === 0 ? 1.5 : 0, w.m), w.familiarity, palette, scale);
        ctx.restore();
    }
}

const LABEL_PX = [14, 12, 10] as const;
const labelGap = (look: Look) => (look.level === 0 ? RADIUS.center + 7 : look.level === 1 ? RADIUS.l1 : RADIUS.l2);
const labelFont = (look: Look, px: number, scale: number) =>
    `${look.level === 0 ? '600 ' : ''}${px / scale}px Geist, "Noto Sans SC", system-ui, sans-serif`;

/** Everything that decides how one word's label is drawn in a frame. */
interface LabelPaint {
    x: number;
    y: number;
    name: string;
    translation?: string;
    look: Look;
    from?: Look;
    m: number;
    alpha: number;
    /** How close it is to the hovered word (0–1); second-degree labels show when it is. */
    near: number;
    /** Zoom-driven visibility of neighbour glosses and second-degree labels. */
    glossAlpha: number;
    outerAlpha: number;
}

function paintLabel(ctx: CanvasRenderingContext2D, l: LabelPaint, palette: Palette, scale: number) {
    const from = l.from ?? l.look;
    const shown = (look: Look) => (look.level === 2 ? Math.max(l.outerAlpha, l.near) : 1);
    const alpha = l.alpha * lerp(shown(from), shown(l.look), l.m);
    if (alpha <= 0.004) return;
    const px = lerp(LABEL_PX[from.level], LABEL_PX[l.look.level], l.m);
    const y = l.y + lerp(labelGap(from), labelGap(l.look), l.m) + 3 / scale;
    const sameText = (from.level === 0) === (l.look.level === 0) && !!from.placeholder === !!l.look.placeholder;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5 / scale;
    ctx.strokeStyle = palette.halo;
    for (const [look, a] of morphLayers(l.from, l.look, l.m, sameText)) {
        if (a <= 0) continue;
        ctx.globalAlpha = alpha * a;
        ctx.font = labelFont(look, px, scale);
        ctx.strokeText(l.name, l.x, y);
        ctx.fillStyle = look.placeholder ? palette.muted : palette.ink;
        ctx.fillText(l.name, l.x, y);
    }
    const glossOf = (look: Look) => (look.level === 0 ? 1 : look.level === 1 ? l.glossAlpha : 0);
    const gloss = lerp(glossOf(from), glossOf(l.look), l.m);
    const text = gloss > 0 ? shortGloss(l.translation) : '';
    if (text) {
        ctx.globalAlpha = alpha * gloss;
        ctx.font = `${10 / scale}px "Noto Sans SC", system-ui, sans-serif`;
        const gy = y + (px + 2) / scale;
        ctx.strokeText(text, l.x, gy);
        ctx.fillStyle = palette.muted;
        ctx.fillText(text, l.x, gy);
    }
    ctx.restore();
}

/** One link; `lit` and `dim` (0–1) are how much it is highlighted or faded by hovering. */
function paintEdge(
    ctx: CanvasRenderingContext2D, a: Point, b: Point, style: LinkStyle, from: LinkStyle | undefined, m: number,
    alpha: number, lit: number, dim: number, palette: Palette, scale: number,
) {
    const base = (s: LinkStyle) => palette.edgeAlpha * (s.level === 2 ? 0.55 : 1);
    const width = (s: LinkStyle) => (s.level === 2 ? 0.8 : 1.3);
    const prev = from ?? style;
    const rest = lerp(base(prev), base(style), m);
    const shown = (rest + (0.95 - rest) * lit + (0.12 - rest) * dim) * alpha;
    if (shown <= 0.004) return;
    ctx.save();
    // Lines are translucent, so a changing colour is blended rather than layered.
    ctx.globalAlpha = shown;
    ctx.strokeStyle = prev.group === style.group ? GROUP_COLORS[style.group] : mix(GROUP_COLORS[prev.group], GROUP_COLORS[style.group], m);
    ctx.lineWidth = lerp(lerp(width(prev), width(style), m), 2, lit) / scale;
    if ((m < 0.5 ? prev : style).pending) ctx.setLineDash([5 / scale, 4 / scale]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.restore();
}

/** Legend swatch: a neutral dot with the same progress ring the graph draws. */
function RingIcon({ level, palette }: { level: Familiarity | 'new'; palette: Palette }) {
    const circumference = 2 * Math.PI * 6;
    const fraction = level === 'new' ? 0 : RING_FRACTION[level];
    const color = level === 'weak' ? palette.weakRing : palette.ring;
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="3.2" fill={palette.muted} />
            {fraction > 0 && fraction < 1 && <circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeOpacity="0.22" strokeWidth="1.6" />}
            {fraction > 0 && (
                <circle
                    cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round"
                    strokeDasharray={`${fraction * circumference} ${circumference}`} transform="rotate(-90 8 8)"
                />
            )}
        </svg>
    );
}

/** Graph responses by word, shared by every panel. Hovering a word warms its entry, so a click can animate at once. */
const graphCache = new Map<string, Promise<GraphData>>();
const GRAPH_CACHE_SIZE = 40;

function loadGraph(word: string): Promise<GraphData> {
    const key = word.toLowerCase();
    let pending = graphCache.get(key);
    if (!pending) {
        pending = fetch(`/api/fission?word=${encodeURIComponent(word)}`).then((res) => {
            if (!res.ok) throw new Error(`fission ${res.status}`);
            return res.json() as Promise<GraphData>;
        });
        pending.catch(() => graphCache.delete(key));
        graphCache.set(key, pending);
        if (graphCache.size > GRAPH_CACHE_SIZE) {
            const oldest = graphCache.keys().next().value;
            if (oldest !== undefined) graphCache.delete(oldest);
        }
    }
    return pending;
}

/** Familiarity for a graph's words, kept briefly so a prefetched graph shows its rings straight away. */
const statesCache = new WeakMap<GraphData, { at: number; states: Promise<Record<string, Familiarity>> }>();
const STATES_TTL_MS = 30_000;

function loadStates(graph: GraphData): Promise<Record<string, Familiarity>> {
    const cached = statesCache.get(graph);
    if (cached && performance.now() - cached.at < STATES_TTL_MS) return cached.states;
    const states = fetch('/api/user/word-states', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ words: graph.nodes.map((n) => n.id) }),
    })
        .then((res) => (res.ok ? res.json() : { states: {} }))
        .then((body: { states?: Record<string, Familiarity> }) => body.states ?? {})
        .catch(() => ({}));
    statesCache.set(graph, { at: performance.now(), states });
    return states;
}

/** Warms everything a word needs before it is clicked. */
function prefetchWord(word: string) {
    loadGraph(word).then(loadStates).catch(() => undefined);
}

/** "vt. 放弃, 抛弃, 遗弃" -> "放弃, 抛弃" */
function shortGloss(translation?: string): string {
    if (!translation) return '';
    const text = translation.replace(/^\s*([a-z]+\.\s*)+/i, '').split(/[;；]/)[0];
    const parts = text.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 2).join(', ');
    return parts.length > 14 ? `${parts.slice(0, 13)}…` : parts;
}

export default function PanelFissionGraph({ word, onNodeClick }: PanelFissionGraphProps) {
    const t = useTranslations('graph');
    const { showHoverTooltip, showGraphTooltip } = useSettings();
    const { theme } = useTheme();
    const palette = PALETTE[theme];

    // The last graph that arrived stays on screen while the next word loads; `from` is the outgoing
    // graph it morphs out of.
    const [fetched, setFetched] = useState<{ word: string; graph: GraphData; from: Snapshot | null } | null>(null);
    /** Familiarity of every word seen so far, so rings stay put when a word moves into the next graph. */
    const [familiarity, setFamiliarity] = useState<Record<string, Familiarity>>({});
    const [expandedByWord, setExpandedByWord] = useState<Record<string, RelationGroup[]>>({});
    const [hidden, setHidden] = useState<Set<RelationGroup>>(new Set());
    const [secondDegree, setSecondDegree] = useState(false);
    const [hovered, setHovered] = useState<AtlasNode | null>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    /** The word just clicked in the graph, pulsing while its neighbourhood loads. */
    const [pending, setPending] = useState<{ word: string; x: number; y: number } | null>(null);
    /** The pulse only shows once a load takes long enough to notice. */
    const [slowWord, setSlowWord] = useState<string | null>(null);

    const containerRef = useRef<HTMLDivElement | null>(null);
    const resizeObserver = useRef<ResizeObserver | null>(null);
    const fgRef = useRef<ForceGraphMethods<NodeObject<AtlasNode>, LinkObject<AtlasNode, AtlasLink>> | undefined>(undefined);
    const tooltipRef = useRef<HTMLDivElement>(null);
    const zoomLabelRef = useRef<HTMLSpanElement>(null);
    const zoomSliderRef = useRef<HTMLInputElement>(null);
    const viewRef = useRef<View | null>(null);
    const sizeRef = useRef(size);
    const motionRef = useRef<NodeMotion | null>(null);
    const cameraRef = useRef<CameraMotion | null>(null);
    /** True while this component moves the camera, to tell its own zoom events from the user's. */
    const cameraDriving = useRef(false);
    /** What the previous view showed that this one does not, fading out. */
    const ghostsRef = useRef<Ghosts | null>(null);
    /** When the family bubble and the group labels of the graph on screen appeared; they fade in from then. */
    const shownAt = useRef({ bubble: -Infinity, pills: -Infinity });
    /** Group labels on screen just before a group was switched off, so they can fade out. */
    const toggledPills = useRef<PillShot[]>([]);
    /** When each word's familiarity first arrived; its ring fades in from then. */
    const ringSince = useRef(new Map<string, number>());
    /** Hover emphasis per word and link, eased instead of switched. */
    const easing = useRef(new Map<string, Eased>());
    /** The word under the pointer, from where words are drawn now. */
    const pointerOver = useRef<AtlasNode | null>(null);
    const pressedAt = useRef<Point | null>(null);

    const data = fetched?.graph ?? null;
    const shownWord = fetched?.word ?? null;
    const loading = !!word && fetched?.word !== word;
    const expanded = useMemo(() => new Set(shownWord ? expandedByWord[shownWord] ?? [] : []), [expandedByWord, shownWord]);

    // ---- data -------------------------------------------------------------
    const toGraph = useCallback((x: number, y: number) => fgRef.current!.screen2GraphCoords(x, y), []);
    /** The outgoing graph as it is on screen right now. */
    const takeSnapshot = useCallback(
        () => snapshotOf(viewRef.current, fgRef.current ? toGraph : null, containerRef.current),
        [toGraph],
    );

    useEffect(() => {
        if (!word) return;
        let live = true;
        loadGraph(word)
            .then((graph) => { if (live) setFetched({ word, graph, from: takeSnapshot() }); })
            .catch(() => { if (live) setFetched({ word, graph: { nodes: [], links: [] }, from: null }); });
        return () => { live = false; };
    }, [word, takeSnapshot]);

    useEffect(() => {
        if (!data?.nodes.length) return;
        let live = true;
        loadStates(data).then((states) => {
            if (!live) return;
            const now = performance.now();
            for (const id of Object.keys(states)) if (!ringSince.current.has(id)) ringSince.current.set(id, now);
            setFamiliarity((prev) => ({ ...prev, ...states }));
            fgRef.current?.d3ReheatSimulation(); // frames for new rings to fade in
        });
        return () => { live = false; };
    }, [data]);

    useEffect(() => {
        if (!loading || !pending || pending.word !== word) return;
        const timer = window.setTimeout(() => setSlowWord(pending.word), 180);
        return () => window.clearTimeout(timer);
    }, [loading, pending, word]);

    const atlas = useMemo(() => (fetched ? buildAtlas(fetched.graph, fetched.from) : null), [fetched]);
    const view = useMemo(
        () => (atlas ? visibleGraph(atlas, { hidden, expanded, secondDegree }) : null),
        [atlas, hidden, expanded, secondDegree],
    );
    const graphData = useMemo(() => (view ? { nodes: view.nodes, links: view.links } : { nodes: [], links: [] }), [view]);
    // Solved while rendering, so the frame that starts a transition only has to set it in motion.
    const layout = useMemo(() => (view ? solveLayout(view) : null), [view]);
    useEffect(() => { viewRef.current = view; }, [view]);

    const neighbours = useMemo(() => {
        const map = new Map<string, Set<string>>();
        for (const l of view?.links ?? []) {
            const s = endpointId(l.source), tId = endpointId(l.target);
            if (!map.has(s)) map.set(s, new Set());
            if (!map.has(tId)) map.set(tId, new Set());
            map.get(s)!.add(tId);
            map.get(tId)!.add(s);
        }
        return map;
    }, [view]);

    // ---- size / keyboard -----------------------------------------------------
    // Callback ref: the graph area only exists once a word is selected, after the first render.
    const attachGraphArea = useCallback((el: HTMLDivElement | null) => {
        resizeObserver.current?.disconnect();
        containerRef.current = el;
        if (!el) return;
        resizeObserver.current = new ResizeObserver(([entry]) => {
            const { width, height } = entry.contentRect;
            setSize({ width: Math.round(width), height: Math.round(height) });
        });
        resizeObserver.current.observe(el);
    }, []);
    useEffect(() => { sizeRef.current = size; }, [size]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            if (e.repeat || target?.closest('input, textarea, [contenteditable="true"]')) return;
            if (e.key.toLowerCase() === 'h') setSecondDegree((v) => !v);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // ---- motion ----------------------------------------------------------------
    const readCamera = useCallback((): Camera | null => {
        const fg = fgRef.current;
        if (!fg) return null;
        const c = fg.centerAt() as unknown as Point;
        return { x: c.x, y: c.y, k: fg.zoom() };
    }, []);

    const applyCamera = useCallback((c: Camera) => {
        const fg = fgRef.current;
        if (!fg) return;
        cameraDriving.current = true;
        fg.zoom(c.k);
        fg.centerAt(c.x, c.y);
        cameraDriving.current = false;
    }, []);

    /** The camera right now and how fast it is moving. */
    const cameraNow = useCallback((now: number): { camera: Camera; velocity: Camera } | null => {
        const moving = cameraRef.current;
        if (moving) return cameraAt(moving, now);
        const camera = readCamera();
        return camera && { camera, velocity: { x: 0, y: 0, k: 0 } };
    }, [readCamera]);

    /** Animate the camera alone (zoom buttons, fit, resize). */
    const moveCamera = useCallback((to: Camera) => {
        const now = performance.now();
        const current = cameraNow(now);
        if (!current) return;
        if (reducedMotion()) { cameraRef.current = null; applyCamera(to); return; }
        cameraRef.current = cameraMotion(current.camera, to, current.velocity, now);
        fgRef.current?.d3ReheatSimulation(); // keeps frames coming; every word is pinned, so nothing else moves
    }, [cameraNow, applyCamera]);

    /**
     * Moves every word to its solved position and the camera to frame it, on one shared spring. Everything
     * starts where it is drawn in this very frame, at the speed it already has, so a click in the middle
     * of a transition bends it instead of restarting it.
     */
    const beginTransition = useCallback((
        target: View, targets: Map<string, Point>, outgoing: View | null, glide: boolean, arrivingPills: PillShot[],
    ) => {
        const fg = fgRef.current;
        if (!fg) return;
        const now = performance.now();
        const to = cameraFor(target.nodes, targets, sizeRef.current.width, sizeRef.current.height);
        const moves = planMoves(target.nodes, targets, statesOf(outgoing, motionRef.current, now));
        const newGraph = !outgoing || outgoing.nodes[0] !== target.nodes[0];
        if (reducedMotion()) {
            stepMotion({ start: -Infinity, moves }, now);
            markShown(target);
            ghostsRef.current = null;
            shownAt.current = { bubble: -Infinity, pills: -Infinity };
            motionRef.current = null;
            cameraRef.current = null;
            applyCamera(to);
            return;
        }
        carryOver(target, outgoing, now);
        if (outgoing && outgoing !== target) {
            const shows = new Set<RelationGroup>(target.sectors);
            if (target.family.length) shows.add('family');
            const pills = newGraph ? arrivingPills : toggledPills.current.filter((p) => !shows.has(p.group));
            ghostsRef.current = ghostsOf(target, outgoing, motionRef.current, pills, now);
        }
        toggledPills.current = [];
        if (newGraph) shownAt.current.pills = now;
        if (target.family.length && !(outgoing?.family.length && outgoing.origin === target.origin)) shownAt.current.bubble = now;
        motionRef.current = { start: now, moves };
        const camera = cameraNow(now);
        if (glide && camera) {
            cameraRef.current = cameraMotion(camera.camera, to, camera.velocity, now);
        } else {
            cameraRef.current = null;
            applyCamera(to);
        }
        fg.d3ReheatSimulation();
    }, [cameraNow, applyCamera]);

    // Runs once per view, as soon as the graph instance exists (its chunk loads lazily) and before the
    // first frame that draws it.
    const settledFor = useRef<View | null>(null);
    const settleView = useCallback(() => {
        const fg = fgRef.current;
        if (!fg || !view || !layout || settledFor.current === view) return;
        const outgoing = settledFor.current;
        settledFor.current = view;
        // The live simulation only keeps frames coming; every position comes from solveLayout.
        fg.d3Force('center', null);
        fg.d3Force('charge')?.strength(0);
        fg.d3Force('link')?.strength(0);
        beginTransition(view, layout, outgoing, outgoing !== null, fetched?.from?.pills ?? []);
    }, [view, layout, fetched, beginTransition]);
    useEffect(() => { settleView(); }, [settleView]);

    // Hover emphasis eases over several frames; keep frames coming even when the layout is at rest.
    useEffect(() => { fgRef.current?.d3ReheatSimulation(); }, [hovered]);

    /** Every frame: advance words and camera along the spring. */
    const onTick = useCallback(() => {
        settleView();
        const now = performance.now();
        const motion = motionRef.current;
        if (motion && stepMotion(motion, now)) motionRef.current = null;
        const camera = cameraRef.current;
        if (camera) {
            const at = cameraAt(camera, now);
            applyCamera(at.camera);
            if (at.done) cameraRef.current = null;
        }
    }, [settleView, applyCamera]);

    const fit = useCallback(() => {
        if (!view) return;
        moveCamera(cameraFor(view.nodes, restingPositions(view.nodes, motionRef.current), size.width, size.height));
    }, [view, size, moveCamera]);

    // Panels are resizable: keep the graph framed when the available space changes.
    useEffect(() => {
        const current = viewRef.current;
        if (!current || !size.width) return;
        const timer = window.setTimeout(() => {
            moveCamera(cameraFor(current.nodes, restingPositions(current.nodes, motionRef.current), size.width, size.height));
        }, 150);
        return () => window.clearTimeout(timer);
    }, [size, moveCamera]);

    // Brings dragged words back into the layout.
    const relayout = useCallback(() => { if (view && layout) beginTransition(view, layout, view, true, []); }, [view, layout, beginTransition]);

    const zoomBy = (factor: number) => {
        const from = readCamera();
        if (from) moveCamera({ ...from, k: Math.min(4, Math.max(0.25, from.k * factor)) });
    };

    const showZoom = (k: number) => {
        const pct = Math.round(k * 100);
        if (zoomLabelRef.current) zoomLabelRef.current.textContent = `${pct}%`;
        if (zoomSliderRef.current) zoomSliderRef.current.value = String(pct);
    };

    // ---- per-frame overlays (group pills, tooltip) ---------------------------------
    const placeOverlays = useCallback(() => {
        const fg = fgRef.current;
        const area = containerRef.current;
        if (!fg || !view || !area) return;
        const now = performance.now();
        // A new graph's labels fade in with it, even when their words were already on screen.
        const graphFade = reducedMotion() ? 1 : clamp01(spring(now - shownAt.current.pills) * 1.6);
        const { x: ox, y: oy } = view.origin;
        for (const el of area.querySelectorAll<HTMLElement>('[data-pill]')) {
            const group = el.dataset.pill as RelationGroup;
            const members = view.nodes.filter((n) => n.level === 1 && n.group === group && n.x !== undefined);
            if (!members.length) { el.style.visibility = 'hidden'; continue; }
            // Graph point the pill hangs from, and the direction it extends in (away from its words).
            let x: number, y: number, ux: number, uy: number;
            if (group === 'family') {
                x = ox; y = oy - bubbleRadius(view); ux = 0; uy = -1;
            } else {
                const anchor = view.anchors.get(group);
                if (!anchor) { el.style.visibility = 'hidden'; continue; }
                const d = Math.hypot(anchor.x - ox, anchor.y - oy) || 1;
                ux = (anchor.x - ox) / d; uy = (anchor.y - oy) / d;
                const reach = Math.max(...members.map((n) => (n.x! - ox) * ux + (n.y! - oy) * uy));
                x = ox + ux * (reach + 26);
                y = oy + uy * (reach + 26);
            }
            const p = fg.graph2ScreenCoords(x, y);
            const w = el.offsetWidth, h = el.offsetHeight;
            // Top-left corner of the pill so that it sits on the far side of the point.
            let left = p.x - w / 2 + ux * w / 2;
            // Words carry their label underneath, so leave room for it below the cluster.
            let top = p.y - h / 2 + uy * h / 2 + (uy > 0 ? 16 : 0);
            left = Math.min(Math.max(left, 6), size.width - w - 6);
            top = Math.min(Math.max(top, 6), size.height - h - 52);
            el.style.visibility = 'visible';
            el.style.opacity = String(Math.min(graphFade, Math.max(...members.map((n) => fadeIn(n.born, now)))));
            el.style.transform = `translate(${left}px, ${top}px)`;
        }
        if (hovered && !motionRef.current && tooltipRef.current && hovered.x !== undefined) {
            const p = fg.graph2ScreenCoords(hovered.x, hovered.y ?? 0);
            tooltipRef.current.style.transform = `translate(${p.x}px, ${p.y - 18}px) translate(-50%, -100%)`;
        }
    }, [view, hovered, size]);

    // ---- canvas painters -------------------------------------------------------
    // Hover emphasis is eased per word and per link (keyed by id, so it carries across graphs).
    const ringAlpha = useCallback((id: string, now: number) => {
        const since = ringSince.current.get(id);
        return since === undefined ? 0 : reducedMotion() ? 1 : clamp01(spring(now - since) * 1.6);
    }, []);

    /** How one word of the live graph is drawn this frame. */
    const livePaint = useCallback((node: AtlasNode, now: number) => {
        // Words slide under a still pointer during a transition; reacting to that would flicker.
        const hov = motionRef.current ? null : hovered;
        const isHovered = hov?.id === node.id;
        const near = !!hov && (isHovered || !!neighbours.get(hov.id)?.has(node.id));
        const e = easing.current;
        return {
            shown: fadeIn(node.born, now),
            emphasis: eased(e, `h:${node.id}`, isHovered ? 1 : 0, now),
            dim: eased(e, `d:${node.id}`, hov && !near && node.level !== 0 ? 1 : 0, now),
            near: eased(e, `n:${node.id}`, near ? 1 : 0, now),
        };
    }, [hovered, neighbours]);

    /** Under the live graph: the previous view fading out, then the word-family bubble. */
    const paintUnderlay = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
        // A frame can draw the next view before any tick has run; start its transition first.
        settleView();
        const now = performance.now();
        const ghosts = ghostsRef.current;
        const fade = ghosts && !reducedMotion() ? 1 - clamp01(spring(now - ghosts.at) * 1.6) : 0;
        if (ghosts && fade <= 0) ghostsRef.current = null;
        if (ghosts && fade > 0) {
            // Departing words keep gliding where they were heading while they fade.
            if (ghosts.motion) stepMotion(ghosts.motion, now);
            const live = new Map(view?.nodes.map((n) => [n.id, n]));
            const pointOf = (end: string | AtlasNode) => {
                const n = live.get(endpointId(end)) ?? (typeof end === 'object' ? end : undefined);
                return n?.x === undefined || n.y === undefined ? null : { x: n.x, y: n.y };
            };
            const e = easing.current;
            for (const l of ghosts.links) {
                const a = pointOf(l.source), b = pointOf(l.target);
                if (!a || !b) continue;
                const key = pairKey(l);
                paintEdge(ctx, a, b, l, l.morph?.from, morphOf(l.morph, now), fade * fadeIn(l.born, now),
                    eased(e, `l:${key}`, 0, now), eased(e, `L:${key}`, 0, now), palette, scale);
            }
            if (ghosts.bubble) {
                ctx.save();
                ctx.globalAlpha = fade;
                paintBubble(ctx, ghosts.bubble.x, ghosts.bubble.y, ghosts.bubble.r, palette, scale);
                ctx.restore();
            }
            for (const n of ghosts.nodes) {
                if (n.x === undefined || n.y === undefined) continue;
                paintWord(ctx, {
                    x: n.x, y: n.y, look: n, from: n.morph?.from, m: morphOf(n.morph, now),
                    alpha: fade * fadeIn(n.born, now) * (1 - 0.65 * eased(e, `d:${n.id}`, 0, now)),
                    grow: 0.6 + 0.4 * fade,
                    emphasis: eased(e, `h:${n.id}`, 0, now),
                    familiarity: familiarity[n.id],
                    ringAlpha: ringAlpha(n.id, now),
                }, palette, scale);
            }
        }

        if (!view?.family.length) return;
        // The bubble belongs to the graph, not to its members: a new graph fades its bubble in,
        // even when some members were already on screen.
        ctx.save();
        ctx.globalAlpha = reducedMotion() ? 1 : clamp01(spring(now - shownAt.current.bubble) * 1.6);
        paintBubble(ctx, view.origin.x, view.origin.y, bubbleRadius(view), palette, scale);
        ctx.restore();
    }, [view, settleView, familiarity, ringAlpha, palette]);

    const paintLink = useCallback((link: AtlasLink, ctx: CanvasRenderingContext2D, scale: number) => {
        const s = link.source as AtlasNode, e = link.target as AtlasNode;
        if (s.x === undefined || s.y === undefined || e.x === undefined || e.y === undefined) return;
        const now = performance.now();
        const hov = motionRef.current ? null : hovered;
        const lit = !!hov && (s.id === hov.id || e.id === hov.id);
        const key = pairKey(link);
        paintEdge(
            ctx, { x: s.x, y: s.y }, { x: e.x, y: e.y }, link, link.morph?.from, morphOf(link.morph, now),
            Math.min(fadeIn(link.born, now), fadeIn(s.born, now), fadeIn(e.born, now)),
            eased(easing.current, `l:${key}`, lit ? 1 : 0, now),
            eased(easing.current, `L:${key}`, hov && !lit ? 1 : 0, now),
            palette, scale,
        );
    }, [hovered, palette]);

    const paintNode = useCallback((node: AtlasNode, ctx: CanvasRenderingContext2D, scale: number) => {
        const now = performance.now();
        const live = livePaint(node, now);
        // Newcomers grow from 60% to full size while fading in; a word whose role changed morphs into it.
        paintWord(ctx, {
            x: node.x ?? 0, y: node.y ?? 0, look: node, from: node.morph?.from, m: morphOf(node.morph, now),
            alpha: live.shown * (1 - 0.65 * live.dim),
            grow: 0.6 + 0.4 * live.shown,
            emphasis: live.emphasis,
            familiarity: familiarity[node.id],
            ringAlpha: ringAlpha(node.id, now),
        }, palette, scale);
    }, [livePaint, familiarity, ringAlpha, palette]);

    const paintLabels = useCallback((ctx: CanvasRenderingContext2D, scale: number) => {
        if (!view) return;
        const now = performance.now();
        // Detail fades in with zoom instead of popping at a threshold.
        const glossAlpha = clamp01((scale - 1.05) / 0.2);
        const outerAlpha = clamp01((scale - 1.3) / 0.2);
        const ghosts = ghostsRef.current;
        const fade = ghosts && !reducedMotion() ? 1 - clamp01(spring(now - ghosts.at) * 1.6) : 0;
        if (ghosts && fade > 0) {
            const e = easing.current;
            for (const n of ghosts.nodes) {
                if (n.x === undefined || n.y === undefined) continue;
                paintLabel(ctx, {
                    x: n.x, y: n.y, name: n.name, translation: n.translation,
                    look: n, from: n.morph?.from, m: morphOf(n.morph, now),
                    alpha: fade * fadeIn(n.born, now) * (1 - 0.65 * eased(e, `d:${n.id}`, 0, now)),
                    near: eased(e, `n:${n.id}`, 0, now), glossAlpha, outerAlpha,
                }, palette, scale);
            }
        }
        for (const node of view.nodes) {
            if (node.x === undefined || node.y === undefined) continue;
            const live = livePaint(node, now);
            paintLabel(ctx, {
                x: node.x, y: node.y, name: node.name, translation: node.translation,
                look: node, from: node.morph?.from, m: morphOf(node.morph, now),
                alpha: live.shown * (1 - 0.65 * live.dim),
                near: live.near, glossAlpha, outerAlpha,
            }, palette, scale);
        }
        // Group labels of the previous graph sat above everything, as their elements did.
        if (ghosts && fade > 0) {
            ctx.save();
            for (const pill of ghosts.pills) {
                ctx.globalAlpha = fade * pill.alpha;
                paintPill(ctx, pill, palette, scale);
            }
            ctx.restore();
        }
    }, [view, livePaint, palette]);

    // ---- pointer ---------------------------------------------------------------
    /** The word under a point on screen, from where words are drawn right now. */
    const wordAt = (clientX: number, clientY: number): AtlasNode | null => {
        const fg = fgRef.current, area = containerRef.current;
        if (!fg || !area || !view) return null;
        const box = area.getBoundingClientRect();
        const p = fg.screen2GraphCoords(clientX - box.left, clientY - box.top);
        let hit: AtlasNode | null = null, best = Infinity;
        for (const n of view.nodes) {
            if (n.x === undefined || n.y === undefined) continue;
            const d = Math.hypot(n.x - p.x, n.y - p.y);
            if (d <= radiusOf(n) + 5 && d < best) { hit = n; best = d; }
        }
        return hit;
    };

    const clickAt = (clientX: number, clientY: number) => {
        const n = wordAt(clientX, clientY);
        if (!n || n.level === 0) return;
        const p = fgRef.current?.graph2ScreenCoords(n.x ?? 0, n.y ?? 0);
        if (p) setPending({ word: n.id, x: p.x, y: p.y });
        setHovered(null);
        onNodeClick?.(n.id);
    };

    // ---- render ----------------------------------------------------------------
    if (!word) {
        return <div className="flex h-full items-center justify-center text-sm tracking-wide text-neutral-500">{t('selectWord')}</div>;
    }

    const totals = atlas?.totals;
    const totalWords = atlas ? atlas.nodes.length - 1 : 0;
    const shownWords = view ? view.nodes.length - 1 : 0;
    const groupsPresent = RELATION_GROUPS.filter((g) => (totals?.[g] ?? 0) > 0);
    const groupLabel = (g: RelationGroup) => t(`atlas.groups.${g}`);

    return (
        <div className="absolute inset-0 flex flex-col overflow-hidden" style={{ background: palette.bg }}>
            {/* Toolbar */}
            <div className="z-20 flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-800 bg-neutral-950/85 px-3 py-2 backdrop-blur-md">
                <div className="min-w-0">
                    <div className="text-[9px] font-bold uppercase tracking-[0.24em] text-emerald-400">{t('atlas.eyebrow')}</div>
                    <div className="flex items-baseline gap-2">
                        <span className="truncate text-lg leading-tight text-white" style={{ fontFamily: "'Instrument Serif', serif" }}>{word}</span>
                        {loading
                            ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" aria-label={t('loadingGraph')} />
                            : atlas && <span className="whitespace-nowrap text-[11px] text-neutral-500">{t('atlas.stats', { shown: shownWords, total: totalWords })}</span>}
                    </div>
                </div>
                <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
                    {groupsPresent.map((g) => {
                        const on = !hidden.has(g);
                        return (
                            <button
                                key={g}
                                type="button"
                                aria-pressed={on}
                                onClick={() => {
                                    // Its group label fades out on the canvas once its element is gone.
                                    toggledPills.current = pillsOf(fgRef.current ? toGraph : null, containerRef.current);
                                    setHidden((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(g)) next.delete(g); else next.add(g);
                                        return next;
                                    });
                                }}
                                className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] leading-none transition-colors hover:bg-neutral-800 ${on ? 'font-semibold text-neutral-100' : 'border-neutral-800 text-neutral-500'}`}
                                style={on ? { borderColor: GROUP_COLORS[g] } : undefined}
                            >
                                <span className="h-2 w-2 rounded-full" style={{ background: GROUP_COLORS[g], opacity: on ? 1 : 0.4 }} />
                                {groupLabel(g)}
                                <span className="font-normal text-neutral-500">{totals![g]}</span>
                            </button>
                        );
                    })}
                    <button
                        type="button"
                        aria-pressed={secondDegree}
                        title={t('atlas.secondDegreeHint')}
                        onClick={() => setSecondDegree((v) => !v)}
                        className={`rounded border px-2 py-1 text-[11px] leading-none transition-colors ${secondDegree ? 'border-neutral-600 bg-neutral-800 text-neutral-100' : 'border-neutral-800 text-neutral-500 hover:bg-neutral-800'}`}
                    >
                        {t('atlas.secondDegree')}
                    </button>
                </div>
            </div>

            <div
                ref={attachGraphArea}
                className="relative min-h-0 flex-1"
                // Hover and clicks are resolved here, from where words are drawn right now: force-graph
                // hit-tests against a picture of the graph it refreshes only every 800 ms, which misses (or
                // mistakes) words that are moving. Hover follows the pointer, never words sliding under it.
                onPointerMove={(e) => {
                    const hit = e.target instanceof HTMLCanvasElement ? wordAt(e.clientX, e.clientY) : null;
                    if (hit !== pointerOver.current) {
                        pointerOver.current = hit;
                        if (hit && hit.level !== 0) prefetchWord(hit.id);
                        if (containerRef.current) containerRef.current.style.cursor = hit && hit.level !== 0 ? 'pointer' : '';
                    }
                    if (!motionRef.current) setHovered(hit);
                }}
                onPointerLeave={() => {
                    pointerOver.current = null;
                    setHovered(null);
                }}
                onPointerDown={(e) => {
                    pressedAt.current = e.button === 0 && e.target instanceof HTMLCanvasElement ? { x: e.clientX, y: e.clientY } : null;
                }}
                onPointerUp={(e) => {
                    const from = pressedAt.current;
                    pressedAt.current = null;
                    // A click, not the end of a pan or a drag.
                    if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) < 5) clickAt(e.clientX, e.clientY);
                }}
            >
                {/* Graph */}
                {size.width > 0 && view && (
                    <ForceGraph2D
                        ref={fgRef}
                        width={size.width}
                        height={size.height}
                        graphData={graphData}
                        backgroundColor={palette.bg}
                        nodeId="id"
                        nodeLabel={() => ''}
                        nodeRelSize={1}
                        nodeVal={(n: AtlasNode) => (n.level === 0 ? RADIUS.center ** 2 : n.level === 1 ? RADIUS.l1 ** 2 : RADIUS.l2 ** 2)}
                        nodeCanvasObject={paintNode}
                        nodePointerAreaPaint={(n: AtlasNode, color: string, ctx: CanvasRenderingContext2D) => {
                            ctx.fillStyle = color;
                            ctx.beginPath();
                            ctx.arc(n.x ?? 0, n.y ?? 0, (n.level === 0 ? RADIUS.center : n.level === 1 ? RADIUS.l1 : RADIUS.l2) + 5, 0, Math.PI * 2);
                            ctx.fill();
                        }}
                        linkCanvasObject={paintLink}
                        onRenderFramePre={paintUnderlay}
                        onRenderFramePost={(ctx: CanvasRenderingContext2D, scale: number) => { paintLabels(ctx, scale); placeOverlays(); }}
                        onEngineTick={onTick}
                        warmupTicks={0}
                        cooldownTicks={90}
                        onZoom={({ k }: { k: number }) => {
                            showZoom(k);
                            // The user is panning or zooming: let go of the camera.
                            if (!cameraDriving.current) cameraRef.current = null;
                        }}
                        onNodeDragEnd={(n: AtlasNode) => { if (n.level !== 0) { n.fx = n.x; n.fy = n.y; } }}
                    />
                )}

                {/* Group pills ("Synonyms 10/13 · show all") */}
                {view && groupsPresent.filter((g) => !hidden.has(g)).map((g) => {
                    const total = totals![g];
                    const shown = Math.min(total, expanded.has(g) ? total : GROUP_CAP);
                    const canToggle = total > GROUP_CAP;
                    const label = expanded.has(g) ? t('atlas.showFewer', { group: groupLabel(g) }) : t('atlas.showAll', { total, group: groupLabel(g) });
                    return (
                        <div
                            key={`${shownWord}|${g}`}
                            data-pill={g}
                            className="pointer-events-auto absolute left-0 top-0 z-10"
                            style={{ visibility: 'hidden' }}
                        >
                            <button
                                type="button"
                                disabled={!canToggle}
                                title={canToggle ? label : undefined}
                                aria-label={canToggle ? label : undefined}
                                onClick={() => setExpandedByWord((prev) => {
                                    if (!shownWord) return prev;
                                    const current = prev[shownWord] ?? [];
                                    return { ...prev, [shownWord]: current.includes(g) ? current.filter((x) => x !== g) : [...current, g] };
                                })}
                                className="whitespace-nowrap rounded-full border bg-neutral-950/90 px-2.5 py-0.5 text-[11px] font-semibold shadow-sm disabled:cursor-default enabled:hover:bg-neutral-900"
                                style={{ borderColor: GROUP_COLORS[g], color: GROUP_COLORS[g] }}
                            >
                                {groupLabel(g)} {g === 'family' ? `· ${shown}` : `${shown}/${total}`}
                                {canToggle && <span className="ml-1 font-normal">{expanded.has(g) ? '−' : '+'}</span>}
                            </button>
                        </div>
                    );
                })}

                {/* States */}
                {loading && !view && <div className="absolute inset-0 z-10 flex items-center justify-center text-sm text-neutral-500">{t('loadingGraph')}</div>}
                {loading && pending?.word === word && slowWord === word && (
                    <span
                        className="pointer-events-none absolute z-10 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-emerald-400 motion-safe:animate-ping"
                        style={{ left: pending.x, top: pending.y }}
                    />
                )}
                {!loading && view && view.nodes.length <= 1 && (
                    <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-neutral-500">{t('atlas.empty')}</div>
                )}

                {/* Familiarity legend (needs room next to the zoom bar) */}
                {size.width >= 640 && (
                <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2.5 rounded-md border border-neutral-800 bg-neutral-950/85 px-2.5 py-1.5 text-[10px] text-neutral-400 backdrop-blur">
                    <span className="font-semibold text-neutral-300">{t('atlas.legend.title')}</span>
                    {FAMILIARITY_ORDER.map((f) => (
                        <span key={f} className="inline-flex items-center gap-1">
                            <RingIcon level={f} palette={palette} />
                            {t(`atlas.legend.${f}`)}
                        </span>
                    ))}
                    <span className="inline-flex items-center gap-1">
                        <span className="h-2.5 w-2.5 rounded-full border border-dashed border-neutral-500" />
                        {t('atlas.legend.unbuilt')}
                    </span>
                </div>
                )}

                {/* Zoom bar */}
                <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-md border border-neutral-800 bg-neutral-950/85 px-1.5 py-1 text-neutral-400 backdrop-blur">
                    <button type="button" onClick={() => zoomBy(1 / 1.25)} title={t('zoomOut')} aria-label={t('zoomOut')} className="rounded p-1 hover:bg-neutral-800 hover:text-white"><Minus size={14} /></button>
                    <input
                        ref={zoomSliderRef}
                        type="range"
                        min={25}
                        max={400}
                        step={5}
                        defaultValue={100}
                        onChange={(e) => {
                            const from = readCamera();
                            cameraRef.current = null;
                            if (from) applyCamera({ ...from, k: Number(e.target.value) / 100 });
                        }}
                        aria-label={t('atlas.zoom')}
                        className="hidden h-1 w-20 cursor-pointer accent-emerald-500 md:block"
                    />
                    <button type="button" onClick={() => zoomBy(1.25)} title={t('zoomIn')} aria-label={t('zoomIn')} className="rounded p-1 hover:bg-neutral-800 hover:text-white"><Plus size={14} /></button>
                    <span ref={zoomLabelRef} className="w-9 text-center text-[10px] tabular-nums">100%</span>
                    <button type="button" onClick={() => fit()} title={t('atlas.fit')} aria-label={t('atlas.fit')} className="rounded p-1 hover:bg-neutral-800 hover:text-white"><Maximize size={14} /></button>
                    <button type="button" onClick={relayout} title={t('atlas.relayout')} aria-label={t('atlas.relayout')} className="rounded p-1 hover:bg-neutral-800 hover:text-white"><RotateCcw size={14} /></button>
                </div>

                {/* Hover tooltip */}
                {showHoverTooltip && showGraphTooltip && hovered && !loading && (
                    <div ref={tooltipRef} className="pointer-events-none absolute left-0 top-0 z-30">
                        <WordTooltip word={hovered.name} phonetic={hovered.phonetic} translation={hovered.translation} />
                    </div>
                )}
            </div>
        </div>
    );
}
