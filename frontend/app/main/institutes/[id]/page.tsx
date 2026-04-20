'use client';

import { useEffect, useState, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { Button } from 'primereact/button';
import { Tag } from 'primereact/tag';
import { TabView, TabPanel } from 'primereact/tabview';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Avatar } from 'primereact/avatar';
import { ProgressSpinner } from 'primereact/progressspinner';
import { classNames } from 'primereact/utils';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Password } from 'primereact/password';
import { Toast } from 'primereact/toast';
import { branchService, tenantAdminService, userService, roleService, api } from '@/services/api';

interface Tenant {
    id: number;
    name: string;
    slug: string;
    subdomain: string;
    email: string;
    phone: string | null;
    address: string | null;
    address_line1: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    status: number;
    institute_type: string | null;
    country: string | null;
    timezone: string | null;
    currency: string | null;
    website: string | null;
    board: string | null;
    medium: string | null;
    established_year: string | null;
    created_at: string;
    updated_at: string;
}

interface Branch {
    id: number;
    name: string;
    subdomain: string;
    email: string | null;
    phone: string | null;
    address: string | null;
    status: number;
}

interface UserData {
    id: number;
    name: string;
    email: string;
    phone: string | null;
    status: number;
    roles?: Array<{ name: string; slug: string }>;
    created_at?: string;
}

interface Role {
    id: number;
    name: string;
    slug: string;
}

const getSeverity = (status: number) => {
    return status === 1 ? 'success' : 'danger';
};

const getStatusLabel = (status: number) => {
    return status === 1 ? 'Active' : 'Inactive';
};

const instituteTypeOptions = [
    { label: 'School', value: 'school', icon: 'pi pi-building' },
    { label: 'College', value: 'college', icon: 'pi pi-book' },
    { label: 'University', value: 'university', icon: 'pi pi-verified' },
    { label: 'Coaching', value: 'coaching', icon: 'pi pi-users' },
    { label: 'Pre-School', value: 'preschool', icon: 'pi pi-heart' },
];

const getInstituteTypeIcon = (type: string | null) => {
    const found = instituteTypeOptions.find(t => t.value === type);
    return found?.icon || 'pi pi-building';
};

const getInitials = (name: string) => {
    return name
        .split(' ')
        .map(word => word[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
};

const formatDate = (dateStr: string) => {
    if (!dateStr) return '-';
    return new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });
};

const InfoCard = ({ title, children, icon, action }: { title: string; children: React.ReactNode; icon?: string; action?: React.ReactNode }) => (
    <div className="surface-card shadow-2 border-round-xl p-4 h-full dark:surface-800">
        <div className="flex align-items-center justify-content-between mb-3">
            <div className="flex align-items-center gap-2">
                {icon && <i className={classNames('pi', icon, 'text-xl')} style={{ color: 'var(--primary-color)' }} />}
                <span className="text-lg font-semibold">{title}</span>
            </div>
            {action}
        </div>
        {children}
    </div>
);

const InfoRow = ({ label, value, highlight }: { label: string; value: string | React.ReactNode; highlight?: boolean }) => (
    <div className="flex align-items-center justify-content-between py-2 border-bottom-1 surface-border dark:border-bluegray-700">
        <span className="text-500 dark:text-bluegray-400">{label}</span>
        {typeof value === 'string' ? (
            <span className={classNames(highlight && 'font-bold')} style={highlight ? { color: 'var(--primary-color)' } : undefined}>{value || '-'}</span>
        ) : value}
    </div>
);

const UserAvatar = ({ name, size = 'normal' }: { name: string; size?: 'normal' | 'large' | 'xlarge' }) => {
    return (
        <Avatar label={getInitials(name)} size={size} shape="circle" className="bg-blue-100 text-blue-600" />
    );
};

