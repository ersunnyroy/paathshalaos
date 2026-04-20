'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Toast } from 'primereact/toast';
import { api, authService, tenantAdminService } from '@/services/api';

interface User {
    id: number;
    roles?: Array<{ slug: string }>;
}

interface Tenant {
    id: number;
    name: string;
    subdomain: string;
    email: string;
    phone: string | null;
    status: number;
    institute_type: string | null;
    logo: string | null;
    created_at: string;
}

export default function InstitutesPage() {
    const router = useRouter();
    const toast = useRef<Toast>(null);
    const [tenants, setTenants] = useState<Tenant[]>([]);
    const [selectedTenants, setSelectedTenants] = useState<Tenant[]>([]);
    const [globalFilter, setGlobalFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState<number | null>(null);
    const [loading, setLoading] = useState(true);
    const [togglingId, setTogglingId] = useState<number | null>(null);
    const [user, setUser] = useState<User | null>(null);

    const statusOptions = [
        { label: 'All Status', value: null },
        { label: 'Active', value: 1 },
        { label: 'Inactive', value: 0 },
    ];

    useEffect(() => {
        fetchData();
    }, []);

    const fetchData = async () => {
        try {
            const userRes = await authService.me();
            if (userRes.success && userRes.data) {
                setUser(userRes.data as unknown as User);
            }

            const tenantRes = await tenantAdminService.getAll();
            if (tenantRes.success) {
                setTenants(tenantRes.data?.data || tenantRes.data || []);
            }
        } catch (error) {
            console.error('Error fetching tenants:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleToggleStatus = async (id: number, currentStatus: number) => {
        const newStatus = currentStatus === 1 ? 0 : 1;
        setTogglingId(id);
        try {
            const res = await tenantAdminService.toggleStatus(id, newStatus);
            if (res.success !== false) {
                setTenants(prev =>
                    prev.map(t => (t.id === id ? { ...t, status: newStatus } : t))
                );
                toast.current?.show({
                    severity: newStatus === 1 ? 'success' : 'warn',
                    summary: newStatus === 1 ? 'Activated' : 'Deactivated',
                    detail: `Institute ${newStatus === 1 ? 'activated' : 'deactivated'} successfully`,
                    life: 3000,
                });
            } else {
                toast.current?.show({
                    severity: 'error',
                    summary: 'Error',
                    detail: res.message || 'Failed to update status',
                    life: 3000,
                });
            }
        } catch {
            toast.current?.show({
                severity: 'error',
                summary: 'Error',
                detail: 'Failed to update status. Please try again.',
                life: 3000,
            });
        } finally {
            setTogglingId(null);
        }
    };

    const nameTemplate = (rowData: Tenant) => (
        <div className="flex align-items-center gap-2">
            {rowData.logo ? (
                <img
                    src={rowData.logo}
                    alt={rowData.name}
                    style={{ width: '32px', height: '32px', borderRadius: '4px', objectFit: 'cover' }}
                />
            ) : (
                <i className="pi pi-building" style={{ fontSize: '1.5rem' }} />
            )}
            <div>
                <div className="font-medium">{rowData.name}</div>
                <div className="text-sm text-500">{rowData.subdomain}.paathshala.local</div>
            </div>
        </div>
    );

    const contactTemplate = (rowData: Tenant) => (
        <div>
            <div className="text-sm">{rowData.email}</div>
            {rowData.phone && <div className="text-sm text-500">{rowData.phone}</div>}
        </div>
    );

    const statusTemplate = (rowData: Tenant) => (
        <Tag
            value={rowData.status === 1 ? 'Active' : 'Inactive'}
            severity={rowData.status === 1 ? 'success' : 'danger'}
        />
    );

    const actionsTemplate = (rowData: Tenant) => {
        const isToggling = togglingId === rowData.id;
        const isActive = rowData.status === 1;
        return (
            <div className="flex gap-2">
                <Button
                    icon="pi pi-eye"
                    className="p-button-text p-button-sm"
                    onClick={() => router.push(`/main/institutes/${rowData.id}`)}
                    tooltip="View"
                    tooltipOptions={{ position: 'top' }}
                />
                <Button
                    icon="pi pi-pencil"
                    className="p-button-text p-button-sm"
                    onClick={() => router.push(`/main/institutes/${rowData.id}/edit`)}
                    tooltip="Edit"
                    tooltipOptions={{ position: 'top' }}
                />
                <Button
                    icon={isToggling ? 'pi pi-spin pi-spinner' : isActive ? 'pi pi-ban' : 'pi pi-check-circle'}
                    className={`p-button-text p-button-sm ${isActive ? 'p-button-danger' : 'p-button-success'}`}
                    onClick={() => handleToggleStatus(rowData.id, rowData.status)}
                    tooltip={isActive ? 'Deactivate' : 'Activate'}
                    tooltipOptions={{ position: 'top' }}
                    disabled={isToggling}
                />
            </div>
        );
    };

    const dateTemplate = (rowData: Tenant) => (
        <span className="text-sm">
            {new Date(rowData.created_at).toLocaleDateString('en-IN', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
            })}
        </span>
    );

    const filteredTenants = tenants.filter((tenant) => {
        if (statusFilter !== null && tenant.status !== statusFilter) return false;
        if (globalFilter) {
            const search = globalFilter.toLowerCase();
            return (
                tenant.name.toLowerCase().includes(search) ||
                tenant.email.toLowerCase().includes(search) ||
                tenant.subdomain.toLowerCase().includes(search)
            );
        }
        return true;
    });

    const header = (
        <div className="flex flex-column md:flex-row gap-2 md:align-items-center justify-content-between">
            <div className="flex gap-2">
                <span className="p-input-icon-left">
                    <i className="pi pi-search" />
                    <InputText
                        value={globalFilter}
                        onChange={(e) => setGlobalFilter(e.target.value)}
                        placeholder="Search institutes..."
                        className="p-inputtext-sm"
                    />
                </span>
                <Dropdown
                    value={statusFilter}
                    options={statusOptions}
                    onChange={(e) => setStatusFilter(e.value)}
                    placeholder="Filter by status"
                    className="p-dropdown-sm"
                />
            </div>
            <Button
                label="Onboard New Institute"
                icon="pi pi-plus"
                onClick={() => router.push('/main/institutes/new')}
            />
        </div>
    );

    if (loading) {
        return (
            <div className="flex align-items-center justify-content-center min-h-screen">
                <i className="pi pi-spin pi-spinner text-4xl" />
            </div>
        );
    }

    return (
        <div className="card">
            <Toast ref={toast} />
            <h1 className="text-3xl font-bold mb-4">Institutes</h1>
            <DataTable
                value={filteredTenants}
                selection={selectedTenants}
                onSelectionChange={(e) => setSelectedTenants(e.value)}
                dataKey="id"
                paginator
                rows={10}
                rowsPerPageOptions={[5, 10, 25, 50]}
                header={header}
                emptyMessage="No institutes found."
                className="p-datatable-sm"
                showGridlines
                selectionMode="multiple"
            >
                <Column selectionMode="multiple" headerStyle={{ width: '3rem' }} />
                <Column field="name" header="Institute" body={nameTemplate} sortable />
                <Column field="email" header="Contact" body={contactTemplate} sortable />
                <Column field="institute_type" header="Type" sortable />
                <Column field="created_at" header="Created" body={dateTemplate} sortable />
                <Column field="status" header="Status" body={statusTemplate} sortable />
                <Column header="Actions" body={actionsTemplate} style={{ width: '10rem' }} />
            </DataTable>
        </div>
    );
}
