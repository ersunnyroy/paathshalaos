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
import { FileUpload } from 'primereact/fileupload';
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
    established_year: number | null;
    student_count: number | null;
    description: string;
    logo: string;
}

type Errors = Partial<Record<keyof FormData, string>>;

const instituteTypes = [
    { label: 'School', value: 'school', icon: 'pi-building' },
    { label: 'College', value: 'college', icon: 'pi-book' },
    { label: 'University', value: 'university', icon: 'pi-verified' },
    { label: 'Coaching', value: 'coaching', icon: 'pi-users' },
    { label: 'Pre-School', value: 'preschool', icon: 'pi-heart' },
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
    { label: 'Asia/Kolkata (IST +5:30)', value: 'Asia/Kolkata' },
    { label: 'America/New_York (EST -5:00)', value: 'America/New_York' },
    { label: 'Europe/London (GMT +0:00)', value: 'Europe/London' },
    { label: 'Asia/Dubai (GST +4:00)', value: 'Asia/Dubai' },
    { label: 'Asia/Singapore (SGT +8:00)', value: 'Asia/Singapore' },
];

const currencies = [
    { label: '₹ INR — Indian Rupee', value: 'INR' },
    { label: '$ USD — US Dollar', value: 'USD' },
    { label: '£ GBP — British Pound', value: 'GBP' },
    { label: 'د.إ AED — UAE Dirham', value: 'AED' },
];

const generateYearOptions = () => {
    const currentYear = new Date().getFullYear();
    const years = [];
    for (let year = currentYear; year >= 1900; year--) {
        years.push({ label: year.toString(), value: year });
    }
    return years;
};

const yearOptions = generateYearOptions();

