import { Suspense } from 'react';
import PayReturnClient from '@/components/pay/PayReturnClient';

export default function PayReturnPage() {
    return (
        <Suspense>
            <PayReturnClient />
        </Suspense>
    );
}
