'use client';

import { useState, useEffect } from 'react';
import { DataTable } from 'primereact/datatable';
import { Column } from 'primereact/column';
import { Button } from 'primereact/button';
import { Dialog } from 'primereact/dialog';
import { InputText } from 'primereact/inputtext';
import { Dropdown } from 'primereact/dropdown';
import { branchService } from '@/services/api';

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

export default function BranchesPage() {
    const [branches, setBranches] = useState<Branch[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogVisible, setDialogVisible] = useState(false);
    const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
    const [formData, setFormData] = useState({
        name: '',
        subdomain: '',
        email: '',
        phone: '',
        address: '',
        status: 1,
    });

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
        setFormData({
            name: '',
            subdomain: '',
            email: '',
            phone: '',
            address: '',
            status: 1,
        });
        setDialogVisible(true);
    };

    const openEdit = (branch: Branch) => {
        setEditingBranch(branch);
        setFormData({
            name: branch.name,
            subdomain: branch.subdomain,
            email: branch.email || '',
            phone: branch.phone || '',
            address: branch.address || '',
            status: branch.status,
        });
        setDialogVisible(true);
    };

    const handleSave = async () => {
        try {
            let response;
            if (editingBranch) {
                response = await branchService.update(editingBranch.id, formData);
            } else {
                response = await branchService.create(formData);
            }

            if (response.success) {
                loadBranches();
                setDialogVisible(false);
            }
        } catch (error) {
            console.error('Error saving branch:', error);
        }
    };

    const handleDelete = (branch: Branch) => {
        if (!confirm(`Are you sure you want to delete "${branch.name}"?`)) {
            return;
        }
        
        branchService.delete(branch.id).then(() => loadBranches());
    };

    const statusBodyTemplate = (rowData: Branch) => {
        return (
            <span className={`badge badge-${rowData.status === 1 ? 'success' : 'secondary'}`}>
                {rowData.status === 1 ? 'Active' : 'Inactive'}
            </span>
        );
    };

    const actionsBodyTemplate = (rowData: Branch) => {
        return (
            <div className="flex gap-2">
                <Button
                    icon="pi pi-pencil"
                    className="p-button-text p-button-sm"
                    onClick={() => openEdit(rowData)}
                />
                <Button
                    icon="pi pi-trash"
                    className="p-button-text p-button-danger p-button-sm"
                    onClick={() => handleDelete(rowData)}
                />
            </div>
        );
    };

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
                <Column field="status" header="Status" body={statusBodyTemplate} sortable />
                <Column header="Actions" body={actionsBodyTemplate} style={{ width: '10rem' }} />
            </DataTable>

            <Dialog
                visible={dialogVisible}
                onHide={() => setDialogVisible(false)}
                header={editingBranch ? 'Edit Branch' : 'Add Branch'}
                style={{ width: '30rem' }}
            >
                <div className="flex flex-column gap-3">
                    <div>
                        <label className="block text-sm font-medium mb-1">Name *</label>
                        <InputText
                            value={formData.name}
                            onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                            className="w-full"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Subdomain</label>
                        <InputText
                            value={formData.subdomain}
                            onChange={(e) => setFormData({ ...formData, subdomain: e.target.value })}
                            className="w-full"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Email</label>
                        <InputText
                            value={formData.email}
                            onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                            className="w-full"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Phone</label>
                        <InputText
                            value={formData.phone}
                            onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                            className="w-full"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Address</label>
                        <InputText
                            value={formData.address}
                            onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                            className="w-full"
                        />
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
                    <div className="flex justify-content-end gap-2 mt-3">
                        <Button
                            label="Cancel"
                            className="p-button-text"
                            onClick={() => setDialogVisible(false)}
                        />
                        <Button label="Save" onClick={handleSave} />
                    </div>
                </div>
            </Dialog>
        </div>
    );
}