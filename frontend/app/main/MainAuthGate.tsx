'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { api, authService } from '@/services/api';

interface User {
    id: number;
    name: string;
    email: string;
    roles?: Array<{ slug: string }>;
}

export default function MainAuthGate({ children }: { children: React.ReactNode }) {
    const router = useRouter();
    const pathname = usePathname();
    const [loading, setLoading] = useState(true);
    const [user, setUser] = useState<User | null>(null);

    useEffect(() => {
        const run = async () => {
            if (!api.isAuthenticated()) {
                router.push('/login');
                return;
            }
            try {
                const response = await authService.me();
                if (response.success && response.data) {
                    setUser(response.data as unknown as User);
                } else {
                    api.removeToken();
                    router.push('/login');
                }
            } catch {
                api.removeToken();
                router.push('/login');
            } finally {
                setLoading(false);
            }
        };
        run();
    }, [router]);

    const isSuperAdmin = user?.roles?.some((r) => r.slug === 'super_admin') ?? false;

    useEffect(() => {
        if (!loading && user && !isSuperAdmin) {
            const path = pathname || '';
            const restricted = ['/main/features', '/main/roles'];
            if (path.startsWith('/main') && restricted.some((r) => path === r || path.startsWith(r + '/'))) {
                router.push('/main');
            }
        }
    }, [user, loading, isSuperAdmin, pathname, router]);

    if (loading) {
        return (
            <div className="flex align-items-center justify-content-center min-h-screen">
                <i className="pi pi-spin pi-spinner text-4xl" />
            </div>
        );
    }

    return <>{children}</>;
}
