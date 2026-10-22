// Pro 产品目录：金额以字符串保存，避免浮点误差污染对账与签名
export interface ProProduct {
    key: string;
    subject: string;
    amount: string;
    days: number;
}

export const PRO_PRODUCTS: Record<string, ProProduct> = {
    pro_monthly: { key: 'pro_monthly', subject: 'WordLink Pro 月卡', amount: '19.90', days: 30 },
    pro_yearly: { key: 'pro_yearly', subject: 'WordLink Pro 年卡', amount: '168.00', days: 365 },
};

export function getProduct(key: string): ProProduct | null {
    return PRO_PRODUCTS[key] ?? null;
}
