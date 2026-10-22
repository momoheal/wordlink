import { NextRequest, NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { getSession } from '@/lib/auth';
import { buildPagePayUrl, isAlipayConfigured } from '@/lib/pay/alipay';
import { getProduct } from '@/lib/pay/products';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
    const session = await getSession();
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!isAlipayConfigured()) {
        return NextResponse.json({ code: 'PAY_NOT_CONFIGURED' }, { status: 503 });
    }

    const body = await request.json().catch(() => null);
    const product = body && typeof body.product === 'string' ? getProduct(body.product) : null;
    if (!product) {
        return NextResponse.json({ error: 'Unknown product' }, { status: 400 });
    }

    const outTradeNo = `WL${Date.now()}${randomBytes(3).toString('hex').toUpperCase()}`;
    await prisma.paymentOrder.create({
        data: {
            outTradeNo,
            userId: session.id,
            product: product.key,
            subject: product.subject,
            amount: product.amount,
        },
    });

    const payUrl = buildPagePayUrl({
        outTradeNo,
        totalAmount: product.amount,
        subject: product.subject,
    });
    return NextResponse.json({ payUrl, outTradeNo });
}