const steps = [
    { label: 'Basic Info' },
    { label: 'Details' },
    { label: 'Location' },
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+/;

function validateStep0(f: FormData): Errors {
    const e: Errors = {};
    if (!f.name.trim()) e.name = 'Institute name is required.';
    if (!f.email.trim()) e.email = 'Admin email is required.';
    else if (!EMAIL_RE.test(f.email)) e.email = 'Please enter a valid email address.';
    return e;
}

function validateStep1(f: FormData): Errors {
    const e: Errors = {};
    if (f.website && !URL_RE.test(f.website)) e.website = 'Website must start with http:// or https://';
    return e;
}

export default function EditInstitutePage() {
    const router = useRouter();
    const params = useParams();
    const toast = useRef<Toast>(null);
    const id = parseInt(params.id as string);

    const [loading, setLoading] = useState(false);
    const [fetchLoading, setFetchLoading] = useState(true);
    const [activeStep, setActiveStep] = useState(0);
    const activeStepRef = useRef(0);
    const [errors, setErrors] = useState<Errors>({});

    useEffect(() => { activeStepRef.current = activeStep; }, [activeStep]);

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
        established_year: null,
        student_count: null,
        description: '',
        logo: '',
    });
    const [logoFile, setLogoFile] = useState<File | null>(null);
    const [logoPreview, setLogoPreview] = useState<string>('');
    const [existingLogo, setExistingLogo] = useState<string>('');
    const [logoUploadKey, setLogoUploadKey] = useState(0);

    useEffect(() => {
        const init = async () => {
            if (!api.isAuthenticated()) { router.push('/auth/login'); return; }
            const userRes = await authService.me();
            if (!userRes.success) { api.removeToken(); router.push('/auth/login'); return; }

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
                        established_year: t.established_year ? parseInt(t.established_year) : null,
                        student_count: t.student_count ?? null,
                        description: t.description || '',
                        logo: t.logo || '',
                    });
                    if (t.logo) { setExistingLogo(t.logo); setLogoPreview(t.logo); }
                } else {
                    toast.current?.show({ severity: 'error', summary: 'Not Found', detail: 'Institute not found', life: 3000 });
                    router.push('/main/institutes');
                }
            } catch {
                toast.current?.show({ severity: 'error', summary: 'Error', detail: 'Failed to load institute data', life: 3000 });
            } finally {
                setFetchLoading(false);
            }
        };
        init();
    }, [id, router]);

    const handleChange = (field: keyof FormData, value: any) => {
        setFormData(prev => ({ ...prev, [field]: value }));
        if (errors[field]) setErrors(prev => ({ ...prev, [field]: '' }));
    };

    const field = (key: keyof FormData) => ({
        value: formData[key] as string,
        onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => handleChange(key, e.target.value),
        className: classNames('w-full', errors[key] && 'p-invalid'),
    });

    const nextStep = () => {
        let stepErrors: Errors = {};
        if (activeStep === 0) stepErrors = validateStep0(formData);
        if (activeStep === 1) stepErrors = validateStep1(formData);
        if (Object.keys(stepErrors).length > 0) {
            setErrors(prev => ({ ...prev, ...stepErrors }));
            return;
        }
        setErrors({});
        setActiveStep(prev => Math.min(prev + 1, steps.length - 1));
    };

    const prevStep = () => setActiveStep(prev => Math.max(prev - 1, 0));

    const commitUpdate = async () => {
        if (activeStepRef.current !== steps.length - 1) return;
        setLoading(true);
        try {
            let logoUrl = formData.logo;

            if (logoFile) {
                try {
                    const fd = new FormData();
                    fd.append('logo', logoFile);
                    const uploadRes = await api.postWithFormData(`/tenants/${id}/logo`, fd);
                    if (uploadRes.success && uploadRes.data?.url) logoUrl = uploadRes.data.url;
                } catch {
                    // non-fatal
                }
            }

            const { subdomain, ...updateData } = formData;
            const response = await tenantAdminService.update(id, {
                ...updateData,
                logo: logoUrl,
                established_year: formData.established_year ?? undefined,
                student_count: formData.student_count ?? undefined,
                website: formData.website || undefined,
                board: formData.board || undefined,
                medium: formData.medium || undefined,
                description: formData.description || undefined,
            });

            if (response.success) {
                toast.current?.show({ severity: 'success', summary: 'Saved', detail: 'Institute updated successfully', life: 2500 });
                setTimeout(() => router.push('/main/institutes'), 1500);
            } else {
                const detail = response.errors
                    ? Object.values(response.errors).flat().join(' ')
                    : response.message || 'Failed to update institute';
                toast.current?.show({ severity: 'error', summary: 'Error', detail, life: 4000 });
            }
        } catch (err: any) {
            toast.current?.show({ severity: 'error', summary: 'Error', detail: err.message || 'An error occurred', life: 4000 });
        } finally {
            setLoading(false);
        }
    };

    const renderStep0 = () => (
        <div className="grid">
            <div className="col-12">
                <label className="block text-700 font-medium mb-2">Institute Type <span className="text-red-500">*</span></label>
                <div className="flex flex-wrap gap-2">
                    {instituteTypes.map((type) => (
                        <div
                            key={type.value}
                            onClick={() => handleChange('institute_type', type.value)}
                            className={classNames(
                                'flex align-items-center gap-2 px-3 py-2 border-1 border-round cursor-pointer transition-colors transition-duration-150',
                                formData.institute_type === type.value
                                    ? 'border-primary bg-primary-50 text-primary'
                                    : 'border-300 hover:border-primary-300 surface-card'
                            )}
                            style={{ minWidth: '120px' }}
                        >
                            <i className={classNames('pi text-lg', type.icon)} />
                            <span className="font-medium text-sm">{type.label}</span>
                        </div>
                    ))}
                </div>
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Institute Name <span className="text-red-500">*</span></label>
                <InputText
                    {...field('name')}
                    placeholder="e.g., Delhi Public School"
                />
                <small className="p-error field-error-hint">{errors.name ?? ''}</small>
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Subdomain</label>
                <div className="p-inputgroup">
                    <InputText value={formData.subdomain} disabled className="p-disabled" />
                    <span className="p-inputgroup-addon text-500 text-sm">.paathshalaos.com</span>
                </div>
                <small className="text-500 field-error-hint">Subdomain cannot be changed after creation.</small>
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Admin Email <span className="text-red-500">*</span></label>
                <InputText
                    {...field('email')}
                    type="email"
                    placeholder="admin@school.com"
                />
                <small className="p-error field-error-hint">{errors.email ?? ''}</small>
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Phone Number</label>
                <InputText {...field('phone')} placeholder="+91 98765 43210" />
                <small className="p-error field-error-hint">{errors.phone ?? ''}</small>
            </div>

            <div className="col-12">
                <label className="block text-700 font-medium mb-2">Institute Logo</label>
                <div className="flex align-items-center gap-3 p-3 border-1 border-300 border-round surface-50" style={{ minHeight: '72px' }}>
                    {logoPreview ? (
                        <img src={logoPreview} alt="Logo preview" style={{ height: '48px', width: 'auto', borderRadius: '6px', objectFit: 'contain' }} />
                    ) : (
                        <div className="flex align-items-center justify-content-center border-1 border-dashed border-300 border-round" style={{ width: '48px', height: '48px' }}>
                            <i className="pi pi-image text-400 text-xl" />
                        </div>
                    )}
                    <div className="flex flex-column gap-1 flex-1">
                        <div className="flex align-items-center gap-2">
                            <FileUpload
                                mode="basic"
                                accept="image/jpeg,image/png,image/webp,image/svg+xml"
                                maxFileSize={2097152}
                                chooseLabel={logoPreview ? 'Change Logo' : 'Upload Logo'}
                                className="p-button-outlined p-button-sm"
                                auto
                                customUpload
                                key={logoUploadKey}
                                uploadHandler={(e: any) => {
                                    const file = e.files[0];
                                    if (!file) return;
                                    setLogoFile(file);
                                    const reader = new FileReader();
                                    reader.onload = (ev) => setLogoPreview(ev.target?.result as string);
                                    reader.readAsDataURL(file);
                                }}
                            />
                            {logoFile && (
                                <Button
                                    type="button"
                                    icon="pi pi-undo"
                                    className="p-button-text p-button-secondary p-button-sm"
                                    tooltip="Revert to saved logo"
                                    tooltipOptions={{ position: 'top' }}
                                    onClick={() => { setLogoFile(null); setLogoPreview(existingLogo); setLogoUploadKey(k => k + 1); }}
                                />
                            )}
                        </div>
                        <small className="text-500">JPG, PNG, WebP, SVG — max 2 MB</small>
                    </div>
                </div>
            </div>
        </div>
    );

    const renderStep1 = () => (
        <div className="grid">
            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Country</label>
                <Dropdown value={formData.country} options={countries} onChange={(e) => handleChange('country', e.value)} className="w-full" placeholder="Select country" />
                <small className="field-error-hint" />
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Timezone</label>
                <Dropdown value={formData.timezone} options={timezones} onChange={(e) => handleChange('timezone', e.value)} className="w-full" placeholder="Select timezone" />
                <small className="field-error-hint" />
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Currency</label>
                <Dropdown value={formData.currency} options={currencies} onChange={(e) => handleChange('currency', e.value)} className="w-full" placeholder="Select currency" />
                <small className="field-error-hint" />
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Established Year</label>
                <Dropdown
                    value={formData.established_year}
                    options={yearOptions}
                    onChange={(e) => handleChange('established_year', e.value)}
                    className="w-full"
                    placeholder="Select year"
                    filter
                    filterPlaceholder="Search year…"
                />
                <small className="field-error-hint" />
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Board / Affiliation</label>
                <InputText {...field('board')} placeholder="CBSE, ICSE, State Board…" />
                <small className="p-error field-error-hint">{errors.board ?? ''}</small>
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Medium of Instruction</label>
                <InputText {...field('medium')} placeholder="English, Hindi, Tamil…" />
                <small className="p-error field-error-hint">{errors.medium ?? ''}</small>
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Expected Students</label>
                <InputNumber
                    value={formData.student_count}
                    onValueChange={(e) => handleChange('student_count', e.value)}
                    className="w-full"
                    min={0}
                    placeholder="0"
                    useGrouping
                />
                <small className="p-error field-error-hint">{errors.student_count ?? ''}</small>
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Website</label>
                <InputText {...field('website')} placeholder="https://schoolwebsite.com" />
                <small className="p-error field-error-hint">{errors.website ?? ''}</small>
            </div>

            <div className="col-12">
                <label className="block text-700 font-medium mb-1">Description</label>
                <InputTextarea
                    value={formData.description}
                    onChange={(e) => handleChange('description', e.target.value)}
                    className="w-full"
                    placeholder="Brief description about the institute"
                    rows={3}
                    autoResize
                />
                <small className="p-error field-error-hint">{errors.description ?? ''}</small>
            </div>
        </div>
    );

    const renderStep2 = () => (
        <div className="grid">
            <div className="col-12">
                <label className="block text-700 font-medium mb-1">Street Address</label>
                <InputText {...field('address_line1')} placeholder="Building, street, area" />
                <small className="p-error field-error-hint">{errors.address_line1 ?? ''}</small>
            </div>

            <div className="col-12 md:col-5">
                <label className="block text-700 font-medium mb-1">City</label>
                <InputText {...field('city')} placeholder="City" />
                <small className="p-error field-error-hint">{errors.city ?? ''}</small>
            </div>

            <div className="col-12 md:col-4">
                <label className="block text-700 font-medium mb-1">State / Province</label>
                <InputText {...field('state')} placeholder="State" />
                <small className="p-error field-error-hint">{errors.state ?? ''}</small>
            </div>

            <div className="col-12 md:col-3">
                <label className="block text-700 font-medium mb-1">Postal Code</label>
                <InputText {...field('postal_code')} placeholder="PIN / ZIP" />
                <small className="p-error field-error-hint">{errors.postal_code ?? ''}</small>
            </div>
        </div>
    );

    if (fetchLoading) {
        return (
            <div className="flex align-items-center justify-content-center" style={{ minHeight: '60vh' }}>
                <ProgressSpinner />
            </div>
        );
    }

    return (
        <div className="surface-section px-3 py-4 md:px-5">
            <Toast ref={toast} />

            <div className="flex align-items-center mb-4">
                <Button
                    type="button"
                    icon="pi pi-arrow-left"
                    label="Back to Institutes"
                    className="p-button-text p-button-sm"
                    onClick={() => router.push('/main/institutes')}
                />
            </div>

            <div className="surface-card shadow-2 border-round p-4 md:p-5" style={{ maxWidth: '860px', margin: '0 auto' }}>
                <div className="mb-4">
                    <h1 className="text-2xl font-bold text-900 m-0 mb-1">Edit Institute</h1>
                    <p className="text-600 m-0 text-sm">Update the details for <strong>{formData.name}</strong></p>
                </div>

                <Steps model={steps} activeIndex={activeStep} readOnly className="mb-5" />

                <form onSubmit={(e) => e.preventDefault()} onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
                    e.preventDefault();
                    if (activeStepRef.current === steps.length - 1 && !loading) void commitUpdate();
                    else nextStep();
                }}>
                    {activeStep === 0 && renderStep0()}
                    {activeStep === 1 && renderStep1()}
                    {activeStep === 2 && renderStep2()}

                    <div className="flex justify-content-between align-items-center mt-5 pt-3 border-top-1 surface-border">
                        <Button
                            type="button"
                            label="Back"
                            icon="pi pi-arrow-left"
                            className="p-button-outlined p-button-secondary"
                            onClick={prevStep}
                            disabled={activeStep === 0}
                        />

                        <div className="flex align-items-center gap-2">
                            <span className="text-500 text-sm">Step {activeStep + 1} of {steps.length}</span>
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
                                    type="button"
                                    label="Save Changes"
                                    icon="pi pi-check"
                                    loading={loading}
                                    disabled={loading}
                                    onClick={() => void commitUpdate()}
                                />
                            )}
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}
