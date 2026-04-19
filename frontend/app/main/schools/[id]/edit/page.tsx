'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { InputText } from 'primereact/inputtext';
import { InputTextarea } from 'primereact/inputtextarea';
import { Dropdown } from 'primereact/dropdown';
import { InputNumber } from 'primereact/inputnumber';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { Steps } from 'primereact/steps';
import { ProgressSpinner } from 'primereact/progressspinner';
import { classNames } from 'primereact/utils';
import { authService, api, tenantAdminService } from '@/services/api';

interface FormData {
    name: string;
    subdomain: string;
    email: string;
    phone: string;
    institute_type: string;
    country: string;
    timezone: string;
    currency: string;
    address_line1: string;
    city: string;
    state: string;
    postal_code: string;
    website: string;
    board: string;
    medium: string;
    established_year: number;
    student_count: number;
    description: string;
}

const instituteTypes = [
    { label: 'School', value: 'school', icon: 'pi pi-building' },
    { label: 'College', value: 'college', icon: 'pi pi-book' },
    { label: 'University', value: 'university', icon: 'pi pi-verified' },
    { label: 'Coaching Institute', value: 'coaching', icon: 'pi pi-users' },
    { label: 'Pre-School', value: 'preschool', icon: 'pi pi-heart' },
];

const countries = [
    { label: 'India', value: 'IN' },
    { label: 'USA', value: 'US' },
    { label: 'UK', value: 'GB' },
    { label: 'UAE', value: 'AE' },
    { label: 'Nepal', value: 'NP' },
    { label: 'Singapore', value: 'SG' },
];

const timezones = [
    { label: 'Asia/Kolkata (IST)', value: 'Asia/Kolkata' },
    { label: 'America/New_York (EST)', value: 'America/New_York' },
    { label: 'Europe/London (GMT)', value: 'Europe/London' },
    { label: 'Asia/Dubai (GST)', value: 'Asia/Dubai' },
];

const currencies = [
    { label: '₹ INR', value: 'INR' },
    { label: '$ USD', value: 'USD' },
    { label: '£ GBP', value: 'GBP' },
    { label: 'د.إ AED', value: 'AED' },
];

const generateYearOptions = () => {
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let year = currentYear; year >= 1900; year--) {
        years.push({ label: year.toString(), value: year });
    }
    return years;
};

const steps = [
    { label: 'Basic Info' },
    { label: 'Details' },
    { label: 'Location' },
];

const FieldLabel = ({ label, required }: { label: string; required?: boolean }) => (
    <label className="block text-700 font-medium mb-1">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
    </label>
);

