'use client';

import { useState, useEffect } from 'react';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { Checkbox } from 'primereact/checkbox';
import { roleService, permissionService } from '@/services/api';
import { parseApiErrors } from '@/lib/formErrors';

interface Role {
    id: number;
    name: string;
    slug: string;
    description?: string;
    is_default: number;
    status: number;
}

interface Permission {
    id: number;
    name: string;
    slug: string;
    module?: string;
}

const statusOptions = [
    { label: 'Active', value: 1 },
    { label: 'Inactive', value: 0 },
];

export default function RolesPage() {
    const [roles, setRoles] = useState<Role[]>([]);
    const [permissions, setPermissions] = useState<Permission[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogVisible, setDialogVisible] = useState(false);
    const [permissionDialogVisible, setPermissionDialogVisible] = useState(false);
    const [saving, setSaving] = useState(false);
    const [editingRole, setEditingRole] = useState<Role | null>(null);
    const [selectedPermissions, setSelectedPermissions] = useState<number[]>([]);
    const [formData, setFormData] = useState({ name: '', description: '', is_default: 0, status: 1 });
    const [errors, setErrors] = useState<Record<string, string>>({});

    useEffect(() => {
        loadData();
    }, []);

    const loadData = async () => {
        setLoading(true);
        try {
            const [rolesRes, permsRes] = await Promise.all([roleService.getAll(), permissionService.getAll()]);
            if (rolesRes.success && rolesRes.data) setRoles(rolesRes.data as Role[]);
            if (permsRes.success && permsRes.data) setPermissions(permsRes.data as Permission[]);
        } catch (error) {
            console.error('Error loading data:', error);
        } finally {
            setLoading(false);
        }
    };

    const openNew = () => {
        setEditingRole(null);
        setFormData({ name: '', description: '', is_default: 0, status: 1 });
        setErrors({});
        setDialogVisible(true);
    };

    const openEdit = (role: Role) => {
        setEditingRole(role);
        setFormData({ name: role.name, description: role.description ?? '', is_default: role.is_default, status: role.status });
        setErrors({});
        setDialogVisible(true);
    };

    const openPermissions = (role: Role) => {
        setEditingRole(role);
        setSelectedPermissions([]);
        setPermissionDialogVisible(true);
    };

    const validate = (): boolean => {
        const e: Record<string, string> = {};
        if (!formData.name.trim()) e.name = 'Role name is required.';
        if (formData.name.length > 255) e.name = 'Role name must not exceed 255 characters.';
        setErrors(e);
        return Object.keys(e).length === 0;
    };

    const handleSave = async () => {
        if (!validate()) return;
        setSaving(true);
        try {
            const response = editingRole
                ? await roleService.update(editingRole.id, formData)
                : await roleService.create(formData);

            if (response.success) {
                loadData();
                setDialogVisible(false);
            } else if (response.errors) {
                setErrors(parseApiErrors(response.errors));
            }
        } catch (error) {
            console.error('Error saving role:', error);
        } finally {
            setSaving(false);
        }
    };

    const handlePermissionSave = async () => {
        if (!editingRole) return;
        try {
            const response = await roleService.assignPermissions(editingRole.id, selectedPermissions);
            if (response.success) setPermissionDialogVisible(false);
        } catch (error) {
            console.error('Error assigning permissions:', error);
        }
    };

    const handleDelete = (role: Role) => {
        if (confirm(`Are you sure you want to delete "${role.name}"?`)) {
            roleService.delete(role.id).then(() => loadData());
        }
    };

    const groupedPermissions = permissions.reduce((acc, perm) => {
        const mod = perm.module || 'Other';
        if (!acc[mod]) acc[mod] = [];
        acc[mod].push(perm);
        return acc;
    }, {} as Record<string, Permission[]>);

    return (
        <div className="surface-card p-4 shadow-2 border-round">
            <div className="flex justify-content-between align-items-center mb-4">
                <h2 className="text-xl font-medium m-0">Roles & Permissions</h2>
                <Button label="Add Role" icon="pi pi-plus" onClick={openNew} />
            </div>

            <DataTable value={roles} loading={loading} paginator rows={10} emptyMessage="No roles found" className="p-datatable-sm">
                <Column field="name" header="Name" sortable />
                <Column field="slug" header="Slug" sortable />
                <Column field="description" header="Description" />
                <Column field="is_default" header="Default" body={(row: Role) => row.is_default ? 'Yes' : 'No'} sortable />
                <Column
                    field="status"
                    header="Status"
                    body={(row: Role) => (
                        <span className={row.status === 1 ? 'text-green-600' : 'text-500'}>
                            {row.status === 1 ? 'Active' : 'Inactive'}
                        </span>
                    )}
                    sortable
                />
                <Column
                    header="Actions"
                    body={(row: Role) => (
                        <div className="flex gap-2">
                            <Button icon="pi pi-key" className="p-button-text p-button-sm" title="Permissions" onClick={() => openPermissions(row)} />
                            <Button icon="pi pi-pencil" className="p-button-text p-button-sm" onClick={() => openEdit(row)} />
                            <Button icon="pi pi-trash" className="p-button-text p-button-danger p-button-sm" onClick={() => handleDelete(row)} />
                        </div>
                    )}
                    style={{ width: '10rem' }}
                />
            </DataTable>

            {/* Role Dialog */}
            <Dialog
                visible={dialogVisible}
                onHide={() => setDialogVisible(false)}
                header={editingRole ? 'Edit Role' : 'Add Role'}
                style={{ width: '32rem' }}
            >
                <div className="flex flex-column gap-3">
                    <div>
                        <label className="block text-sm font-medium mb-1">Name <span className="text-red-500">*</span></label>
                        <InputText
                            value={formData.name}
                            onChange={(e) => {
                                setFormData({ ...formData, name: e.target.value });
                                if (errors.name) setErrors({ ...errors, name: '' });
                            }}
                            className={`w-full${errors.name ? ' p-invalid' : ''}`}
                            placeholder="e.g. Class Teacher"
                        />
                        <small className="p-error field-error-hint">{errors.name}</small>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Description</label>
                        <InputText
                            value={formData.description}
                            onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                            className="w-full"
                            placeholder="Brief description of this role"
                        />
                    </div>
                    <div className="flex align-items-center gap-2">
                        <Checkbox
                            inputId="is_default"
                            checked={formData.is_default === 1}
                            onChange={(e) => setFormData({ ...formData, is_default: e.checked ? 1 : 0 })}
                        />
                        <label htmlFor="is_default">Set as default role for new users</label>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Status</label>
                        <Dropdown
                            value={formData.status}
                            options={statusOptions}
                            onChange={(e) => setFormData({ ...formData, status: e.value })}
                            className="w-full"
                        />
                    </div>
                    <div className="flex justify-content-end gap-2 mt-2">
                        <Button label="Cancel" className="p-button-text" onClick={() => setDialogVisible(false)} />
                        <Button label="Save" onClick={handleSave} loading={saving} />
                    </div>
                </div>
            </Dialog>

            {/* Permissions Dialog */}
            <Dialog
                visible={permissionDialogVisible}
                onHide={() => setPermissionDialogVisible(false)}
                header={`Permissions — ${editingRole?.name}`}
                style={{ width: '40rem' }}
            >
                <div className="flex flex-column gap-3">
                    {Object.entries(groupedPermissions).map(([mod, perms]) => (
                        <div key={mod}>
                            <div className="text-base font-semibold mb-2 text-700">{mod}</div>
                            <div className="flex flex-wrap gap-3">
                                {perms.map((perm) => (
                                    <div key={perm.id} className="flex align-items-center">
                                        <Checkbox
                                            inputId={`perm-${perm.id}`}
                                            value={perm.id}
                                            checked={selectedPermissions.includes(perm.id)}
                                            onChange={(e) => {
                                                setSelectedPermissions(e.checked
                                                    ? [...selectedPermissions, perm.id]
                                                    : selectedPermissions.filter((id) => id !== perm.id)
                                                );
                                            }}
                                        />
                                        <label htmlFor={`perm-${perm.id}`} className="ml-2">{perm.name}</label>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ))}
                    <div className="flex justify-content-end gap-2 mt-3">
                        <Button label="Cancel" className="p-button-text" onClick={() => setPermissionDialogVisible(false)} />
                        <Button label="Save Permissions" onClick={handlePermissionSave} />
                    </div>
                </div>
            </Dialog>
        </div>
    );
}
