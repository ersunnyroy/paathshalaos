'use client';

import { useState, useEffect } from 'react';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { branchService } from '@/services/api';
import { parseApiErrors } from '@/lib/formErrors';

interface Branch {
    id: number;
    name: string;
    slug: string;
    subdomain: string;
    email?: string;
    phone?: string;
    address?: string;
    status: number;
}

const statusOptions = [
    { label: 'Active', value: 1 },
    { label: 'Inactive', value: 0 },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function BranchesPage() {
    const [branches, setBranches] = useState<Branch[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogVisible, setDialogVisible] = useState(false);
    const [saving, setSaving] = useState(false);
    const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
    const [formData, setFormData] = useState({
        name: '',
        subdomain: '',
        email: '',
        phone: '',
        address: '',
        status: 1,
    });
    const [errors, setErrors] = useState<Record<string, string>>({});

    useEffect(() => {
        loadBranches();
    }, []);

    const loadBranches = async () => {
        setLoading(true);
        try {
            const response = await branchService.getAll();
            if (response.success && response.data) {
                setBranches(response.data as Branch[]);
            }
        } catch (error) {
            console.error('Error loading branches:', error);
        } finally {
            setLoading(false);
        }
    };

    const openNew = () => {
        setEditingBranch(null);
        setFormData({ name: '', subdomain: '', email: '', phone: '', address: '', status: 1 });
        setErrors({});
        setDialogVisible(true);
    };

    const openEdit = (branch: Branch) => {
        setEditingBranch(branch);
        setFormData({
            name: branch.name,
            subdomain: branch.subdomain ?? '',
            email: branch.email ?? '',
            phone: branch.phone ?? '',
            address: branch.address ?? '',
            status: branch.status,
        });
        setErrors({});
        setDialogVisible(true);
    };

    const validate = (): boolean => {
        const e: Record<string, string> = {};
        if (!formData.name.trim()) e.name = 'Branch name is required.';
        if (formData.email && !EMAIL_RE.test(formData.email)) e.email = 'Please enter a valid email address.';
        if (formData.phone && formData.phone.length > 20) e.phone = 'Phone number must not exceed 20 characters.';
        setErrors(e);
        return Object.keys(e).length === 0;
    };

    const handleSave = async () => {
        if (!validate()) return;
        setSaving(true);
        try {
            const payload = {
                ...formData,
                email: formData.email || undefined,
                subdomain: formData.subdomain || undefined,
                phone: formData.phone || undefined,
                address: formData.address || undefined,
            };
            const response = editingBranch
                ? await branchService.update(editingBranch.id, payload)
                : await branchService.create(payload);

            if (response.success) {
                loadBranches();
                setDialogVisible(false);
            } else if (response.errors) {
                setErrors(parseApiErrors(response.errors));
            }
        } catch (error) {
            console.error('Error saving branch:', error);
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = (branch: Branch) => {
        if (!confirm(`Are you sure you want to delete "${branch.name}"?`)) return;
        branchService.delete(branch.id).then(() => loadBranches());
    };

    const field = (key: keyof typeof formData) => ({
        value: formData[key] as string,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            setFormData({ ...formData, [key]: e.target.value });
            if (errors[key]) setErrors({ ...errors, [key]: '' });
        },
        className: `w-full${errors[key] ? ' p-invalid' : ''}`,
    });

    return (
        <div className="surface-card p-4 shadow-2 border-round">
            <div className="flex justify-content-between align-items-center mb-4">
                <h2 className="text-xl font-medium m-0">Branches</h2>
                <Button label="Add Branch" icon="pi pi-plus" onClick={openNew} />
            </div>

            <DataTable
                value={branches}
                loading={loading}
                paginator
                rows={10}
                emptyMessage="No branches found"
                className="p-datatable-sm"
            >
                <Column field="name" header="Name" sortable />
                <Column field="subdomain" header="Subdomain" sortable />
                <Column field="email" header="Email" />
                <Column field="phone" header="Phone" />
                <Column
                    field="status"
                    header="Status"
                    body={(row: Branch) => (
                        <span className={row.status === 1 ? 'text-green-600' : 'text-500'}>
                            {row.status === 1 ? 'Active' : 'Inactive'}
                        </span>
                    )}
                    sortable
                />
                <Column
                    header="Actions"
                    body={(row: Branch) => (
                        <div className="flex gap-2">
                            <Button icon="pi pi-pencil" className="p-button-text p-button-sm" onClick={() => openEdit(row)} />
                            <Button icon="pi pi-trash" className="p-button-text p-button-danger p-button-sm" onClick={() => handleDelete(row)} />
                        </div>
                    )}
                    style={{ width: '8rem' }}
                />
            </DataTable>

            <Dialog
                visible={dialogVisible}
                onHide={() => setDialogVisible(false)}
                header={editingBranch ? 'Edit Branch' : 'Add Branch'}
                style={{ width: '32rem' }}
            >
                <div className="flex flex-column gap-3">
                    <div>
                        <label className="block text-sm font-medium mb-1">Name <span className="text-red-500">*</span></label>
                        <InputText {...field('name')} placeholder="e.g. Main Campus" />
                        <small className="p-error field-error-hint">{errors.name}</small>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Subdomain</label>
                        <InputText {...field('subdomain')} placeholder="e.g. main-campus" />
                        <small className="p-error field-error-hint">{errors.subdomain}</small>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Email</label>
                        <InputText {...field('email')} placeholder="branch@school.com" />
                        <small className="p-error field-error-hint">{errors.email}</small>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Phone</label>
                        <InputText {...field('phone')} placeholder="+91 98765 43210" />
                        <small className="p-error field-error-hint">{errors.phone}</small>
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Address</label>
                        <InputText {...field('address')} placeholder="Full address" />
                        <small className="p-error field-error-hint">{errors.address}</small>
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
        </div>
    );
}