export default function EditSchoolPage() {
    const router = useRouter();
    const params = useParams();
    const toast = useRef<Toast>(null);
    const id = parseInt(params.id as string);

    const [loading, setLoading] = useState(false);
    const [fetchLoading, setFetchLoading] = useState(true);
    const [activeStep, setActiveStep] = useState(0);
    const [touched, setTouched] = useState<Record<string, boolean>>({});

    const [formData, setFormData] = useState<FormData>({
        name: '',
        subdomain: '',
        email: '',
        phone: '',
        institute_type: 'school',
        country: 'IN',
        timezone: 'Asia/Kolkata',
        currency: 'INR',
        address_line1: '',
        city: '',
        state: '',
        postal_code: '',
        website: '',
        board: '',
        medium: '',
        established_year: new Date().getFullYear(),
        student_count: 0,
        description: '',
    });

    useEffect(() => {
        const init = async () => {
            if (!api.isAuthenticated()) {
                router.push('/auth/login');
                return;
            }
            const userRes = await authService.me();
            if (!userRes.success) {
                api.removeToken();
                router.push('/auth/login');
                return;
            }

            try {
                const res = await tenantAdminService.getById(id);
                if (res.success && res.data) {
                    const t = res.data as any;
                    setFormData({
                        name: t.name || '',
                        subdomain: t.subdomain || '',
                        email: t.email || '',
                        phone: t.phone || '',
                        institute_type: t.institute_type || 'school',
                        country: t.country || 'IN',
                        timezone: t.timezone || 'Asia/Kolkata',
                        currency: t.currency || 'INR',
                        address_line1: t.address_line1 || t.address || '',
                        city: t.city || '',
                        state: t.state || '',
                        postal_code: t.postal_code || '',
                        website: t.website || '',
                        board: t.board || '',
                        medium: t.medium || '',
                        established_year: t.established_year ? parseInt(t.established_year) : new Date().getFullYear(),
                        student_count: t.student_count || 0,
                        description: t.description || '',
                    });
                } else {
                    toast.current?.show({ severity: 'error', summary: 'Not Found', detail: 'School not found', life: 3000 });
                    router.push('/main/schools');
                }
            } catch {
                toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to load school data', life: 3000 });
            } finally {
                setFetchLoading(false);
            }
        };
        init();
    }, [id, router]);

    const handleChange = (field: keyof FormData, value: any) => {
        setFormData(prev => ({ ...prev, [field]: value }));
    };

    const handleBlur = (field: string) => {
        setTouched(prev => ({ ...prev, [field]: true }));
    };

    const getError = (field: keyof FormData): string | null => {
        if (!touched[field]) return null;
        if (field === 'email' && formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
            return 'Invalid email address';
        }
        return null;
    };

    const validateStep = (step: number): boolean => {
        if (step === 0) {
            if (!formData.name || !formData.email) return false;
            if (formData.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) return false;
        }
        return true;
    };

    const nextStep = () => {
        if (validateStep(activeStep)) {
            setActiveStep(prev => Math.min(prev + 1, steps.length - 1));
        }
    };

    const prevStep = () => setActiveStep(prev => Math.max(prev - 1, 0));

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        try {
            const { subdomain, ...updateData } = formData;
            const response = await tenantAdminService.update(id, updateData);
            if (response.success) {
                toast.current?.show({ severity: 'success', summary: 'Saved', detail: 'Institute updated successfully', life: 2500 });
                setTimeout(() => router.push('/main/schools'), 1500);
            } else {
                toast.current?.show({
                    severity: 'error',
                    summary: 'Error',
                    detail: response.message || 'Failed to update institute',
                    life: 4000,
                });
            }
        } catch (err: any) {
            toast.current?.show({ severity: 'error', summary: 'Error', detail: err.message || 'An error occurred', life: 4000 });
        } finally {
            setLoading(false);
        }
    };

    const renderStepContent = () => {
        switch (activeStep) {
            case 0:
                return (
                    <div className="grid nested-grid">
                        <div className="col-12">
                            <FieldLabel label="Institute Type" required />
                            <div className="flex flex-wrap gap-2">
                                {instituteTypes.map((type) => (
                                    <div
                                        key={type.value}
                                        onClick={() => handleChange('institute_type', type.value)}
                                        className={classNames(
                                            'surface-card p-3 border-1 border-round cursor-pointer transition-colors transition-duration-200 flex align-items-center gap-2',
                                            formData.institute_type === type.value
                                                ? 'border-primary bg-primary-50'
                                                : 'border-surface-200 hover:surface-50'
                                        )}
                                        style={{ minWidth: '140px', flex: '1 1 auto' }}
                                    >
                                        <i className={classNames('pi text-xl', type.icon)} />
                                        <span className="font-medium">{type.label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="col-12 md:col-6">
                            <FieldLabel label="Institute Name" required />
                            <InputText
                                value={formData.name}
                                onChange={(e) => handleChange('name', e.target.value)}
                                onBlur={() => handleBlur('name')}
                                className={classNames('w-full', getError('name') && 'p-invalid')}
                                placeholder="e.g., Delhi Public School"
                            />
                            {getError('name') && <small className="p-error">{getError('name')}</small>}
                        </div>

                        <div className="col-12 md:col-6">
                            <FieldLabel label="Subdomain" />
                            <div className="p-inputgroup">
                                <InputText
                                    value={formData.subdomain}
                                    disabled
                                    className="p-disabled w-full"
                                />
                                <span className="p-inputgroup-addon text-500">.paathshalaos.com</span>
                            </div>
                            <small className="text-500">Subdomain cannot be changed after creation</small>
                        </div>

                        <div className="col-12 md:col-6">
                            <FieldLabel label="Admin Email" required />
                            <InputText
                                value={formData.email}
                                onChange={(e) => handleChange('email', e.target.value)}
                                onBlur={() => handleBlur('email')}
                                type="email"
                                className={classNames('w-full', getError('email') && 'p-invalid')}
                                placeholder="admin@school.com"
                            />
                            {getError('email') && <small className="p-error block">{getError('email')}</small>}
                        </div>

                        <div className="col-12 md:col-6">
                            <FieldLabel label="Phone Number" />
                            <InputText
                                value={formData.phone}
                                onChange={(e) => handleChange('phone', e.target.value)}
                                className="w-full"
                                placeholder="+91 98765 43210"
                            />
                        </div>
                    </div>
                );

            case 1:
                return (
                    <div className="grid nested-grid">
                        <div className="col-12 md:col-6">
                            <FieldLabel label="Country" />
                            <Dropdown
                                value={formData.country}
                                options={countries}
                                onChange={(e) => handleChange('country', e.value)}
                                className="w-full"
                                optionLabel="label"
                                placeholder="Select Country"
                            />
                        </div>

                        <div className="col-12 md:col-6">
                            <FieldLabel label="Timezone" />
                            <Dropdown
                                value={formData.timezone}
                                options={timezones}
                                onChange={(e) => handleChange('timezone', e.value)}
                                className="w-full"
                                placeholder="Select Timezone"
                            />
                        </div>

                        <div className="col-12 md:col-6">
                            <FieldLabel label="Currency" />
                            <Dropdown
                                value={formData.currency}
                                options={currencies}
                                onChange={(e) => handleChange('currency', e.value)}
                                className="w-full"
                                placeholder="Select Currency"
                            />
                        </div>

                        <div className="col-12 md:col-6">
                            <FieldLabel label="Established Year" />
                            <Dropdown
                                value={formData.established_year}
                                options={generateYearOptions()}
                                onChange={(e) => handleChange('established_year', e.value)}
                                className="w-full"
                                placeholder="Select Year"
                                filter
                                filterPlaceholder="Search year"
                            />
                        </div>

                        <div className="col-12 md:col-6">
                            <FieldLabel label="Board / Affiliation" />
                            <InputText
                                value={formData.board}
                                onChange={(e) => handleChange('board', e.target.value)}
                                className="w-full"
                                placeholder="CBSE, ICSE, State Board"
                            />
                        </div>

                        <div className="col-12 md:col-6">
                            <FieldLabel label="Medium of Instruction" />
                            <InputText
                                value={formData.medium}
                                onChange={(e) => handleChange('medium', e.target.value)}
                                className="w-full"
                                placeholder="English, Hindi, etc."
                            />
                        </div>

                        <div className="col-12 md:col-6">
                            <FieldLabel label="Expected Students" />
                            <InputNumber
                                value={formData.student_count}
                                onChange={(e) => handleChange('student_count', e.value)}
                                className="w-full"
                                min={0}
                                showButtons
                                buttonLayout="horizontal"
                                decrementButtonClassName="p-button-secondary"
                                incrementButtonClassName="p-button-secondary"
                            />
                        </div>

                        <div className="col-12 md:col-6">
                            <FieldLabel label="Website" />
                            <InputText
                                value={formData.website}
                                onChange={(e) => handleChange('website', e.target.value)}
                                className="w-full"
                                placeholder="https://schoolwebsite.com"
                            />
                        </div>

                        <div className="col-12">
                            <FieldLabel label="Description" />
                            <InputTextarea
                                value={formData.description}
                                onChange={(e) => handleChange('description', e.target.value)}
                                className="w-full"
                                placeholder="Brief description about the institute"
                                rows={3}
                                autoResize
                            />
                        </div>
                    </div>
                );

            case 2:
                return (
                    <div className="grid nested-grid">
                        <div className="col-12">
                            <FieldLabel label="Address" />
                            <InputText
                                value={formData.address_line1}
                                onChange={(e) => handleChange('address_line1', e.target.value)}
                                className="w-full"
                                placeholder="Street address"
                            />
                        </div>

                        <div className="col-12 md:col-4">
                            <FieldLabel label="City" />
                            <InputText
                                value={formData.city}
                                onChange={(e) => handleChange('city', e.target.value)}
                                className="w-full"
                                placeholder="City"
                            />
                        </div>

                        <div className="col-12 md:col-4">
                            <FieldLabel label="State" />
                            <InputText
                                value={formData.state}
                                onChange={(e) => handleChange('state', e.target.value)}
                                className="w-full"
                                placeholder="State"
                            />
                        </div>

                        <div className="col-12 md:col-4">
                            <FieldLabel label="Postal Code" />
                            <InputText
                                value={formData.postal_code}
                                onChange={(e) => handleChange('postal_code', e.target.value)}
                                className="w-full"
                                placeholder="PIN/ZIP"
                            />
                        </div>
                    </div>
                );
        }
    };

    if (fetchLoading) {
        return (
            <div className="flex align-items-center justify-content-center min-h-screen">
                <ProgressSpinner />
            </div>
        );
    }

    return (
        <div className="flex flex-column surface-section px-3 py-4 md:px-5 lg:px-6 min-h-full">
            <Toast ref={toast} />

            <div className="flex align-items-center justify-content-between mb-4">
                <Button
                    icon="pi pi-arrow-left"
                    label="Back to Schools"
                    className="p-button-text p-button-sm"
                    onClick={() => router.push('/main/schools')}
                />
            </div>

            <div className="surface-card shadow-2 border-round p-4" style={{ maxWidth: '900px', margin: '0 auto', width: '100%' }}>
                <div className="flex align-items-center gap-2 mb-1">
                    <i className="pi pi-pencil text-xl" style={{ color: 'var(--primary-color)' }} />
                    <h1 className="text-xl font-bold m-0">Edit Institute</h1>
                </div>
                <p className="text-600 m-0 mb-4 text-sm">Update the details for <strong>{formData.name}</strong></p>

                <Steps model={steps} activeIndex={activeStep} className="mb-4" />

                <form onSubmit={handleSubmit}>
                    {renderStepContent()}

                    <div className="flex justify-content-between mt-4 pt-3 border-top-1 surface-border">
                        <Button
                            type="button"
                            label="Back"
                            icon="pi pi-arrow-left"
                            className="p-button-secondary p-button-outlined"
                            onClick={prevStep}
                            disabled={activeStep === 0}
                        />

                        {activeStep < steps.length - 1 ? (
                            <Button
                                type="button"
                                label="Continue"
                                icon="pi pi-arrow-right"
                                iconPos="right"
                                onClick={nextStep}
                            />
                        ) : (
                            <Button
                                type="submit"
                                label="Save Changes"
                                icon="pi pi-check"
                                loading={loading}
                            />
                        )}
                    </div>
                </form>
            </div>
        </div>
    );
}
