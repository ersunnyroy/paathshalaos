import { Metadata } from 'next';
import Layout from '@/layout/layout';
import MainAuthGate from './MainAuthGate';

interface AppLayoutProps {
    children: React.ReactNode;
}

export const metadata: Metadata = {
    title: 'PaathshalaOS',
    description: 'School Management System',
    robots: { index: false, follow: false },
    viewport: { initialScale: 1, width: 'device-width' },
    icons: {
        icon: '/favicon.ico',
    },
};

export default function AppLayout({ children }: AppLayoutProps) {
    return (
        <MainAuthGate>
            <Layout>{children}</Layout>
        </MainAuthGate>
    );
}