export default function InstituteDetailPage() {
    const router = useRouter();
    const params = useParams();
    const toast = useRef<Toast>(null);
    const [tenant, setTenant] = useState<Tenant | null>(null);
    const [branches, setBranches] = useState<Branch[]>([]);
    const [users, setUsers] = useState<UserData[]>([]);
    const [roles, setRoles] = useState<Role[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeIndex, setActiveIndex] = useState(0);

    const [userDialog, setUserDialog] = useState(false);
    const [userForm, setUserForm] = useState({ name: '', email: '', phone: '', role_id: null as number | null, password: '' });
    const [userSubmitting, setUserSubmitting] = useState(false);
    const [editUserDialog, setEditUserDialog] = useState(false);
    const [selectedUser, setSelectedUser] = useState<UserData | null>(null);

    const tenantId = parseInt(params.id as string);

    useEffect(() => {
        fetchTenant();
    }, [tenantId]);

    const fetchTenant = async () => {
        try {
            const response = await tenantAdminService.getById(tenantId);
            if (response.success && response.data) {
                setTenant(response.data as unknown as Tenant);
            }

            const branchesRes = await branchService.getAll({ tenant_id: String(tenantId) });
            if (branchesRes.success) {
                setBranches(branchesRes.data || []);
            }

            const usersRes = await userService.getAll({ tenant_id: String(tenantId) });
            if (usersRes.success) {
                setUsers(usersRes.data || []);
            }

            const rolesRes = await roleService.getAll({ tenant_id: String(tenantId) });
            if (rolesRes.success) {
                setRoles(rolesRes.data || []);
            }
        } catch (error) {
            console.error('Error fetching data:', error);
        } finally {
            setLoading(false);
        }
    };

    const handleToggleStatus = async () => {
        if (!tenant) return;
        const newStatus = tenant.status === 1 ? 0 : 1;
        try {
            await tenantAdminService.toggleStatus(tenantId, newStatus);
            setTenant({ ...tenant, status: newStatus });
            toast.current?.show({ severity: 'success', summary: 'Success', detail: 'Status updated' });
        } catch (error) {
            toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to update status' });
            console.error('Error toggling status:', error);
        }
    };

    const openAddUser = () => {
        setUserForm({ name: '', email: '', phone: '', role_id: null, password: '' });
        setUserDialog(true);
    };

    const saveUser = async () => {
        if (!userForm.name || !userForm.email || !userForm.password || !userForm.role_id) {
            toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Please fill all required fields' });
            return;
        }
        setUserSubmitting(true);
        try {
            const res = await userService.create({
                ...userForm,
                tenant_id: tenantId,
            });
            if (res.success) {
                setUserDialog(false);
                setUsers(prev => [...prev, res.data]);
                toast.current?.show({ severity: 'success', summary: 'Success', detail: 'User created successfully' });
            } else {
                toast.current?.show({ severity: 'error', summary: 'Error', detail: res.message });
            }
        } catch (error: any) {
            toast.current?.show({ severity: 'error', summary: 'Error', detail: error.message });
        } finally {
            setUserSubmitting(false);
        }
    };

    const branchStatusBodyTemplate = (rowData: Branch) => (
        <Tag value={getStatusLabel(rowData.status)} severity={getSeverity(rowData.status)} />
    );

    const userStatusBodyTemplate = (rowData: UserData) => (
        <Tag value={getStatusLabel(rowData.status)} severity={getSeverity(rowData.status)} />
    );

    const userNameBodyTemplate = (rowData: UserData) => (
        <div className="flex align-items-center gap-2">
            <Avatar label={getInitials(rowData.name)} size="normal" shape="circle" className="bg-blue-100 text-blue-600" />
            <div>
                <span className="font-medium">{rowData.name}</span>
                <div className="text-xs text-500 dark:text-bluegray-400">{rowData.email}</div>
            </div>
        </div>
    );

    const rolesBodyTemplate = (rowData: UserData) => (
        <div className="flex gap-1 flex-wrap">
            {rowData.roles?.map((role, idx) => (
                <Tag key={idx} value={role.name} severity="info" />
            )) || <span className="text-500">-</span>}
        </div>
    );

    const createdAtBodyTemplate = (rowData: UserData) => (
        <span className="text-500">{rowData.created_at ? formatDate(rowData.created_at) : '-'}</span>
    );

    const userActionsBodyTemplate = (rowData: UserData) => (
        <div className="flex gap-1">
            <Button 
                icon="pi pi-eye" 
                className="p-button-text p-button-sm" 
                tooltip="View"
                onClick={() => {
                    setSelectedUser(rowData);
                    setEditUserDialog(true);
                }}
            />
            <Button 
                icon="pi pi-pencil" 
                className="p-button-text p-button-sm" 
                tooltip="Edit"
                onClick={() => {
                    setSelectedUser(rowData);
                    setUserForm({
                        name: rowData.name,
                        email: rowData.email,
                        phone: rowData.phone || '',
                        role_id: null,
                        password: ''
                    });
                    setEditUserDialog(false);
                    setUserDialog(true);
                }}
            />
        </div>
    );

    if (loading) {
        return (
            <div className="flex align-items-center justify-content-center min-h-screen">
                <ProgressSpinner />
            </div>
        );
    }

    if (!tenant) {
        return (
            <div className="text-center p-5">
                <h2>Institute not found</h2>
                <Button label="Back to Institutes" onClick={() => router.push('/main/institutes')} />
            </div>
        );
    }

    return (
        <div className="surface-ground px-3 py-4 md:px-5 lg:px-6 min-h-full dark:bg-surface-900">
            <div className="flex flex-column md:flex-row align-items-start md:align-items-center justify-content-between gap-4 mb-4">
                <div className="flex align-items-center gap-4">
                    <div className="surface-ground dark:bg-surface-800 border-circle w-4rem h-4rem flex align-items-center justify-content-center">
                        <i className={classNames('pi text-2xl', getInstituteTypeIcon(tenant.institute_type))} style={{ color: 'var(--primary-color)' }} />
                    </div>
                    <div>
                        <div className="flex align-items-center gap-2">
                            <h1 className="text-2xl font-bold m-0 dark:text-white">{tenant.name}</h1>
                            <Tag value={getStatusLabel(tenant.status)} severity={getSeverity(tenant.status)} />
                        </div>
                        <div className="text-500 mt-1 flex align-items-center gap-2 dark:text-bluegray-400">
                            <i className="pi pi-globe text-sm" />
                            {tenant.subdomain}.paathshalaos.com
                        </div>
                    </div>
                </div>
                <div className="flex gap-2">
                    <Button
                        label={tenant.status === 1 ? 'Deactivate' : 'Activate'}
                        icon={tenant.status === 1 ? 'pi pi-ban' : 'pi pi-check'}
                        severity={tenant.status === 1 ? 'danger' : 'success'}
                        onClick={handleToggleStatus}
                    />
                    <Button
                        label="Edit"
                        icon="pi pi-pencil"
                        outlined
                        onClick={() => router.push(`/main/institutes/${tenantId}/edit`)}
                    />
                    <Button
                        icon="pi pi-arrow-left"
                        className="p-button-text"
                        onClick={() => router.push('/main/institutes')}
                        tooltip="Back to Institutes"
                        tooltipOptions={{ position: 'top' }}
                    />
                </div>
            </div>

            <TabView activeIndex={activeIndex} onTabChange={(e) => setActiveIndex(e.index)}>
                <TabPanel header="Overview" leftIcon="pi pi-info-circle mr-2">
                    <div className="grid">
                        <div className="col-12 md:col-6 lg:col-4">
                            <InfoCard title="Institute Details" icon="pi pi-building">
                                <InfoRow label="Type" value={tenant.institute_type || '-'} />
                                <InfoRow label="Board/Affiliation" value={tenant.board || '-'} />
                                <InfoRow label="Medium" value={tenant.medium || '-'} />
                                <InfoRow label="Established" value={tenant.established_year || '-'} />
                                <InfoRow label="Created" value={formatDate(tenant.created_at)} />
                            </InfoCard>
                        </div>
                        <div className="col-12 md:col-6 lg:col-4">
                            <InfoCard title="Contact Information" icon="pi pi-phone">
                                <InfoRow label="Email" value={tenant.email} highlight />
                                <InfoRow label="Phone" value={tenant.phone || '-'} />
                                <InfoRow label="Website" value={tenant.website || '-'} />
                            </InfoCard>
                        </div>
                        <div className="col-12 md:col-6 lg:col-4">
                            <InfoCard title="Location & Settings" icon="pi pi-map-marker">
                                <InfoRow label="Country" value={tenant.country || '-'} />
                                <InfoRow label="State" value={tenant.state || '-'} />
                                <InfoRow label="City" value={tenant.city || '-'} />
                                <InfoRow label="Postal Code" value={tenant.postal_code || '-'} />
                                <InfoRow label="Timezone" value={tenant.timezone || '-'} />
                                <InfoRow label="Currency" value={tenant.currency || '-'} />
                            </InfoCard>
                        </div>
                    </div>
                </TabPanel>

                <TabPanel header="Branches" leftIcon="pi pi-map mr-2">
                    <div className="mb-3 flex justify-content-end">
                        <Button label="Add Branch" icon="pi pi-plus" size="small" />
                    </div>
                    <div className="surface-card shadow-2 border-round dark:bg-surface-800">
                        <DataTable value={branches} emptyMessage="No branches yet" stripedRows>
                            <Column field="name" header="Branch Name" sortable />
                            <Column field="subdomain" header="Subdomain" />
                            <Column field="email" header="Email" />
                            <Column field="phone" header="Phone" />
                            <Column field="status" header="Status" body={branchStatusBodyTemplate} sortable />
                            <Column header="Actions" body={() => (
                                <div className="flex gap-1">
                                    <Button icon="pi pi-eye" className="p-button-text p-button-sm" tooltip="View" />
                                    <Button icon="pi pi-pencil" className="p-button-text p-button-sm" tooltip="Edit" />
                                </div>
                            )} />
                        </DataTable>
                    </div>
                </TabPanel>

                <TabPanel header="Users" leftIcon="pi pi-users mr-2">
                    <div className="mb-3 flex justify-content-end">
                        <Button label="Add User" icon="pi pi-plus" size="small" onClick={openAddUser} />
                    </div>
                    <div className="surface-card shadow-2 border-round dark:bg-surface-800">
                        <DataTable value={users} emptyMessage="No users yet" stripedRows>
                            <Column header="User" body={userNameBodyTemplate} sortable field="name" />
                            <Column field="email" header="Email" sortable />
                            <Column field="phone" header="Phone" />
                            <Column header="Roles" body={rolesBodyTemplate} />
                            <Column field="status" header="Status" body={userStatusBodyTemplate} sortable />
                            <Column header="Joined" body={createdAtBodyTemplate} sortable field="created_at" />
                            <Column header="Actions" body={userActionsBodyTemplate} />
                        </DataTable>
                    </div>
                </TabPanel>
            </TabView>

            <Toast ref={toast} />
            <Dialog visible={userDialog} onHide={() => setUserDialog(false)} header={editUserDialog ? "Edit User" : "Add User"} modal className="w-full sm:w-30rem">
                <div className="flex flex-column gap-3">
                    <div className="flex flex-column gap-1">
                        <label htmlFor="name">Name *</label>
                        <InputText
                            id="name"
                            value={userForm.name}
                            onChange={(e) => setUserForm({ ...userForm, name: e.target.value })}
                            className="w-full"
                        />
                    </div>
                    <div className="flex flex-column gap-1">
                        <label htmlFor="email">Email *</label>
                        <InputText
                            id="email"
                            type="email"
                            value={userForm.email}
                            onChange={(e) => setUserForm({ ...userForm, email: e.target.value })}
                            className="w-full"
                        />
                    </div>
                    <div className="flex flex-column gap-1">
                        <label htmlFor="phone">Phone</label>
                        <InputText
                            id="phone"
                            value={userForm.phone}
                            onChange={(e) => setUserForm({ ...userForm, phone: e.target.value })}
                            className="w-full"
                        />
                    </div>
                    <div className="flex flex-column gap-1">
                        <label htmlFor="role">Role *</label>
                        <Dropdown
                            id="role"
                            value={userForm.role_id}
                            options={roles.map(r => ({ label: r.name, value: r.id }))}
                            onChange={(e) => setUserForm({ ...userForm, role_id: e.value })}
                            className="w-full"
                            placeholder="Select Role"
                        />
                    </div>
                    {!editUserDialog && (
                        <div className="flex flex-column gap-1">
                            <label htmlFor="password">Password *</label>
                            <Password
                                id="password"
                                value={userForm.password}
                                onChange={(e) => setUserForm({ ...userForm, password: e.target.value })}
                                className="w-full"
                                inputClassName="w-full"
                                feedback={false}
                            />
                        </div>
                    )}
                    <div className="flex justify-content-end gap-2 mt-2">
                        <Button label="Cancel" severity="secondary" outlined onClick={() => {
                            setUserDialog(false);
                            setEditUserDialog(false);
                        }} />
                        <Button label="Save" icon="pi pi-check" onClick={saveUser} loading={userSubmitting} />
                    </div>
                </div>
            </Dialog>

            <Dialog visible={editUserDialog && !!selectedUser} onHide={() => {
                setEditUserDialog(false);
                setSelectedUser(null);
            }} header="User Details" modal className="w-full sm:w-30rem">
                {selectedUser && (
                    <div className="flex flex-column gap-3">
                        <div className="flex align-items-center gap-3">
                            <Avatar label={getInitials(selectedUser.name)} size="large" shape="circle" className="bg-blue-100 text-blue-600" />
                            <div>
                                <div className="text-xl font-bold">{selectedUser.name}</div>
                                <div className="text-500">{selectedUser.email}</div>
                            </div>
                        </div>
                        <div className="grid">
                            <div className="col-6">
                                <div className="text-500 text-sm">Phone</div>
                                <div>{selectedUser.phone || '-'}</div>
                            </div>
                            <div className="col-6">
                                <div className="text-500 text-sm">Status</div>
                                <Tag value={selectedUser.status === 1 ? 'Active' : 'Inactive'} severity={selectedUser.status === 1 ? 'success' : 'danger'} />
                            </div>
                        </div>
                        <div>
                            <div className="text-500 text-sm">Roles</div>
                            <div className="flex gap-1 flex-wrap">
                                {selectedUser.roles?.map((role, idx) => (
                                    <Tag key={idx} value={role.name} severity="info" />
                                )) || <span>-</span>}
                            </div>
                        </div>
                        <div className="flex justify-content-end gap-2 mt-2">
                            <Button label="Close" severity="secondary" outlined onClick={() => {
                                setEditUserDialog(false);
                                setSelectedUser(null);
                            }} />
                        </div>
                    </div>
                )}
            </Dialog>
        </div>
    );
}