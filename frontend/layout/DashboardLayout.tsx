'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { useTheme } from '@/hooks/useTheme';
import { api, authService } from '@/services/api';

interface DashboardLayoutProps {
    children: React.ReactNode;
}

interface MenuItem {
    label: string;
    icon: string;
    url: string;
    roles?: string[];
}

interface User {
    id: number;
    name: string;
    email: string;
    tenant?: {
        name: string;
        id: number;
    };
    roles?: Array<{
        slug: string;
    }>;
}

const menuItems: MenuItem[] = [
    { label: 'Dashboard', icon: 'pi pi-home', url: '/main' },
    { label: 'Schools', icon: 'pi pi-building', url: '/main/schools' },
    { label: 'Branches', icon: 'pi pi-map-marker', url: '/main/branches' },
    { label: 'Roles & Permissions', icon: 'pi pi-shield', url: '/main/roles' },
    { label: 'Features', icon: 'pi pi-cog', url: '/main/features' },
    { label: 'Settings', icon: 'pi pi-cog', url: '/main/settings' },
];

export default function DashboardLayout({ children }: DashboardLayoutProps) {
    const router = useRouter();
    const pathname = usePathname();
    const { themeMode, setThemeMode, mounted } = useTheme();
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState(true);
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [showThemeConfirm, setShowThemeConfirm] = useState(false);
    const [pendingTheme, setPendingTheme] = useState<'light' | 'dark'>('light');

    const colorScheme = mounted ? themeMode : 'light';
    const isDark = colorScheme === 'dark';

    const isSuperAdmin = user?.roles?.some(r => r.slug === 'super_admin') ?? false;

    const filteredMenuItems = menuItems.filter(item => {
        if (item.roles && !item.roles.some(r => user?.roles?.some(ur => ur.slug === r))) {
            return false;
        }
        return true;
    });

    useEffect(() => {
        const fetchUser = async () => {
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
            } catch (error) {
                console.error('Error fetching user:', error);
                api.removeToken();
                router.push('/login');
            } finally {
                setLoading(false);
            }
        };

        fetchUser();
    }, [router]);

    useEffect(() => {
        if (!loading && user && !isSuperAdmin) {
            const path = pathname || '';
            const publicRoutes = ['/main/features', '/main/roles', '/main/settings'];
            if (path.startsWith('/main') && publicRoutes.includes(path)) {
                router.push('/main');
            }
        }
    }, [user, loading, router, pathname]);

    useEffect(() => {
        if (mounted) {
            const isDark = themeMode === 'dark';
            document.documentElement.classList.toggle('dark', isDark);
        }
    }, [themeMode, mounted]);

    const handleLogout = async () => {
        try {
            await authService.logout();
        } catch (e) {
            console.error('Logout error:', e);
        } finally {
            api.removeToken();
            router.push('/login');
        }
    };

    const toggleTheme = () => {
        setPendingTheme(colorScheme === 'light' ? 'dark' : 'light');
        setShowThemeConfirm(true);
    };

    const confirmThemeChange = () => {
        setThemeMode(pendingTheme);
        setShowThemeConfirm(false);
    };

    if (loading) {
        return (
            <div className="flex align-items-center justify-content-center min-h-screen">
                <i className="pi pi-spin pi-spinner text-4xl" />
            </div>
        );
    }

    return (
        <div className="flex min-h-screen">
            {/* Sidebar */}
            <aside className={`sidebar surface-card shadow-2 flex flex-column ${sidebarOpen ? 'open' : ''}`}>
                <div className="p-3 flex align-items-center gap-2 border-bottom-1 surface-border">
                    <span className="text-xl font-bold">PaathshalaOS</span>
                </div>

                <nav className="flex-1 p-2">
                    {menuItems.map((item) => (
                        <Link
                            key={item.url}
                            href={item.url}
                            className="flex align-items-center p-3 text-700 border-round hover:surface-100 transition-duration-200 transition-colors"
                        >
                            <i className={`${item.icon} mr-2`} />
                            <span>{item.label}</span>
                        </Link>
                    ))}
                </nav>

                <div className="p-3 border-top-1 surface-border">
                    <div className="text-sm text-600 mb-2">{user?.name}</div>
                    <div className="text-xs text-500 mb-2">{user?.tenant?.name}</div>
                    <button
                        onClick={handleLogout}
                        className="p-button p-button-text p-button-sm w-full"
                    >
                        <i className="pi pi-sign-out mr-2" />
                        Logout
                    </button>
                </div>
            </aside>

            {/* Main Content */}
            <main className="flex-1 flex flex-column">
                {/* Header */}
                <header className="surface-card shadow-1 p-3 flex align-items-center justify-content-between">
                    <button
                        className="p-button p-button-text"
                        onClick={() => setSidebarOpen(!sidebarOpen)}
                    >
                        <i className="pi pi-bars text-xl" />
                    </button>

                    <div className="flex align-items-center gap-3">
                        <button
                            className="p-button p-button-text"
                            onClick={toggleTheme}
                            title={`Switch to ${colorScheme === 'light' ? 'dark' : 'light'} mode`}
                        >
                            <i className={`pi ${colorScheme === 'light' ? 'pi-moon' : 'pi-sun'} text-xl`} />
                        </button>
                        <div className="text-right">
                            <div className="text-sm font-medium">{user?.name}</div>
                            <div className="text-xs text-500">{user?.tenant?.name}</div>
                        </div>
                        <div className="surface-100 border-circle w-2rem h-2rem flex align-items-center justify-content-center">
                            <i className="pi pi-user" />
                        </div>
                    </div>
                </header>

                {/* Page Content */}
                <div className="flex-1 p-4">
                    {children}
                </div>
            </main>

            <Dialog 
                header="Confirm Theme Change" 
                visible={showThemeConfirm} 
                onHide={() => setShowThemeConfirm(false)} 
                style={{ width: '350px' }} 
                modal
                footer={
                    <div className="flex gap-2 justify-content-end">
                        <Button 
                            label="Cancel" 
                            icon="pi pi-times" 
                            severity="secondary" 
                            onClick={() => setShowThemeConfirm(false)} 
                        />
                        <Button 
                            label="Confirm" 
                            icon="pi pi-check" 
                            onClick={confirmThemeChange} 
                        />
                    </div>
                }
            >
                <p className="m-0">
                    Do you want to switch to {pendingTheme} mode? 
                    Your preference will be saved in the browser.
                </p>
            </Dialog>
        </div>
    );
}