/** 单词笔记的共用规则，前后端都会引用（不能依赖 Prisma 等服务端模块） */

export const MAX_NOTE_LENGTH = 2000;
export const MAX_COMMENT_LENGTH = 500;

/** 笔记对所有用户公开，不暴露完整邮箱：只返回脱敏后的显示名 */
export function maskEmail(email: string): string {
    const name = email.split('@')[0] || 'user';
    if (name.length <= 2) return name[0] + '*'.repeat(Math.max(name.length - 1, 1));
    return name.slice(0, 2) + '***';
}
