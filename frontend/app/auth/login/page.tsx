'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { InputText } from 'primereact/inputtext';
import { Password } from 'primereact/password';
import { Button } from 'primereact/button';
import { Checkbox } from 'primereact/checkbox';
import { Message } from 'primereact/message';
import { authService, api } from '@/services/api';
import { tenantService } from '@/services/tenant';

function setFavicon(url: string) {
    let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }
    link.href = url;
}

export default function LoginPage() {
    const router = useRouter();
    const [tenant, setTenant] = useState<any>(null);
    const [loadingTenant, setLoadingTenant] = useState(true);
    const [tenantFound, setTenantFound] = useState(true);
    const [emailOrPhone, setEmailOrPhone] = useState('');
    const [password, setPassword] = useState('');
    const [rememberMe, setRememberMe] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [fieldErrors, setFieldErrors] = useState<{ emailOrPhone?: string; password?: string }>({});

    useEffect(() => {
        const initTenant = async () => {
            // Try cached tenant first to avoid flash
            const stored = tenantService.getTenant();
            if (stored) {
                setTenant(stored);
                applyTenantBranding(stored);
            } else {
                const result = await tenantService.check();
                if (result.found && result.tenant) {
                    setTenant(result.tenant);
                    applyTenantBranding(result.tenant);
                } else if (tenantService.isMultiTenant()) {
                    setTenantFound(false);
                }
            }
            setLoadingTenant(false);
        };
        initTenant();
    }, []);

    function applyTenantBranding(t: any) {
        if (t.name) document.title = `${t.name} — Sign In`;
        if (t.favicon_url) setFavicon(t.favicon_url);
    }

    useEffect(() => {
        if (!loadingTenant && api.isAuthenticated()) {
            router.push('/main');
        }
    }, [loadingTenant, router]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (loading) return;

        const fe: typeof fieldErrors = {};
        if (!emailOrPhone.trim()) fe.emailOrPhone = 'Email or phone is required.';
        if (!password) fe.password = 'Password is required.';
        if (Object.keys(fe).length) { setFieldErrors(fe); return; }
        setFieldErrors({});

        setLoading(true);
        setError('');

        try {
            const response = await authService.login({
                email_or_phone: emailOrPhone,
                password: password,
            });

            if (response.success && response.data?.token) {
                api.setToken(response.data.token);
                router.push('/main');
            } else {
                setError(response.message || 'Login failed. Please check your credentials.');
            }
        } catch (err: any) {
            setError(err.message || 'An error occurred. Please try again.');
        } finally {
            setLoading(false);
        }
    };

    const handleGoHome = () => {
        tenantService.clearTenant();
        router.push('/home');
    };

    if (loadingTenant) {
        return (
            <div className="flex align-items-center justify-content-center min-h-screen surface-50 p-4">
                <i className="pi pi-spin pi-spinner text-4xl" />
            </div>
        );
    }

    if (!tenantFound) {
        return (
            <div className="flex align-items-center justify-content-center min-h-screen surface-50 p-4">
                <div className="surface-card p-5 shadow-2 border-round-xl text-center max-w-30rem">
                    <div className="mb-4">
                        <i className="pi pi-exclamation-triangle text-6xl text-orange-500" />
                    </div>
                    <h1 className="text-4xl font-bold text-900 mb-3">School Not Found</h1>
                    <p className="text-600 mb-4">
                        We couldn&apos;t find a school with this web address. The school may have moved or the web address might be incorrect.
                    </p>
                    <Button
                        label="Go to PaathshalaOS"
                        icon="pi pi-home"
                        onClick={handleGoHome}
                    />
                </div>
            </div>
        );
    }

    const schoolName = tenant?.name || 'PaathshalaOS';

    return (
        <div className="flex align-items-center justify-content-center min-h-screen surface-50 p-4">
            <div className="surface-card p-4 shadow-2 border-round-xl w-full max-w-30rem">
                <div className="text-center mb-4">
                    {tenant?.logo_url ? (
                        <img
                            src={tenant.logo_url}
                            alt={schoolName}
                            className="mb-3"
                            style={{ maxHeight: '64px', maxWidth: '200px', objectFit: 'contain' }}
                        />
                    ) : (
                        <i className="pi pi-building text-900 mb-3" style={{ fontSize: '3rem' }}></i>
                    )}
                    <h2 className="text-2xl font-bold text-900 mt-0 mb-1">{schoolName}</h2>
                    <span className="text-600 text-sm">
                        {tenant ? 'Sign in to your account' : 'Sign in to your account or register your school'}
                    </span>
                </div>

                {error && (
                    <Message severity="error" text={error} className="mb-3 w-full" />
                )}

                <form onSubmit={handleSubmit}>
                    <div className="mb-3">
                        <label htmlFor="email" className="block text-900 font-medium mb-2">
                            Email or Phone
                        </label>
                        <InputText
                            id="email"
                            value={emailOrPhone}
                            onChange={(e) => { setEmailOrPhone(e.target.value); if (fieldErrors.emailOrPhone) setFieldErrors(f => ({ ...f, emailOrPhone: '' })); }}
                            className={`w-full${fieldErrors.emailOrPhone ? ' p-invalid' : ''}`}
                            placeholder="Enter your email or phone"
                        />
                        <small className="p-error field-error-hint">{fieldErrors.emailOrPhone}</small>
                    </div>

                    <div className="mb-3">
                        <label htmlFor="password" className="block text-900 font-medium mb-2">
                            Password
                        </label>
                        <Password
                            id="password"
                            value={password}
                            onChange={(e) => { setPassword(e.target.value); if (fieldErrors.password) setFieldErrors(f => ({ ...f, password: '' })); }}
                            className="w-full"
                            inputClassName={`w-full${fieldErrors.password ? ' p-invalid' : ''}`}
                            placeholder="Enter your password"
                            feedback={false}
                            toggleMask
                        />
                        <small className="p-error field-error-hint">{fieldErrors.password}</small>
                    </div>

                    <div className="flex align-items-center justify-content-between mb-3">
                        <div className="flex align-items-center">
                            <Checkbox
                                inputId="remember"
                                checked={rememberMe}
                                onChange={(e) => setRememberMe(!!e.checked)}
                                className="mr-2"
                            />
                            <label htmlFor="remember" className="text-600">
                                Remember me
                            </label>
                        </div>
                        <Link href="/forgot-password" className="text-primary font-medium">
                            Forgot password?
                        </Link>
                    </div>

                    <Button
                        type="submit"
                        label="Sign In"
                        className="w-full"
                        loading={loading}
                    />
                </form>
            </div>
        </div>
    );
}
