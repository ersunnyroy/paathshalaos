'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { InputText } from 'primereact/inputtext';
import { InputTextarea } from 'primereact/inputtextarea';
import { Dropdown } from 'primereact/dropdown';
import { InputNumber } from 'primereact/inputnumber';
import { Button } from 'primereact/button';
import { Message } from 'primereact/message';
import { Steps } from 'primereact/steps';
import { FileUpload } from 'primereact/fileupload';
import { classNames } from 'primereact/utils';
import { authService, api } from '@/services/api';

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

type Errors = Partial<Record<keyof FormData, string>>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/.+/;

function validateStep0(f: FormData): Errors {
    const e: Errors = {};
    if (!f.name.trim()) e.name = 'Institute name is required.';
    if (!f.subdomain.trim()) e.subdomain = 'Subdomain is required.';
    else if (f.subdomain.length < 3) e.subdomain = 'Subdomain must be at least 3 characters.';
    if (!f.email.trim()) e.email = 'Admin email is required.';
    else if (!EMAIL_RE.test(f.email)) e.email = 'Please enter a valid email address.';
    return e;
}

function validateStep1(f: FormData): Errors {
    const e: Errors = {};
    if (f.website && !URL_RE.test(f.website)) e.website = 'Website must start with http:// or https://';
    return e;
}

