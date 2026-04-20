'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, authService } from '@/services/api';
import { tenantService } from '@/services/tenant';
import { Button } from 'primereact/button';
import { Card } from 'primereact/card';
import { Tag } from 'primereact/tag';

interface User {
    id: number;
    name: string;
    email: string;
    tenant?: {
        name: string;
        id: number;
    };
    roles?: Array<{
        name: string;
        slug: string;
    }>;
}

interface TenantStats {
    total_tenants: number;
    active_tenants: number;
    inactive_tenants: number;
    total_users: number;
    total_branches: number;
}

interface Tenant {
    id: number;
    name: string;
    subdomain: string;
    email: string;
    status: number;
    created_at: string;
}

export default function DashboardPage() {
    const router = useRouter();
    const [user, setUser] = useState<User | null>(null);
    const [stats, setStats] = useState<TenantStats | null>(null);
    const [tenants, setTenants] = useState<Tenant[]>([]);
    const [loading, setLoading] = useState(true);

    const isSuperAdmin = user?.roles?.some(r => r.slug === 'super_admin') ?? false;

    useEffect(() => {
        const fetchData = async () => {
            if (!api.isAuthenticated()) {
                router.push('/auth/login');
                return;
            }

            try {
                const response = await authService.me();
                if (response.success && response.data) {
                    setUser(response.data as unknown as User);

                    if ((response.data as unknown as User).roles?.some(r => r.slug === 'super_admin')) {
                        const [statsRes, tenantsRes] = await Promise.all([
                            tenantService.getStats(),
                            tenantService.getAll({ per_page: 5 })
                        ]);

                        if (statsRes.success) {
                            setStats(statsRes.data);
                        }
                        if (tenantsRes.success) {
                            setTenants(tenantsRes.data?.data || tenantsRes.data || []);
                        }
                    }
                } else {
                    api.removeToken();
                    router.push('/auth/login');
                }
            } catch (error) {
                console.error('Error fetching data:', error);
                api.removeToken();
                router.push('/auth/login');
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, [router]);

    const getSeverity = (status: number) => {
        return status === 1 ? 'success' : 'danger';
    };

    const getStatusLabel = (status: number) => {
        return status === 1 ? 'Active' : 'Inactive';
    };

    if (loading) {
        return (
            <div className="flex align-items-center justify-content-center min-h-screen">
                <i className="pi pi-spin pi-spinner text-4xl" />
            </div>
        );
    }

    return (
        <div className="surface-section px-4 py-5 md:px-6 lg:px-8">
            <div className="flex flex-column md:flex-row align-items-center justify-content-between gap-4">
                <div>
                    <div className="text-900 font-medium mb-2">Welcome back, {user?.name}!</div>
                    <div className="text-500">
                        {user?.tenant?.name || 'Super Admin'}
                    </div>
                </div>
                <div className="flex gap-2">
                    {isSuperAdmin && (
                        <Button
                            label="Onboard New Institute"
                            icon="pi pi-plus"
                            onClick={() => router.push('/main/institutes/new')}
                        />
                    )}
                    <Tag value={user?.roles?.[0]?.name || 'User'} severity="info" />
                </div>
            </div>

            {isSuperAdmin && stats ? (
                <>
                    <div className="grid mt-5">
                        <div className="col-12 md:col-6 lg:col-3">
                            <div className="surface-card shadow-2 p-3 border-round">
                                <div className="flex justify-content-center mb-3">
                                    <i className="pi pi-building text-4xl text-blue-500" />
                                </div>
                                <div className="text-center">
                                    <span className="text-2xl font-medium">{stats.total_tenants}</span>
                                    <div className="text-500">Total Institutes</div>
                                </div>
                            </div>
                        </div>
                        <div className="col-12 md:col-6 lg:col-3">
                            <div className="surface-card shadow-2 p-3 border-round">
                                <div className="flex justify-content-center mb-3">
                                    <i className="pi pi-check-circle text-4xl text-green-500" />
                                </div>
                                <div className="text-center">
                                    <span className="text-2xl font-medium">{stats.active_tenants}</span>
                                    <div className="text-500">Active Institutes</div>
                                </div>
                            </div>
                        </div>
                        <div className="col-12 md:col-6 lg:col-3">
                            <div className="surface-card shadow-2 p-3 border-round">
                                <div className="flex justify-content-center mb-3">
                                    <i className="pi pi-users text-4xl text-orange-500" />
                                </div>
                                <div className="text-center">
                                    <span className="text-2xl font-medium">{stats.total_users}</span>
                                    <div className="text-500">Total Users</div>
                                </div>
                            </div>
                        </div>
                        <div className="col-12 md:col-6 lg:col-3">
                            <div className="surface-card shadow-2 p-3 border-round">
                                <div className="flex justify-content-center mb-3">
                                    <i className="pi pi-map-marker text-4xl text-purple-500" />
                                </div>
                                <div className="text-center">
                                    <span className="text-2xl font-medium">{stats.total_branches}</span>
                                    <div className="text-500">Total Branches</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="grid mt-3">
                        <div className="col-12 lg:col-6">
                            <Card title="Recent Institutes">
                                <div className="flex flex-column gap-2">
                                    {tenants.length > 0 ? (
                                        tenants.map((tenant) => (
                                            <div
                                                key={tenant.id}
                                                className="flex align-items-center justify-content-between p-2 surface-50 border-round cursor-pointer hover:surface-100"
                                                onClick={() => router.push(`/main/institutes/${tenant.id}`)}
                                            >
                                                <div>
                                                    <div className="font-medium">{tenant.name}</div>
                                                    <div className="text-sm text-500">{tenant.subdomain}.paathshala.local</div>
                                                </div>
                                                <Tag
                                                    value={getStatusLabel(tenant.status)}
                                                    severity={getSeverity(tenant.status)}
                                                />
                                            </div>
                                        ))
                                    ) : (
                                        <div className="text-center text-500 p-4">
                                            No institutes yet. Onboard your first institute!
                                        </div>
                                    )}
                                </div>
                            </Card>
                        </div>
                        <div className="col-12 lg:col-6">
                            <Card title="Quick Actions">
                                <div className="flex flex-column gap-2">
                                    <Button
                                        label="View All Institutes"
                                        icon="pi pi-building"
                                        className="p-button-text"
                                        onClick={() => router.push('/main/institutes')}
                                    />
                                    <Button
                                        label="Manage Roles & Permissions"
                                        icon="pi pi-shield"
                                        className="p-button-text"
                                        onClick={() => router.push('/main/roles')}
                                    />
                                    <Button
                                        label="Configure Features"
                                        icon="pi pi-cog"
                                        className="p-button-text"
                                        onClick={() => router.push('/main/features')}
                                    />
                                </div>
                            </Card>
                        </div>
                    </div>
                </>
            ) : (
                <div className="grid mt-5">
                    <div className="col-12 md:col-6 lg:col-3">
                        <div className="surface-card shadow-2 p-3 border-round">
                            <div className="flex justify-content-center mb-3">
                                <i className="pi pi-users text-4xl text-blue-500" />
                            </div>
                            <div className="text-center">
                                <span className="text-2xl font-medium">-</span>
                                <div className="text-500">Total Students</div>
                            </div>
                        </div>
                    </div>
                    <div className="col-12 md:col-6 lg:col-3">
                        <div className="surface-card shadow-2 p-3 border-round">
                            <div className="flex justify-content-center mb-3">
                                <i className="pi pi-book text-4xl text-green-500" />
                            </div>
                            <div className="text-center">
                                <span className="text-2xl font-medium">-</span>
                                <div className="text-500">Courses</div>
                            </div>
                        </div>
                    </div>
                    <div className="col-12 md:col-6 lg:col-3">
                        <div className="surface-card shadow-2 p-3 border-round">
                            <div className="flex justify-content-center mb-3">
                                <i className="pi pi-calendar text-4xl text-orange-500" />
                            </div>
                            <div className="text-center">
                                <span className="text-2xl font-medium">-</span>
                                <div className="text-500">Attendance</div>
                            </div>
                        </div>
                    </div>
                    <div className="col-12 md:col-6 lg:col-3">
                        <div className="surface-card shadow-2 p-3 border-round">
                            <div className="flex justify-content-center mb-3">
                                <i className="pi pi-wallet text-4xl text-purple-500" />
                            </div>
                            <div className="text-center">
                                <span className="text-2xl font-medium">-</span>
                                <div className="text-500">Revenue</div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}