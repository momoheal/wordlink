// 词链图的共享类型与常量 —— 客户端组件也可安全引用（不得引入 fs/prisma 等服务端依赖）

export interface GraphNode {
    id: string;
    name: string;
    val: number; // size
    color?: string;
    level: 0 | 1 | 2;
    phonetic?: string;
    translation?: string;
    placeholder?: boolean; // 目标词未建词条：灰点占位
}

export type RelationType =
    | 'synonym' | 'near_synonym' | 'antonym'
    | 'derivative' | 'inflection' | 'spelling_similar';

export interface GraphLink {
    source: string;
    target: string;
    color?: string;
    meaning?: string;
    type?: RelationType;
    status?: 'confirmed' | 'pending'; // pending = 指向占位词的候选边，前端虚线
}

export const RELATION_COLORS: Record<RelationType, string> = {
    synonym: '#16A34A',
    near_synonym: '#0EA5E9',
    antonym: '#EF4444',
    derivative: '#8B5CF6',
    inflection: '#0D9488',
    spelling_similar: '#F59E0B',
};

export interface GraphData {
    nodes: GraphNode[];
    links: GraphLink[];
    definitions?: Record<string, string>;
}

/** How well the current user knows a word; absent = never opened ("new"). */
export type Familiarity = 'seen' | 'weak' | 'learning' | 'mastered';

/**
 * Relation groups shown in the graph toolbar. Derivatives and inflections are merged into one
 * "word family", drawn as a bubble around the centre word instead of as edges.
 */
export type RelationGroup = 'family' | 'synonym' | 'near_synonym' | 'antonym' | 'spelling_similar';

export const RELATION_GROUPS: RelationGroup[] = ['family', 'synonym', 'near_synonym', 'antonym', 'spelling_similar'];

export const GROUP_COLORS: Record<RelationGroup, string> = {
    family: RELATION_COLORS.derivative,
    synonym: RELATION_COLORS.synonym,
    near_synonym: RELATION_COLORS.near_synonym,
    antonym: RELATION_COLORS.antonym,
    spelling_similar: RELATION_COLORS.spelling_similar,
};

export function groupOf(type: RelationType | undefined): RelationGroup {
    if (type === 'derivative' || type === 'inflection') return 'family';
    return type ?? 'synonym';
}