export default function NewInstitutePage() {
    const router = useRouter();
    const [loading, setLoading] = useState(false);
    const [submitError, setSubmitError] = useState('');
    const [success, setSuccess] = useState(false);
    const [user, setUser] = useState<any>(null);
    const [activeStep, setActiveStep] = useState(0);
    const activeStepRef = useRef(0);
    const [errors, setErrors] = useState<Errors>({});
    const [subdomainStatus, setSubdomainStatus] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
    const subdomainCheckTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
    const [logoUploadKey, setLogoUploadKey] = useState(0);

    useEffect(() => {
        const checkAuth = async () => {
            if (!api.isAuthenticated()) { router.push('/auth/login'); return; }
            const res = await authService.me();
            if (!res.success) { api.removeToken(); router.push('/auth/login'); return; }
            setUser(res.data);
        };
        checkAuth();
    }, [router]);

    const handleChange = (field: keyof FormData, value: any) => {
        setFormData(prev => ({ ...prev, [field]: value }));
        if (errors[field]) setErrors(prev => ({ ...prev, [field]: '' }));

        if (field === 'name' && !formData.subdomain) {
            const sub = value.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            setFormData(prev => ({ ...prev, name: value, subdomain: sub }));
            scheduleSubdomainCheck(sub);
        }

        if (field === 'subdomain') {
            setSubdomainStatus('idle');
            scheduleSubdomainCheck(value);
        }
    };

    const scheduleSubdomainCheck = (value: string) => {
        if (subdomainCheckTimeoutRef.current) clearTimeout(subdomainCheckTimeoutRef.current);
        if (value && value.length >= 3) {
            setSubdomainStatus('checking');
            subdomainCheckTimeoutRef.current = setTimeout(() => checkSubdomain(value), 600);
        }
    };

    const checkSubdomain = async (subdomain: string) => {
        try {
            const res: any = await api.get(`/tenants/check-subdomain?subdomain=${encodeURIComponent(subdomain)}`);
            const available = res.available !== undefined ? res.available : res.data?.available;
            setSubdomainStatus(available ? 'available' : 'taken');
        } catch {
            setSubdomainStatus('idle');
        }
    };

    const nextStep = () => {
        let stepErrors: Errors = {};
        if (activeStep === 0) {
            stepErrors = validateStep0(formData);
            if (subdomainStatus === 'taken') stepErrors.subdomain = 'This subdomain is already taken. Please choose another.';
            else if (subdomainStatus === 'checking') stepErrors.subdomain = 'Checking subdomain availability…';
        }
        if (activeStep === 1) {
            stepErrors = validateStep1(formData);
        }
        if (Object.keys(stepErrors).length > 0) {
            setErrors(prev => ({ ...prev, ...stepErrors }));
            return;
        }
        setErrors({});
        setActiveStep(prev => Math.min(prev + 1, steps.length - 1));
    };

    const prevStep = () => setActiveStep(prev => Math.max(prev - 1, 0));

    const commitCreate = async () => {
        if (activeStepRef.current !== steps.length - 1) return;
        setLoading(true);
        setSubmitError('');

        try {
            if (subdomainStatus === 'taken') {
                setSubmitError('This subdomain is already taken. Please go back and choose another.');
                setLoading(false);
                return;
            }

            const payload: any = {
                ...formData,
                slug: formData.subdomain,
                status: 1,
                established_year: formData.established_year ?? undefined,
                student_count: formData.student_count ?? undefined,
                website: formData.website || undefined,
                board: formData.board || undefined,
                medium: formData.medium || undefined,
                description: formData.description || undefined,
                logo: '',
            };

            const response = await api.post('/tenants', payload);

            if (!response.success) {
                if (response.errors) {
                    setSubmitError(Object.values(response.errors).flat().join(' '));
                } else {
                    setSubmitError(response.message || 'Failed to create institute.');
                }
                setLoading(false);
                return;
            }

            const tenantId = response.data?.id;
            if (tenantId && logoFile) {
                try {
                    const fd = new FormData();
                    fd.append('logo', logoFile);
                    const uploadRes = await api.postWithFormData(`/tenants/${tenantId}/logo`, fd);
                    if (uploadRes.success && uploadRes.data?.url) {
                        await api.put(`/tenants/${tenantId}`, { logo: uploadRes.data.url });
                    }
                } catch {
                    // logo upload failure is non-fatal
                }
            }

            setSuccess(true);
            setTimeout(() => router.push('/main/institutes'), 1800);
        } catch (err: any) {
            setSubmitError(err.message || 'An unexpected error occurred.');
        } finally {
            setLoading(false);
        }
    };

    const field = (key: keyof FormData) => ({
        value: formData[key] as string,
        onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => handleChange(key, e.target.value),
        className: classNames('w-full', errors[key] && 'p-invalid'),
    });

    const renderStep0 = () => (
        <div className="grid">
            {/* Institute Type */}
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

            {/* Name */}
            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Institute Name <span className="text-red-500">*</span></label>
                <InputText
                    value={formData.name}
                    onChange={(e) => handleChange('name', e.target.value)}
                    className={classNames('w-full', errors.name && 'p-invalid')}
                    placeholder="e.g., Delhi Public School"
                />
                <small className="p-error field-error-hint">{errors.name ?? ''}</small>
            </div>

            {/* Subdomain */}
            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Subdomain <span className="text-red-500">*</span></label>
                <div className="p-inputgroup">
                    <InputText
                        value={formData.subdomain}
                        onChange={(e) => handleChange('subdomain', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                        className={classNames(errors.subdomain && 'p-invalid')}
                        placeholder="dps"
                    />
                    <span className="p-inputgroup-addon text-600 text-sm">.paathshalaos.com</span>
                </div>
                <small className={classNames('field-error-hint', errors.subdomain ? 'p-error' : subdomainStatus === 'available' ? 'text-green-600' : 'text-600')}>
                    {errors.subdomain
                        ? errors.subdomain
                        : subdomainStatus === 'checking'
                        ? 'Checking availability…'
                        : subdomainStatus === 'available'
                        ? 'Subdomain is available'
                        : subdomainStatus === 'taken'
                        ? 'This subdomain is already taken'
                        : ''}
                </small>
            </div>

            {/* Email */}
            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Admin Email <span className="text-red-500">*</span></label>
                <InputText
                    {...field('email')}
                    type="email"
                    placeholder="admin@school.com"
                />
                <small className="p-error field-error-hint">{errors.email ?? ''}</small>
            </div>

            {/* Phone */}
            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Phone Number</label>
                <InputText
                    {...field('phone')}
                    placeholder="+91 98765 43210"
                />
                <small className="p-error field-error-hint">{errors.phone ?? ''}</small>
            </div>

            {/* Logo */}
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
                            {logoPreview && (
                                <Button
                                    type="button"
                                    icon="pi pi-times"
                                    className="p-button-text p-button-danger p-button-sm"
                                    tooltip="Remove logo"
                                    tooltipOptions={{ position: 'top' }}
                                    onClick={() => { setLogoFile(null); setLogoPreview(''); setLogoUploadKey(k => k + 1); }}
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
            <div className="col-12">
                <p className="text-600 text-sm mt-0 mb-3">All fields on this step are optional. You can fill them in later from the institute settings.</p>
            </div>

            {/* Row 1: Country + Timezone */}
            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Country</label>
                <Dropdown
                    value={formData.country}
                    options={countries}
                    onChange={(e) => handleChange('country', e.value)}
                    className="w-full"
                    placeholder="Select country"
                />
                <small className="field-error-hint" />
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Timezone</label>
                <Dropdown
                    value={formData.timezone}
                    options={timezones}
                    onChange={(e) => handleChange('timezone', e.value)}
                    className="w-full"
                    placeholder="Select timezone"
                />
                <small className="field-error-hint" />
            </div>

            {/* Row 2: Currency + Established Year */}
            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Currency</label>
                <Dropdown
                    value={formData.currency}
                    options={currencies}
                    onChange={(e) => handleChange('currency', e.value)}
                    className="w-full"
                    placeholder="Select currency"
                />
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

            {/* Row 3: Board + Medium */}
            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Board / Affiliation</label>
                <InputText
                    {...field('board')}
                    placeholder="CBSE, ICSE, State Board…"
                />
                <small className="p-error field-error-hint">{errors.board ?? ''}</small>
            </div>

            <div className="col-12 md:col-6">
                <label className="block text-700 font-medium mb-1">Medium of Instruction</label>
                <InputText
                    {...field('medium')}
                    placeholder="English, Hindi, Tamil…"
                />
                <small className="p-error field-error-hint">{errors.medium ?? ''}</small>
            </div>

            {/* Row 4: Student Count + Website */}
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
                <InputText
                    {...field('website')}
                    placeholder="https://schoolwebsite.com"
                />
                <small className="p-error field-error-hint">{errors.website ?? ''}</small>
            </div>

            {/* Description */}
            <div className="col-12">
                <label className="block text-700 font-medium mb-1">Description</label>
                <InputTextarea
                    value={formData.description}
                    onChange={(e) => handleChange('description', e.target.value)}
                    className="w-full"
                    placeholder="Brief description about the institute (optional)"
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
                <p className="text-600 text-sm mt-0 mb-3">Provide the physical address of the institute (optional).</p>
            </div>

            <div className="col-12">
                <label className="block text-700 font-medium mb-1">Street Address</label>
                <InputText
                    {...field('address_line1')}
                    placeholder="Building, street, area"
                />
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

    if (!user) {
        return (
            <div className="flex align-items-center justify-content-center" style={{ minHeight: '60vh' }}>
                <i className="pi pi-spin pi-spinner text-4xl text-400" />
            </div>
        );
    }

    return (
        <div className="surface-section px-3 py-4 md:px-5">
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
                    <h1 className="text-2xl font-bold text-900 m-0 mb-1">Onboard New Institute</h1>
                    <p className="text-600 m-0 text-sm">Complete the 3 steps below to set up your institute.</p>
                </div>

                <Steps model={steps} activeIndex={activeStep} readOnly className="mb-5" />

                {submitError && <Message severity="error" text={submitError} className="mb-4 w-full" />}
                {success && <Message severity="success" text="Institute created successfully! Redirecting…" className="mb-4 w-full" />}

                <form onSubmit={(e) => e.preventDefault()} onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
                    e.preventDefault();
                    if (activeStepRef.current === steps.length - 1 && !loading) void commitCreate();
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
                                    label="Create Institute"
                                    icon="pi pi-check"
                                    loading={loading}
                                    disabled={loading || success}
                                    onClick={() => void commitCreate()}
                                />
                            )}
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}
