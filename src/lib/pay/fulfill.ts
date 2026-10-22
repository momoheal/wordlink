import { prisma } from '@/lib/prisma';
import { getProduct } from './products';

export type FulfillResult = 'paid' | 'already_paid' | 'amount_mismatch' | 'unknown_product' | 'not_found';

// 支付成功后的开通/续期：先原子抢占订单状态（幂等），再在事务内为用户延期。
// 被异步通知（/api/pay/notify）与主动查单兜底（GET /api/pay/orders/[outTradeNo]）共用。
export async function fulfillPaidOrder(input: {
    outTradeNo: string;
    alipayTradeNo?: string;
    totalAmount?: string;
    raw?: unknown;
}): Promise<FulfillResult> {
    const order = await prisma.paymentOrder.findUnique({
        where: { outTradeNo: input.outTradeNo },
    });
    if (!order) return 'not_found';
    if (order.status === 'paid') return 'already_paid';

    const product = getProduct(order.product);
    if (!product) return 'unknown_product';
    if (input.totalAmount && Number(input.totalAmount) !== Number(order.amount)) {
        return 'amount_mismatch';
    }

    const now = new Date();
    let claimed = false;
    await prisma.$transaction(async (tx) => {
        const claim = await tx.paymentOrder.updateMany({
            where: { outTradeNo: order.outTradeNo, status: 'pending' },
            data: {
                status: 'paid',
                alipayTradeNo: input.alipayTradeNo ?? null,
                paidAt: now,
                rawNotify: input.raw === undefined ? undefined : (input.raw as object),
            },
        });
        if (claim.count === 0) return; // 并发回调已处理
        claimed = true;

        const user = await tx.user.findUnique({
            where: { id: order.userId },
            select: { planExpiresAt: true },
        });
        const base = user?.planExpiresAt && user.planExpiresAt > now ? user.planExpiresAt : now;
        const planExpiresAt = new Date(base.getTime() + product.days * 86_400_000);
        await tx.user.update({
            where: { id: order.userId },
            data: { plan: 'pro', planExpiresAt },
        });
    });

    return claimed ? 'paid' : 'already_paid';
}
