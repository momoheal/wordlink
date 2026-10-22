import { verifyNotify } from '@/lib/pay/alipay';
import { fulfillPaidOrder } from '@/lib/pay/fulfill';

export const runtime = 'nodejs';

const PAID_STATUSES = new Set(['TRADE_SUCCESS', 'TRADE_FINISHED']);

// 支付宝异步通知：验签 → 按订单号开通。返回体必须是纯文本 success/failure，
// 返回 failure 或非 200 支付宝会按梯度重试。
export async function POST(request: Request) {
    try {
        const params = Object.fromEntries(new URLSearchParams(await request.text()));
        if (!verifyNotify(params)) return new Response('failure');

        const outTradeNo = params.out_trade_no || '';
        if (!outTradeNo) return new Response('failure');

        if (PAID_STATUSES.has(params.trade_status || '')) {
            const result = await fulfillPaidOrder({
                outTradeNo,
                alipayTradeNo: params.trade_no,
                totalAmount: params.total_amount,
                raw: params,
            });
            // 找不到订单/金额对不上/产品不存在属于真实异常，不能回 success
            if (result === 'not_found' || result === 'amount_mismatch' || result === 'unknown_product') {
                console.error(`[pay/notify] fulfill failed: ${result}`, outTradeNo);
                return new Response('failure');
            }
        }

        // WAIT_BUYER_PAY 等其他状态：确认收到即可
        return new Response('success');
    } catch (error) {
        console.error('[pay/notify] error:', error);
        return new Response('failure');
    }
}
